// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import katex from "katex";
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));
import FormulaFragment from "./FormulaFragment";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("does not revalidate 201 unchanged formulas during repeated reading progress updates", async () => {
  const validate = vi.spyOn(katex, "renderToString");
  const formulas = Array.from({ length: 201 }, (_, i) => `$$x_{${i}}^2+y^2$$`);
  const render = (update: number) =>
    root.render(
      <>
        {formulas.map((content, i) => (
          <FormulaFragment
            key={i}
            content={content}
            number={String(i)}
            fallback={<span data-update={update}>original</span>}
          />
        ))}
      </>,
    );
  await act(async () => render(0));
  expect(validate).toHaveBeenCalledTimes(201);
  validate.mockClear();
  for (let i = 1; i <= 10; i++) await act(async () => render(i));
  expect(validate).not.toHaveBeenCalled();
  expect(host.querySelectorAll(".translation-formula")).toHaveLength(201);
});
it("revalidates changed content and keeps invalid-formula fallback", async () => {
  const validate = vi.spyOn(katex, "renderToString");
  const render = (content: string) =>
    root.render(
      <FormulaFragment
        content={content}
        fallback={<span>original formula</span>}
      />,
    );
  await act(async () => render("$$x^2$$"));
  expect(host.querySelector(".translation-formula")).not.toBeNull();
  await act(async () => render("$$\\notARealCommand{x}$$"));
  expect(validate).toHaveBeenCalledTimes(2);
  expect(host.querySelector(".translation-formula")).toBeNull();
  expect(host.textContent).toBe("original formula");
});
