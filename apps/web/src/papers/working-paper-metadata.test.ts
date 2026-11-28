import { expect, it } from "vitest";
import type { PDFBlock } from "@neoread/core";
import { paper } from "./fixtures";
import {
  buildWorkingPaperPatch,
  extractWorkingPaperMetadata,
  isMangledCreators,
  isPreprintVenueOrDOI,
  splitAuthorStringToCreators,
} from "./working-paper-metadata";

const block = (
  id: string,
  page: number,
  label: string,
  text: string,
): PDFBlock => ({
  id,
  page,
  label,
  text,
  bounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
});

it("extracts space-separated LaTeX working paper authors, exact date, affiliation and preprint venue", () => {
  const blocks: PDFBlock[] = [
    block(
      "p1-b1",
      1,
      "doc_title",
      "Policy Experimentation in China: The Political Economy of Policy Learning",
    ),
    block("p1-b2", 1, "text", "Shaoda Wang David Y. Yang *"),
    block("p1-b3", 1, "text", "February 24, 2025"),
    block("p1-b4", 1, "paragraph_title", "Abstract"),
    block(
      "p1-b5",
      1,
      "abstract",
      "Many governments engage in policy experimentation in various forms to resolve uncertainty and facilitate learning.",
    ),
    block(
      "p1-b6",
      1,
      "footnote",
      "* . Wang: University of Chicago and NBER; shaoda@uchicago.edu . Yang: Harvard University, NBER, BREAD, and CIFAR; davidyang@fas.harvard.edu .",
    ),
  ];

  const extracted = extractWorkingPaperMetadata(blocks);
  expect(extracted).toMatchObject({
    title:
      "Policy Experimentation in China: The Political Economy of Policy Learning",
    creators: [
      { given: "Shaoda", family: "Wang" },
      { given: "David Y.", family: "Yang" },
    ],
    date: "2025-02-24",
    itemType: "preprint",
    venue: "Working Paper",
  });
  expect(extracted.affiliation).toContain("University of Chicago");
  expect(extracted.affiliation).toContain("Harvard University");
});

it("extracts stacked Author Information cover pages and falls back to PDF CreationDate while ignoring footnote Accessed dates", () => {
  const stackedBlocks: PDFBlock[] = [
    block(
      "p1-b1",
      1,
      "doc_title",
      "Recommendation Auctions, Information Disclosure, and Consumer Welfare",
    ),
    block("p1-b2", 1, "text", "Author Information"),
    block("p1-b3", 1, "paragraph_title", "Mingrui Gao"),
    block(
      "p1-b4",
      1,
      "text",
      "School of Digital Economics and Management, Nanjing University Email: 602023740003@smail.nju.edu.cn",
    ),
    block("p1-b5", 1, "paragraph_title", "Huixin Wang"),
    block("p1-b6", 1, "paragraph_title", "Jing Fang"),
    block("p1-b7", 1, "paragraph_title", "Dazhong Wang"),
    block("p1-b9", 1, "paragraph_title", "Corresponding author"),
    block(
      "p2-b3",
      2,
      "footnote",
      "1 Accessed July 9, 2025 at https://example.com.",
    ),
  ];

  const extracted = extractWorkingPaperMetadata(stackedBlocks, {
    CreationDate: "D:20261105205458+08'00'",
  });
  expect(extracted.creators).toEqual([
    { given: "Mingrui", family: "Gao" },
    { given: "Huixin", family: "Wang" },
    { given: "Jing", family: "Fang" },
    { given: "Dazhong", family: "Wang" },
  ]);
  expect(extracted.date).toBe("2026-11-05");
  expect(extracted.itemType).toBe("preprint");
  expect(extracted.venue).toBe("Working Paper");
});

it("recognizes NBER, SSRN, and CEPR preprint series and prefers This Version date over First Draft", () => {
  const nberBlocks: PDFBlock[] = [
    block("p1-b0", 1, "text", "NBER WORKING PAPER SERIES\nWorking Paper 33456"),
    block("p1-b1", 1, "doc_title", "Industrial Policy and Innovation Networks"),
    block("p1-b2", 1, "text", "Kaicheng Luo Shaoda Wang David Y. Yang"),
    block(
      "p1-b3",
      1,
      "text",
      "First draft: May 2023; This version: October 12, 2025",
    ),
  ];
  const extracted = extractWorkingPaperMetadata(nberBlocks);
  expect(extracted.itemType).toBe("preprint");
  expect(extracted.venue).toContain("NBER Working Paper");
  expect(extracted.date).toBe("2025-10-12");
  expect(extracted.creators).toEqual([
    { given: "Kaicheng", family: "Luo" },
    { given: "Shaoda", family: "Wang" },
    { given: "David Y.", family: "Yang" },
  ]);

  expect(isPreprintVenueOrDOI("SSRN Electronic Journal")).toBe(true);
  expect(isPreprintVenueOrDOI("", "10.3386/w33456")).toBe(true);
  expect(isPreprintVenueOrDOI("American Economic Review", "10.1257/aer.1")).toBe(
    false,
  );
});

it("splits multi-author paste strings and repairs mangled single-blob creators without clobbering clean manual edits", () => {
  expect(
    splitAuthorStringToCreators("Kaicheng Luo；David Yang；Shaoda Wang"),
  ).toEqual([
    { given: "Kaicheng", family: "Luo" },
    { given: "David", family: "Yang" },
    { given: "Shaoda", family: "Wang" },
  ]);

  const mangledDoc = paper({
    id: "wp1",
    title: "Policy Experimentation in China",
    metadata: {
      itemType: "preprint",
      creators: [{ given: "David Yang", family: "Shaoda Wang" }],
      sources: { creators: "manual", itemType: "manual", title: "manual" },
    },
  });
  expect(isMangledCreators(mangledDoc.metadata.creators)).toBe(true);

  const patch = buildWorkingPaperPatch(mangledDoc, {
    creators: [
      { given: "Shaoda", family: "Wang" },
      { given: "David Y.", family: "Yang" },
    ],
    date: "2025-02-24",
    venue: "Working Paper",
  });
  expect(patch).toEqual({
    metadata: {
      creators: [
        { given: "Shaoda", family: "Wang" },
        { given: "David Y.", family: "Yang" },
      ],
      date: "2025-02-24",
      venue: "Working Paper",
    },
  });
});
