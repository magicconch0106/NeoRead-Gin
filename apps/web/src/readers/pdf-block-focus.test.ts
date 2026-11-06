// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFBlock } from "@neoread/core";
vi.mock("pdfjs-dist", () => ({
  Util: { transform: (_a: number[], b: number[]) => b },
}));
import { PDFReadingNavigation } from "./pdf-navigation";
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup() {
  const host = document.createElement("div");
  const size = { width: 600, height: 600 };
  let scale = 1;
  Object.defineProperties(host, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
    scrollWidth: { value: 5000 },
    scrollHeight: { value: 10000 },
  });
  host.getBoundingClientRect = () =>
    new DOMRect(30, 50, size.width, size.height);
  const blocks: PDFBlock[] = [
    {
      id: "a",
      page: 1,
      label: "text",
      text: "A",
      bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.2 },
    },
    {
      id: "b",
      page: 1,
      label: "text",
      text: "B",
      bounds: { x: 0.1, y: 0.5, width: 0.8, height: 0.4 },
    },
    {
      id: "image",
      page: 2,
      label: "image",
      text: "",
      image: "figure.png",
      bounds: { x: 0.6, y: 0.2, width: 0.2, height: 0.7 },
    },
    {
      id: "footer",
      page: 2,
      label: "footer",
      text: "2",
      bounds: { x: 0.5, y: 0.95, width: 0.1, height: 0.02 },
    },
  ];
  const nodes = [0, 1].map((n) => {
    const node = document.createElement("div");
    node.getBoundingClientRect = () =>
      new DOMRect(
        30 +
          (host.classList.contains("pdf-block-reading") ? size.width / 2 : 0) -
          host.scrollLeft,
        50 +
          (host.classList.contains("pdf-block-reading") ? size.height / 2 : 0) +
          n * 1300 * scale -
          host.scrollTop,
        1000 * scale,
        1200 * scale,
      );
    return node;
  });
  const focus = vi.fn(),
    anchor = vi.fn();
  const page = vi.fn(
    async () =>
      ({ getViewport: () => ({ width: 750, height: 900 }) }) as PDFPageProxy,
  );
  const viewer = {
    currentPageNumber: 1,
    refresh: vi.fn(),
    get currentScale() {
      return scale;
    },
    set currentScaleValue(value: string) {
      scale = Number(value);
    },
    updateScale: vi.fn(({ scaleFactor }: { scaleFactor: number }) => {
      scale = Math.round(scale * scaleFactor * 100) / 100;
    }),
    getPageView: (i: number) => ({ div: nodes[i] }),
  } as unknown as PDFViewer;
  const nav = new PDFReadingNavigation(
    host,
    viewer,
    page,
    () => blocks,
    { location: vi.fn(), selection: vi.fn(), readingAnchor: anchor },
    focus,
  );
  const rect = (id: string) => {
    const block = blocks.find((b) => b.id === id)!;
    const r = nodes[block.page - 1].getBoundingClientRect();
    return new DOMRect(
      r.left + block.bounds.x * r.width,
      r.top + block.bounds.y * r.height,
      block.bounds.width * r.width,
      block.bounds.height * r.height,
    );
  };
  return { nav, host, size, viewer, page, blocks, focus, rect, anchor };
}
async function finish(p: Promise<unknown>) {
  await vi.advanceTimersByTimeAsync(500);
  return p;
}

it.each(["source", "parallel"] as const)(
  "keeps user zoom and page layout during explicit %s navigation",
  async (mode) => {
    const s = setup();
    try {
      for (const zoom of [0.5, 1, 2]) {
        s.viewer.currentScaleValue = String(zoom);
        for (const id of ["a", "b", "image"]) {
          expect(await finish(s.nav.focusBlock(id, mode))).toBe(true);
          expect(s.viewer.currentScale).toBe(zoom);
          expect(s.host.classList.contains("pdf-block-reading")).toBe(false);
        }
      }
      expect(s.viewer.updateScale).not.toHaveBeenCalled();
      expect(s.viewer.refresh).not.toHaveBeenCalled();
      expect(s.focus).toHaveBeenLastCalledWith(null);
    } finally {
      s.nav.destroy();
    }
  },
);
it("cancels explicit navigation as soon as the user scrolls", async () => {
  const s = setup();
  try {
    const pending = s.nav.focusBlock("b");
    await vi.advanceTimersByTimeAsync(80);
    s.host.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    s.host.scrollTop = 125;
    expect(await finish(pending)).toBe(false);
    expect(s.host.scrollTop).toBe(125);
    expect(s.viewer.currentScale).toBe(1);
    expect(await finish(s.nav.focusBlock("a"))).toBe(true);
  } finally {
    s.nav.destroy();
  }
});
it("follows the active pane immediately without queued scroll or zoom animations", async () => {
  const s = setup();
  try {
    await s.nav.follow({ blockId: "b", fraction: 0.5 });
    const top = s.host.scrollTop;
    expect(top).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(s.host.scrollTop).toBe(top);
    expect(s.viewer.currentScale).toBe(1);
    expect(s.viewer.updateScale).not.toHaveBeenCalled();
  } finally {
    s.nav.destroy();
  }
});
it("reads page geometry once per page when locating a reading anchor", () => {
  const s = setup();
  const page = s.viewer.getPageView(0).div;
  const geometry = vi.spyOn(page, "getBoundingClientRect");
  try {
    expect(s.nav.anchor()).toBeDefined();
    expect(geometry).toHaveBeenCalledTimes(1);
  } finally {
    s.nav.destroy();
  }
});
it("ignores missing blocks and prevents disposed navigation", async () => {
  const s = setup();
  expect(await s.nav.focusBlock("missing")).toBe(false);
  s.nav.destroy();
  expect(await s.nav.focusBlock("a")).toBe(false);
});
