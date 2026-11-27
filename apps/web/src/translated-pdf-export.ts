import {
  exportOperation,
  exportFailure,
  exportFailureDetail,
  PDFExportError,
} from "./translation/pdf-export-error";
import type {
  Annotation,
  Document,
  DocumentNavigation,
  Message,
} from "@neoread/core";
import { api, publicationURL } from "@neoread/api";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { toast } from "sonner";
import { downloadBlob, fileTitle } from "./download";
import { reportDiagnostic } from "./diagnostics";
import { buildNavigation } from "./navigation-model";
import { readPDFOutline } from "./readers/pdf-outline";
import type {
  PDFExportProgress,
  TranslatedPDF,
} from "./translation/pdf-export-model";

export async function exportTranslatedPDF(
  doc: Document,
  signal: AbortSignal,
  onProgress: (progress: PDFExportProgress) => void,
  kinds?: Annotation["kind"][],
): Promise<Omit<TranslatedPDF, "bytes">> {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  let phase = "snapshot";
  const event = (result: string, detail = "") =>
    reportDiagnostic({
      level: result === "failed" ? "error" : "info",
      event: `pdf.translation_export.${result}`,
      requestId,
      durationMs: Math.round(performance.now() - started),
      detail: `phase=${phase}${detail ? ` ${detail}` : ""}`,
    });
  const font = (path: string) =>
    exportOperation("font_load", async () => {
      const response = await fetch(path, { signal });
      if (!response.ok)
        throw new Error("PDF 导出字体加载失败，请重新打开应用后重试。");
      return new Uint8Array(await response.arrayBuffer());
    });
  event("start");
  onProgress({ phase: "preparing", done: 0, total: 0 });
  try {
    if (doc.type !== "pdf")
      throw new PDFExportError(
        "unsupported_document",
        new Error("译文 PDF 导出仅适用于 PDF 文档"),
      );
    signal.throwIfAborted();
    const [
      blocks,
      translations,
      annotations,
      messages,
      navigation,
      cjk,
      latin,
      pdfjs,
      engine,
    ] = await Promise.all([
      exportOperation("snapshot", () => api.blocks(doc.id, signal)),
      exportOperation("snapshot", () => api.translations(doc.id, signal)),
      exportOperation("snapshot", () =>
        api.annotations
          ? api.annotations(doc.id, signal)
          : Promise.resolve([] as Annotation[]),
      ),
      exportOperation("snapshot", () =>
        api.messages
          ? api.messages(doc.id, signal)
          : Promise.resolve([] as Message[]),
      ),
      exportOperation("snapshot", () =>
        api.navigation
          ? api.navigation(doc.id)
          : Promise.resolve(null as DocumentNavigation | null),
      ),
      font("/pdf-assets/export-fonts/NotoSansSC-Regular.ttf"),
      font("/pdf-assets/standard_fonts/LiberationSans-Regular.ttf"),
      exportOperation("module_load", () => import("pdfjs-dist")),
      exportOperation("module_load", () => import("./translation/pdf-export")),
    ]);
    signal.throwIfAborted();
    const marks = annotations.filter(
      (a) =>
        a.kind !== "bookmark" &&
        a.location.type === "pdf" &&
        (!kinds || kinds.includes(a.kind)),
    );
    const answers = Object.fromEntries(messages.map((m) => [m.id, m.content]));
    phase = "layout";
    event("stage");
    pdfjs.GlobalWorkerOptions.workerSrc ||= workerURL;
    const result = await engine.translatedPDF(
      pdfjs.getDocument,
      {
        url: publicationURL(doc.id, "original.pdf"),
        cMapUrl: "/pdf-assets/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "/pdf-assets/standard_fonts/",
        wasmUrl: "/pdf-assets/wasm/",
      },
      blocks,
      translations,
      { cjk, latin },
      {
        signal,
        annotations: marks,
        answers,
        navigation: navigation
          ? async (pdf) =>
              buildNavigation(
                await readPDFOutline(pdf),
                blocks,
                annotations,
                navigation,
              ).filter((item) => !item.id.startsWith("page-"))
          : undefined,
        onProgress: (progress) => {
          if (progress.phase === "saving") {
            phase = "saving";
            event("stage");
          }
          onProgress(progress);
        },
      },
    );
    signal.throwIfAborted();
    phase = "download";
    downloadBlob(
      new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
        type: "application/pdf",
      }),
      `${fileTitle(doc.title)}-译文.pdf`,
    );
    // Browser download initiation is observable; disk completion is not.
    event(
      "download_requested",
      `pages=${result.pages} translated=${result.translated} preserved=${result.issues.length} annotations=${result.annotationsExported ?? 0}`,
    );
    const { bytes: _bytes, ...summary } = result;
    return summary;
  } catch (error) {
    event(
      signal.aborted ? "cancelled" : "failed",
      signal.aborted
        ? "reasonCode=user_cancelled"
        : exportFailureDetail(
            exportFailure(
              error,
              phase === "download"
                ? "download"
                : phase === "layout"
                  ? "layout"
                  : phase === "saving"
                    ? "save"
                    : "unrecognized",
            ),
          ),
    );
    if (signal.aborted) throw new DOMException("已取消导出", "AbortError");
    throw error;
  }
}

/** Runs translated PDF export from library context menus with toast feedback. */
export function exportTranslatedPDFWithToast(doc: Document) {
  const controller = new AbortController();
  const id = toast.loading("正在导出译文 PDF…");
  return exportTranslatedPDF(doc, controller.signal, (progress) => {
    if (progress.phase === "pages" && progress.total > 0) {
      toast.loading(
        `正在排版译文 PDF（${progress.done + 1} / ${progress.total} 页）…`,
        {
          id,
        },
      );
    } else if (progress.phase === "saving") {
      toast.loading("正在写入译文与批注…", { id });
    }
  }).then(
    ({ translated, annotationsExported, annotationsSkipped, issues }) => {
      const parts = [`已写入 ${translated} 个译文段落`];
      if (annotationsExported) parts.push(`保留 ${annotationsExported} 条批注`);
      const details: string[] = [];
      if (issues.length) details.push(`${issues.length} 处未完成段落未包含`);
      if (annotationsSkipped)
        details.push(`${annotationsSkipped} 条批注无法定位`);
      toast.success(parts.join("，"), {
        id,
        description: details.length ? details.join("；") : undefined,
      });
    },
    (error: Error) => toast.error(error.message, { id }),
  );
}
