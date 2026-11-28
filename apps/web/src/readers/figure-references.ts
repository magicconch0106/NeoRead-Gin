import type { PDFBlock } from "@neoread/core";

const number = String.raw`(?:[A-Za-z]\.\d+(?:\.\d+)*|[Ss]?\d+(?:\.\d+)*|[零〇一二三四五六七八九十百两]+)`;
const pattern = new RegExp(
  String.raw`(?:\bfig(?:ure)?\.?\s*|图\s*)(?:\[\s*(${number})\s*\]|［\s*(${number})\s*］|(${number}))(?:\s*\([a-z]\)|[a-z])?(?![\w.]*\d|[a-z])`,
  "gi",
);
const tablePattern = new RegExp(
  String.raw`(?:\btable\.?\s*|表\s*)(?:\[\s*(${number})\s*\]|［\s*(${number})\s*］|(${number}))(?:\s*\([a-z]\)|[a-z])?(?![\w.]*\d|[a-z])`,
  "gi",
);
function normalize(value: string) {
  if (/^[a-z]\.\d/i.test(value) || /^[s\d]/i.test(value))
    return value.toLowerCase().replace(/^0+(?=\d)/, "");
  const digits = "零一二三四五六七八九";
  let total = 0,
    digit = 0;
  for (const char of value.replaceAll("〇", "零").replaceAll("两", "二")) {
    if (char === "十" || char === "百") {
      total += (digit || 1) * (char === "十" ? 10 : 100);
      digit = 0;
    } else digit = digits.indexOf(char);
  }
  return String(total + digit);
}
export function figureReferences(text: string) {
  return Array.from(text.matchAll(pattern), (match) => ({
    index: match.index,
    text: match[0],
    label: normalize(match[1] ?? match[2] ?? match[3]),
  }));
}
export function tableReferences(text: string) {
  return Array.from(text.matchAll(tablePattern), (match) => ({
    index: match.index,
    text: match[0],
    label: normalize(match[1] ?? match[2] ?? match[3]),
  }));
}
const isFigure = (block: PDFBlock) =>
  ["image", "chart", "figure"].includes(block.label);
const isTable = (block: PDFBlock) => block.label === "table";

/** Only captions establish figure numbers; mentions in body text are not targets. */
export function figureTarget(blocks: PDFBlock[], label: string) {
  const matches = (value: string) => {
    // Strip only explicit title prefixes, not arbitrary text before a mention.
    const title = value
      .trim()
      .replace(/^(?:supplement(?:ary|al)|appendix)\s+/i, "");
    const first = figureReferences(title)[0];
    return first?.index === 0 && first.label === normalize(label);
  };
  const direct = blocks.filter(
    (block) => isFigure(block) && matches(block.caption || block.text),
  );
  if (direct.length) return direct.length === 1 ? direct[0] : undefined;
  let captions = blocks.filter(
    (block) =>
      ["figure_title", "figure_caption", "caption"].includes(block.label) &&
      matches(block.text),
  );
  if (!captions.length) {
    // Multi-panel figure pages sometimes classify the bottom "Figure 2: ..." note as "text".
    captions = blocks.filter(
      (block) =>
        block.label === "text" &&
        /^(?:appendix\s+)?(?:fig(?:ure)?\.?|图)\s*(?:[A-Za-z]\.\d+|\d+)\s*[:：.]/i.test(
          block.text.trim(),
        ) &&
        matches(block.text) &&
        blocks.some((other) => isFigure(other) && other.page === block.page),
    );
  }
  if (captions.length !== 1) return;
  const caption = captions[0];
  const candidates = blocks
    .filter((block) => {
      if (!isFigure(block) || block.page !== caption.page) return false;
      const a = block.bounds,
        b = caption.bounds;
      return Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x);
    })
    .map((block) => ({
      block,
      distance: Math.min(
        Math.abs(block.bounds.y + block.bounds.height - caption.bounds.y),
        Math.abs(caption.bounds.y + caption.bounds.height - block.bounds.y),
      ),
    }))
    .filter(({ distance }) => distance < 0.15)
    .sort((a, b) => a.distance - b.distance);
  if (candidates.length === 1) return candidates[0].block;
  if (
    candidates.length > 1 &&
    Math.abs(candidates[0].distance - candidates[1].distance) >= 0.005
  ) {
    return candidates[0].block;
  }
  // On multi-panel figure pages where several subfigures sit above a full-page Figure N caption,
  // jump to the topmost figure on that page when no other Figure M caption exists on the page.
  const otherFigureCaptions = blocks.filter(
    (b) =>
      b.page === caption.page &&
      b.id !== caption.id &&
      ["figure_title", "figure_caption", "caption"].includes(b.label) &&
      figureReferences(b.text.trim())[0]?.index === 0,
  );
  if (!otherFigureCaptions.length) {
    const pageFigures = blocks
      .filter((b) => isFigure(b) && b.page === caption.page)
      .sort((a, b) => a.bounds.y - b.bounds.y);
    if (pageFigures.length > 1) return pageFigures[0];
  }
}

