import {
  parseAuthorYearLabel,
  resolveAuthorYearReference,
} from "../readers/author-year-citations";
import {
  figurePreviewRegion,
  figureTarget,
  tablePreviewRegion,
  tableTarget,
} from "../readers/figure-references";
import { readerLayout, updateReaderLayout } from "../neoread-layout";
import { useReaderStore } from "../store";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  memo,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useTranslations } from "./useTranslations";
import { createPortal } from "react-dom";
import { Crosshair } from "lucide-react";
import type {
  Annotation,
  Document as ReaderDocument,
  DocumentLocation,
  PDFBlock,
  PDFReadingAnchor,
  Processing,
  ReaderAdapter,
  ReaderEvents,
  ReaderSelection,
  ReaderTheme,
  SearchResult,
  TOCItem,
  TranslationBlock,
} from "@neoread/core";
import { defaultTheme, isPDFPageDecoration, zoomCommand } from "@neoread/core";
import { api } from "@neoread/api";
import { Button } from "@neoread/ui/components/button";
import { Tabs, TabsList, TabsTrigger } from "@neoread/ui/components/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@neoread/ui/components/tooltip";
import { Popover, PopoverContent } from "@neoread/ui/components/popover";
import { toast } from "sonner";
import { ReaderView } from "../ReaderView";
import { overlap, ReadingSync } from "../readers/pdf-reading";
import { animatePDFScroll } from "../readers/pdf-scroll";
import { TranslationPanes } from "./TranslationPanes";
import { formulaNumbers } from "./formulaNumbers";
import { TranslationText } from "./TranslationText";
import { blockImageCache } from "./block-images";
import { useSentenceMarks } from "./useSentenceMarks";
import { translatedSelection as captureTranslationSelection } from "./selection";
import { installTranslationSelectionHighlight } from "./selection-highlight";
import { translationFont } from "../appearance";
import { selectSentence } from "../readers/sentence-selection";
import { installCitationHover } from "../readers/citation-hover";
import { numberedReference } from "../readers/pdf-citations";
import "./translation.css";

import { AssistanceControls } from "./AssistanceControls";
import { chapterRange, headingPages } from "./chapters";
import { mergeCompositeFigureBlocks } from "./pdf-figures";
import { searchPDFBlocks } from "./pdf-search";

type Mode = "source" | "parallel" | "interleaved" | "translation";
const isSingleColumn = (mode: Mode) =>
  mode === "translation" || mode === "interleaved";
