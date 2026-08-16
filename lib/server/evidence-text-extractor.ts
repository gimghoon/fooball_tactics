export type EvidenceFileKind = "pdf" | "text";

export type ExtractedPage = {
  locator: string;
  text: string;
};

// These keep one Cloudflare Worker invocation bounded even when a PDF expands
// dramatically after decoding. Callers may lower them in tests, never raise them.
export const MAX_PDF_PAGES = 200;
export const MAX_EXTRACTED_OUTPUT_BYTES = 5 * 1024 * 1024;
export const MAX_EXTRACTION_MS = 10_000;

export type EvidenceExtractionOptions = {
  maxPages?: number;
  maxOutputBytes?: number;
  maxExtractionMs?: number;
  now?: () => number;
  abortSignal?: AbortSignal;
  /** Server-only test seam for interruptible PDF.js operations. */
  pdfLoader?: EvidencePdfLoader;
};

export type EvidencePdfTextContent = { items: Array<{ str?: string }> };
export type EvidencePdfPage = { getTextContent: () => Promise<EvidencePdfTextContent> };
export type EvidencePdfDocument = { numPages: number; getPage: (page: number) => Promise<EvidencePdfPage> };
export type EvidencePdfLoadingTask = { promise: Promise<EvidencePdfDocument>; destroy: () => Promise<void> };
export type EvidencePdfLoader = {
  getDocument: (input: { data: Uint8Array; useWorkerFetch: false; isEvalSupported: false }) => EvidencePdfLoadingTask;
};

export class PdfPasswordProtectedError extends Error {
  constructor() {
    super("암호화된 PDF는 업로드할 수 없습니다.");
    this.name = "PdfPasswordProtectedError";
  }
}

type ExtractionBudget = {
  add: (page: ExtractedPage) => void;
  assertActive: () => void;
};

class ExtractionInterruptedError extends Error {
  constructor(kind: "abort" | "deadline") {
    super(kind === "abort" ? "텍스트 추출이 중단되었습니다." : "텍스트 추출 시간 제한을 초과했습니다.");
    this.name = "ExtractionInterruptedError";
  }
}

type OperationGuard = {
  wait: <T>(operation: Promise<T>, destroy: () => Promise<void>) => Promise<T>;
  dispose: () => void;
};

function limit(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Math.min(value, maximum);
}

function createBudget(options: EvidenceExtractionOptions): ExtractionBudget {
  const maxPages = limit(options.maxPages, MAX_PDF_PAGES);
  const maxOutputBytes = limit(options.maxOutputBytes, MAX_EXTRACTED_OUTPUT_BYTES);
  const maxExtractionMs = limit(options.maxExtractionMs, MAX_EXTRACTION_MS);
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  const encoder = new TextEncoder();
  let pages = 0;
  let outputBytes = 2; // The enclosing JSON array brackets written by storage.

  function assertWithinTimeBudget(): void {
    if (options.abortSignal?.aborted) {
      throw new Error("텍스트 추출이 중단되었습니다.");
    }
    if (now() - startedAt > maxExtractionMs) {
      throw new Error("텍스트 추출 시간 제한을 초과했습니다.");
    }
  }

  return {
    assertActive: assertWithinTimeBudget,
    add(page) {
      assertWithinTimeBudget();
      pages += 1;
      if (pages > maxPages) throw new Error("PDF 페이지 제한을 초과했습니다.");
      // Count the exact per-page JSON representation before retaining it. This
      // prevents an oversized R2 extraction payload from being assembled later.
      const nextBytes = encoder.encode(JSON.stringify(page)).byteLength + (pages === 1 ? 0 : 1);
      if (outputBytes + nextBytes > maxOutputBytes) {
        throw new Error("추출 텍스트 크기 제한을 초과했습니다.");
      }
      outputBytes += nextBytes;
    },
  };
}

