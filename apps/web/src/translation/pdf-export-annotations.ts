import {
  sentenceAnchor,
  type Annotation,
  type PDFBlock,
  type PDFLocation,
  type TOCItem,
  type TranslationBlock,
  type TranslationLocation,
} from "@neoread/core";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import {
  commentText,
  displayQuads,
  editorPrefix,
  editorValue,
  sentenceQuads,
  type Quad,
} from "../readers/pdf-export";
import { writePDFOutline } from "../readers/pdf-outline-export";
import { exportFlowText } from "./pdf-content";
import { overlaps, type Rect } from "./pdf-layout";

export type TranslatedLineRecord = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  text: string;
  x: number;
  baselineY: number;
  size: number;
  lineHeight: number;
  ascent: number;
  descent: number;
  measurePrefix: (endIndex: number) => number;
};

export type TranslatedBlockRecord = {
  block: PDFBlock;
  sourcePage: number;
  sourceBounds: Rect;
  translation: TranslationBlock;
  text: string;
  lines: TranslatedLineRecord[];
};

export type FigurePlacementRecord = {
  blockId: string;
  sourcePage: number;
  sourceBounds: Rect;
  outPage: number;
  outRect: Rect;
};

export type BlockAnchorRecord = {
  blockId: string;
  sourcePage: number;
  sourceY: number;
  outPage: number;
  outY: number;
};

type TextSpan = { start: number; end: number };
type PageRect = { page: number; rect: Rect };
type TranslationPart = NonNullable<TranslationLocation["ranges"]>[number];

type BlockLayout = TranslatedBlockRecord & {
  sentenceRanges: TextSpan[];
  spanPageRects: (start: number, end: number) => PageRect[];
};

const compact = (text: string) =>
  text.replace(/[\s\u00ad]+/gu, "").toLowerCase();

function normalizeWithOffsets(value: string) {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (!/\s/u.test(ch)) {
      const folded =
        cp >= 0xff01 && cp <= 0xff5e
          ? String.fromCharCode(cp - 0xfee0)
          : /[\ue000-\uf8ff]/u.test(ch)
            ? "\ufffc"
            : ch;
      for (let k = 0; k < folded.length; k++) {
        text += folded[k];
        starts.push(i);
        ends.push(next);
      }
    }
    i = next;
  }
  return { text, starts, ends };
}

function buildSentenceRanges(
  fullText: string,
  translation: TranslationBlock,
): TextSpan[] {
  const full = normalizeWithOffsets(fullText);
  const ranges: TextSpan[] = [];
  let cursor = 0;
  for (const sentence of translation.sentences) {
    const rendered =
      exportFlowText(sentence.target.trim(), () => "\ufffc") ||
      sentence.target.trim();
    const needle = normalizeWithOffsets(rendered).text;
    if (!needle) {
      const pos =
        cursor < full.starts.length ? full.starts[cursor] : fullText.length;
      ranges.push({ start: pos, end: pos });
      continue;
    }
    let idx = full.text.indexOf(needle, cursor);
    if (idx < 0) idx = full.text.indexOf(needle);
    if (idx >= 0) {
      ranges.push({
        start: full.starts[idx],
        end: full.ends[idx + needle.length - 1],
      });
      cursor = idx + needle.length;
    } else {
      ranges.push({ start: 0, end: fullText.length });
    }
  }
  return ranges;
}