const noSearchResults: SearchResult[] = [];
// Progress and hover updates must not re-render every sentence and formula.
const PDFTranslationText = memo(function PDFTranslationText({
  requestTranslation,
  ...props
}: Omit<ComponentProps<typeof TranslationText>, "retry"> & {
  requestTranslation: (blockId: string) => Promise<void>;
}) {
  const retry = useCallback(
    () => void requestTranslation(props.block.id),
    [requestTranslation, props.block.id],
  );
  return <TranslationText {...props} retry={retry} />;
});
export function PDFReadingView({
  document: doc,
  active = true,
  theme,
  annotations,
  blocks,
  processing,
  toolbarHost,
  autoCenterHost,
  pageNavigation,
  searchResults = noSearchResults,
  searchQuery = "",
  onReady,
  events,
}: {
  document: ReaderDocument;
  active?: boolean;
  theme: ReaderTheme;
  annotations: Annotation[];
  blocks: PDFBlock[];
  processing?: Processing;
  toolbarHost?: HTMLElement | null;
  autoCenterHost?: HTMLElement | null;
  pageNavigation?: ReactNode;
  sidebarsOpen?: { left: boolean; right: boolean };
  searchResults?: SearchResult[];
  searchQuery?: string;
  onReady: (adapter: ReaderAdapter, toc: TOCItem[]) => void;
  events: ReaderEvents;
}) {
  const layoutPref = readerLayout(theme.readerLayout);
  const { swapped, sourceWidth } = layoutPref;
  const [mode, setMode] = useState<Mode>(
      () => layoutPref.readingMode ?? "source",
    ),
    [syncEnabled, setSyncEnabled] = useState(true),
    [contentFit, setContentFit] = useState(false);
  const { translations, error } = useTranslations(doc.id);
  const [popup, setPopup] = useState<{ block: PDFBlock; rect: DOMRect }>();
  const [engine, setEngine] = useState<ReaderAdapter>();
  const [bodySize, setBodySize] = useState<{
    documentId: string;
    pixels: number;
  }>();
  const [singleBodySize, setSingleBodySize] = useState<{
    documentId: string;
    pixels: number;
  }>();
  useEffect(() => {
    setContentFit(false);
  }, [doc.id]);
  const sourceBodySize =
    bodySize?.documentId === doc.id ? bodySize.pixels : undefined;
  const activeSingleBodySize =
    singleBodySize?.documentId === doc.id ? singleBodySize.pixels : undefined;
  const effectiveBodySize = isSingleColumn(mode)
    ? (activeSingleBodySize ?? sourceBodySize)
    : sourceBodySize;
  const hoveredBlock = useRef<string | undefined>(undefined);
  const translationNodes = useRef(new Map<string, HTMLElement>());
  const [focusedBlock, setFocusedBlock] = useState<string>();
  const hoverOwner = useRef<"source" | "translation" | undefined>(undefined);
  const hover = (origin: "source" | "translation", blockId?: string) => {
    if (mode === "interleaved" && blockId) return;
    if (!blockId && hoverOwner.current !== origin) return;
    if (hoveredBlock.current === blockId && hoverOwner.current === origin)
      return;
    if (hoveredBlock.current)
      translationNodes.current
        .get(hoveredBlock.current)
        ?.removeAttribute("data-hovered");
    hoveredBlock.current = blockId;
    hoverOwner.current = blockId ? origin : undefined;
    if (blockId)
      translationNodes.current
        .get(blockId)
        ?.setAttribute("data-hovered", "true");
    engine?.hoverBlock?.(
      mode === "parallel" && origin === "translation"
        ? (blockId ?? null)
        : null,
    );
  };
  const previousMode = useRef<Mode>("source");
  const syncEnabledRef = useRef(syncEnabled);
  syncEnabledRef.current = syncEnabled;
  const explicitFocus = useRef({
    operation: 0,
    moving: false,
  });
  const root = useRef<HTMLDivElement>(null),
    pane = useRef<HTMLDivElement>(null),
    control = useRef(new ReadingSync()),
    side = useRef<"source" | "translation">("source"),
    reading = useRef<PDFReadingAnchor | undefined>(undefined);
  const recordReading = (anchor: PDFReadingAnchor) => {
    reading.current = anchor;
  };
  const translationMotion = useRef({
    operation: 0,
    moving: false,
    blockId: "",
  });
  const cancelTranslationMotion = () => {
    translationMotion.current.operation++;
    translationMotion.current.moving = false;
  };
  useLayoutEffect(() => {
    if (!active) return;
    const host = pane.current;
    if (!host) return;
    // Measure the panel, not the pane: the pane's own half-height padding
    // would keep it from shrinking when the panel gets shorter.
    const frame = host.parentElement ?? host;
    let initialized = false;
    const resize = () => {
      const node = Array.from(
        host.querySelectorAll<HTMLElement>("[data-translation-block]"),
      ).find(
        (node) => node.dataset.translationBlock === reading.current?.blockId,
      );
      const before = node?.getBoundingClientRect().top;
      host.style.setProperty(
        "--translation-inset",
        `${frame.clientHeight / 2}px`,
      );
      if (initialized && node && before !== undefined)
        host.scrollTop += node.getBoundingClientRect().top - before;
      initialized = true;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(frame);
    return () => {
      observer.disconnect();
      cancelTranslationMotion();
    };
  }, [mode, doc.id, active]);
  const state = useRef({ mode, blocks, translations, events, theme });
  state.current = { mode, blocks, translations, events, theme };
  useSentenceMarks(
    root,
    engine,
    blocks,
    translations,
    annotations,
    theme.linkTranslationAnnotations !== false,
    mode,
    events,
    searchQuery,
    searchResults,
  );
  const byId = useMemo(
    () => new Map(translations.map((t) => [t.blockId, t])),
    [translations],
  );
  const selecting = useRef(false),
    selection = useRef<ReaderSelection | null>(null),
    scrollFrame = useRef(0);
  const equationNumbers = useMemo(() => formulaNumbers(blocks), [blocks]);
  const visibleBlocks = useMemo(
    () =>
      mergeCompositeFigureBlocks(
        blocks.filter(
          (b) =>
            !isPDFPageDecoration(b) && !equationNumbers.pairedIds.has(b.id),
        ),
      ),
    [blocks, equationNumbers],
  );
  const visibleById = useRef(new Map<string, PDFBlock>());
  visibleById.current = new Map(visibleBlocks.map((b) => [b.id, b]));
  const [blockImages, setBlockImages] =
    useState<ReturnType<typeof blockImageCache>>();
  useEffect(() => {
    if (!engine?.renderBlockImage) return;
    const render = engine.renderBlockImage.bind(engine);
    const cache = blockImageCache((blockId, signal, width) =>
      render(blockId, signal, width, visibleById.current.get(blockId)?.bounds),
    );
    setBlockImages(cache);
    return () => {
      cache.dispose();
      setBlockImages(undefined);
    };
  }, [engine, blocks]);
  useEffect(() => {
    if (!active || !isSingleColumn(mode) || !engine?.fitSingleColumn) return;
    const host = pane.current;
    if (!host) return;
    let cancelled = false;
    const updateSize = () => {
      const width = host.clientWidth;
      if (width <= 64) return;
      const anchorId = reading.current?.blockId;
      const anchorNode = anchorId
        ? translationNodes.current.get(anchorId)
        : undefined;
      const beforeTop = anchorNode?.getBoundingClientRect().top;
      const currentBlock = state.current.blocks.find((b) => b.id === anchorId);
      const pageNum =
        currentBlock?.page ??
        (engine.getLocation() as { page: number }).page ??
        1;
      void engine
        .fitSingleColumn?.(width, pageNum, contentFit)
        .then((pixels) => {
          if (cancelled || !pixels || !Number.isFinite(pixels)) return;
          setSingleBodySize((prev) =>
            prev?.documentId === doc.id && prev.pixels === pixels
              ? prev
              : { documentId: doc.id, pixels },
          );
          if (beforeTop !== undefined && anchorId) {
            requestAnimationFrame(() => {
              const afterNode = translationNodes.current.get(anchorId);
              if (!cancelled && afterNode && pane.current === host) {
                host.scrollTop +=
                  afterNode.getBoundingClientRect().top - beforeTop;
              }
            });
          }
        })
        .catch(() => {});
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [active, mode, engine, doc.id, contentFit, blocks.length]);
  useEffect(() => {
    if (!active || !isSingleColumn(mode)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const command = zoomCommand(event);
      if (!command || event.defaultPrevented) return;
      if (
        document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
        )
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
        )
      )
        return;
      event.preventDefault();
      const { theme: currentTheme, setTheme } = useReaderStore.getState();
      if (command === "width") {
        setTheme({ translationFontSize: 1 });
        void facade.current?.fitContent?.();
        return;
      }
      const currentScale = currentTheme.translationFontSize ?? 1;
      const next = Math.min(
        1.6,
        Math.max(
          0.8,
          Math.round((currentScale + (command === "in" ? 0.05 : -0.05)) * 100) /
            100,
        ),
      );
      setTheme({ translationFontSize: next });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, mode]);
  const sourceAnnotations = useMemo(
    () =>
      annotations.filter(
        (a) => a.location.type !== "pdf" || !a.location.translation,
      ),
    [annotations],
  );
  const searchBlockIds = useMemo(
    () => [
      ...new Set(
        searchResults
          .map((result) => result.blockId)
          .filter((id): id is string => !!id),
      ),
    ],
    [searchResults],
  );
  useEffect(() => {
    engine?.setSearchBlocks?.(searchBlockIds);
  }, [engine, searchBlockIds]);
  useEffect(() => {
    if (pane.current) return installTranslationSelectionHighlight(pane.current);
  }, [mode, doc.id]);
  const translate = useCallback(
    async (blockId = "") => {
      try {
        await api.translate(doc.id, blockId);
      } catch (e) {
        toast.error((e as Error).message);
      }
    },
    [doc.id],
  );
  const targetNode = (id: string) => translationNodes.current.get(id);
  const followTranslation = (
    anchor: PDFReadingAnchor,
    sentenceIndex?: number,
    options: { smooth?: boolean; center?: boolean } = {},
  ) => {
    const node = targetNode(anchor.blockId),
      host = pane.current;
    if (!node || !host) return;
    control.current.following("translation");
    const target =
      sentenceIndex === undefined
        ? node
        : (node.querySelector<HTMLElement>(
            `[data-sentence="${sentenceIndex}"]`,
          ) ?? node);
    const r = target.getBoundingClientRect(),
      v = host.getBoundingClientRect();
    const top =
      host.scrollTop +
      r.top -
      v.top -
      (options.center
        ? Math.max(0, (v.height - r.height) / 2)
        : v.height * 0.5 -
          (sentenceIndex === undefined ? r.height * anchor.fraction : 0));
    if (
      translationMotion.current.moving &&
      translationMotion.current.blockId === anchor.blockId &&
      !options.center
    )
      return;
    cancelTranslationMotion();
    if (!options.smooth) {
      host.scrollTop = top;
      return;
    }
    const motion = translationMotion.current;
    const operation = motion.operation;
    motion.moving = true;
    motion.blockId = anchor.blockId;
    return animatePDFScroll(
      host,
      options.center
        ? host.scrollLeft + r.left - v.left + r.width / 2 - host.clientWidth / 2
        : host.scrollLeft,
      top,
      () => operation !== motion.operation || pane.current !== host,
      () => {},
    ).finally(() => {
      if (operation === motion.operation) {
        motion.moving = false;
        // Ignore the last programmatic scroll event; fresh input releases this.
        control.current.following("translation");
      }
    });
  };
  const focusBlock = (block: PDFBlock, origin: "source" | "translation") => {
    input(origin);
    const motion = explicitFocus.current;
    const operation = motion.operation;
    motion.moving = true;
    setFocusedBlock(block.id);
    const anchor = { blockId: block.id, fraction: 0.5 };
    recordReading(anchor);
    // Both panels center their own geometry; a tall translation must not shift
    // a short original away from its center (or vice versa).
    const source = !isSingleColumn(mode)
      ? engine?.focusBlock?.(block.id, mode)
      : undefined;
    const translated =
      mode !== "source"
        ? followTranslation(anchor, undefined, { smooth: true, center: true })
        : undefined;
    const completed = Promise.all([source, translated])
      .catch((e) => toast.error(e.message))
      .finally(() => {
        if (operation === motion.operation) {
          motion.moving = false;
          setFocusedBlock(undefined);
          control.current.following(origin);
        }
      });
    events.location(
      { type: "pdf", page: block.page, x: block.bounds.x, y: block.bounds.y },
      block.page /
        (engine?.getPageCount?.() || Math.max(1, ...blocks.map((b) => b.page))),
    );
    return completed;
  };
  const focusTranslation = (block: PDFBlock) => {
    void focusBlock(block, "translation");
  };
  const locationBlock = (location: DocumentLocation) => {
    if (location.type !== "pdf") return;
    const readable = state.current.blocks.filter(
      (b) => !isPDFPageDecoration(b),
    );
    const linked =
      location.translation?.blockId ??
      location.sourceAnchors?.[0]?.blockId ??
      location.sentenceLink?.parts[0]?.blockId;
    const page = readable.filter((b) => b.page === location.page);
    // Saved selections carry rects rather than x/y; the first marked line
    // decides the paragraph, never the page origin.
    const rect = location.rects?.[0] ?? location.sourceAnchors?.[0]?.bounds;
    const covering =
      rect &&
      page
        .map((b) => ({ block: b, area: overlap(rect, b.bounds) }))
        .filter((c) => c.area > 0)
        .sort((a, b) => b.area - a.area)[0]?.block;
    const x = location.x ?? (rect ? rect.x + rect.width / 2 : 0),
      y = location.y ?? (rect ? rect.y + rect.height / 2 : 0);
    return (
      readable.find((b) => b.id === linked) ??
      covering ??
      page.sort((a, b) => {
        const distance = (block: PDFBlock) =>
          Math.max(
            block.bounds.y - y,
            y - block.bounds.y - block.bounds.height,
            0,
          ) +
          Math.max(
            block.bounds.x - x,
            x - block.bounds.x - block.bounds.width,
            0,
          ) *
            2;
        return distance(a) - distance(b);
      })[0]
    );
  };
  const go = async (location: DocumentLocation) => {
    input(isSingleColumn(mode) ? "translation" : "source");
    await engine?.goTo(location);
    if (location.type !== "pdf") return;
    const block = locationBlock(location);
    if (block) {
      const anchor = {
        blockId: block.id,
        fraction:
          location.y === undefined
            ? 0
            : Math.max(
                0,
                Math.min(
                  1,
                  (location.y - block.bounds.y) / (block.bounds.height || 1),
                ),
              ),
      };
      recordReading(anchor);
      followTranslation(anchor, location.translation?.sentenceIndexes[0]);
      state.current.events.location(
        location,
        block.page / Math.max(1, ...state.current.blocks.map((b) => b.page)),
      );
    }
  };
  const focus = async (location: DocumentLocation) => {
    const block = locationBlock(location);
    const completed = block
      ? focusBlock(block, isSingleColumn(mode) ? "translation" : "source")
      : go(location);
    const operation = explicitFocus.current.operation;
    await completed;
    if (operation !== explicitFocus.current.operation) return;
    if (location.type === "pdf" && !isSingleColumn(mode))
      engine?.flashReference?.(location, location.quote ?? "");
  };
  // Keep the public adapter usable by TOC, notes and page navigation in all modes.
  const facade = useRef<ReaderAdapter | undefined>(undefined);
  const outline = useRef<TOCItem[]>([]);
  const actions = useRef({ go, focus });
  actions.current = { go, focus };
  useEffect(() => {
    if (!root.current || !engine || mode === "interleaved") return;
    return installCitationHover(
      root.current,
      async (blockId, label) => {
        if (label.startsWith("figure:")) {
          const block = figureTarget(blocks, label.slice(7));
          return block
            ? {
                type: "pdf" as const,
                page: block.page,
                x: block.bounds.x,
                y: block.bounds.y,
              }
            : undefined;
        }
        if (label.startsWith("table:")) {
          const block = tableTarget(blocks, label.slice(6));
          return block
            ? {
                type: "pdf" as const,
                page: block.page,
                x: block.bounds.x,
                y: block.bounds.y,
              }
            : undefined;
        }
        if (label.startsWith("cite:")) {
          return resolveAuthorYearReference(blocks, label)?.location;
        }
        return (
          (await engine.resolveCitation?.(blockId, label)) ??
          numberedReference(blocks, label)
        );
      },
      async (location, anchor) => {
        await engine.previewCitation?.(location, anchor);
      },
      () => engine.hideCitationPreview?.(),
    );
  }, [engine, blocks, mode]);
  const visitCitation = async (blockId: string, label: string) => {
    try {
      if (label.startsWith("figure:")) {
        const figLabel = label.slice(7);
        const region = figurePreviewRegion(blocks, figLabel);
        if (!region) throw new Error(`未找到图 ${figLabel} 的图片位置`);
        if (engine?.previewRegion) {
          await engine.previewRegion({
            page: region.page,
            bounds: region.bounds,
            title: region.title,
            location: {
              type: "pdf",
              page: region.target.page,
              x: region.target.bounds.x,
              y: region.target.bounds.y,
            },
            autoPin: true,
          });
          return;
        }
        if (facade.current) events.internalLink?.(facade.current.getLocation());
        const block = region.target;
        const visibleTarget =
          visibleById.current.get(block.id) ??
          visibleBlocks.find(
            (b) =>
              b.page === block.page &&
              b.id.endsWith(":composite") &&
              b.bounds.y <= block.bounds.y + 0.01 &&
              b.bounds.y + b.bounds.height >=
                block.bounds.y + block.bounds.height - 0.01,
          ) ??
          block;
        focusBlock(visibleTarget, "translation");
        return;
      }
      if (label.startsWith("table:")) {
        const tblLabel = label.slice(6);
        const region = tablePreviewRegion(blocks, tblLabel);
        if (!region) throw new Error(`未找到表 ${tblLabel} 的位置`);
        if (engine?.previewRegion) {
          await engine.previewRegion({
            page: region.page,
            bounds: region.bounds,
            title: region.title,
            location: {
              type: "pdf",
              page: region.target.page,
              x: region.target.bounds.x,
              y: region.target.bounds.y,
            },
            autoPin: true,
          });
          return;
        }
        if (facade.current) events.internalLink?.(facade.current.getLocation());
        focusBlock(region.target, "translation");
        return;
      }
      if (label.startsWith("cite:")) {
        const parsed = parseAuthorYearLabel(label);
        const resolved = resolveAuthorYearReference(blocks, label);
        if (!resolved) {
          throw new Error(
            `未在参考文献中找到 ${parsed?.display ?? label.slice(5)}`,
          );
        }
        if (engine?.previewRegion) {
          await engine.previewRegion({
            page: resolved.page,
            bounds: resolved.bounds,
            title: resolved.title,
            captionText: resolved.entryText,
            location: resolved.location,
            autoPin: true,
            textHint: parsed
              ? { surname: parsed.authors[0], year: parsed.year }
              : undefined,
          });
          return;
        }
        if (facade.current) events.internalLink?.(facade.current.getLocation());
        await go(resolved.location);
        return;
      }
      const target =
        (await engine?.resolveCitation?.(blockId, label)) ??
        numberedReference(blocks, label);
      if (!target) throw new Error(`未找到参考论文 [${label}] 的跳转位置`);
      if (isSingleColumn(state.current.mode) && engine?.previewRegion) {
        const refX = Math.max(0, (target.x ?? 0.08) - 0.01);
        const refY = Math.max(0, (target.y ?? 0.1) - 0.012);
        await engine.previewRegion({
          page: target.page,
          bounds: {
            x: refX,
            y: refY,
            width: Math.min(1 - refX, 0.84),
            height: Math.min(1 - refY, 0.16),
          },
          title: `参考文献 [${label}] · 第 ${target.page} 页`,
          location: target,
          autoPin: true,
        });
        return;
      }
      if (facade.current) events.internalLink?.(facade.current.getLocation());
      await go(target);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const citationAction = useRef(visitCitation);
  citationAction.current = visitCitation;
  const followCitation = useCallback(
    (blockId: string, label: string) =>
      void citationAction.current(blockId, label),
    [],
  );
  const ready = (adapter: ReaderAdapter, toc: TOCItem[]) => {
    outline.current = toc;
    setEngine(adapter);
    facade.current = new Proxy(adapter, {
      get(target, key) {
        if (key === "prepareAnnotation")
          return async (value: ReaderSelection) => {
            if (value.location.type !== "pdf") return value;
            // Keep navigation metadata, but never persist a cross-side mark.
            const { sentenceLink: _, ...location } = value.location;
            return { ...value, location };
          };
        if (key === "goTo")
          return (l: DocumentLocation) => actions.current.go(l);
        if (key === "search")
          return async (query: string) => {
            const current = state.current;
            if (!current.blocks.length) return target.search(query);
            const found = searchPDFBlocks(
              query,
              current.blocks,
              current.translations,
            );
            const parsedPages = new Set(
              current.blocks.map((block) => block.page),
            );
            if (
              parsedPages.size >= (target.getPageCount?.() ?? parsedPages.size)
            )
              return found;
            const unparsed = (await target.search(query)).filter(
              (result) =>
                result.location.type === "pdf" &&
                !parsedPages.has(result.location.page),
            );
            return [...found, ...unparsed].slice(0, 100);
          };
        if (key === "focusLocation")
          return (l: DocumentLocation) => actions.current.focus(l);
        if (key === "next" || key === "previous")
          return () => {
            if (!state.current.blocks.length) return target[key]();
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            const current =
              block?.page ?? (target.getLocation() as { page: number }).page;
            return actions.current.go({
              type: "pdf",
              page: Math.max(1, current + (key === "next" ? 1 : -1)),
            });
          };
        if (key === "renderBlockImage" && target.renderBlockImage)
          return (id: string, signal: AbortSignal, width?: number) =>
            target.renderBlockImage!(
              id,
              signal,
              width,
              visibleById.current.get(id)?.bounds,
            );
        if (key === "fitContent" && isSingleColumn(state.current.mode))
          return async () => {
            const host = pane.current;
            if (!host) return;
            const anchorId = reading.current?.blockId;
            const anchorNode = anchorId ? targetNode(anchorId) : undefined;
            const beforeTop = anchorNode?.getBoundingClientRect().top;
            const currentBlock = state.current.blocks.find(
              (b) => b.id === anchorId,
            );
            const pageNum =
              currentBlock?.page ??
              (target.getLocation() as { page: number }).page ??
              1;
            setContentFit(true);
            const pixels = await target.fitSingleColumn?.(
              host.clientWidth,
              pageNum,
              true,
            );
            if (pixels && Number.isFinite(pixels)) {
              setSingleBodySize({ documentId: doc.id, pixels });
            }
            requestAnimationFrame(() => {
              const afterNode = anchorId ? targetNode(anchorId) : undefined;
              if (
                afterNode &&
                beforeTop !== undefined &&
                pane.current === host
              ) {
                host.scrollTop +=
                  afterNode.getBoundingClientRect().top - beforeTop;
              }
            });
          };
        if (key === "getLocation" && isSingleColumn(state.current.mode))
          return () => {
            const block = state.current.blocks.find(
              (b) => b.id === reading.current?.blockId,
            );
            return block
              ? {
                  type: "pdf",
                  page: block.page,
                  x: block.bounds.x,
                  y:
                    block.bounds.y +
                    (reading.current?.fraction ?? 0) * block.bounds.height,
                }
              : target.getLocation();
          };
        if (key === "isNear" && isSingleColumn(state.current.mode))
          return (location: DocumentLocation) => {
            const block = locationBlock(location),
              host = pane.current;
            const node = block && targetNode(block.id);
            if (!block || !host || !node || location.type !== "pdf")
              return false;
            const rect = node.getBoundingClientRect(),
              view = host.getBoundingClientRect();
            const fraction = Math.max(
              0,
              Math.min(
                1,
                ((location.y ?? block.bounds.y) - block.bounds.y) /
                  (block.bounds.height || 1),
              ),
            );
            return (
              Math.abs(
                rect.top + rect.height * fraction - view.top - view.height / 2,
              ) <
              view.height / 4
            );
          };
        if (key === "clearSelection")
          return () => {
            window.getSelection()?.removeAllRanges();
            selection.current = null;
            void target.focusSentences?.("", []);
            state.current.events.selection(null);
            target.clearSelection();
          };
        if (key === "getSelection")
          return () => selection.current ?? target.getSelection();
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    onReady(facade.current, toc);
  };
  useEffect(() => {
    if (!engine || !active) return;
    hoverOwner.current = undefined;
    if (hoveredBlock.current)
      translationNodes.current
        .get(hoveredBlock.current)
        ?.removeAttribute("data-hovered");
    hoveredBlock.current = undefined;
    engine.hoverBlock?.(null);
    const previous = previousMode.current;
    previousMode.current = mode;
    let cancelled = false;
    selection.current = null;
    events.selection(null);
    window.getSelection()?.removeAllRanges();
    void engine.focusSentences?.("", []);
    const anchor = reading.current;
    const operation = explicitFocus.current.operation;
    const restore = async () => {
      if (previous !== mode) {
        // Use the same preference path as the 适宽 button, including clearing
        // temporary passage zoom and saving this document's zoom preference.
        events.zoom?.("width");
        await engine.setTheme({ ...state.current.theme, zoom: "width" });
        if (cancelled) return;
        if (!isSingleColumn(mode) && anchor && syncEnabledRef.current)
          await engine.followBlock?.(anchor);
      }
      if (!cancelled && mode !== "source" && anchor) followTranslation(anchor);
    };
    const apply = () =>
      void restore().catch((e) => {
        if (!cancelled) toast.error(e.message);
      });
    // Both PDF fit-width and translation positioning need the expanded panes.
    let frame = 0;
    if (previous !== mode) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (!cancelled && operation === explicitFocus.current.operation)
            apply();
        });
      });
    } else apply();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      engine.hoverBlock?.(null);
    };
  }, [mode, engine, active]);
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);
  useEffect(() => {
    const release = () => {
      selecting.current = false;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);
  const input = (active: typeof side.current) => {
    cancelTranslationMotion();
    if (explicitFocus.current.moving || active === "translation")
      engine?.cancelBlockFocus?.();
    explicitFocus.current.operation++;
    explicitFocus.current.moving = false;
    setFocusedBlock(undefined);
    side.current = active;
    control.current.input(active);
  };
  const sourceSelection = (value: ReaderSelection | null) => {
    if (side.current !== "source") return;
    selection.current = value;
    events.selection(value);
  };
  const translatedSelection = () => {
    selecting.current = false;
    const selected = window.getSelection();
    if (!selected?.rangeCount || !selected.toString().trim() || !pane.current)
      return;
    const value = captureTranslationSelection(
      pane.current,
      selected.getRangeAt(0),
      blocks,
      translations,
    );
    if (!value) return;
    selection.current = value.selection;
    events.selection(value.selection);
  };
  const translatedScroll = () => {
    cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      if (
        selecting.current ||
        explicitFocus.current.moving ||
        translationMotion.current.moving ||
        !pane.current ||
        !control.current.canFollow("translation")
      )
        return;
      const v = pane.current.getBoundingClientRect(),
        y = v.top + v.height * 0.5;
      // Sections stay in document order. Locate the center with logarithmic
      // geometry reads instead of scanning every translated paragraph per frame.
      let low = 0,
        high = visibleBlocks.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const candidate = targetNode(visibleBlocks[middle].id);
        if (candidate && candidate.getBoundingClientRect().bottom <= y)
          low = middle + 1;
        else high = middle;
      }
      const node =
        low < visibleBlocks.length
          ? targetNode(visibleBlocks[low].id)
          : undefined;
      if (!node) return;
      const r = node.getBoundingClientRect(),
        anchor = {
          blockId: node.dataset.translationBlock!,
          fraction: Math.max(0, Math.min(1, (y - r.top) / (r.height || 1))),
        };
      recordReading(anchor);
      const block = blocks.find((b) => b.id === anchor.blockId);
      if (block)
        events.location(
          {
            type: "pdf",
            page: block.page,
            x: block.bounds.x,
            y: block.bounds.y + anchor.fraction * block.bounds.height,
          },
          block.page /
            (engine?.getPageCount?.() ||
              Math.max(1, ...blocks.map((b) => b.page))),
        );
      if (mode === "parallel" && syncEnabledRef.current) {
        control.current.following("source");
        void engine?.followBlock?.(anchor);
      }
    });
  };
  const changeMode = (value: Mode) => {
    input(isSingleColumn(value) ? "translation" : "source");
    setPopup(undefined);
    setMode(value);
    updateReaderLayout({ readingMode: value });
  };
  const activePopup = popup && byId.get(popup.block.id);
  const toggleSync = () => {
    const enabled = !syncEnabledRef.current;
    syncEnabledRef.current = enabled;
    setSyncEnabled(enabled);
    // Stop pending follow animations before changing the synchronization policy.
    input(side.current);
    engine?.cancelBlockFocus?.();
    const anchor = reading.current;
    if (!enabled || mode !== "parallel" || !anchor) return;
    if (side.current === "source") {
      void followTranslation(anchor, undefined, { smooth: true });
    } else {
      control.current.following("source");
      void engine?.followBlock?.(anchor).catch((e) => toast.error(e.message));
    }
  };
  const autoCenterButton = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={syncEnabled ? "default" : "outline"}
            size="icon-sm"
            aria-label={syncEnabled ? "取消同步效果" : "开启同步效果"}
            aria-pressed={syncEnabled}
            onClick={toggleSync}
          />
        }
      >
        <Crosshair />
      </TooltipTrigger>
      <TooltipContent>
        {syncEnabled ? "取消同步效果" : "开启同步效果"}
      </TooltipContent>
    </Tooltip>
  );
  const toolbar = (
    <div className="translation-toolbar">
      {!autoCenterHost && autoCenterButton}
      <AssistanceControls
        documentId={doc.id}
        processing={processing}
        library={doc.library}
        chapter={() => {
          const location = facade.current?.getLocation();
          if (location?.type !== "pdf") return undefined;
          return chapterRange(
            outline.current,
            location.page,
            engine?.getPageCount?.() ||
              Math.max(1, ...blocks.map((b) => b.page)),
            headingPages(blocks),
          );
        }}
      />
      <Tabs value={mode} onValueChange={(v) => changeMode(v as Mode)}>
        <TabsList>
          <TabsTrigger value="source">仅原文</TabsTrigger>
          <TabsTrigger value="parallel" data-tour="parallel-mode">
            原文译文
          </TabsTrigger>
          <TabsTrigger value="interleaved">逐段对照</TabsTrigger>
          <TabsTrigger value="translation">仅译文</TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
  const blockActionRef = useRef(events.blockAction);
  blockActionRef.current = events.blockAction;
  const previewBlockImage = useCallback(
    (block: PDFBlock) =>
      blockActionRef.current?.(
        { ...block, image: block.image || "pdf-crop" },
        "preview",
      ),
    [],
  );
  const sectionActions = useRef({ hover, focusTranslation });
  sectionActions.current = { hover, focusTranslation };
  const interleaved = mode === "interleaved";
  const canPreviewImages = !!events.blockAction;
  // Reading progress changes do not rebuild the entire translated document.
  const translationContent = useMemo(
    () =>
      visibleBlocks.map((block) => {
        const baseBlockId = block.id.includes(":")
          ? block.id.split(":")[0]
          : block.id;
        const translated = byId.get(baseBlockId),
          noteIndexes = annotations.flatMap((a) => {
            const mark =
              a.location.type === "pdf" ? a.location.translation : undefined;
            return mark
              ? (mark.ranges ?? [mark])
                  .filter(
                    (r) =>
                      r.blockId === baseBlockId &&
                      r.sourceHash === translated?.sourceHash,
                  )
                  .flatMap((r) => r.sentenceIndexes)
              : [];
          });
        const isAssetBlock =
          !!block.image ||
          ["algorithm", "table", "chart", "image", "figure"].includes(
            block.label,
          );
        return (
          <section
            key={block.id}
            data-translation-block={block.id}
            data-block-kind={isAssetBlock ? "image" : "text"}
            data-label={block.label}
            data-focused={focusedBlock === block.id || undefined}
            data-search-hit={
              searchBlockIds.includes(baseBlockId) || undefined
            }
            aria-current={focusedBlock === block.id || undefined}
            tabIndex={0}
            ref={(node) => {
              if (node) translationNodes.current.set(block.id, node);
              else translationNodes.current.delete(block.id);
            }}
            onKeyDown={(event) => {
              if (
                event.target === event.currentTarget &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                sectionActions.current.focusTranslation(block);
              }
            }}
            onPointerEnter={
              interleaved
                ? undefined
                : (event) => {
                    if (!event.buttons && !selecting.current)
                      sectionActions.current.hover("translation", block.id);
                  }
            }
            onPointerMove={
              interleaved
                ? undefined
                : (event) => {
                    if (!event.buttons && !selecting.current)
                      sectionActions.current.hover("translation", block.id);
                  }
            }
            onPointerLeave={
              interleaved
                ? undefined
                : () => sectionActions.current.hover("translation")
            }
            className={noteIndexes.length ? "translation-annotated" : ""}
          >
            <PDFTranslationText
              block={block}
              onCitation={followCitation}
              formulaNumber={equationNumbers.byFormula.get(baseBlockId)}
              translation={translated}
              documentId={doc.id}
              renderImage={blockImages?.url}
              onPreview={
                canPreviewImages && isAssetBlock
                  ? () => previewBlockImage(block)
                  : undefined
              }
              requestTranslation={translate}
              paused={processing?.enabled === false}
              interleaved={interleaved}
            />
            {noteIndexes.length > 0 && (
              <span
                className="translation-note-indicator"
                title="此段有已保存的标注"
                aria-label="此段有已保存的标注"
              />
            )}
          </section>
        );
      }),
    [
      visibleBlocks,
      byId,
      annotations,
      focusedBlock,
      searchBlockIds,
      equationNumbers,
      followCitation,
      doc.id,
      blockImages,
      translate,
      processing?.enabled,
      interleaved,
      canPreviewImages,
      previewBlockImage,
    ],
  );
  return (
    <div
      className="pdf-reading"
      data-reading-mode={mode}
      data-content-fit={
        (isSingleColumn(mode) && contentFit) || undefined
      }
      ref={root}
      data-theme={theme.mode}
      data-dark-contrast={theme.pdfDarkContrast ?? "soft"}
    >
      {autoCenterHost && createPortal(autoCenterButton, autoCenterHost)}
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      {isSingleColumn(mode) && (
        <div className="pdf-reading-controls">
          <div className="pdf-page-navigation">{pageNavigation}</div>
        </div>
      )}
      <TranslationPanes
        mode={mode}
        swapped={swapped}
        onSwap={() => updateReaderLayout({ swapped: !swapped })}
        sourceWidth={sourceWidth}
        onSourceWidthChange={(sourceWidth) =>
          updateReaderLayout({ sourceWidth })
        }
        onResizeStart={() => engine?.cancelBlockFocus?.()}
        source={
          <div
            className="translation-source"
            inert={isSingleColumn(mode)}
            onWheelCapture={() => input("source")}
            onPointerDownCapture={() => input("source")}
            onKeyDownCapture={() => input("source")}
          >
            <ReaderView
              active={active}
              document={doc}
              theme={theme}
              annotations={sourceAnnotations}
              blocks={blocks}
              onReady={ready}
              events={{
                ...events,
                bodyFontSize: (pixels) => {
                  if (!Number.isFinite(pixels) || pixels <= 0) return;
                  setBodySize((previous) =>
                    previous?.documentId === doc.id &&
                    previous.pixels === pixels
                      ? previous
                      : { documentId: doc.id, pixels },
                  );
                },
                selection: sourceSelection,
                blockFocus: (block) => {
                  void focusBlock(block, "source");
                },
                location: (location, percentage) => {
                  if (
                    !isSingleColumn(state.current.mode) &&
                    side.current === "source"
                  )
                    events.location(location, percentage);
                },
                readingAnchor: (anchor) => {
                  if (
                    explicitFocus.current.moving ||
                    !control.current.canFollow("source") ||
                    selecting.current
                  )
                    return;
                  recordReading(anchor);
                  if (
                    state.current.mode === "parallel" &&
                    syncEnabledRef.current
                  )
                    followTranslation(anchor);
                },
                blockHover: (block) => {
                  if (mode === "parallel") hover("source", block?.id);
                },
                blockAction: (block, action) => {
                  if (action !== "translate") {
                    events.blockAction?.(block, action);
                    return;
                  }
                  const button = root.current?.querySelector<HTMLElement>(
                    `[data-block-id="${block.id}"] [data-block-action="translate"]`,
                  );
                  setPopup({
                    block,
                    rect:
                      button?.getBoundingClientRect() ??
                      root.current!.getBoundingClientRect(),
                  });
                },
              }}
            />
            {!isSingleColumn(mode) && (
              <div className="pdf-reading-controls">
                <div className="pdf-page-navigation">{pageNavigation}</div>
              </div>
            )}
          </div>
        }
        translation={
          mode !== "source" && (
            <div
              className="translation-document"
              ref={pane}
              tabIndex={0}
              aria-label="论文译文"
              onScroll={() => {
                hover("translation");
                translatedScroll();
              }}
              onPointerLeave={() => hover("translation")}
              onWheelCapture={() => input("translation")}
              onPointerDownCapture={(event) => {
                const section = (event.target as Element).closest<HTMLElement>(
                  "[data-translation-block]",
                );
                input("translation");
                hover("translation");
                // The viewport itself receives scrollbar presses. Keep following
                // those scrolls while the pointer is down; only text drags select.
                selecting.current = !!section && event.button === 0;
                selection.current = null;
                events.selection(null);
                void engine?.focusSentences?.("", []);
              }}
              onPointerUp={translatedSelection}
              onDoubleClick={(event) => {
                // Select the translated sentence; untranslated text falls
                // back to the sentence around the word.
                const target = event.target as Element;
                const sentence = target.closest(
                  ".translation-sentence, .translation-source-sentence",
                );
                const selected = window.getSelection();
                if (sentence && selected) {
                  const range = document.createRange();
                  range.selectNodeContents(sentence);
                  selected.removeAllRanges();
                  selected.addRange(range);
                } else {
                  const section = target.closest("section");
                  if (section) selectSentence(selected, section);
                }
                translatedSelection();
              }}
              onKeyDownCapture={() => input("translation")}
              onKeyUp={translatedSelection}
              style={{
                fontSize: effectiveBodySize
                  ? `${effectiveBodySize * (theme.translationFontSize ?? 1)}px`
                  : `${theme.translationFontSize ?? 1}rem`,
                fontFamily: translationFont(theme.translationFontFamily),
                fontWeight:
                  (theme.translationFontWeight ??
                    defaultTheme.translationFontWeight) === "bold"
                    ? 600
                    : undefined,
                lineHeight: theme.lineHeight,
              }}
            >
              {error && <p role="alert">{error}</p>}
              {!visibleBlocks.length && (
                <p role="status">
                  {doc.library === "books"
                    ? "尚未翻译任何章节，可在工具栏翻译本章。"
                    : "正文仍在解析中，完成的段落会在这里显示。"}
                </p>
              )}
              {translationContent}
            </div>
          )
        }
      />
      <Popover
        open={!!popup}
        onOpenChange={(open) => {
          if (!open) setPopup(undefined);
        }}
      >
        <PopoverContent
          anchor={
            popup ? { getBoundingClientRect: () => popup.rect } : undefined
          }
          className="translation-popover"
          side="bottom"
          align="end"
        >
          {popup && (
            <>
              <TranslationText
                block={popup.block}
                onCitation={followCitation}
                formulaNumber={equationNumbers.byFormula.get(popup.block.id)}
                translation={activePopup}
                documentId={doc.id}
                renderImage={blockImages?.url}
                retry={() => void translate(popup.block.id)}
                paused={processing?.enabled === false}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  recordReading({ blockId: popup.block.id, fraction: 0 });
                  changeMode("parallel");
                }}
              >
                进入双栏对照
              </Button>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
