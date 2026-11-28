import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import type { Annotation, PDFBlock, TranslationBlock } from "@neoread/core";
import { translatedPDF, type ExportCanvas } from "./pdf-export";
import { embedExportFonts, type FontBytes } from "./pdf-fonts";
import { preparePDFText } from "./pdf-math";

const require = createRequire(new URL("../../package.json", import.meta.url));
const processorRequire = createRequire(
  new URL("../../../processor/package.json", import.meta.url),
);
const { createCanvas } = processorRequire("@napi-rs/canvas") as {
  createCanvas(
    width: number,
    height: number,
  ): {
    width: number;
    height: number;
    getContext(type: "2d"): unknown;
    toDataURL(type?: string): string;
  };
};
const fontBytes: Promise<FontBytes> = Promise.all([
  readFile(
    new URL(
      "../../public/pdf-assets/export-fonts/NotoSansSC-Regular.ttf",
      import.meta.url,
    ),
  ),
  readFile(
    require.resolve("pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf"),
  ),
]).then(([cjk, latin]) => ({ cjk, latin }));

function canvas(width: number, height: number): ExportCanvas {
  const c = createCanvas(width, height);
  return {
    canvas: c as unknown as HTMLCanvasElement,
    context: c.getContext("2d") as unknown as CanvasRenderingContext2D,
    dispose: () => {
      c.width = c.height = 1;
    },
  };
}

function translation(
  block: PDFBlock,
  target = "我们将译文按单栏连续排版，彻底不带英文原文。",
): TranslationBlock {
  return {
    blockId: block.id,
    status: "complete",
    sourceHash: createHash("sha256")
      .update(`zh-CN:v1:${block.text.trim()}`)
      .digest("hex"),
    sentences: [{ source: block.text, target }],
  };
}

async function fixture() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 500]);
  page.drawText("Original paragraph on the left.", {
    x: 30,
    y: 450,
    size: 10,
    font,
  });
  page.drawText("Second line of source text.", {
    x: 30,
    y: 436,
    size: 10,
    font,
  });
  page.drawText("Right column stays here.", { x: 220, y: 450, size: 10, font });
  page.drawRectangle({
    x: 30,
    y: 250,
    width: 100,
    height: 80,
    color: rgb(0.1, 0.5, 0.8),
  });
  page.drawText("E = mc2", { x: 220, y: 300, font, size: 15 });
  page.drawText("[1] Untranslated English reference entry.", {
    x: 30,
    y: 80,
    font,
    size: 9,
  });
  const blocks: PDFBlock[] = [
    {
      id: "left",
      page: 1,
      label: "text",
      bounds: { x: 30 / 400, y: 40 / 500, width: 165 / 400, height: 30 / 500 },
      text: "Original paragraph on the left. Second line of source text.",
    },
    {
      id: "right",
      page: 1,
      label: "text",
      bounds: { x: 220 / 400, y: 40 / 500, width: 150 / 400, height: 30 / 500 },
      text: "Right column stays here.",
    },
    {
      id: "figure",
      page: 1,
      label: "image",
      bounds: { x: 30 / 400, y: 170 / 500, width: 100 / 400, height: 80 / 500 },
      text: "",
      image: "figure.png",
    },
    {
      id: "formula",
      page: 1,
      label: "display_formula",
      bounds: {
        x: 220 / 400,
        y: 185 / 500,
        width: 100 / 400,
        height: 25 / 500,
      },
      text: "E = mc2",
    },
    {
      id: "ref-1",
      page: 1,
      label: "reference_content",
      bounds: { x: 30 / 400, y: 410 / 500, width: 300 / 400, height: 20 / 500 },
      text: "[1] Untranslated English reference entry.",
    },
  ];
  return {
    doc,
    page,
    blocks,
    translations: [
      translation(blocks[0], "左侧第一段中文译文。"),
      translation(blocks[1], "右侧第二段中文译文。"),
      {
        blockId: "formula",
        status: "complete" as const,
        sourceHash: "formula-hash",
        sentences: [],
        formulaMarkdown: "$$E = mc^2$$",
      },
    ],
  };
}

async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  signal?: AbortSignal,
) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return translatedPDF(
    pdfjs.getDocument,
    { data: await f.doc.save(), useSystemFonts: true },
    f.blocks,
    f.translations,
    await fontBytes,
    { signal, createCanvas: canvas },
  );
}

