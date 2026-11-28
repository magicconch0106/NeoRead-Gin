import { selectionContext } from "../readers/selection-context";
import { epubSentenceLocation } from "./epub-links";
import type {
  PDFBlock,
  EPUBReadingBlock,
  PDFPassage,
  PDFSentenceLink,
  ReaderSelection,
  TranslationBlock,
  TranslationLocation,
} from "@neoread/core";
import { sentenceAnchor } from "@neoread/core";

export function translatedSelection(
  host: HTMLElement,
  range: Range,
  blocks: (PDFBlock | EPUBReadingBlock)[],
  translations: TranslationBlock[],
) {
  const ranges: NonNullable<TranslationLocation["ranges"]> = [];
  const passages: PDFPassage[] = [],
    links: PDFSentenceLink[] = [];
  for (const node of host.querySelectorAll<HTMLElement>(
    "[data-translation-block]",
  )) {
    if (!range.intersectsNode(node)) continue;
    const block = blocks.find((b) => b.id === node.dataset.translationBlock),
      translation = translations.find(
        (t) => t.blockId === block?.id && t.status === "complete",
      );
    if (!block || !translation) continue;
    const sentencesRoot =
      node.querySelector<HTMLElement>(".translation-sentences") ?? node;
    if (!range.intersectsNode(sentencesRoot)) continue;
    const clipped = document.createRange();
    clipped.selectNodeContents(sentencesRoot);
    if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
      clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
      clipped.setEnd(range.endContainer, range.endOffset);
    const quote = clipped.toString().trim();
    if (!quote) continue;
    const sentenceIndexes = Array.from(
      sentencesRoot.querySelectorAll<HTMLElement>("[data-sentence]"),
    )
      .filter((n) => {
        if (!clipped.intersectsNode(n)) return false;
        const part = document.createRange();
        part.selectNodeContents(n);
        if (clipped.compareBoundaryPoints(Range.START_TO_START, part) > 0)
          part.setStart(clipped.startContainer, clipped.startOffset);
        if (clipped.compareBoundaryPoints(Range.END_TO_END, part) < 0)
          part.setEnd(clipped.endContainer, clipped.endOffset);
        return !!part.toString().trim();
      })
      .map((n) => Number(n.dataset.sentence));
    if (!sentenceIndexes.length) continue;
    const before = clipped.cloneRange();
    before.selectNodeContents(sentencesRoot);
    before.setEnd(clipped.startContainer, clipped.startOffset);
    const start = before.toString().length;
    ranges.push({
      blockId: block.id,
      sourceHash: translation.sourceHash,
      sentenceIndexes,
      wholeSentence:
        quote ===
        sentenceIndexes
          .map(
            (i) =>
              node.querySelector(`[data-sentence="${i}"]`)?.textContent ?? "",
          )
          .join("")
          .trim(),
      sourceText: sentenceIndexes
        .map((i) => sentenceAnchor(translation.sentences[i]))
        .join(""),
      // Offsets are paragraph-relative: an earlier sentence can move this mark.
      targetText: translation.sentences
        .map((sentence) => sentence.target)
        .join(""),
      start,
      end: start + clipped.toString().length,
      quote,
      ...("location" in block
        ? {
            location: epubSentenceLocation(
              block,
              translation.sentences,
              sentenceIndexes,
            ),
          }
        : {}),
    });
    passages.push({
      blockId: block.id,
      sources: sentenceIndexes.map((i) =>
        sentenceAnchor(translation.sentences[i]),
      ),
      sourceOffset: translation.sentences
        .slice(0, sentenceIndexes[0])
        .map(sentenceAnchor)
        .join("")
        .toLowerCase()
        .replace(/[\s\u00ad]/g, "").length,
    });
    links.push({ blockId: block.id, sentenceIndexes });
  }
  if (!ranges.length) {
    return interleavedSourceSelection(host, range, blocks, translations);
  }
  const first = ranges[0],
    block = blocks.find((b) => b.id === first.blockId)!,
    rect = range.getBoundingClientRect();
  const selection: ReaderSelection = {
    context: selectionContext(range, host),
    text: range.toString().trim(),
    anchor: {
      x: (rect.left + rect.right) / 2,
      top: rect.top,
      bottom: rect.bottom,
    },
    location: {
      ...("location" in block
        ? first.location!
        : {
            type: "pdf" as const,
            page: block.page,
            quote: passages.flatMap((p) => p.sources).join(" "),
            rects: [block.bounds],
          }),
      translation: {
        blockId: first.blockId,
        sourceHash: first.sourceHash,
        sentenceIndexes: first.sentenceIndexes,
        start: first.start,
        end: first.end,
        ranges,
      },
    },
  };
  return { selection, passages, links };
}

