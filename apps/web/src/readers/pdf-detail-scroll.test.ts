import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

// Exercise the installed, patched PDF.js scheduling methods themselves.
const source = readFileSync(
  createRequire(import.meta.url).resolve("pdfjs-dist/web/pdf_viewer.mjs"),
  "utf8",
);
const viewer = source.slice(source.indexOf("class PDFViewer {"));
const method = (start: string, end: string) =>
  viewer
    .slice(viewer.indexOf(start), viewer.indexOf(end))
    .replace(/#(\w+)/g, "_$1");
const Viewer = new Function(
  "DEFAULT_CACHE_SIZE",
  "SpreadMode",
  "ScrollMode",
  `return class {
${method("  _scrollUpdate() {", "  #scrollIntoView(")}
${method("  update() {", "  #switchToEditAnnotationMode(")}
${method("  forceRendering(", "  get hasEqualPageSizes(")}
}`,
)(10, { NONE: 0 }, { PAGE: 0, VERTICAL: 1 });

afterEach(() => vi.useRealTimers());

function setup() {
  const page = { updateVisibleArea: vi.fn() };
  const offscreen = { id: 2, updateVisibleArea: vi.fn() };
  const visibleArea = { minY: 100, maxY: 600 };
  const visible = {
    first: { id: 1 },
    views: [{ id: 1, percent: 100, view: page, visibleArea }],
    ids: new Set([1]),
  };
  const instance = new Viewer();
  const buffer = Object.assign([offscreen], { resize: vi.fn() });
  Object.assign(instance, {
    pagesCount: 2,
    _scaleTimeoutId: null,
    _scrollTimeoutId: null,
    _buffer: buffer,
    _pages: [page, offscreen],
    _spreadMode: 0,
    _scrollMode: 1,
    _currentPageNumber: 1,
    _getVisiblePages: () => visible,
    _getScrollAhead: () => true,
    _setCurrentPageNumber: vi.fn(),
    _updateLocation: vi.fn(),
    eventBus: { dispatch: vi.fn() },
    renderingQueue: {
      renderHighestPriority: vi.fn(),
      getHighestPriority: vi.fn(),
      renderView: vi.fn(),
    },
  });
  return { instance, page, offscreen, visibleArea };
}

it("defers detail crops throughout scrolling, then restores sharp rendering once scrolling settles", () => {
  vi.useFakeTimers();
  const { instance, page, offscreen, visibleArea } = setup();
  for (let i = 0; i < 50; i++) {
    instance._scrollUpdate();
    instance.forceRendering();
    vi.advanceTimersByTime(16);
  }
  expect(page.updateVisibleArea).not.toHaveBeenCalled();
  expect(offscreen.updateVisibleArea).toHaveBeenCalledWith(null);
  expect(
    instance.renderingQueue.getHighestPriority.mock.calls.every(
      (args: unknown[]) => args[4] === true,
    ),
  ).toBe(true);
  // Page rendering/navigation continue while only detail crops are deferred.
  expect(instance.renderingQueue.renderHighestPriority).toHaveBeenCalledTimes(
    50,
  );
  vi.advanceTimersByTime(84);
  expect(page.updateVisibleArea).toHaveBeenCalledExactlyOnceWith(visibleArea);
  instance.forceRendering();
  expect(instance.renderingQueue.getHighestPriority.mock.lastCall[4]).toBe(
    false,
  );
});

it("keeps detail crops deferred during an animated zoom even after scroll settling", () => {
  const { instance, page } = setup();
  instance._scaleTimeoutId = 1;
  instance.update();
  instance.forceRendering();
  expect(page.updateVisibleArea).not.toHaveBeenCalled();
  expect(instance.renderingQueue.getHighestPriority.mock.lastCall[4]).toBe(
    true,
  );
});