it("exports a pure single-column Chinese PDF with figures and formulas and zero English source text", async () => {
  const f = await fixture();
  const original = await f.doc.save();
  const result = await run(f);
  expect(result.translated).toBe(3);
  expect(result.issues).toEqual([]);
  expect(await f.doc.save()).toEqual(original);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width).toBeCloseTo(595.28, 1);
    expect(viewport.height).toBeCloseTo(841.89, 1);

    const content = await page.getTextContent();
    const extracted = content.items
      .map((i) => ("str" in i ? i.str : ""))
      .join("");
    expect(extracted).toContain("左侧第一段中文译文。");
    expect(extracted).toContain("右侧第二段中文译文。");
    // Original English paragraphs and bibliography must NOT exist anywhere in the output PDF.
    expect(extracted).not.toContain("Original paragraph");
    expect(extracted).not.toContain("Right column stays here");
    expect(extracted).not.toContain("Untranslated English reference");

    // Verify both Chinese glyph rendering and cropped figure pixels on the output page.
    const surface = canvas(
      Math.ceil(viewport.width),
      Math.ceil(viewport.height),
    );
    await page.render({
      canvas: surface.canvas,
      canvasContext: surface.context,
      viewport,
    }).promise;
    const pixels = surface.context.getImageData(
      0,
      0,
      surface.canvas.width,
      surface.canvas.height,
    ).data;
    let blueFigurePixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (
        Math.abs(pixels[i] - 26) <= 8 &&
        Math.abs(pixels[i + 1] - 128) <= 8 &&
        Math.abs(pixels[i + 2] - 204) <= 8
      ) {
        blueFigurePixels++;
      }
    }
    expect(blueFigurePixels).toBeGreaterThan(2000);
    surface.dispose();
  } finally {
    await task.destroy();
  }
});

it("flows very long translations, display math and unsupported glyphs across pages without reverting to English", async () => {
  const f = await fixture();
  f.translations[0].sentences[0].target =
    "这是一段非常长的中文译文内容。".repeat(180);
  f.translations[1].sentences[0].target =
    "包含嵌入式公式 $$x^2 + y^2 = z^2$$ 与特殊符号🦄的译文段落。";
  const result = await run(f);
  expect(result.translated).toBe(3);
  expect(result.issues).toEqual([]);
  expect(result.pages).toBeGreaterThanOrEqual(2);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    const allText: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const p = await pdf.getPage(i);
      const tc = await p.getTextContent();
      allText.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(""));
    }
    const joined = allText.join("\n");
    expect(joined).toContain("这是一段非常长的中文译文内容。");
    expect(joined).toContain("包含嵌入式公式");
    expect(joined).toContain("与特殊符号");
    expect(joined).not.toContain("Original paragraph");
    expect(joined).not.toContain("Right column");
  } finally {
    await task.destroy();
  }
});

it("omits untranslated or stale blocks without falling back to English source text", async () => {
  const f = await fixture();
  f.translations[0].status = "running";
  f.translations[1].sourceHash = "stale-hash";
  // Formula is still complete, so export succeeds with only the formula + figure.
  const result = await run(f);
  expect(result.translated).toBe(1);
  expect(result.issues).toEqual([
    { page: 1, blockId: "left", reason: "untranslated" },
    { page: 1, blockId: "right", reason: "stale" },
  ]);

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    const tc = await (await pdf.getPage(1)).getTextContent();
    const text = tc.items.map((it) => ("str" in it ? it.str : "")).join("");
    expect(text).not.toContain("Original paragraph");
    expect(text).not.toContain("Right column");
  } finally {
    await task.destroy();
  }
});

it("releases the rendering surface and loading task on cancellation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let disposed = 0;
  await expect(
    translatedPDF(
      pdfjs.getDocument,
      { data: await f.doc.save(), useSystemFonts: true },
      f.blocks,
      f.translations,
      await fontBytes,
      {
        signal: controller.signal,
        createCanvas: (w, h) => {
          const result = canvas(w, h);
          controller.abort();
          return {
            ...result,
            dispose: () => {
              disposed++;
              result.dispose();
            },
          };
        },
      },
    ),
  ).rejects.toThrow();
  expect(disposed).toBe(1);
});

