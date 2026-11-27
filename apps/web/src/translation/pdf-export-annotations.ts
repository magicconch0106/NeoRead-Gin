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
import { exportText } from "./pdf-content";
import { overlaps, type Rect } from "./pdf-layout";

export type TranslatedLineRecord = {
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
  page: number;
  pageWidth: number;
  pageHeight: number;
  block: PDFBlock;
  box: Rect;
  mask: Rect;
  translation: TranslationBlock;
  text: string;
  lines: TranslatedLineRecord[];
};

type TextSpan = { start: number; end: number };
type TranslationPart = NonNullable<TranslationLocation["ranges"]>[number];

type BlockLayout = TranslatedBlockRecord & {
  sentenceRanges: TextSpan[];
  spanRects: (start: number, end: number) => Rect[];
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
      exportText(sentence.target.trim(), () => "\ufffc") ??
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

  const spanRects = (start: number, end: number): Rect[] => {
    if (end <= start) return [];
    const rects: Rect[] = [];
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
        Math.min(record.pageWidth, line.x + line.measurePrefix(from)),
      );
      const x2 = Math.max(
        0,
        Math.min(record.pageWidth, line.x + line.measurePrefix(to)),
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
        Math.min(record.pageHeight, line.baselineY - line.size * topAscent),
      );
      const y2 = Math.max(
        0,
        Math.min(record.pageHeight, line.baselineY + line.size * botDescent),
      );
      if (y2 - y1 <= 0.05) continue;
      rects.push({
        x: x1 / record.pageWidth,
        y: y1 / record.pageHeight,
        width: (x2 - x1) / record.pageWidth,
        height: (y2 - y1) / record.pageHeight,
      });
    }
    return rects;
  };

  return { ...record, sentenceRanges, spanRects };
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
    exportText(rawQuote, () => "\ufffc") ?? "",
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

  // Inline KaTeX DOM text may expand math symbols; fall back safely to the
  // persisted sentence window, matching the reader's own recovery behavior.
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