function interleavedSourceSelection(
  host: HTMLElement,
  range: Range,
  blocks: (PDFBlock | EPUBReadingBlock)[],
  translations: TranslationBlock[],
) {
  const sourceAnchors: {
    blockId: string;
    source: string;
    page: number;
    bounds: { x: number; y: number; width: number; height: number };
  }[] = [];
  const passages: PDFPassage[] = [];
  let firstBlock: PDFBlock | EPUBReadingBlock | undefined;
  let firstEpubLocation: ReturnType<typeof epubSentenceLocation> | undefined;
  const quotes: string[] = [];

  for (const node of host.querySelectorAll<HTMLElement>(
    "[data-translation-block]",
  )) {
    const sourceRoot = node.querySelector<HTMLElement>(
      "[data-interleaved-source]",
    );
    if (!sourceRoot || !range.intersectsNode(sourceRoot)) continue;
    const block = blocks.find((b) => b.id === node.dataset.translationBlock);
    if (!block) continue;
    const clipped = document.createRange();
    clipped.selectNodeContents(sourceRoot);
    if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0)
      clipped.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0)
      clipped.setEnd(range.endContainer, range.endOffset);
    const quote = clipped.toString().trim();
    if (!quote) continue;
    if (!firstBlock) firstBlock = block;
    quotes.push(quote);

    const translation = translations.find(
      (t) => t.blockId === block.id && t.status === "complete",
    );
    const sentenceIndexes = Array.from(
      sourceRoot.querySelectorAll<HTMLElement>("[data-source-sentence]"),
    )
      .filter((n) => {
        if (!clipped.intersectsNode(n)) return false;
        const part = document.createRange();
        part.selectNodeContents(n);
        if (clipped.compareBoundaryPoints(Range.START_TO_START, part) > 0)
          part.setStart(clipped.startContainer, clipped.startOffset);
        if (clipped.compareBoundaryPoints(Range.END_TO_END, part) < 0)
          part.setEnd(clipped.endContainer, clipped.endOffset);
        return !!part.toString().trim();
      })
      .map((n) => Number(n.dataset.sourceSentence));

    if ("location" in block) {
      if (!firstEpubLocation) {
        firstEpubLocation =
          translation && sentenceIndexes.length
            ? epubSentenceLocation(
                block,
                translation.sentences,
                sentenceIndexes,
              )
            : { ...block.location, quote };
      }
    } else {
      const sources =
        translation && sentenceIndexes.length
          ? sentenceIndexes.map((i) => sentenceAnchor(translation.sentences[i]))
          : [quote];
      for (const source of sources) {
        sourceAnchors.push({
          blockId: block.id,
          source,
          page: block.page,
          bounds: block.bounds,
        });
      }
      passages.push({ blockId: block.id, sources });
    }
  }

  if (!firstBlock || !quotes.length) return;
  const fullQuote = quotes.join(" ").trim();
  const rect = range.getBoundingClientRect();
  const selection: ReaderSelection = {
    context: selectionContext(range, host),
    text: fullQuote,
    anchor: {
      x: (rect.left + rect.right) / 2,
      top: rect.top,
      bottom: rect.bottom,
    },
    location:
      "location" in firstBlock
        ? (firstEpubLocation ?? { ...firstBlock.location, quote: fullQuote })
        : {
            type: "pdf" as const,
            page: firstBlock.page,
            quote: fullQuote,
            rects: [firstBlock.bounds],
            ...(sourceAnchors.length ? { sourceAnchors } : {}),
          },
  };
  return { selection, passages, links: [] as PDFSentenceLink[] };
}