it("exports the bundled 15-page paper as a pure Chinese single-column PDF without English paragraphs or references", async () => {
  const base = new URL(
    "../../../server/internal/neoread/example-paper/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    await readFile(new URL("analysis/manifest.json", base), "utf8"),
  );
  const paper = JSON.parse(await readFile(new URL("paper.json", base), "utf8"));
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const result = await translatedPDF(
    pdfjs.getDocument,
    {
      data: new Uint8Array(await readFile(new URL("paper.pdf", base))),
      useSystemFonts: true,
    },
    manifest.blocks,
    paper.translations,
    await fontBytes,
    { createCanvas: canvas },
  );
  expect(result.issues).toEqual([]);
  expect(result.translated).toBe(122);
  expect(result.pages).toBeGreaterThanOrEqual(8);

  const loading = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const output = await loading.promise;
    const pageTexts: string[] = [];
    for (let p = 1; p <= output.numPages; p++) {
      const page = await output.getPage(p);
      pageTexts.push(
        (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str : ""))
          .join(""),
      );
    }
    const fullText = pageTexts.join("\n");
    for (const sentence of [
      "注意力就是一切",
      "循环模型通常按照",
      "顺序计算这一根本限制依然存在",
      "最常用的两种注意力函数",
      "其中，投影参数矩阵为",
    ]) {
      expect(fullText).toContain(sentence);
    }
    expect(fullText).not.toMatch(/[\ue000-\uf8ff]/u);
    // Original English prose and bibliography must be absent.
    expect(fullText).not.toContain(
      "The dominant sequence transduction models are based on complex recurrent",
    );
    expect(fullText).not.toContain(
      "Neural machine translation by jointly learning",
    );
  } finally {
    await loading.destroy();
  }
});

it("does not produce an empty translation PDF and honours cancellation", async () => {
  const f = await fixture();
  f.translations = [];
  await expect(run(f)).rejects.toMatchObject({
    reason: "no_translated_blocks",
  });
  const controller = new AbortController();
  controller.abort();
  await expect(run(f, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
});

it("renders inline formula paths above the baseline with subscripts below it", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const content = preparePDFText(
    "$h_{t-1}$",
    await embedExportFonts(doc, await fontBytes),
  )!;
  content.draw(page, content.text, 30, 100, 30);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({
    data: await doc.save(),
    useSystemFonts: true,
  });
  const surface = canvas(200, 200);
  try {
    const pdf = await loading.promise;
    const rendered = await pdf.getPage(1);
    await rendered.render({
      canvas: surface.canvas,
      canvasContext: surface.context,
      viewport: rendered.getViewport({ scale: 1 }),
    }).promise;
    const ink = (x: number, y: number, width: number, height: number) => {
      const pixels = surface.context.getImageData(x, y, width, height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 160) count++;
      return count;
    };
    expect(
      ink(30, 75, 18, 24),
      "missing or inverted base glyph",
    ).toBeGreaterThan(40);
    expect(
      ink(48, 101, 40, 8),
      "missing or misplaced subscript",
    ).toBeGreaterThan(10);
  } finally {
    surface.dispose();
    await loading.destroy();
  }
});

it("renders curved parentheses within their glyph bounds without spikes", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const content = preparePDFText(
    "$( $",
    await embedExportFonts(doc, await fontBytes),
  )!;
  content.draw(page, content.text, 30, 100, 60);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdfjs.getDocument({
    data: await doc.save(),
    useSystemFonts: true,
  });
  const surface = canvas(200, 200);
  try {
    const pdf = await loading.promise;
    const rendered = await pdf.getPage(1);
    await rendered.render({
      canvas: surface.canvas,
      canvasContext: surface.context,
      viewport: rendered.getViewport({ scale: 1 }),
    }).promise;
    const pixels = surface.context.getImageData(0, 0, 200, 200).data;
    let ink = 0,
      escaped = 0;
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 200; x++) {
        if (pixels[(y * 200 + x) * 4] >= 160) continue;
        ink++;
        if (x < 35 || x > 51 || y < 54 || y > 116) escaped++;
      }
    expect(ink).toBeGreaterThan(150);
    expect(
      escaped,
      "curve control points must not produce spikes beyond the glyph outline",
    ).toBe(0);
  } finally {
    surface.dispose();
    await loading.destroy();
  }
});

it.each(["pdf_decode", "font_embed"] as const)(
  "classifies real %s failures at the engine boundary",
  async (reason) => {
    const f = await fixture();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    await expect(
      translatedPDF(
        pdfjs.getDocument,
        {
          data:
            reason === "pdf_decode"
              ? new Uint8Array([1, 2, 3])
              : await f.doc.save(),
          useSystemFonts: true,
        },
        f.blocks,
        f.translations,
        reason === "font_embed"
          ? { cjk: new Uint8Array([1]), latin: new Uint8Array([1]) }
          : await fontBytes,
        { createCanvas: canvas },
      ),
    ).rejects.toMatchObject({ reason });
  },
);