export function tableTarget(blocks: PDFBlock[], label: string) {
  const matches = (value: string) => {
    const title = value
      .trim()
      .replace(/^(?:supplement(?:ary|al)|appendix)\s+/i, "");
    const first = tableReferences(title)[0];
    return first?.index === 0 && first.label === normalize(label);
  };
  const direct = blocks.filter(
    (block) => isTable(block) && matches(block.caption || block.text),
  );
  if (direct.length) return direct.length === 1 ? direct[0] : undefined;
  let captions = blocks.filter(
    (block) =>
      [
        "table_title",
        "table_caption",
        "figure_title",
        "figure_caption",
        "caption",
      ].includes(block.label) && matches(block.text),
  );
  if (!captions.length) {
    captions = blocks.filter(
      (block) =>
        ["paragraph_title", "text"].includes(block.label) &&
        /^(?:appendix\s+|supplement(?:ary|al)\s+)?(?:table\.?|表)\s*(?:[A-Za-z]\.\d+|[Ss]?\d+)\s*[:：.—–-]/i.test(
          block.text.trim(),
        ) &&
        matches(block.text) &&
        blocks.some((other) => isTable(other) && other.page === block.page),
    );
  }
  if (captions.length !== 1) return;
  const caption = captions[0];
  const samePageTables = blocks
    .filter((b) => {
      if (!isTable(b) || b.page !== caption.page) return false;
      if (b.caption && tableReferences(b.caption.trim()).length > 0)
        return false;
      return true;
    })
    .sort((a, b) => {
      const dist = (item: PDFBlock) =>
        Math.min(
          Math.abs(item.bounds.y - (caption.bounds.y + caption.bounds.height)),
          Math.abs(caption.bounds.y - (item.bounds.y + item.bounds.height)),
        );
      return dist(a) - dist(b);
    });
  return samePageTables[0] ?? caption;
}

export interface FigureOrTablePreviewRegion {
  target: PDFBlock;
  page: number;
  bounds: PDFBlock["bounds"];
  title: string;
  captionText?: string;
}

function unionPaddedBounds(
  items: PDFBlock[],
  pad = 0.008,
): PDFBlock["bounds"] {
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
    width: Math.max(0.02, x2 - x1),
    height: Math.max(0.02, y2 - y1),
  };
}

function displayRefLabel(label: string): string {
  return normalize(label).toUpperCase();
}

function findMatchingFigureCaption(
  blocks: PDFBlock[],
  page: number,
  label: string,
): PDFBlock | undefined {
  const norm = normalize(label);
  return blocks.find((b) => {
    if (b.page !== page) return false;
    const raw = (b.caption || b.text || "").trim();
    if (!raw) return false;
    const stripped = raw.replace(/^(?:supplement(?:ary|al)|appendix)\s+/i, "");
    const ref = figureReferences(stripped)[0];
    return ref?.index === 0 && ref.label === norm;
  });
}

function findMatchingTableCaption(
  blocks: PDFBlock[],
  page: number,
  label: string,
): PDFBlock | undefined {
  const norm = normalize(label);
  return blocks.find((b) => {
    if (b.page !== page) return false;
    const raw = (b.caption || b.text || "").trim();
    if (!raw) return false;
    const stripped = raw.replace(/^(?:supplement(?:ary|al)|appendix)\s+/i, "");
    const ref = tableReferences(stripped)[0];
    return ref?.index === 0 && ref.label === norm;
  });
}

/**
 * Computes the complete bounding region (all sub-panels + figure caption + notes)
 * so floating preview windows show the entire original figure cleanly.
 */
