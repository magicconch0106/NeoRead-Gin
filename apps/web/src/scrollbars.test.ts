// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installScrollbars } from "./scrollbars";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("keeps scrollbar appearance stable throughout a scroll burst without repeated inherited-style mutations", () => {
  vi.useFakeTimers();
  const pane = document.createElement("div");
  document.body.append(pane);
  const set = vi.spyOn(pane, "setAttribute");
  const dispose = installScrollbars(document);
  try {
    for (let i = 0; i < 100; i++) {
      pane.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(16);
    }
    expect(set).toHaveBeenCalledTimes(1);
    expect(pane.hasAttribute("data-neoread-scrolling")).toBe(true);
    vi.advanceTimersByTime(983);
    expect(pane.hasAttribute("data-neoread-scrolling")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pane.hasAttribute("data-neoread-scrolling")).toBe(false);
    pane.dispatchEvent(new Event("scroll"));
    expect(set).toHaveBeenCalledTimes(2);
  } finally {
    dispose();
  }
});

it("cleans up active panes, pending timers and listeners", () => {
  vi.useFakeTimers();
  const panes = [document.createElement("div"), document.createElement("div")];
  document.body.append(...panes);
  const dispose = installScrollbars(document);
  panes.forEach((pane) => pane.dispatchEvent(new Event("scroll")));
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  panes.forEach((pane) => {
    expect(pane.hasAttribute("data-neoread-scrolling")).toBe(false);
    pane.dispatchEvent(new Event("scroll"));
    expect(pane.hasAttribute("data-neoread-scrolling")).toBe(false);
  });
});