it("preserves translation-side phrase highlights, underlines, Q&A comments, source marks and remapped outline", async () => {
  const f = await fixture();
  f.translations[0] = {
    blockId: "left",
    status: "complete",
    sourceHash: createHash("sha256")
      .update(`zh-CN:v1:${f.blocks[0].text.trim()}`)
      .digest("hex"),
    sentences: [
      { source: "Original paragraph on the left.", target: "左侧第一句译文。" },
      { source: "Second line of source text.", target: "第二句重点结论在此。" },
    ],
  };
  const leftHash = f.translations[0].sourceHash;
  const rightHash = f.translations[1].sourceHash;

  const annotations: Annotation[] = [
    {
      id: "phrase-note",
      documentId: "doc",
      kind: "note",
      quote: "重点结论",
      note: "核心结论批注",
      color: "#facc15",
      createdAt: "2026-11-27T02:00:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "left",
          sourceHash: leftHash,
          sentenceIndexes: [1],
          start: 11,
          end: 15,
          ranges: [
            {
              blockId: "left",
              sourceHash: leftHash,
              sentenceIndexes: [1],
              start: 11,
              end: 15,
              quote: "重点结论",
            },
          ],
        },
      },
    },
    {
      id: "trans-underline",
      documentId: "doc",
      kind: "underline",
      quote: "第二段中文译文。",
      note: "",
      color: "#3b82f6",
      createdAt: "2026-11-27T02:01:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "right",
          sourceHash: rightHash,
          sentenceIndexes: [0],
          start: 2,
          end: 10,
          ranges: [
            {
              blockId: "right",
              sourceHash: rightHash,
              sentenceIndexes: [0],
              start: 2,
              end: 10,
              quote: "第二段中文译文。",
            },
          ],
        },
      },
    },
    {
      id: "src-first-sentence-question",
      documentId: "doc",
      kind: "question",
      quote: "Original paragraph on the left.",
      note: "第一句是什么意思？",
      answerId: "ans-1",
      color: "#22c55e",
      createdAt: "2026-11-27T02:02:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        quote: "Original paragraph on the left.",
        rects: [
          { x: 30 / 400, y: 40 / 500, width: 120 / 400, height: 12 / 500 },
        ],
      },
    },
    {
      id: "src-figure-note",
      documentId: "doc",
      kind: "note",
      quote: "",
      note: "架构图说明",
      color: "#ef4444",
      createdAt: "2026-11-27T02:03:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        rects: [
          { x: 40 / 400, y: 180 / 500, width: 80 / 400, height: 40 / 500 },
        ],
      },
    },
    {
      id: "stale-mark",
      documentId: "doc",
      kind: "highlight",
      quote: "旧译文",
      note: "",
      color: "#facc15",
      createdAt: "2026-11-27T02:04:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "left",
          sourceHash: "stale-hash",
          sentenceIndexes: [0],
          start: 0,
          end: 3,
        },
      },
    },
  ];

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const result = await translatedPDF(
    pdfjs.getDocument,
    { data: await f.doc.save(), useSystemFonts: true },
    f.blocks,
    f.translations,
    await fontBytes,
    {
      createCanvas: canvas,
      annotations,
      answers: { "ans-1": "介绍研究背景。" },
      navigation: async () => [
        {
          id: "sec-1",
          label: "第一章 导言",
          location: { type: "pdf", page: 1, x: 0.075, y: 0.08 },
          children: [],
        },
      ],
    },
  );
  expect(result).toMatchObject({
    translated: 3,
    annotationsExported: 4,
    annotationsSkipped: 1,
    navigationExported: 1,
  });

  const task = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    const outline = await pdf.getOutline();
    expect(outline?.map((o) => o.title)).toEqual(["第一章 导言"]);

    const page = await pdf.getPage(1);
    const annots = (await page.getAnnotations()).filter(
      (a) => a.subtype !== "Popup",
    );
    expect(annots).toHaveLength(4);

    const noteAnnot = annots.find(
      (a) => a.contentsObj?.str === "核心结论批注",
    )!;
    expect(noteAnnot.subtype).toBe("Highlight");
    // "重点结论" is 4 chars (~42 pt wide) inside sentence 2, well after "左侧第一句译文。 第二句" (x > 150).
    expect(noteAnnot.rect[0]).toBeGreaterThan(150);
    expect(noteAnnot.rect[2] - noteAnnot.rect[0]).toBeLessThan(55);

    const underlineAnnot = annots.find(
      (a) => Array.from(a.color).join() === "59,130,246",
    )!;
    expect(underlineAnnot.opacity).toBe(1);
    expect(underlineAnnot.rect[3] - underlineAnnot.rect[1]).toBeCloseTo(1.5, 1);

    const questionAnnot = annots.find((a) =>
      a.contentsObj?.str?.includes("问题：第一句是什么意思？"),
    )!;
    expect(questionAnnot.contentsObj.str).toBe(
      "问题：第一句是什么意思？\n\n回答：介绍研究背景。",
    );
    // First sentence starts at the left margin (x ≈ 56 pt).
    expect(questionAnnot.rect[0]).toBeCloseTo(56, 0);

    const figAnnot = annots.find((a) => a.contentsObj?.str === "架构图说明")!;
    expect(figAnnot).toBeTruthy();
  } finally {
    await task.destroy();
  }
});

