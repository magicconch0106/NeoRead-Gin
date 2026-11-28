import {
  exportFailure,
  PDFExportError,
  type PDFExportFailure,
} from "./pdf-export-error";
import { PDFDocument, rgb, type PDFPage } from "pdf-lib";
import {
  isPDFPageDecoration,
  pdfFontAscent,
  type Annotation,
  type PDFBlock,
  type TOCItem,
  type TranslationBlock,
} from "@neoread/core";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import { wrapText, validRect, type Rect } from "./pdf-layout";
import { splitLegacyCaptions } from "./pdf-captions";
import { matchesSource } from "./pdf-content";
import {
  escapeFootnoteMarkdown,
  mergeCompositeFigureBlocks,
} from "./pdf-figures";
import {
  compileFormula,
  drawFormula,
  prepareFlowPDFText,
  type Formula,
} from "./pdf-math";
import { embedExportFonts, type FontBytes } from "./pdf-fonts";
import { formulaNumbers } from "./formulaNumbers";
import {
  applyTranslatedPDFAnnotations,
  type BlockAnchorRecord,
  type FigurePlacementRecord,
  type TranslatedBlockRecord,
  type TranslatedLineRecord,
} from "./pdf-export-annotations";
import type {
  ExportIssue,
  PDFExportProgress,
  TranslatedPDF,
  TranslatedPDFLayout,
} from "./pdf-export-model";

export type ExportCanvas = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  dispose(): void;
};

export type ExportOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: PDFExportProgress) => void;
  createCanvas?: (width: number, height: number) => ExportCanvas;
  annotations?: Annotation[];
  answers?: Record<string, string>;
  navigation?: (pdf: PDFDocumentProxy) => Promise<TOCItem[]>;
  layout?: TranslatedPDFLayout;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 54;
const MARGIN_BOTTOM = 56;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const ASSET_LABELS = new Set([
  "image",
  "figure",
  "table",
  "chart",
  "algorithm",
]);
const FORMULA_LABELS = new Set(["display_formula", "inline_formula"]);
const REFERENCE_LABELS = new Set(["reference", "reference_content"]);

function browserCanvas(width: number, height: number): ExportCanvas {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法创建 PDF 导出画布");
  return {
    canvas,
    context,
    dispose: () => {
      canvas.width = canvas.height = 0;
    },
  };
}

function dataURLToBytes(dataURL: string): Uint8Array {
  const comma = dataURL.indexOf(",");
  const base64 = comma >= 0 ? dataURL.slice(comma + 1) : dataURL;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stripFormulaDelimiters(markdown: string): string {
  const trimmed = markdown.trim();
  const blockMatch =
    /^(?:\$\$([\s\S]+)\$\$|\\\[([\s\S]+)\\\]|\\\(([\s\S]+)\\\)|\$([\s\S]+)\$)$/u.exec(
      trimmed,
    );
  return (
    blockMatch?.[1] ??
    blockMatch?.[2] ??
    blockMatch?.[3] ??
    blockMatch?.[4] ??
    trimmed
  ).trim();
}

function sameSourceAndTarget(translation: TranslationBlock): boolean {
  if (!translation.sentences.length) return false;
  const norm = (value: string) =>
    value.replace(/[\s\u00ad*∗⋆⁎]+/gu, "").toLowerCase();
  return (
    norm(translation.sentences.map((s) => s.source).join("")) ===
    norm(translation.sentences.map((s) => s.target).join(""))
  );
}

async function textSpans(page: PDFPageProxy) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  return content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [a, b, c, d, e, f] = item.transform;
    const origin = viewport.convertToViewportPoint(e, f);
    const advance = Math.hypot(a, b);
    if (!advance) return [];
    const end = viewport.convertToViewportPoint(
      e + (item.width * a) / advance,
      f + (item.width * b) / advance,
    );
    const top = viewport.convertToViewportPoint(e + c, f + d);
    const up = [top[0] - origin[0], top[1] - origin[1]];
    const ascent = pdfFontAscent(content.styles[item.fontName]);
    const corners = [origin, end].flatMap((point) =>
      [ascent, ascent - 1].map((factor) => [
        point[0] + up[0] * factor,
        point[1] + up[1] * factor,
      ]),
    );
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return [
      {
        box: {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(...xs) - Math.min(...xs),
          height: Math.max(...ys) - Math.min(...ys),
        },
        text: item.str,
      },
    ];
  });
}

