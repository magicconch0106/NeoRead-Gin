import { expect, it } from "vitest";
import type { PDFBlock } from "@neoread/core";
import {
  authorYearReferences,
  resolveAuthorYearReference,
} from "./author-year-citations";

it("extracts narrative and parenthetical economics citations in English and Chinese", () => {
  expect(
    authorYearReferences(
      "Determining policies is essential (e.g., Hayek 1978; North et al. 1990).",
    ).map((r) => ({ text: r.text, label: r.label })),
  ).toEqual([
    { text: "Hayek 1978", label: "cite:Hayek@1978" },
    { text: "North et al. 1990", label: "cite:North*@1990" },
  ]);

  expect(
    authorYearReferences(
      "标准误基于Miratrix、Sekhon和Yu（2013）估计，并采用Sun和Abraham（2021）的调整（例如 Hayek 1978；Heilmann 2008b）。",
    ).map((r) => ({ text: r.text, label: r.label })),
  ).toEqual([
    {
      text: "Miratrix、Sekhon和Yu（2013）",
      label: "cite:Miratrix|Sekhon|Yu@2013",
    },
    { text: "Sun和Abraham（2021）", label: "cite:Sun|Abraham@2021" },
    { text: "Hayek 1978", label: "cite:Hayek@1978" },
    { text: "Heilmann 2008b", label: "cite:Heilmann@2008b" },
  ]);

  expect(
    authorYearReferences(
      "See Matějka and McKay (2015), Heilmann (2008a, b), and Interestingly, Mehmood, Naseer, and Chen (2021).",
    ).map((r) => ({ text: r.text, label: r.label })),
  ).toEqual([
    { text: "Matějka and McKay (2015)", label: "cite:Matějka|McKay@2015" },
    { text: "2008a", label: "cite:Heilmann@2008a" },
    { text: "b", label: "cite:Heilmann@2008b" },
    {
      text: "Mehmood, Naseer, and Chen (2021)",
      label: "cite:Mehmood|Naseer|Chen@2021",
    },
  ]);
});

it("ignores dates, months, structural labels, places and acronyms", () => {
  expect(
    authorYearReferences(
      "February 24, 2025. Counties before 2007 and after 2007. Panel A (2010), Table 1 (2020), China (2015), NBER (2024).",
    ),
  ).toEqual([]);
});

it("resolves concatenated bibliography entries, repeated-author rules, and co-author disambiguation", () => {
  const blocks: PDFBlock[] = [
    {
      id: "p41-b1",
      page: 41,
      label: "reference",
      text: [
        "Fisman, Raymond, Jing Shi, Yongxiang Wang, and Weixing Wu. 2020. “Social ties and the selection of China’s political elite.” American Economic Review 110 (6): 1752–81.",
        "Hayek, Friedrich August. 1978. Law, legislation and liberty, volume 1: Rules and order. University of Chicago Press.",
        "Heilmann, Sebastian. 2008a. “From local experiments to national policy.” The China Journal, no. 59, 1–30.",
        ". 2008b. “Policy experimentation in China’s economic rise.” Studies in Comparative International Development 43 (1): 1–26.",
      ].join(" "),
      bounds: { x: 0.11, y: 0.1, width: 0.78, height: 0.8 },
    },
    {
      id: "p43-b1",
      page: 43,
      label: "reference",
      text: [
        "Alexander J (2020) Creators finally know how much money YouTube makes. Accessed March 4, 2024.",
        "Wang, Zhi, Qinghua Zhang, and Li-An Zhou. 2020. “Career incentives of city leaders and urban spatial expansion in China.” Review of Economics and Statistics 102 (5): 897–911.",
      ].join(" "),
      bounds: { x: 0.11, y: 0.1, width: 0.78, height: 0.5 },
    },
  ];

  const heilmannB = resolveAuthorYearReference(blocks, "cite:Heilmann@2008b");
  expect(heilmannB).toBeDefined();
  expect(heilmannB?.page).toBe(41);
  expect(heilmannB?.entryText).toContain("Heilmann, Sebastian. 2008b.");
  expect(heilmannB?.entryText).toContain("Policy experimentation");

  const wang2020 = resolveAuthorYearReference(
    blocks,
    "cite:Wang|Zhang|Zhou@2020",
  );
  expect(wang2020?.page).toBe(43);
  expect(wang2020?.entryText).toContain("Wang, Zhi, Qinghua Zhang");

  const informs = resolveAuthorYearReference(blocks, "cite:Alexander@2020");
  expect(informs?.page).toBe(43);
  expect(informs?.entryText).toContain("Alexander J (2020)");
});
