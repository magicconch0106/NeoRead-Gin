import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@neoread/core";
import { PDFExportError, exportFailure } from "./translation/pdf-export-error";
const mocks = vi.hoisted(() => ({
  blocks: vi.fn(),
  translations: vi.fn(),
  annotations: vi.fn(),
  messages: vi.fn(),
  navigation: vi.fn(),
  engine: vi.fn(),
  log: vi.fn(),
  download: vi.fn(),
  toast: { loading: vi.fn(() => "toast-id"), success: vi.fn(), error: vi.fn() },
}));
vi.mock("@neoread/api", () => ({
  api: {
    blocks: mocks.blocks,
    translations: mocks.translations,
    annotations: mocks.annotations,
    messages: mocks.messages,
    navigation: mocks.navigation,
  },
  publicationURL: () => "/private-document.pdf",
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(),
}));
vi.mock("./translation/pdf-export", () => ({ translatedPDF: mocks.engine }));
vi.mock("./diagnostics", () => ({ reportDiagnostic: mocks.log }));
vi.mock("./download", () => ({
  downloadBlob: mocks.download,
  fileTitle: () => "document",
}));
import {
  exportTranslatedPDF,
  exportTranslatedPDFWithToast,
} from "./translated-pdf-export";
const doc = {
  id: "private-document",
  type: "pdf",
  title: "PRIVATE TITLE",
} as Document;
const secret =
  "PRIVATE BODY token=secret https://private.example /Users/private/file.pdf";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.toast.loading.mockReturnValue("toast-id");
  mocks.blocks.mockResolvedValue([]);
  mocks.translations.mockResolvedValue([]);
  mocks.annotations.mockResolvedValue([]);
  mocks.messages.mockResolvedValue([]);
  mocks.navigation.mockResolvedValue({ revision: 0, entries: {} });
  mocks.engine.mockResolvedValue({
    bytes: new Uint8Array(),
    translated: 1,
    pages: 1,
    issues: [],
    annotationsExported: 0,
    annotationsSkipped: 0,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    }),
  );
});
it.each([
  "snapshot",
  "font_load",
  "pdf_decode",
  "encrypted_pdf",
  "font_embed",
  "layout",
  "no_translated_blocks",
  "save",
  "download",
] as const)(
  "logs a controlled %s failure without exception contents",
  async (reason) => {
    const raw = new Error(secret);
    if (reason === "snapshot") mocks.blocks.mockRejectedValue(raw);
    else if (reason === "font_load") vi.mocked(fetch).mockRejectedValue(raw);
    else if (reason === "download")
      mocks.download.mockImplementation(() => {
        throw raw;
      });
    else mocks.engine.mockRejectedValue(new PDFExportError(reason, raw));
    await expect(
      exportTranslatedPDF(doc, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(secret);
    const events = mocks.log.mock.calls.map(([event]) => event);
    const failures = events.filter(
      (event) => event.event === "pdf.translation_export.failed",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      level: "error",
      requestId: events[0].requestId,
    });
    expect(failures[0].detail).toContain(`reasonCode=${reason}`);
    expect(failures[0].detail).toContain("errorCode=");
    expect(JSON.stringify(events)).not.toMatch(
      /PRIVATE|secret|private-document|private.example|Users/,
    );
  },
);
it("recognizes only explicit encrypted-PDF error names during decoding", () => {
  const error = new Error(secret);
  error.name = "PasswordException";
  expect(exportFailure(error, "pdf_decode").reason).toBe("encrypted_pdf");
  expect(exportFailure(error, "font_embed").reason).toBe("font_embed");
  expect(
    exportFailure(new Error("PasswordException"), "pdf_decode").reason,
  ).toBe("pdf_decode");
});
it("records cancellation as one informational terminal event", async () => {
  const controller = new AbortController();
  mocks.engine.mockImplementation(() => {
    controller.abort();
    throw new Error(secret);
  });
  await expect(
    exportTranslatedPDF(doc, controller.signal, vi.fn()),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "info",
      event: "pdf.translation_export.cancelled",
      detail: expect.stringContaining("reasonCode=user_cancelled"),
    }),
  );
  expect(
    mocks.log.mock.calls.filter(([e]) => e.event.endsWith("failed")),
  ).toHaveLength(0);
  expect(mocks.download).not.toHaveBeenCalled();
});
it("keeps successful downloads free of failure diagnostics", async () => {
  await exportTranslatedPDF(doc, new AbortController().signal, vi.fn());
  expect(mocks.log).toHaveBeenLastCalledWith(
    expect.objectContaining({
      event: "pdf.translation_export.download_requested",
    }),
  );
  expect(
    mocks.log.mock.calls.filter(([e]) => e.event.endsWith("failed")),
  ).toHaveLength(0);
});

it("passes PDF annotations, Q&A answers and navigation to the engine and reports toast counts", async () => {
  mocks.annotations.mockResolvedValue([
    {
      id: "a1",
      kind: "question",
      answerId: "m1",
      location: { type: "pdf", page: 1 },
    },
    {
      id: "b1",
      kind: "bookmark",
      location: { type: "pdf", page: 1 },
    },
  ]);
  mocks.messages.mockResolvedValue([{ id: "m1", content: "AI 回答正文" }]);
  mocks.engine.mockResolvedValue({
    bytes: new Uint8Array([37, 80, 68, 70]),
    translated: 5,
    pages: 2,
    issues: [{ page: 2, blockId: "p2-b1", reason: "overflow" }],
    annotationsExported: 1,
    annotationsSkipped: 0,
  });

  await exportTranslatedPDFWithToast(doc);
  const options = mocks.engine.mock.calls[0][5];
  expect(options.annotations.map((a: { id: string }) => a.id)).toEqual(["a1"]);
  expect(options.answers).toEqual({ m1: "AI 回答正文" });
  expect(options.navigation).toBeTypeOf("function");
  expect(mocks.toast.success).toHaveBeenCalledWith(
    "已写入 5 个译文段落，保留 1 条批注",
    {
      id: "toast-id",
      description: "1 处保留原文",
    },
  );
});