export async function applyTranslatedPDFAnnotations({
  getDocument,
  source,
  sourcePDF,
  bytes,
  blocks,
  translations,
  translatedBlocks,
  annotations = [],
  answers = {},
  navigation,
  signal,
}: {
  getDocument: (params: DocumentInitParameters) => PDFDocumentLoadingTask;
  source: DocumentInitParameters;
  sourcePDF: PDFDocumentProxy;
  bytes: Uint8Array;
  blocks: PDFBlock[];
  translations: TranslationBlock[];
  translatedBlocks: TranslatedBlockRecord[];
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
  let outputBytes = bytes;
  let navigationExported: number | undefined;
  if (navigation) {
    signal?.throwIfAborted();
    const items = await navigation(sourcePDF);
    signal?.throwIfAborted();
    const count = (nodes: TOCItem[]): number =>
      nodes.reduce((n, item) => n + 1 + count(item.children), 0);
    navigationExported = count(items);
    if (items.length) {
      outputBytes = await writePDFOutline(outputBytes, items, sourcePDF);
    }
  }

  const marks = annotations.filter(
    (a) => a.kind !== "bookmark" && a.location.type === "pdf",
  );
  if (!marks.length) {
    return {
      bytes: outputBytes,
      exported: 0,
      skipped: 0,
      ...(navigationExported !== undefined ? { navigationExported } : {}),
    };
  }

  const layouts = new Map<string, BlockLayout>();
  const layoutsByPage = new Map<number, BlockLayout[]>();
  for (const record of translatedBlocks) {
    const built = buildBlockLayout(record);
    layouts.set(record.block.id, built);
    const list = layoutsByPage.get(record.page) ?? [];
    list.push(built);
    layoutsByPage.set(record.page, list);
  }
  const blocksById = new Map(blocks.map((b) => [b.id, b]));
  for (const record of translatedBlocks)
    blocksById.set(record.block.id, record.block);
  const translationsById = new Map(translations.map((t) => [t.blockId, t]));

  const inRange = (page: number) => page >= 1 && page <= sourcePDF.numPages;
  const pageCache = new Map<number, Promise<PDFPageProxy>>();
  const getPage = (page: number) => {
    let cached = pageCache.get(page);
    if (!cached) {
      cached = sourcePDF.getPage(page);
      pageCache.set(page, cached);
    }
    return cached;
  };

  const resolved: Array<{
    key: string;
    value: ReturnType<typeof editorValue>;
  }> = [];
  let exported = 0,
    skipped = 0;

  for (const annotation of marks) {
    signal?.throwIfAborted();
    const location = annotation.location as PDFLocation;
    const pages = new Map<number, Quad[]>();
    const addQuads = (page: number, quads: Quad[]) => {
      if (!quads.length) return;
      pages.set(page, [...(pages.get(page) ?? []), ...quads]);
    };

    if (location.translation) {
      const mark = location.translation;
      const parts: TranslationPart[] = mark.ranges?.length
        ? mark.ranges
        : [{ ...mark, quote: annotation.quote }];
      for (const part of parts) {
        const layout = layouts.get(part.blockId);
        if (layout) {
          if (layout.translation.sourceHash !== part.sourceHash) {
            pages.clear();
            break;
          }
          const span = resolveTranslationSpan(
            layout,
            part,
            parts.length === 1 ? annotation.quote : "",
          );
          const rects = span ? layout.spanRects(span.start, span.end) : [];
          if (!rects.length) {
            pages.clear();
            break;
          }
          const page = await getPage(layout.page);
          addQuads(layout.page, displayQuads(page, rects));
          continue;
        }
        // Paragraph remained in original English; place on its matching source sentences.
        const block = blocksById.get(part.blockId);
        const translation = translationsById.get(part.blockId);
        if (
          !block ||
          !inRange(block.page) ||
          !translation ||
          translation.sourceHash !== part.sourceHash
        ) {
          pages.clear();
          break;
        }
        const sources = part.sentenceIndexes
          .map((i) => translation.sentences[i])
          .filter(Boolean)
          .map(sentenceAnchor);
        const fallbackSources = sources.length
          ? sources
          : part.sourceText
            ? [part.sourceText]
            : [];
        const page = await getPage(block.page);
        const quads = await sentenceQuads(
          page,
          block.bounds,
          fallbackSources,
          part.sentenceIndexes.length
            ? sentenceOffset(translation, part.sentenceIndexes[0])
            : 0,
        );
        if (!quads.length) {
          pages.clear();
          break;
        }
        addQuads(block.page, quads);
      }
    } else if (location.sourceAnchors?.length) {
      for (const anchor of location.sourceAnchors) {
        if (!inRange(anchor.page)) {
          pages.clear();
          break;
        }
        const anchorNorm = compact(anchor.source);
        const pageLayouts = layoutsByPage.get(anchor.page) ?? [];
        const candidates = pageLayouts.filter((l) =>
          compact(l.block.text).includes(anchorNorm),
        );
        const layout =
          layouts.get(anchor.blockId) ??
          (candidates.length === 1 ? candidates[0] : undefined);
        const page = await getPage(anchor.page);
        if (layout) {
          const indexes = matchSourceSentencesByText(
            layout.translation,
            anchor.source,
          );
          const rects = contiguousRuns(indexes).flatMap(([from, to]) =>
            layout.spanRects(
              layout.sentenceRanges[from].start,
              layout.sentenceRanges[to].end,
            ),
          );
          if (!rects.length) {
            pages.clear();
            break;
          }
          addQuads(layout.page, displayQuads(page, rects));
        } else {
          const quads = await sentenceQuads(page, anchor.bounds, [
            anchor.source,
          ]);
          if (!quads.length) {
            pages.clear();
            break;
          }
          addQuads(anchor.page, quads);
        }
      }
    } else if (location.sentenceLink?.parts?.length) {
      for (const part of location.sentenceLink.parts) {
        const layout = layouts.get(part.blockId);
        if (
          layout &&
          layout.translation.sourceHash === part.sourceHash &&
          layout.sentenceRanges[part.sentenceIndex]
        ) {
          const range = layout.sentenceRanges[part.sentenceIndex];
          const rects = layout.spanRects(range.start, range.end);
          if (!rects.length) {
            pages.clear();
            break;
          }
          const page = await getPage(layout.page);
          addQuads(layout.page, displayQuads(page, rects));
          continue;
        }
        const block = blocksById.get(part.blockId);
        if (!block || !inRange(block.page)) {
          pages.clear();
          break;
        }
        const page = await getPage(block.page);
        const quads = await sentenceQuads(
          page,
          block.bounds,
          [part.source],
          layout ? sentenceOffset(layout.translation, part.sentenceIndex) : 0,
        );
        if (!quads.length) {
          pages.clear();
          break;
        }
        addQuads(block.page, quads);
      }
    } else if (inRange(location.page) && location.rects?.length) {
      const page = await getPage(location.page);
      const viewport = page.getViewport({ scale: 1 });
      const pageLayouts = layoutsByPage.get(location.page) ?? [];
      const rectItems = location.rects.map((norm) => ({
        norm,
        pts: {
          x: norm.x * viewport.width,
          y: norm.y * viewport.height,
          width: norm.width * viewport.width,
          height: norm.height * viewport.height,
        },
      }));
      const touched = pageLayouts.filter((l) =>
        rectItems.some((item) => overlaps(item.pts, l.mask)),
      );
      if (!touched.length) {
        addQuads(location.page, displayQuads(page, location.rects));
      } else {
        const outsideNorms = rectItems
          .filter((item) => !touched.some((l) => overlaps(item.pts, l.mask)))
          .map((item) => item.norm);
        if (outsideNorms.length) {
          addQuads(location.page, displayQuads(page, outsideNorms));
        }
        for (const layout of touched) {
          const overlappingPts = rectItems
            .filter((item) => overlaps(item.pts, layout.mask))
            .map((item) => item.pts);
          const matched: number[] = [];
          for (let i = 0; i < layout.translation.sentences.length; i++) {
            const sQuads = await sentenceQuads(
              page,
              layout.block.bounds,
              [sentenceAnchor(layout.translation.sentences[i])],
              sentenceOffset(layout.translation, i),
            );
            const hit = sQuads.some((q) => {
              const sq = quadDisplayRect(page, q);
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
              Math.min(
                0.999,
                (minY - layout.box.y) / Math.max(1, layout.box.height),
              ),
            );
            const toRatio = Math.max(
              fromRatio,
              Math.min(
                0.999,
                (maxY - layout.box.y) / Math.max(1, layout.box.height),
              ),
            );
            for (
              let idx = Math.floor(fromRatio * count);
              idx <= Math.floor(toRatio * count);
              idx++
            ) {
              matched.push(idx);
            }
          }
          const rects = contiguousRuns(matched).flatMap(([from, to]) =>
            layout.spanRects(
              layout.sentenceRanges[from].start,
              layout.sentenceRanges[to].end,
            ),
          );
          addQuads(layout.page, displayQuads(page, rects));
        }
      }
    }

    if (!pages.size) {
      skipped++;
      continue;
    }

    let comment = commentText(annotation, answers[annotation.answerId ?? ""]);
    for (const [pageNum, quads] of [...pages].sort((a, b) => a[0] - b[0])) {
      resolved.push({
        key: `${editorPrefix}${annotation.id}-${pageNum}`,
        value: editorValue(annotation, pageNum - 1, quads, comment),
      });
      comment = "";
    }
    exported++;
  }

  if (resolved.length) {
    signal?.throwIfAborted();
    const { url: _url, data: _data, ...fontParams } = source;
    const outTask = getDocument({ ...fontParams, data: outputBytes.slice() });
    const abortOut = () => {
      void outTask.destroy().catch(() => {});
    };
    signal?.addEventListener("abort", abortOut, { once: true });
    try {
      const outPDF = await outTask.promise;
      signal?.throwIfAborted();
      for (const entry of resolved) {
        outPDF.annotationStorage.setValue(entry.key, entry.value);
      }
      outputBytes = await outPDF.saveDocument();
    } finally {
      signal?.removeEventListener("abort", abortOut);
      await outTask.destroy().catch(() => {});
    }
  }

  return {
    bytes: outputBytes,
    exported,
    skipped,
    ...(navigationExported !== undefined ? { navigationExported } : {}),
  };
}