export function buildBlockLayout(record: TranslatedBlockRecord): BlockLayout {
  const lineOffsets: number[][] = [];
  let cursor = 0;
  for (const line of record.lines) {
    const offsets: number[] = [];
    let i = 0;
    while (i < line.text.length) {
      const cp = line.text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      while (
        cursor < record.text.length &&
        !record.text.startsWith(ch, cursor)
      ) {
        cursor++;
      }
      const base =
        cursor < record.text.length
          ? cursor
          : Math.max(0, record.text.length - ch.length);
      for (let u = 0; u < ch.length; u++) offsets.push(base + u);
      if (cursor < record.text.length) cursor += ch.length;
      i += ch.length;
    }
    lineOffsets.push(offsets);
  }

  const sentenceRanges = buildSentenceRanges(record.text, record.translation);

  const spanPageRects = (start: number, end: number): PageRect[] => {
    if (end <= start) return [];
    const results: PageRect[] = [];
    for (let lineIdx = 0; lineIdx < record.lines.length; lineIdx++) {
      const line = record.lines[lineIdx];
      const offsets = lineOffsets[lineIdx];
      let from = -1,
        to = -1;
      for (let k = 0; k < offsets.length; k++) {
        if (offsets[k] >= start && offsets[k] < end) {
          if (from < 0) from = k;
          to = k + 1;
        }
      }
      while (from >= 0 && from < to && /\s/u.test(line.text[from])) from++;
      while (to > from && /\s/u.test(line.text[to - 1])) to--;
      if (from < 0 || from >= to) continue;
      const x1 = Math.max(
        0,
        Math.min(line.pageWidth, line.x + line.measurePrefix(from)),
      );
      const x2 = Math.max(
        0,
        Math.min(line.pageWidth, line.x + line.measurePrefix(to)),
      );
      if (x2 - x1 <= 0.05) continue;
      const hasFormula = /[\ue000-\uf8ff]/u.test(line.text.slice(from, to));
      const topAscent = hasFormula
        ? Math.min(Math.max(0.88, line.ascent), 1.35)
        : 0.88;
      const botDescent = hasFormula
        ? Math.min(Math.max(0.2, line.descent), 0.45)
        : 0.2;
      const y1 = Math.max(
        0,
        Math.min(line.pageHeight, line.baselineY - line.size * topAscent),
      );
      const y2 = Math.max(
        0,
        Math.min(line.pageHeight, line.baselineY + line.size * botDescent),
      );
      if (y2 - y1 <= 0.05) continue;
      results.push({
        page: line.page,
        rect: {
          x: x1 / line.pageWidth,
          y: y1 / line.pageHeight,
          width: (x2 - x1) / line.pageWidth,
          height: (y2 - y1) / line.pageHeight,
        },
      });
    }
    return results;
  };

  return { ...record, sentenceRanges, spanPageRects };
}

function resolveTranslationSpan(
  layout: BlockLayout,
  part: TranslationPart,
  fallbackQuote: string,
): TextSpan | null {
  const validIndexes = part.sentenceIndexes.filter(
    (i) => i >= 0 && i < layout.sentenceRanges.length,
  );
  const winStart = validIndexes.length
    ? Math.min(...validIndexes.map((i) => layout.sentenceRanges[i].start))
    : 0;
  const winEnd = validIndexes.length
    ? Math.max(...validIndexes.map((i) => layout.sentenceRanges[i].end))
    : layout.text.length;
  if (winEnd <= winStart) return null;
  if (part.wholeSentence) return { start: winStart, end: winEnd };

  const rawQuote = (
    part.recovered ? (part.matchedQuote ?? "") : part.quote || fallbackQuote
  ).trim();
  if (!rawQuote) {
    if (
      !part.recovered &&
      !/[\ue000-\uf8ff]/u.test(layout.text) &&
      part.start >= winStart &&
      part.end <= winEnd &&
      part.end > part.start
    ) {
      return { start: part.start, end: part.end };
    }
    return { start: winStart, end: winEnd };
  }

  const windowStr = layout.text.slice(winStart, winEnd);
  const direct = windowStr.indexOf(rawQuote);
  if (direct >= 0) {
    return {
      start: winStart + direct,
      end: winStart + direct + rawQuote.length,
    };
  }

  const normalizedWindow = normalizeWithOffsets(windowStr);
  for (const candidate of [
    rawQuote,
    exportFlowText(rawQuote, () => "\ufffc"),
  ]) {
    if (!candidate) continue;
    const needle = normalizeWithOffsets(candidate).text;
    if (!needle) continue;
    const pos = normalizedWindow.text.indexOf(needle);
    if (pos >= 0) {
      return {
        start: winStart + normalizedWindow.starts[pos],
        end: winStart + normalizedWindow.ends[pos + needle.length - 1],
      };
    }
  }

  return { start: winStart, end: winEnd };
}