function paragraphStyle(label: string) {
  switch (label) {
    case "doc_title":
      return {
        size: 16.5,
        lineHeightRatio: 1.38,
        spaceBefore: 4,
        spaceAfter: 12,
        centered: true,
        keepWithNext: true,
        color: rgb(0.06, 0.06, 0.06),
      };
    case "paragraph_title":
      return {
        size: 12.5,
        lineHeightRatio: 1.42,
        spaceBefore: 11,
        spaceAfter: 5,
        centered: false,
        keepWithNext: true,
        color: rgb(0.08, 0.08, 0.08),
      };
    case "figure_title":
    case "figure_caption":
    case "table_caption":
      return {
        size: 9.5,
        lineHeightRatio: 1.48,
        spaceBefore: 3,
        spaceAfter: 10,
        centered: false,
        keepWithNext: false,
        color: rgb(0.22, 0.22, 0.22),
      };
    case "footnote":
    case "aside_text":
      return {
        size: 9,
        lineHeightRatio: 1.45,
        spaceBefore: 2,
        spaceAfter: 6,
        centered: false,
        keepWithNext: false,
        color: rgb(0.28, 0.28, 0.28),
      };
    default:
      return {
        size: 10.5,
        lineHeightRatio: 1.56,
        spaceBefore: 0,
        spaceAfter: 8,
        centered: false,
        keepWithNext: false,
        color: rgb(0.1, 0.1, 0.1),
      };
  }
}

function sourceParagraphStyle(label: string) {
  switch (label) {
    case "doc_title":
      return {
        size: 14.5,
        lineHeightRatio: 1.35,
        spaceBefore: 4,
        spaceAfter: 3,
        centered: true,
        keepWithNext: true,
        color: rgb(0.18, 0.18, 0.18),
      };
    case "paragraph_title":
      return {
        size: 11.5,
        lineHeightRatio: 1.38,
        spaceBefore: 11,
        spaceAfter: 2.5,
        centered: false,
        keepWithNext: true,
        color: rgb(0.2, 0.2, 0.2),
      };
    case "figure_title":
    case "figure_caption":
    case "table_caption":
      return {
        size: 9,
        lineHeightRatio: 1.44,
        spaceBefore: 3,
        spaceAfter: 2.5,
        centered: false,
        keepWithNext: true,
        color: rgb(0.32, 0.32, 0.32),
      };
    case "footnote":
    case "aside_text":
      return {
        size: 8.75,
        lineHeightRatio: 1.42,
        spaceBefore: 2,
        spaceAfter: 2,
        centered: false,
        keepWithNext: true,
        color: rgb(0.35, 0.35, 0.35),
      };
    default:
      return {
        size: 10,
        lineHeightRatio: 1.5,
        spaceBefore: 2,
        spaceAfter: 3.5,
        centered: false,
        keepWithNext: false,
        color: rgb(0.24, 0.24, 0.24),
      };
  }
}

/**
 * Generates a pure single-column translated PDF matching NeoRead's "仅译文"
 * reading view: Chinese translations, original cropped figures/tables/charts,
 * vector LaTeX formulas, and standard PDF annotations & outline — without any
 * original English pages or English paragraph fallbacks.
 */
