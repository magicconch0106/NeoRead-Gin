import { expect, it } from "vitest";
import type { PDFBlock } from "@neoread/core";
import {
  figurePreviewRegion,
  figureReferences,
  figureTarget,
  tablePreviewRegion,
  tableReferences,
  tableTarget,
} from "./figure-references";
const block = (
  id: string,
  label: string,
  text: string,
  x = 0.1,
  y = 0.1,
): PDFBlock => ({
  id,
  label,
  text,
  page: 1,
  bounds: { x, y, width: 0.3, height: 0.2 },
});
it("recognizes English, bracketed, Chinese, supplementary, appendix and subfigure references", () => {
  expect(
    figureReferences(
      "如图三，Figure 3, figure[12], Fig. 2(a), 图十二、Figure S1、Figure A.9、图 A.9、Figure 2.1。",
    ).map((r) => r.label),
  ).toEqual(["3", "3", "12", "2", "12", "s1", "a.9", "a.9", "2.1"]);
  expect(figureReferences("[3] configuration 4 Figure 12word")).toEqual([]);
});
it("recognizes and resolves English, Chinese and appendix table references", () => {
  expect(
    tableReferences(
      "见表 1、Table 2、Appendix Table A.27 和表 A.27。",
    ).map((r) => r.label),
  ).toEqual(["1", "2", "a.27", "a.27"]);
  const tbl1 = {
    ...block("tbl1", "table", ""),
    caption: "Table 1: Summary Statistics",
  };
  const tblA27 = block(
    "tblA27",
    "table_title",
    "Appendix Table A.27: Robustness Checks",
    0.1,
    0.15,
  );
  const tblA27Body = block("tblA27-body", "table", "", 0.1, 0.22);
  expect(tableTarget([tbl1, tblA27, tblA27Body], "1")).toBe(tbl1);
  expect(tableTarget([tbl1, tblA27, tblA27Body], "a.27")).toBe(tblA27Body);

  const tblPageBlocks: PDFBlock[] = [
    block("t-cap", "figure_title", "Table 3: Naive evaluation", 0.2, 0.09),
    block("t-body", "table", "", 0.15, 0.12),
    block("t-note", "vision_footnote", "Note: Standard errors clustered.", 0.15, 0.33),
  ];
  const tblRegion = tablePreviewRegion(tblPageBlocks, "3")!;
  expect(tblRegion.title).toBe("表 3 · 第 1 页");
  expect(tblRegion.bounds.y).toBeLessThanOrEqual(0.09);
  expect(tblRegion.bounds.y + tblRegion.bounds.height).toBeGreaterThanOrEqual(
    0.53,
  );

  const figPageBlocks: PDFBlock[] = [
    block("f-a", "image", "", 0.2, 0.08),
    block("f-pa", "figure_title", "Panel A: Spatial distribution", 0.2, 0.3),
    block("f-b", "image", "", 0.2, 0.35),
    block("f-cap", "text", "Figure 2: Multi-panel results", 0.12, 0.6),
  ];
  const figRegion = figurePreviewRegion(figPageBlocks, "2")!;
  expect(figRegion.title).toBe("图 2 · 第 1 页");
  expect(figRegion.bounds.y).toBeLessThanOrEqual(0.08);
  expect(figRegion.bounds.y + figRegion.bounds.height).toBeGreaterThanOrEqual(
    0.8,
  );
});
it("resolves only caption identities and never selects a matching body paragraph", () => {
  const image = {
    ...block("image", "image", ""),
    caption: "Figure 3. Results",
  };
  const body = block("body", "text", "Figure 3 illustrates the result.");
  expect(figureTarget([body, image], "3")).toBe(image);
  expect(figureTarget([body, image], "1")).toBeUndefined();
  expect(
    figureTarget([body, image, { ...image, id: "duplicate" }], "3"),
  ).toBeUndefined();
});
it("associates a separate caption with the adjacent image in the same column", () => {
  const image = block("image", "chart", "");
  const other = block("other", "image", "", 0.6);
  const caption = block("caption", "figure_title", "图三 实验结果", 0.1, 0.31);
  expect(figureTarget([other, caption, image], "3")).toBe(image);
  expect(figureTarget([other, caption], "3")).toBeUndefined();
  expect(figureTarget([{ ...image, page: 2 }, caption], "3")).toBeUndefined();
});

it.each([
  "Supplementary Figure S1. Results",
  "supplementary Fig. S1. Results",
  "Supplemental Figure S1. Results",
  "  Supplementary\nFigure S1. Results  ",
])("resolves supplementary captions: %s", (caption) => {
  const image = { ...block("image", "image", ""), caption };
  expect(figureTarget([image], "s1")).toBe(image);
  expect(figureTarget([image], "1")).toBeUndefined();
  const separate = block("caption", "figure_title", caption, 0.1, 0.31);
  const uncaptioned = block("image", "image", "");
  expect(figureTarget([uncaptioned, separate], "s1")).toBe(uncaptioned);
});

it("rejects incidental supplementary mentions and ambiguous supplementary targets", () => {
  const image = {
    ...block("image", "image", ""),
    caption: "Results shown in Supplementary Figure S1.",
  };
  expect(figureTarget([image], "s1")).toBeUndefined();
  const target = { ...image, caption: "Supplementary Figure S1. Results" };
  expect(
    figureTarget([target, { ...target, id: "duplicate" }], "s1"),
  ).toBeUndefined();
});