function matchSourceSentencesByText(
  translation: TranslationBlock,
  sourceQuote: string,
): number[] {
  const needle = compact(sourceQuote);
  if (!needle || !translation.sentences.length) return [];
  const anchors = translation.sentences.map((s) => compact(sentenceAnchor(s)));
  const spans: TextSpan[] = [];
  let full = "";
  for (const a of anchors) {
    spans.push({ start: full.length, end: full.length + a.length });
    full += a;
  }
  const idx = full.indexOf(needle);
  if (idx >= 0) {
    const end = idx + needle.length;
    const matched: number[] = [];
    spans.forEach((s, i) => {
      if (Math.min(s.end, end) > Math.max(s.start, idx)) matched.push(i);
    });
    if (matched.length) return matched;
  }
  const overlapping: number[] = [];
  anchors.forEach((a, i) => {
    if (a && (a.includes(needle) || needle.includes(a))) overlapping.push(i);
  });
  return overlapping;
}

function contiguousRuns(indexes: number[]): Array<[number, number]> {
  const sorted = [...new Set(indexes)].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const idx of sorted) {
    const last = runs.at(-1);
    if (last && idx === last[1] + 1) last[1] = idx;
    else runs.push([idx, idx]);
  }
  return runs;
}

function quadDisplayRect(page: PDFPageProxy, quad: Quad): Rect {
  const viewport = page.getViewport({ scale: 1 });
  const points = [
    viewport.convertToViewportPoint(quad[0], quad[1]),
    viewport.convertToViewportPoint(quad[2], quad[3]),
    viewport.convertToViewportPoint(quad[4], quad[5]),
    viewport.convertToViewportPoint(quad[6], quad[7]),
  ];
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function sentenceOffset(translation: TranslationBlock, index: number): number {
  return translation.sentences
    .slice(0, index)
    .map((s) => compact(sentenceAnchor(s)))
    .join("").length;
}

function remapTOCItems(
  items: TOCItem[],
  anchors: BlockAnchorRecord[],
  layouts: Map<string, BlockLayout>,
  maxOutPage: number,
): TOCItem[] {
  const mapLocation = (loc: TOCItem["location"]): TOCItem["location"] => {
    if (loc.type !== "pdf" || !anchors.length) {
      return { type: "pdf", page: 1 };
    }
    const srcY = loc.y ?? 0;
    const samePage = anchors.filter((a) => a.sourcePage === loc.page);
    const pool = samePage.length ? samePage : anchors;
    let best = pool[0];
    let bestScore = Infinity;
    for (const candidate of pool) {
      const pagePenalty = Math.abs(candidate.sourcePage - loc.page) * 10;
      const yPenalty = Math.abs(candidate.sourceY - srcY);
      const score = pagePenalty + yPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return {
      type: "pdf",
      page: Math.max(1, Math.min(maxOutPage, best.outPage)),
      x: 0,
      y: best.outY,
    };
  };

  return items.map((item) => {
    let label = item.label;
    if (item.location.type === "pdf") {
      const srcPage = item.location.page;
      // Translate unmodified PDF heading labels when a matching paragraph_title was translated.
      const heading = [...layouts.values()].find(
        (l) =>
          l.sourcePage === srcPage &&
          (l.block.label === "paragraph_title" ||
            l.block.label === "doc_title") &&
          compact(l.block.text) === compact(item.originalLabel ?? item.label),
      );
      if (
        heading &&
        (!item.originalLabel || item.label === item.originalLabel)
      ) {
        label = heading.text.replace(/\s+/gu, " ").trim() || label;
      }
    }
    return {
      ...item,
      label,
      location: mapLocation(item.location),
      children: remapTOCItems(item.children, anchors, layouts, maxOutPage),
    };
  });
}

export async function applyTranslatedPDFAnnotations({
  getDocument,
  source,
  sourcePDF,
  bytes,
  translatedBlocks,
  figurePlacements,
  blockAnchors,
  annotations = [],
  answers = {},
  navigation,
  signal,
}: {
  getDocument: (params: DocumentInitParameters) => PDFDocumentLoadingTask;
  source: DocumentInitParameters;
  sourcePDF: PDFDocumentProxy;
  bytes: Uint8Array;
  blocks?: PDFBlock[];
  translations?: TranslationBlock[];
  translatedBlocks: TranslatedBlockRecord[];
  figurePlacements: FigurePlacementRecord[];
  blockAnchors: BlockAnchorRecord[];
  annotations?: Annotation[];
  answers?: Record<string, string>;
  navigation?: (pdf: PDFDocumentProxy) => Promise<TOCItem[]>;
  signal?: AbortSignal;
}): Promise<{
  bytes: Uint8Array;
  exported: number;
  skipped: number;
  navigationExported?: number;
}> {
  const marks = annotations.filter(
    (a) => a.kind !== "bookmark" && a.location.type === "pdf",
  );
  if (!marks.length && !navigation) {
    return { bytes, exported: 0, skipped: 0 };
  }

  const layouts = new Map<string, BlockLayout>();
  const layoutsBySourcePage = new Map<number, BlockLayout[]>();
  for (const record of translatedBlocks) {
    const built = buildBlockLayout(record);
    layouts.set(record.block.id, built);
    const list = layoutsBySourcePage.get(record.sourcePage) ?? [];
    list.push(built);
    layoutsBySourcePage.set(record.sourcePage, list);
  }
  const figuresById = new Map(figurePlacements.map((f) => [f.blockId, f]));
  const figuresBySourcePage = new Map<number, FigurePlacementRecord[]>();
  for (const fig of figurePlacements) {
    const list = figuresBySourcePage.get(fig.sourcePage) ?? [];
    list.push(fig);
    figuresBySourcePage.set(fig.sourcePage, list);
  }

  let outputBytes = bytes;
  let navigationExported: number | undefined;
  const { url: _url, data: _data, ...fontParams } = source;

  // Step 1: Write remapped PDF Outline / Bookmarks against the new translated PDF pages.
  if (navigation) {
    signal?.throwIfAborted();
    const rawItems = await navigation(sourcePDF);
    signal?.throwIfAborted();
    const count = (nodes: TOCItem[]): number =>
      nodes.reduce((n, item) => n + 1 + count(item.children), 0);
    navigationExported = count(rawItems);
    if (rawItems.length) {
      const navTask = getDocument({ ...fontParams, data: outputBytes.slice() });
      try {
        const navPDF = await navTask.promise;
        const remapped = remapTOCItems(
          rawItems,
          blockAnchors,
          layouts,
          navPDF.numPages,
        );
        outputBytes = await writePDFOutline(outputBytes, remapped, navPDF);
      } finally {
        await navTask.destroy().catch(() => {});
      }
    }
  }

  if (!marks.length) {
    return {
      bytes: outputBytes,
      exported: 0,
      skipped: 0,
      ...(navigationExported !== undefined ? { navigationExported } : {}),
    };
  }

  // Step 2: Resolve all translation-side and source-side annotations onto output pages.
  const outTask = getDocument({ ...fontParams, data: outputBytes.slice() });
  const abortOut = () => {
    void outTask.destroy().catch(() => {});
  };
  signal?.addEventListener("abort", abortOut, { once: true });

  try {
    const outPDF = await outTask.promise;
    signal?.throwIfAborted();

    const srcPageCache = new Map<number, Promise<PDFPageProxy>>();
    const getSrcPage = (p: number) => {
      let cached = srcPageCache.get(p);
      if (!cached) {
        cached = sourcePDF.getPage(p);
        srcPageCache.set(p, cached);
      }
      return cached;
    };
    const outPageCache = new Map<number, Promise<PDFPageProxy>>();
    const getOutPage = (p: number) => {
      let cached = outPageCache.get(p);
      if (!cached) {
        cached = outPDF.getPage(p);
        outPageCache.set(p, cached);
      }
      return cached;
    };

    const inSrcRange = (p: number) => p >= 1 && p <= sourcePDF.numPages;
    const inOutRange = (p: number) => p >= 1 && p <= outPDF.numPages;

    let exported = 0,
      skipped = 0;

    for (const annotation of marks) {
      signal?.throwIfAborted();
      const location = annotation.location as PDFLocation;
      const pages = new Map<number, Quad[]>();
      const addPageRects = async (items: PageRect[]) => {
        const byPage = new Map<number, Rect[]>();
        for (const item of items) {
          if (!inOutRange(item.page)) continue;
          const list = byPage.get(item.page) ?? [];
          list.push(item.rect);
          byPage.set(item.page, list);
        }
        for (const [pageNum, rects] of byPage) {
          const outPage = await getOutPage(pageNum);
          const quads = displayQuads(outPage, rects);
          if (quads.length) {
            pages.set(pageNum, [...(pages.get(pageNum) ?? []), ...quads]);
          }
        }
      };

      if (location.translation) {
        const mark = location.translation;
        const parts: TranslationPart[] = mark.ranges?.length
          ? mark.ranges
          : [{ ...mark, quote: annotation.quote }];
        for (const part of parts) {
          const layout = layouts.get(part.blockId);
          if (!layout || layout.translation.sourceHash !== part.sourceHash) {
            pages.clear();
            break;
          }
          const span = resolveTranslationSpan(
            layout,
            part,
            parts.length === 1 ? annotation.quote : "",
          );
          const pageRects = span
            ? layout.spanPageRects(span.start, span.end)
            : [];
          if (!pageRects.length) {
            pages.clear();
            break;
          }
          await addPageRects(pageRects);
        }
      } else if (location.sourceAnchors?.length) {
        for (const anchor of location.sourceAnchors) {
          const anchorNorm = compact(anchor.source);
          const candidates = (
            layoutsBySourcePage.get(anchor.page) ?? []
          ).filter((l) => compact(l.block.text).includes(anchorNorm));
          const layout =
            layouts.get(anchor.blockId) ??
            (candidates.length === 1 ? candidates[0] : undefined);
          if (!layout) {
            pages.clear();
            break;
          }
          const indexes = matchSourceSentencesByText(
            layout.translation,
            anchor.source,
          );
          const pageRects = contiguousRuns(indexes).flatMap(([from, to]) =>
            layout.spanPageRects(
              layout.sentenceRanges[from].start,
              layout.sentenceRanges[to].end,
            ),
          );
          if (!pageRects.length) {
            pages.clear();
            break;
          }
          await addPageRects(pageRects);
        }
      } else if (location.sentenceLink?.parts?.length) {
        for (const part of location.sentenceLink.parts) {
          const layout = layouts.get(part.blockId);
          if (
            !layout ||
            layout.translation.sourceHash !== part.sourceHash ||
            !layout.sentenceRanges[part.sentenceIndex]
          ) {
            pages.clear();
            break;
          }
          const range = layout.sentenceRanges[part.sentenceIndex];
          const pageRects = layout.spanPageRects(range.start, range.end);
          if (!pageRects.length) {
            pages.clear();
            break;
          }
          await addPageRects(pageRects);
        }
      } else if (inSrcRange(location.page) && location.rects?.length) {
        const srcPage = await getSrcPage(location.page);
        const srcViewport = srcPage.getViewport({ scale: 1 });
        const srcRectsPts = location.rects.map((norm) => ({
          norm,
          pts: {
            x: norm.x * srcViewport.width,
            y: norm.y * srcViewport.height,
            width: norm.width * srcViewport.width,
            height: norm.height * srcViewport.height,
          },
        }));

        const pageLayouts = layoutsBySourcePage.get(location.page) ?? [];
        const touchedLayouts = pageLayouts.filter((l) => {
          const boxPts = {
            x: l.sourceBounds.x * srcViewport.width,
            y: l.sourceBounds.y * srcViewport.height,
            width: l.sourceBounds.width * srcViewport.width,
            height: l.sourceBounds.height * srcViewport.height,
          };
          return srcRectsPts.some((item) => overlaps(item.pts, boxPts));
        });

        for (const layout of touchedLayouts) {
          const boxPts = {
            x: layout.sourceBounds.x * srcViewport.width,
            y: layout.sourceBounds.y * srcViewport.height,
            width: layout.sourceBounds.width * srcViewport.width,
            height: layout.sourceBounds.height * srcViewport.height,
          };
          const overlappingPts = srcRectsPts
            .filter((item) => overlaps(item.pts, boxPts))
            .map((item) => item.pts);
          const matched: number[] = [];
          for (let i = 0; i < layout.translation.sentences.length; i++) {
            const sQuads = await sentenceQuads(
              srcPage,
              layout.sourceBounds,
              [sentenceAnchor(layout.translation.sentences[i])],
              sentenceOffset(layout.translation, i),
            );
            const hit = sQuads.some((q) => {
              const sq = quadDisplayRect(srcPage, q);
              return overlappingPts.some((rp) => {
                const vOverlap =
                  Math.min(rp.y + rp.height, sq.y + sq.height) -
                  Math.max(rp.y, sq.y);
                const hOverlap =
                  Math.min(rp.x + rp.width, sq.x + sq.width) -
                  Math.max(rp.x, sq.x);
                return (
                  vOverlap >
                    Math.max(0.5, Math.min(rp.height, sq.height) * 0.35) &&
                  hOverlap > 0.5
                );
              });
            });
            if (hit) matched.push(i);
          }
          if (!matched.length) {
            matched.push(
              ...matchSourceSentencesByText(
                layout.translation,
                location.quote || annotation.quote,
              ),
            );
          }
          if (!matched.length && layout.sentenceRanges.length) {
            const minY = Math.min(...overlappingPts.map((r) => r.y));
            const maxY = Math.max(...overlappingPts.map((r) => r.y + r.height));
            const count = layout.sentenceRanges.length;
            const fromRatio = Math.max(
              0,
              Math.min(0.999, (minY - boxPts.y) / Math.max(1, boxPts.height)),
            );
            const toRatio = Math.max(
              fromRatio,
              Math.min(0.999, (maxY - boxPts.y) / Math.max(1, boxPts.height)),
            );
            for (
              let idx = Math.floor(fromRatio * count);
              idx <= Math.floor(toRatio * count);
              idx++
            ) {
              matched.push(idx);
            }
          }
          const pageRects = contiguousRuns(matched).flatMap(([from, to]) =>
            layout.spanPageRects(
              layout.sentenceRanges[from].start,
              layout.sentenceRanges[to].end,
            ),
          );
          await addPageRects(pageRects);
        }

        // Also map source annotations placed onto figures, tables, charts, or equations.
        const pageFigures = figuresBySourcePage.get(location.page) ?? [];
        for (const fig of pageFigures) {
          const figPts = {
            x: fig.sourceBounds.x * srcViewport.width,
            y: fig.sourceBounds.y * srcViewport.height,
            width: fig.sourceBounds.width * srcViewport.width,
            height: fig.sourceBounds.height * srcViewport.height,
          };
          const mappedRects: PageRect[] = [];
          for (const item of srcRectsPts) {
            if (!overlaps(item.pts, figPts)) continue;
            const ix1 = Math.max(figPts.x, item.pts.x);
            const iy1 = Math.max(figPts.y, item.pts.y);
            const ix2 = Math.min(
              figPts.x + figPts.width,
              item.pts.x + item.pts.width,
            );
            const iy2 = Math.min(
              figPts.y + figPts.height,
              item.pts.y + item.pts.height,
            );
            if (ix2 <= ix1 || iy2 <= iy1) continue;
            const rx = (ix1 - figPts.x) / Math.max(1, figPts.width);
            const ry = (iy1 - figPts.y) / Math.max(1, figPts.height);
            const rw = (ix2 - ix1) / Math.max(1, figPts.width);
            const rh = (iy2 - iy1) / Math.max(1, figPts.height);
            mappedRects.push({
              page: fig.outPage,
              rect: {
                x: fig.outRect.x + rx * fig.outRect.width,
                y: fig.outRect.y + ry * fig.outRect.height,
                width: rw * fig.outRect.width,
                height: rh * fig.outRect.height,
              },
            });
          }
          if (mappedRects.length) await addPageRects(mappedRects);
        }
        void figuresById;
      }

      if (!pages.size) {
        skipped++;
        continue;
      }

      let comment = commentText(annotation, answers[annotation.answerId ?? ""]);
      for (const [pageNum, quads] of [...pages].sort((a, b) => a[0] - b[0])) {
        outPDF.annotationStorage.setValue(
          `${editorPrefix}${annotation.id}-${pageNum}`,
          editorValue(annotation, pageNum - 1, quads, comment),
        );
        comment = "";
      }
      exported++;
    }

    if (exported > 0) {
      signal?.throwIfAborted();
      outputBytes = await outPDF.saveDocument();
    }

    return {
      bytes: outputBytes,
      exported,
      skipped,
      ...(navigationExported !== undefined ? { navigationExported } : {}),
    };
  } finally {
    signal?.removeEventListener("abort", abortOut);
    await outTask.destroy().catch(() => {});
  }
}
