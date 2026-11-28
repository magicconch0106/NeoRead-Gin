import type { PDFBlock } from "@neoread/core";

const FIGURE_PANEL_LABELS = new Set(["image", "chart", "figure"]);
const EMPTY_GRAPHICAL_LABELS = new Set([
  "vision_footnote",
  "figure_title",
  "figure_caption",
]);
const DROP_WHEN_EMPTY_LABELS = new Set([
  "reference",
  "reference_content",
  "header",
  "footer",
  "number",
  "text",
  "paragraph_title",
  "doc_title",
  "abstract",
  "footnote",
  "aside_text",
]);

function isCompositeCandidate(block: PDFBlock): boolean {
  if (FIGURE_PANEL_LABELS.has(block.label)) return true;
  return (
    !block.image &&
    !block.text.trim() &&
    EMPTY_GRAPHICAL_LABELS.has(block.label)
  );
}

function verticalOverlapRatio(a: PDFBlock["bounds"], b: PDFBlock["bounds"]) {
  const overlap =
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const minH = Math.min(a.height, b.height);
  return minH > 0 ? overlap / minH : 0;
}

function unionBounds(items: PDFBlock[]): PDFBlock["bounds"] {
  const pad = 0.003;
  const x1 = Math.max(0, Math.min(...items.map((b) => b.bounds.x)) - pad);
  const y1 = Math.max(0, Math.min(...items.map((b) => b.bounds.y)) - pad);
  const x2 = Math.min(
    1,
    Math.max(...items.map((b) => b.bounds.x + b.bounds.width)) + pad,
  );
  const y2 = Math.min(
    1,
    Math.max(...items.map((b) => b.bounds.y + b.bounds.height)) + pad,
  );
  return {
    x: x1,
    y: y1,
    width: Math.max(0.01, x2 - x1),
    height: Math.max(0.01, y2 - y1),
  };
}

/**
 * Keeps original PDF figures intact:
 * 1. Drops empty text/reference blocks that have neither image nor text.
 * 2. Merges multi-panel side-by-side figures and rasterized empty-text panel
 *    labels on the same page into one unified original-PDF figure region so
 *    2x2 / 3x2 subfigure grids keep their original layout and panel titles.
 * 3. Promotes isolated empty-text graphical blocks to PDF crop images instead
 *    of rendering stuck "正在翻译中…" placeholders.
 */
export function mergeCompositeFigureBlocks(blocks: PDFBlock[]): PDFBlock[] {
  const result: PDFBlock[] = [];
  let i = 0;
  while (i < blocks.length) {
    const current = blocks[i];
    if (
      !current.image &&
      !current.text.trim() &&
      DROP_WHEN_EMPTY_LABELS.has(current.label)
    ) {
      i++;
      continue;
    }

    if (!isCompositeCandidate(current)) {
      result.push(current);
      i++;
      continue;
    }

    const run: PDFBlock[] = [current];
    let j = i + 1;
    while (
      j < blocks.length &&
      blocks[j].page === current.page &&
      isCompositeCandidate(blocks[j])
    ) {
      run.push(blocks[j]);
      j++;
    }

    const hasRealFigure = run.some((b) => FIGURE_PANEL_LABELS.has(b.label));
    const hasEmptySubLabel = run.some((b) => !b.image && !b.text.trim());
    let hasSideBySide = false;
    for (let a = 0; a < run.length && !hasSideBySide; a++) {
      for (let b = a + 1; b < run.length; b++) {
        if (verticalOverlapRatio(run[a].bounds, run[b].bounds) > 0.25) {
          hasSideBySide = true;
          break;
        }
      }
    }

    if (
      run.length >= 2 &&
      hasRealFigure &&
      (hasEmptySubLabel || hasSideBySide) &&
      run.every((b) => !b.caption?.trim())
    ) {
      const first = run[0];
      result.push({
        id: `${first.id}:composite`,
        page: first.page,
        label: "image",
        text: "",
        bounds: unionBounds(run),
      });
    } else {
      for (const item of run) {
        if (!item.image && !item.text.trim()) {
          result.push({ ...item, label: "image" });
        } else {
          result.push(item);
        }
      }
    }
    i = j;
  }
  return result;
}

/**
 * Prevents leading `* ` or `11. ` in academic footnotes from being parsed by
 * CommonMark as bulleted or indented lists (`• . Wang:`).
 */
export function escapeFootnoteMarkdown(text: string, label?: string): string {
  if (!text) return text;
  if (
    label === "footnote" ||
    label === "vision_footnote" ||
    label === "aside_text" ||
    /^\*\s+\./.test(text)
  ) {
    return text
      .replace(/^(\s*)\*(\s+)/, "$1\\*$2")
      .replace(/^(\s*\d+)\.(\s+)/, "$1\\.$2");
  }
  return text;
}