export function figurePreviewRegion(
  blocks: PDFBlock[],
  label: string,
): FigureOrTablePreviewRegion | undefined {
  const target = figureTarget(blocks, label);
  if (!target) return undefined;
  const page = target.page;
  const norm = normalize(label);
  const captionBlock = findMatchingFigureCaption(blocks, page, label);

  const hasOtherFigureOrTable = blocks.some((b) => {
    if (b.page !== page) return false;
    const raw = (b.caption || b.text || "")
      .trim()
      .replace(/^(?:supplement(?:ary|al)|appendix)\s+/i, "");
    if (!raw) return false;
    const fRef = figureReferences(raw)[0];
    if (fRef?.index === 0 && fRef.label !== norm) return true;
    const tRef = tableReferences(raw)[0];
    if (tRef?.index === 0) return true;
    return isTable(b);
  });

  const regionItems = new Set<PDFBlock>([target]);
  if (captionBlock) regionItems.add(captionBlock);

  if (!hasOtherFigureOrTable) {
    const pageVisuals = blocks.filter(
      (b) =>
        b.page === page &&
        (isFigure(b) ||
          ["figure_title", "figure_caption", "caption", "vision_footnote"].includes(
            b.label,
          )),
    );
    for (const item of pageVisuals) regionItems.add(item);
  } else {
    // Mixed page: include adjacent panel titles or Note. footnotes in the same column.
    const anchorItems = [...regionItems];
    const minX = Math.min(...anchorItems.map((b) => b.bounds.x));
    const maxX = Math.max(...anchorItems.map((b) => b.bounds.x + b.bounds.width));
    const maxY = Math.max(...anchorItems.map((b) => b.bounds.y + b.bounds.height));
    for (const b of blocks) {
      if (
        b.page === page &&
        ["vision_footnote", "figure_title", "figure_caption"].includes(b.label) &&
        Math.min(maxX, b.bounds.x + b.bounds.width) > Math.max(minX, b.bounds.x) &&
        b.bounds.y >= maxY - 0.01 &&
        b.bounds.y - maxY <= 0.045 &&
        /^(?:note|notes|source|sources|注)\b/i.test(b.text.trim())
      ) {
        regionItems.add(b);
      }
    }
  }

  return {
    target,
    page,
    bounds: unionPaddedBounds([...regionItems]),
    title: `图 ${displayRefLabel(label)} · 第 ${page} 页`,
    captionText: (captionBlock?.caption || captionBlock?.text || target.caption || "").trim() || undefined,
  };
}

/**
 * Computes the complete bounding region (table title + table body + table notes)
 * for floating table preview windows.
 */
export function tablePreviewRegion(
  blocks: PDFBlock[],
  label: string,
): FigureOrTablePreviewRegion | undefined {
  const target = tableTarget(blocks, label);
  if (!target) return undefined;
  const page = target.page;
  const captionBlock = findMatchingTableCaption(blocks, page, label);
  const regionItems = new Set<PDFBlock>([target]);
  if (captionBlock) regionItems.add(captionBlock);

  const bottomY = Math.max(
    ...[...regionItems].map((b) => b.bounds.y + b.bounds.height),
  );
  const minX = Math.min(...[...regionItems].map((b) => b.bounds.x));
  const maxX = Math.max(
    ...[...regionItems].map((b) => b.bounds.x + b.bounds.width),
  );

  for (const b of blocks) {
    if (b.page !== page || regionItems.has(b)) continue;
    if (["header", "footer", "number"].includes(b.label)) continue;
    const horizOverlap =
      Math.min(maxX, b.bounds.x + b.bounds.width) > Math.max(minX, b.bounds.x);
    if (!horizOverlap) continue;
    if (
      b.bounds.y >= bottomY - 0.01 &&
      b.bounds.y - bottomY <= 0.04 &&
      (b.label === "vision_footnote" ||
        /^(?:note|notes|source|sources|注)[:：.\s]/i.test(b.text.trim()))
    ) {
      regionItems.add(b);
    }
  }

  return {
    target,
    page,
    bounds: unionPaddedBounds([...regionItems]),
    title: `表 ${displayRefLabel(label)} · 第 ${page} 页`,
    captionText: (captionBlock?.caption || captionBlock?.text || target.caption || "").trim() || undefined,
  };
}