export async function translatedPDF(
  getDocument: (parameters: DocumentInitParameters) => PDFDocumentLoadingTask,
  source: DocumentInitParameters,
  blocks: PDFBlock[],
  translations: TranslationBlock[],
  fontBytes: FontBytes,
  {
    signal,
    onProgress,
    createCanvas = browserCanvas,
    annotations,
    answers,
    navigation,
    layout = "translation",
  }: ExportOptions = {},
): Promise<TranslatedPDF> {
  const bilingual = layout === "bilingual";
  signal?.throwIfAborted();
  onProgress?.({ phase: "preparing", done: 0, total: 0 });
  let task: PDFDocumentLoadingTask;
  try {
    task = getDocument(source);
  } catch (error) {
    throw exportFailure(error, "pdf_decode");
  }
  let failureReason: PDFExportFailure = "pdf_decode";
  let failed = false;
  const abort = () => {
    void task.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    const input = await task.promise;
    signal?.throwIfAborted();
    const output = await PDFDocument.create();
    failureReason = "font_embed";
    const fonts = await embedExportFonts(output, fontBytes);
    failureReason = "layout";

    const byId = new Map(translations.map((t) => [t.blockId, t]));
    const equations = formulaNumbers(blocks);
    const bySourcePage = new Map<number, PDFBlock[]>();
    const issues: ExportIssue[] = [];

    for (const block of blocks) {
      if (isPDFPageDecoration(block) || equations.pairedIds.has(block.id))
        continue;
      if (
        !Number.isInteger(block.page) ||
        block.page < 1 ||
        block.page > input.numPages
      ) {
        issues.push({ page: block.page, blockId: block.id, reason: "bounds" });
        continue;
      }
      const list = bySourcePage.get(block.page) ?? [];
      list.push(block);
      bySourcePage.set(block.page, list);
    }

    let currentPage: PDFPage | null = null;
    let outPageNum = 0;
    let cursorY = MARGIN_TOP;
    const ensurePage = (): PDFPage => {
      if (!currentPage) {
        currentPage = output.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        outPageNum = output.getPageCount();
        cursorY = MARGIN_TOP;
      }
      return currentPage;
    };
    const nextPage = (): PDFPage => {
      currentPage = output.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      outPageNum = output.getPageCount();
      cursorY = MARGIN_TOP;
      return currentPage;
    };

    const translatedBlocks: TranslatedBlockRecord[] = [];
    const sourceBlocks: TranslatedBlockRecord[] = [];
    const figurePlacements: FigurePlacementRecord[] = [];
    const blockAnchors: BlockAnchorRecord[] = [];
    const anchoredBlockIds = new Set<string>();
    let translatedCount = 0;

    for (let srcPageNum = 1; srcPageNum <= input.numPages; srcPageNum++) {
      signal?.throwIfAborted();
      onProgress?.({
        phase: "pages",
        done: srcPageNum - 1,
        total: input.numPages,
      });
      let pageBlocks = bySourcePage.get(srcPageNum) ?? [];
      if (!pageBlocks.length) {
        if (!blocks.some((b) => b.page === srcPageNum)) {
          issues.push({ page: srcPageNum, reason: "unparsed" });
        }
        continue;
      }

      const srcPage = await input.getPage(srcPageNum);
      const viewport = srcPage.getViewport({ scale: 1 });
      const { width: srcW, height: srcH } = viewport;
      if (
        ![srcW, srcH].every((n) => Number.isFinite(n) && n > 0 && n <= 20_000)
      ) {
        throw new PDFExportError(
          "page_dimensions",
          new Error("PDF 页面尺寸超出导出范围"),
        );
      }

      if (pageBlocks.some((b) => b.image && b.caption?.trim())) {
        const spans = await textSpans(srcPage);
        const recovered = splitLegacyCaptions(pageBlocks, spans, srcW, srcH);
        pageBlocks = recovered.blocks;
      }
      pageBlocks = mergeCompositeFigureBlocks(pageBlocks);

      let renderedSurface: ExportCanvas | undefined;
      const renderScale = Math.min(2, Math.sqrt(6_000_000 / (srcW * srcH)));

      const cropBlockPNG = async (bounds: Rect): Promise<Uint8Array | null> => {
        const box = {
          x: bounds.x * srcW,
          y: bounds.y * srcH,
          width: bounds.width * srcW,
          height: bounds.height * srcH,
        };
        if (!validRect(box)) return null;
        if (!renderedSurface) {
          renderedSurface = createCanvas(
            Math.max(1, Math.ceil(srcW * renderScale)),
            Math.max(1, Math.ceil(srcH * renderScale)),
          );
          await srcPage.render({
            canvas: renderedSurface.canvas,
            canvasContext: renderedSurface.context,
            viewport: srcPage.getViewport({ scale: renderScale }),
            background: "#ffffff",
          }).promise;
        }
        const sx = Math.max(0, Math.floor(box.x * renderScale));
        const sy = Math.max(0, Math.floor(box.y * renderScale));
        const sw = Math.min(
          renderedSurface.canvas.width - sx,
          Math.max(1, Math.ceil((box.x + box.width) * renderScale) - sx),
        );
        const sh = Math.min(
          renderedSurface.canvas.height - sy,
          Math.max(1, Math.ceil((box.y + box.height) * renderScale) - sy),
        );
        if (sw <= 0 || sh <= 0) return null;
        const pixels = renderedSurface.context.getImageData(sx, sy, sw, sh);
        const crop = createCanvas(sw, sh);
        try {
          crop.context.putImageData(pixels, 0, 0);
          return dataURLToBytes(crop.canvas.toDataURL("image/png"));
        } finally {
          crop.dispose();
        }
      };

      const drawEmbeddedCrop = async (
        blockId: string,
        bounds: Rect,
        eqLabel?: string,
      ): Promise<boolean> => {
        const pngBytes = await cropBlockPNG(bounds);
        if (!pngBytes) return false;
        const png = await output.embedPng(pngBytes);
        const origW = Math.max(1, bounds.width * srcW);
        const origH = Math.max(1, bounds.height * srcH);
        const maxW = eqLabel ? CONTENT_WIDTH - 48 : CONTENT_WIDTH;
        const maxH = (PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM) * 0.72;
        const scale = Math.min(1.15, maxW / origW, maxH / origH);
        const drawW = origW * scale;
        const drawH = origH * scale;

        ensurePage();
        if (
          cursorY > MARGIN_TOP &&
          cursorY + 6 + drawH > PAGE_HEIGHT - MARGIN_BOTTOM
        ) {
          nextPage();
        }
        if (cursorY > MARGIN_TOP) cursorY += 6;
        const page = ensurePage();
        const drawX =
          MARGIN_X +
          ((eqLabel ? CONTENT_WIDTH - 40 : CONTENT_WIDTH) - drawW) / 2;
        const topY = cursorY;
        page.drawImage(png, {
          x: drawX,
          y: PAGE_HEIGHT - topY - drawH,
          width: drawW,
          height: drawH,
        });
        if (eqLabel) {
          const safeEq = fonts.sanitize(eqLabel);
          const runs = fonts.runs(safeEq);
          if (runs) {
            let ex = MARGIN_X + CONTENT_WIDTH - fonts.measure(safeEq, 10);
            const ey = PAGE_HEIGHT - topY - drawH / 2 - 3.5;
            for (const run of runs) {
              page.drawText(run.text, {
                x: ex,
                y: ey,
                size: 10,
                font: run.font,
                color: rgb(0.2, 0.2, 0.2),
              });
              ex += run.font.widthOfTextAtSize(run.text, 10);
            }
          }
        }
        const outRect: Rect = {
          x: drawX / PAGE_WIDTH,
          y: topY / PAGE_HEIGHT,
          width: drawW / PAGE_WIDTH,
          height: drawH / PAGE_HEIGHT,
        };
        figurePlacements.push({
          blockId,
          sourcePage: srcPageNum,
          sourceBounds: bounds,
          outPage: outPageNum,
          outRect,
        });
        blockAnchors.push({
          blockId,
          sourcePage: srcPageNum,
          sourceY: bounds.y,
          outPage: outPageNum,
          outY: outRect.y,
        });
        cursorY = topY + drawH + 6;
        return true;
      };

      const drawSourceParagraph = (
        block: PDFBlock,
        translation?: TranslationBlock,
        labelOverride?: string,
      ): boolean => {
        const rawSource = escapeFootnoteMarkdown(
          translation?.status === "complete" && translation.sentences.length
            ? translation.sentences
                .map((s) => s.source.trim())
                .filter(Boolean)
                .join(" ")
            : (block.caption || block.text).trim(),
          block.label,
        );
        const content = prepareFlowPDFText(rawSource, fonts);
        if (!content) return false;
        const effectiveLabel = labelOverride ?? block.label;
        const style = sourceParagraphStyle(effectiveLabel);
        const lines = wrapText(
          content.text,
          CONTENT_WIDTH,
          style.size,
          content.measure,
        );
        if (!lines?.length) return false;

        const baseLineHeight = style.size * style.lineHeightRatio;
        ensurePage();
        if (cursorY > MARGIN_TOP) cursorY += style.spaceBefore;
        const minNeeded = baseLineHeight + (style.keepWithNext ? 32 : 0);
        if (
          cursorY > MARGIN_TOP &&
          cursorY + minNeeded > PAGE_HEIGHT - MARGIN_BOTTOM
        ) {
          nextPage();
        }

        const lineRecords: TranslatedLineRecord[] = [];
        let firstPage = outPageNum;
        let firstTopY = cursorY;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const metrics = content.lineMetrics(line);
          const lineH = Math.max(
            baseLineHeight,
            style.size * (metrics.ascent + metrics.descent + 0.18),
          );
          if (
            cursorY > MARGIN_TOP &&
            cursorY + lineH > PAGE_HEIGHT - MARGIN_BOTTOM
          ) {
            nextPage();
          }
          const page = ensurePage();
          if (i === 0) {
            firstPage = outPageNum;
            firstTopY = cursorY;
          }
          const lineW = content.measure(line, style.size);
          const shouldCenter =
            style.centered ||
            (effectiveLabel === "figure_title" &&
              lines.length === 1 &&
              lineW < CONTENT_WIDTH * 0.85);
          const x =
            MARGIN_X +
            (shouldCenter ? Math.max(0, (CONTENT_WIDTH - lineW) / 2) : 0);
          const baselineY = cursorY + style.size * metrics.ascent;
          content.draw(
            page,
            line,
            x,
            PAGE_HEIGHT - baselineY,
            style.size,
            style.color,
          );
          lineRecords.push({
            page: outPageNum,
            pageWidth: PAGE_WIDTH,
            pageHeight: PAGE_HEIGHT,
            text: line,
            x,
            baselineY,
            size: style.size,
            lineHeight: lineH,
            ascent: metrics.ascent,
            descent: metrics.descent,
            measurePrefix: (endIndex: number) =>
              content.measure(line.slice(0, endIndex), style.size),
          });
          cursorY += lineH;
        }

        cursorY += translation ? style.spaceAfter : 7;
        if (
          translation?.status === "complete" &&
          translation.sentences.length
        ) {
          sourceBlocks.push({
            block,
            sourcePage: srcPageNum,
            sourceBounds: block.bounds,
            translation: {
              ...translation,
              sentences: translation.sentences.map((s) => ({
                ...s,
                target: s.source,
              })),
            },
            text: content.text,
            lines: lineRecords,
          });
        }
        if (!anchoredBlockIds.has(block.id)) {
          anchoredBlockIds.add(block.id);
          blockAnchors.push({
            blockId: block.id,
            sourcePage: srcPageNum,
            sourceY: block.bounds.y,
            outPage: firstPage,
            outY: firstTopY / PAGE_HEIGHT,
          });
        }
        return true;
      };

      const drawTranslatedParagraph = (
        block: PDFBlock,
        translation: TranslationBlock,
        labelOverride?: string,
        precededBySource = false,
      ): boolean => {
        const joined = escapeFootnoteMarkdown(
          translation.sentences
            .map((s) => s.target.trim())
            .filter(Boolean)
            .join(" "),
          block.label,
        );
        const content = prepareFlowPDFText(joined, fonts);
        if (!content) return false;
        const style = paragraphStyle(labelOverride ?? block.label);
        const lines = wrapText(
          content.text,
          CONTENT_WIDTH,
          style.size,
          content.measure,
        );
        if (!lines?.length) return false;

        const baseLineHeight = style.size * style.lineHeightRatio;
        ensurePage();
        if (cursorY > MARGIN_TOP && !precededBySource) {
          cursorY += style.spaceBefore;
        }
        const minNeeded = baseLineHeight + (style.keepWithNext ? 26 : 0);
        if (
          cursorY > MARGIN_TOP &&
          cursorY + minNeeded > PAGE_HEIGHT - MARGIN_BOTTOM
        ) {
          nextPage();
        }

        const lineRecords: TranslatedLineRecord[] = [];
        let firstPage = outPageNum;
        let firstTopY = cursorY;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const metrics = content.lineMetrics(line);
          const lineH = Math.max(
            baseLineHeight,
            style.size * (metrics.ascent + metrics.descent + 0.18),
          );
          if (
            cursorY > MARGIN_TOP &&
            cursorY + lineH > PAGE_HEIGHT - MARGIN_BOTTOM
          ) {
            nextPage();
          }
          const page = ensurePage();
          if (i === 0) {
            firstPage = outPageNum;
            firstTopY = cursorY;
          }
          const lineW = content.measure(line, style.size);
          const shouldCenter =
            style.centered ||
            ((labelOverride ?? block.label) === "figure_title" &&
              lines.length === 1 &&
              lineW < CONTENT_WIDTH * 0.85);
          const x =
            MARGIN_X +
            (shouldCenter ? Math.max(0, (CONTENT_WIDTH - lineW) / 2) : 0);
          const baselineY = cursorY + style.size * metrics.ascent;
          content.draw(
            page,
            line,
            x,
            PAGE_HEIGHT - baselineY,
            style.size,
            style.color,
          );
          lineRecords.push({
            page: outPageNum,
            pageWidth: PAGE_WIDTH,
            pageHeight: PAGE_HEIGHT,
            text: line,
            x,
            baselineY,
            size: style.size,
            lineHeight: lineH,
            ascent: metrics.ascent,
            descent: metrics.descent,
            measurePrefix: (endIndex: number) =>
              content.measure(line.slice(0, endIndex), style.size),
          });
          cursorY += lineH;
        }

        cursorY += style.spaceAfter + (precededBySource ? 2.5 : 0);
        translatedBlocks.push({
          block,
          sourcePage: srcPageNum,
          sourceBounds: block.bounds,
          translation,
          text: content.text,
          lines: lineRecords,
        });
        if (!anchoredBlockIds.has(block.id)) {
          anchoredBlockIds.add(block.id);
          blockAnchors.push({
            blockId: block.id,
            sourcePage: srcPageNum,
            sourceY: block.bounds.y,
            outPage: firstPage,
            outY: firstTopY / PAGE_HEIGHT,
          });
        }
        return true;
      };

      try {
        for (const block of pageBlocks) {
          signal?.throwIfAborted();
          const baseId = block.id.endsWith(":asset")
            ? block.id.slice(0, -6)
            : block.id.endsWith(":composite")
              ? block.id.slice(0, -10)
              : block.id;
          const translation = byId.get(baseId);

          // 1. Standalone display/inline formula block
          if (FORMULA_LABELS.has(block.label)) {
            const eqNum = equations.byFormula.get(baseId);
            let drawn = false;
            if (
              translation?.status === "complete" &&
              translation.formulaMarkdown?.trim()
            ) {
              let compiled: Formula | null = null;
              try {
                compiled = compileFormula(
                  stripFormulaDelimiters(translation.formulaMarkdown),
                  true,
                );
              } catch {
                compiled = null;
              }
              if (compiled) {
                const maxW = eqNum ? CONTENT_WIDTH - 52 : CONTENT_WIDTH * 0.92;
                const naturalW = compiled.width * 11;
                const fSize = naturalW > maxW ? 11 * (maxW / naturalW) : 11;
                const fW = compiled.width * fSize;
                const fH = (compiled.ascent + compiled.descent) * fSize;
                ensurePage();
                if (
                  cursorY > MARGIN_TOP &&
                  cursorY + fH + 12 > PAGE_HEIGHT - MARGIN_BOTTOM
                ) {
                  nextPage();
                }
                if (cursorY > MARGIN_TOP) cursorY += 6;
                const page = ensurePage();
                const topY = cursorY;
                const fx =
                  MARGIN_X +
                  ((eqNum ? CONTENT_WIDTH - 40 : CONTENT_WIDTH) - fW) / 2;
                const baselineY = topY + compiled.ascent * fSize;
                drawFormula(page, compiled, fx, PAGE_HEIGHT - baselineY, fSize);
                if (eqNum) {
                  const safeEq = fonts.sanitize(eqNum);
                  const runs = fonts.runs(safeEq);
                  if (runs) {
                    let ex =
                      MARGIN_X + CONTENT_WIDTH - fonts.measure(safeEq, 10);
                    const ey = PAGE_HEIGHT - topY - fH / 2 - 3.5;
                    for (const run of runs) {
                      page.drawText(run.text, {
                        x: ex,
                        y: ey,
                        size: 10,
                        font: run.font,
                        color: rgb(0.2, 0.2, 0.2),
                      });
                      ex += run.font.widthOfTextAtSize(run.text, 10);
                    }
                  }
                }
                const outRect: Rect = {
                  x: fx / PAGE_WIDTH,
                  y: topY / PAGE_HEIGHT,
                  width: fW / PAGE_WIDTH,
                  height: fH / PAGE_HEIGHT,
                };
                figurePlacements.push({
                  blockId: baseId,
                  sourcePage: srcPageNum,
                  sourceBounds: block.bounds,
                  outPage: outPageNum,
                  outRect,
                });
                blockAnchors.push({
                  blockId: baseId,
                  sourcePage: srcPageNum,
                  sourceY: block.bounds.y,
                  outPage: outPageNum,
                  outY: outRect.y,
                });
                cursorY = topY + fH + 8;
                translatedCount++;
                drawn = true;
              }
            }
            if (!drawn) {
              await drawEmbeddedCrop(baseId, block.bounds, eqNum);
              if (translation?.status === "complete") translatedCount++;
            }
            continue;
          }

          // 2. Split asset crop (`p3-b1:asset`) or unsplit figure/table/chart/algorithm
          const isAsset = !!block.image || ASSET_LABELS.has(block.label);
          if (isAsset) {
            if (!validRect(block.bounds)) {
              issues.push({
                page: srcPageNum,
                blockId: baseId,
                reason: "bounds",
              });
              continue;
            }
            await drawEmbeddedCrop(baseId, block.bounds);
            // If this block still carries an unsplit caption with a completed translation,
            // render its caption directly underneath.
            if (
              !block.id.endsWith(":asset") &&
              block.caption?.trim() &&
              translation?.status === "complete" &&
              translation.sentences.length
            ) {
              const drewSrc =
                bilingual &&
                !sameSourceAndTarget(translation) &&
                drawSourceParagraph(block, translation, "figure_title");
              if (
                drawTranslatedParagraph(
                  block,
                  translation,
                  "figure_title",
                  drewSrc,
                )
              ) {
                translatedCount++;
              }
            }
            continue;
          }

          // 3. Untranslated English bibliography items (`reference`, `reference_content`)
          if (REFERENCE_LABELS.has(block.label)) {
            if (
              translation?.status === "complete" &&
              translation.sentences.length
            ) {
              const drewSrc =
                bilingual &&
                !sameSourceAndTarget(translation) &&
                drawSourceParagraph(block, translation);
              if (
                drawTranslatedParagraph(block, translation, undefined, drewSrc)
              )
                translatedCount++;
            } else if (bilingual && block.text.trim()) {
              drawSourceParagraph(block);
            }
            continue;
          }

          // 4. Ordinary translatable text/heading/caption/footnote block
          if (!block.text.trim()) continue;
          if (
            !validRect(block.bounds) ||
            block.bounds.x < -0.05 ||
            block.bounds.y < -0.05
          ) {
            issues.push({
              page: srcPageNum,
              blockId: block.id,
              reason: "bounds",
            });
            continue;
          }
          if (
            !translation ||
            translation.status !== "complete" ||
            !translation.sentences.length
          ) {
            issues.push({
              page: srcPageNum,
              blockId: block.id,
              reason: "untranslated",
            });
            continue;
          }
          // Split legacy caption blocks carry block.caption as their text; check against original text if needed.
          const originalBlock = blocks.find((b) => b.id === block.id) ?? block;
          if (
            !(await matchesSource(block, translation)) &&
            !(await matchesSource(originalBlock, translation))
          ) {
            issues.push({
              page: srcPageNum,
              blockId: block.id,
              reason: "stale",
            });
            continue;
          }
          const drewSource =
            bilingual &&
            !sameSourceAndTarget(translation) &&
            drawSourceParagraph(block, translation);
          if (
            drawTranslatedParagraph(block, translation, undefined, drewSource)
          ) {
            translatedCount++;
          }
        }
      } finally {
        renderedSurface?.dispose();
        srcPage.cleanup();
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    signal?.throwIfAborted();
    if (!translatedCount) {
      throw new PDFExportError(
        "no_translated_blocks",
        new Error("当前还没有可导出的已完成译文，请完成翻译后重试。"),
      );
    }

    // Draw subtle page numbers at the bottom center of every generated page.
    const totalOutPages = output.getPageCount();
    for (let i = 0; i < totalOutPages; i++) {
      const p = output.getPage(i);
      const label = `${i + 1} / ${totalOutPages}`;
      const runs = fonts.runs(label);
      if (!runs) continue;
      let x = (PAGE_WIDTH - fonts.measure(label, 9)) / 2;
      for (const run of runs) {
        p.drawText(run.text, {
          x,
          y: 24,
          size: 9,
          font: run.font,
          color: rgb(0.48, 0.48, 0.48),
        });
        x += run.font.widthOfTextAtSize(run.text, 9);
      }
    }

    onProgress?.({
      phase: "saving",
      done: input.numPages,
      total: input.numPages,
    });
    failureReason = "save";
    output.setProducer("NeoRead");
    const rawBytes = await output.save({ objectsPerTick: 30 });
    signal?.throwIfAborted();

    const annotated = await applyTranslatedPDFAnnotations({
      getDocument,
      source,
      sourcePDF: input,
      bytes: rawBytes,
      translatedBlocks,
      sourceBlocks,
      figurePlacements,
      blockAnchors,
      annotations,
      answers,
      navigation,
      signal,
    });
    signal?.throwIfAborted();

    return {
      bytes: annotated.bytes,
      translated: translatedCount,
      pages: totalOutPages,
      issues,
      annotationsExported: annotated.exported,
      annotationsSkipped: annotated.skipped,
      ...(annotated.navigationExported !== undefined
        ? { navigationExported: annotated.navigationExported }
        : {}),
    };
  } catch (error) {
    failed = true;
    throw exportFailure(error, failureReason);
  } finally {
    signal?.removeEventListener("abort", abort);
    try {
      await task.destroy();
    } catch (error) {
      if (!failed && !signal?.aborted) throw exportFailure(error, "cleanup");
    }
  }
}
