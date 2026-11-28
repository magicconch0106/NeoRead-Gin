import type { Annotation, TranslationBlock } from "@neoread/core";

export function textRange(
  root: HTMLElement,
  start: number,
  end: number,
): Range | undefined {
  if (start < 0 || end <= start) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0,
    first: { node: Text; offset: number } | undefined;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const size = node.textContent?.length ?? 0;
    if (!first && start < offset + size)
      first = { node: node as Text, offset: start - offset };
    if (first && end <= offset + size) {
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(node, end - offset);
      return range;
    }
    offset += size;
  }
}

// Source hashes prevent old marks from being attached to unrelated regenerated text.
export function translatedAnnotationRanges(
  host: HTMLElement,
  annotations: Annotation[],
  translations: TranslationBlock[],
) {
  const result: { annotation: Annotation; range: Range }[] = [];
  for (const annotation of annotations) {
    const mark = annotation.location.translation;
    if (!mark) continue;
    for (const part of mark.ranges ?? [{ ...mark, quote: annotation.quote }]) {
      if (
        !translations.some(
          (t) =>
            t.blockId === part.blockId &&
            t.sourceHash === part.sourceHash &&
            t.status === "complete",
        )
      )
        continue;
      const blockNode = Array.from(
        host.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find((n) => n.dataset.translationBlock === part.blockId);
      if (!blockNode) continue;
      const node =
        blockNode.querySelector<HTMLElement>(".translation-sentences") ??
        blockNode;
      if (part.recovered) {
        const range = recoveredAnnotationRange(
          node,
          part.sentenceIndexes,
          part.wholeSentence ? "" : part.matchedQuote || "",
        );
        if (range) result.push({ annotation, range });
        continue;
      }
      const range = textRange(node, part.start, part.end);
      if (range?.toString().trim() === part.quote.trim())
        result.push({ annotation, range });
    }
  }
  return result;
}

/** Matches source-side annotations against interleaved original paragraphs. */
export function interleavedSourceAnnotationRanges(
  host: HTMLElement,
  annotations: Annotation[],
) {
  const result: { annotation: Annotation; range: Range }[] = [];
  const blockNodes = Array.from(
    host.querySelectorAll<HTMLElement>("[data-translation-block]"),
  );
  if (!blockNodes.some((n) => n.querySelector("[data-interleaved-source]")))
    return result;

  const findPhraseRange = (
    root: HTMLElement,
    quote: string,
  ): Range | undefined => {
    const trimmed = quote.trim();
    if (!trimmed) return;
    const full = root.textContent ?? "";
    const direct = full.indexOf(trimmed);
    if (direct >= 0) return textRange(root, direct, direct + trimmed.length);
    const normalize = (value: string) => {
      let text = "";
      const offsets: number[] = [];
      for (let i = 0; i < value.length; i++) {
        if (/[\s\u00ad]/u.test(value[i])) continue;
        text += value[i].toLowerCase();
        offsets.push(i);
      }
      return { text, offsets };
    };
    const normFull = normalize(full);
    const normNeedle = normalize(trimmed).text;
    if (!normNeedle) return;
    const pos = normFull.text.indexOf(normNeedle);
    if (pos >= 0) {
      return textRange(
        root,
        normFull.offsets[pos],
        normFull.offsets[pos + normNeedle.length - 1] + 1,
      );
    }
  };

  for (const annotation of annotations) {
    if (annotation.location.translation || annotation.kind === "bookmark")
      continue;
    if (annotation.location.type === "pdf") {
      const anchors = annotation.location.sourceAnchors;
      if (anchors?.length) {
        for (const anchor of anchors) {
          const blockNode = blockNodes.find(
            (n) => n.dataset.translationBlock === anchor.blockId,
          );
          const srcRoot = blockNode?.querySelector<HTMLElement>(
            "[data-interleaved-source]",
          );
          if (!srcRoot) continue;
          const range =
            findPhraseRange(srcRoot, annotation.quote) ??
            findPhraseRange(srcRoot, anchor.source);
          if (range) result.push({ annotation, range });
        }
        continue;
      }
      const quote = (
        annotation.quote ||
        annotation.location.quote ||
        ""
      ).trim();
      if (!quote) continue;
      for (const blockNode of blockNodes) {
        const srcRoot = blockNode.querySelector<HTMLElement>(
          "[data-interleaved-source]",
        );
        if (!srcRoot) continue;
        const range = findPhraseRange(srcRoot, quote);
        if (range) {
          result.push({ annotation, range });
          break;
        }
      }
    } else if (annotation.location.type === "epub") {
      const quote = (
        annotation.quote ||
        annotation.location.quote ||
        ""
      ).trim();
      if (!quote) continue;
      const epubBlockId = annotation.location.blockId;
      const candidates = epubBlockId
        ? blockNodes.filter((n) => n.dataset.translationBlock === epubBlockId)
        : blockNodes;
      for (const blockNode of candidates) {
        const srcRoot = blockNode.querySelector<HTMLElement>(
          "[data-interleaved-source]",
        );
        if (!srcRoot) continue;
        const range = findPhraseRange(srcRoot, quote);
        if (range) {
          result.push({ annotation, range });
          break;
        }
      }
    }
  }
  return result;
}

export function paintTranslatedAnnotations(
  host: HTMLElement,
  annotations: Annotation[],
  translations: TranslationBlock[],
) {
  const api = (
    globalThis.CSS as unknown as
      { highlights?: Map<string, unknown> } | undefined
  )?.highlights;
  const Highlight = (
    globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (!api || !Highlight) return;
  const ranges = [
    ...translatedAnnotationRanges(host, annotations, translations),
    ...interleavedSourceAnnotationRanges(host, annotations),
  ];
  api.set(
    "neoread-translation-marks",
    new Highlight(
      ...ranges
        .filter((r) => r.annotation.kind !== "underline")
        .map((r) => r.range),
    ),
  );
  api.set(
    "neoread-translation-underlines",
    new Highlight(
      ...ranges
        .filter((r) => r.annotation.kind === "underline")
        .map((r) => r.range),
    ),
  );
  return () => {
    api.delete("neoread-translation-marks");
    api.delete("neoread-translation-underlines");
  };
}

// Recovery has already selected and persisted the sentence window on the
// server. Drawing only resolves that window in the current formatted DOM.
function recoveredAnnotationRange(
  root: HTMLElement,
  indexes: number[],
  quote: string,
): Range | undefined {
  const sentences = indexes.map((i) =>
    root.querySelector<HTMLElement>(`[data-sentence="${i}"]`),
  );
  if (!sentences.length || sentences.some((node) => !node)) return;
  const range = document.createRange();
  range.setStart(sentences[0]!, 0);
  const last = sentences.at(-1)!;
  range.setEnd(last, last.childNodes.length);
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const base = before.toString().length;
  const text = range.toString();
  const whole = () => textRange(root, base, base + text.length);
  if (!quote) return whole();
  let start = text.indexOf(quote);
  if (start >= 0)
    return textRange(root, base + start, base + start + quote.length);
  const normalize = (value: string) => {
    let text = "";
    const offsets: number[] = [];
    for (let i = 0; i < value.length; i++) {
      if (/\s/u.test(value[i])) continue;
      const code = value.charCodeAt(i);
      text +=
        code >= 0xff01 && code <= 0xff5e
          ? String.fromCharCode(code - 0xfee0)
          : value[i];
      offsets.push(i);
    }
    return { text, offsets };
  };
  const normalized = normalize(text),
    needle = normalize(quote).text;
  start = needle ? normalized.text.indexOf(needle) : -1;
  if (start >= 0)
    return textRange(
      root,
      base + normalized.offsets[start],
      base + normalized.offsets[start + needle.length - 1] + 1,
    );
  // Markdown/KaTeX can change the visible character stream. The persisted
  // source-aligned sentence remains the safe fallback for a missing phrase.
  return whole();
}
