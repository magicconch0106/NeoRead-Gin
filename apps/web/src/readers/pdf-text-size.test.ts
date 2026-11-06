import { expect, it } from "vitest";
import { pdfBodyTextSize } from "./pdf-text-size";

const text = (str: string, size: number) => ({
  str,
  transform: [size, 0, 0, size, 0, 0],
});

it("uses the dominant body size rather than titles, footnotes or formula scripts", () => {
  expect(
    pdfBodyTextSize([
      {
        userUnit: 1,
        items: [
          text("Title", 24),
          text("A long paragraph of regular body text.", 10),
          text("Small footnote", 8),
          text("1", 5),
        ],
      },
    ]),
  ).toBeCloseTo((10 * 96) / 72);
});
it("combines sampled pages and handles rotated text and PDF user units", () => {
  expect(
    pdfBodyTextSize([
      { userUnit: 1, items: [text("Cover", 24)] },
      {
        userUnit: 2,
        items: [
          {
            str: "Regular text on the following page.",
            transform: [0, 10, -10, 0, 0, 0],
          },
        ],
      },
    ]),
  ).toBeCloseTo((20 * 96) / 72);
});
it("ignores whitespace, marked-content records and invalid sizes", () => {
  expect(
    pdfBodyTextSize([
      {
        userUnit: 1,
        items: [
          text("  ", 30),
          { type: "beginMarkedContent" },
          text("bad", NaN),
          text("zero", 0),
        ],
      },
    ]),
  ).toBeUndefined();
  expect(pdfBodyTextSize([])).toBeUndefined();
});