it("handles rotated source pages when cropping figures and extracting captions", async () => {
  const f = await fixture();
  const rotated = f.doc.addPage([500, 400]);
  rotated.setRotation(degrees(90));
  rotated.drawText("A rotated page", {
    x: 50,
    y: 30,
    size: 10,
    rotate: degrees(90),
  });
  const block: PDFBlock = {
    id: "rotated",
    page: 2,
    label: "text",
    text: "A rotated page",
    bounds: { x: 30 / 400, y: 40 / 500, width: 150 / 400, height: 30 / 500 },
  };
  f.blocks.push(block);
  f.translations.push(translation(block, "旋转源页面的中文译文。"));
  const result = await run(f);
  expect(result.translated).toBe(4);
});

it("exports bilingual paragraph-by-paragraph PDF with source above translation and anchors source marks onto English text", async () => {
  const f = await fixture();
  f.translations[0] = {
    blockId: "left",
    status: "complete",
    sourceHash: createHash("sha256")
      .update(`zh-CN:v1:${f.blocks[0].text.trim()}`)
      .digest("hex"),
    sentences: [
      { source: "Original paragraph on the left.", target: "左侧第一句译文。" },
      { source: "Second line of source text.", target: "第二句译文。" },
    ],
  };
  const leftHash = f.translations[0].sourceHash;
  const annotations: Annotation[] = [
    {
      id: "en-phrase",
      documentId: "doc",
      kind: "highlight",
      quote: "Original paragraph",
      note: "英文句高亮",
      color: "#22c55e",
      createdAt: "2026-11-27T03:00:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        quote: "Original paragraph",
        sourceAnchors: [
          {
            blockId: "left",
            source: "Original paragraph on the left.",
            page: 1,
            bounds: f.blocks[0].bounds,
          },
        ],
      },
    },
    {
      id: "zh-phrase",
      documentId: "doc",
      kind: "note",
      quote: "第二句译文。",
      note: "中文句批注",
      color: "#facc15",
      createdAt: "2026-11-27T03:01:00.000Z",
      location: {
        type: "pdf",
        page: 1,
        translation: {
          blockId: "left",
          sourceHash: leftHash,
          sentenceIndexes: [1],
          start: 8,
          end: 14,
          ranges: [
            {
              blockId: "left",
              sourceHash: leftHash,
              sentenceIndexes: [1],
              start: 8,
              end: 14,
              quote: "第二句译文。",
            },
          ],
        },
      },
    },
  ];

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const result = await translatedPDF(
    pdfjs.getDocument,
    { data: await f.doc.save(), useSystemFonts: true },
    f.blocks,
    f.translations,
    await fontBytes,
    {
      createCanvas: canvas,
      layout: "bilingual",
      annotations,
    },
  );
  expect(result.translated).toBe(3);
  expect(result.annotationsExported).toBe(2);

  const task = pdfjs.getDocument({
    data: result.bytes.slice(),
    useSystemFonts: true,
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const extracted = content.items
      .map((i) => ("str" in i ? i.str : ""))
      .join("");
    // Both English source paragraphs, Chinese translations, and bibliography appear in order.
    const enIdx = extracted.indexOf("Original paragraph on the left.");
    const zhIdx = extracted.indexOf("左侧第一句译文。");
    expect(enIdx).toBeGreaterThanOrEqual(0);
    expect(zhIdx).toBeGreaterThan(enIdx);
    expect(extracted).toContain("Right column stays here.");
    expect(extracted).toContain("右侧第二段中文译文。");
    expect(extracted).toContain("Untranslated English reference entry.");

    const annots = (await page.getAnnotations()).filter(
      (a) => a.subtype !== "Popup",
    );
    expect(annots).toHaveLength(2);
    const enAnnot = annots.find((a) => a.contentsObj?.str === "英文句高亮")!;
    const zhAnnot = annots.find((a) => a.contentsObj?.str === "中文句批注")!;
    // In PDF bottom-up coordinates, the English paragraph above has a larger Y than the Chinese paragraph below!
    expect(enAnnot.rect[1]).toBeGreaterThan(zhAnnot.rect[1]);
  } finally {
    await task.destroy();
  }
});