function createOperationGuard(options: EvidenceExtractionOptions): OperationGuard {
  const maxExtractionMs = limit(options.maxExtractionMs, MAX_EXTRACTION_MS);
  const now = options.now ?? performance.now.bind(performance);
  const deadline = now() + maxExtractionMs;
  let rejectInterruption!: (reason: unknown) => void;
  const interruption = new Promise<never>((_, reject) => {
    rejectInterruption = reject;
  });
  // A pre-aborted signal may be noticed by the synchronous budget before this
  // promise is raced; attach a handler so it never becomes an unhandled reject.
  void interruption.catch(() => undefined);
  const onAbort = () => rejectInterruption(new ExtractionInterruptedError("abort"));
  if (options.abortSignal?.aborted) onAbort();
  else options.abortSignal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => rejectInterruption(new ExtractionInterruptedError("deadline")),
    Math.max(0, deadline - now()),
  );

  return {
    async wait<T>(operation: Promise<T>, destroy: () => Promise<void>): Promise<T> {
      try {
        return await Promise.race([operation, interruption]);
      } catch (error) {
        if (error instanceof ExtractionInterruptedError) void destroy();
        throw error;
      }
    },
    dispose() {
      clearTimeout(timeout);
      options.abortSignal?.removeEventListener("abort", onAbort);
    },
  };
}

function strictText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("텍스트 파일은 UTF-8이어야 합니다.");
  }
}

function extractTextParagraphs(bytes: Uint8Array, budget: ExtractionBudget): ExtractedPage[] {
  const pages: ExtractedPage[] = [];
  for (const paragraph of strictText(bytes).split(/\r?\n\s*\r?\n+/)) {
    const text = paragraph.trim();
    if (!text) continue;
    const page = { locator: `paragraph:${pages.length + 1}`, text };
    budget.add(page);
    pages.push(page);
  }
  return pages;
}

async function loadPdfJs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

async function defaultPdfLoader(): Promise<EvidencePdfLoader> {
  const { getDocument } = await loadPdfJs();
  return {
    getDocument: (input) => getDocument(input) as unknown as EvidencePdfLoadingTask,
  };
}

/** Identifies password-protected PDFs from PDF.js before any R2 persistence. */
export async function assertPdfIsNotPasswordProtected(bytes: Uint8Array): Promise<void> {
  const { getDocument, PasswordException } = await loadPdfJs();
  const loadingTask = getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => {
    destroyPromise ??= loadingTask.destroy().catch(() => undefined);
    return destroyPromise;
  };
  const guard = createOperationGuard({});
  try {
    await guard.wait(loadingTask.promise, destroy);
  } catch (error) {
    if (error instanceof PasswordException || (error instanceof Error && error.name === "PasswordException")) {
      throw new PdfPasswordProtectedError();
    }
    if (error instanceof ExtractionInterruptedError) throw error;
    throw error;
  } finally {
    guard.dispose();
    await destroy();
  }
}

async function extractPdfPages(
  bytes: Uint8Array,
  budget: ExtractionBudget,
  maxPages: number,
  options: EvidenceExtractionOptions,
): Promise<ExtractedPage[]> {
  budget.assertActive();
  const loader = options.pdfLoader ?? await defaultPdfLoader();
  const loadingTask = loader.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
  });
  let destroyPromise: Promise<void> | undefined;
  const destroy = () => {
    destroyPromise ??= loadingTask.destroy().catch(() => undefined);
    return destroyPromise;
  };
  const guard = createOperationGuard(options);

  try {
    const document = await guard.wait(loadingTask.promise, destroy);
    if (document.numPages > maxPages) throw new Error("PDF 페이지 제한을 초과했습니다.");
    const pages: ExtractedPage[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const page = await guard.wait(document.getPage(index), destroy);
      const content = await guard.wait(page.getTextContent(), destroy);
      const text = content.items
        .filter((item): item is typeof item & { str: string } => typeof item.str === "string")
        .map((item) => item.str)
        .join(" ");
      const extractedPage = { locator: `page:${index}`, text };
      budget.add(extractedPage);
      pages.push(extractedPage);
    }
    return pages;
  } finally {
    guard.dispose();
    await destroy();
  }
}

/** Extracts text only; scanned PDFs deliberately remain unsupported in the MVP. */
export async function extractEvidenceText(
  kind: EvidenceFileKind,
  bytes: Uint8Array,
  options: EvidenceExtractionOptions = {},
): Promise<ExtractedPage[]> {
  const budget = createBudget(options);
  return kind === "pdf"
    ? extractPdfPages(bytes, budget, limit(options.maxPages, MAX_PDF_PAGES), options)
    : extractTextParagraphs(bytes, budget);
}
