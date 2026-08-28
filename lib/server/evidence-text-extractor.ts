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
const HTML_SECTION_BYTES = 32 * 1024;
const HTML_STRIPPED_ELEMENTS = new Set(["script", "style", "form", "iframe", "object", "embed", "svg"]);
const HTML_BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "figcaption", "figure",
  "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p",
  "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

export type EvidenceExtractionOptions = {
  maxPages?: number;
  maxOutputBytes?: number;
  maxExtractionMs?: number;
  now?: () => number;
  abortSignal?: AbortSignal;
  /** Server-only test seam for interruptible PDF.js operations. */
  pdfLoader?: EvidencePdfLoader;
};

export type HtmlEvidenceExtractionOptions = {
  maxPages?: number;
  maxOutputBytes?: number;
};

export type EvidencePdfTextContent = { items: Array<{ str?: string }> };
export type EvidencePdfOperatorList = { argsArray: unknown[] };
export type EvidencePdfObjectStore = {
  get: (id: string, callback?: (value: unknown) => void) => unknown;
};
export type EvidencePdfPage = {
  getTextContent: () => Promise<EvidencePdfTextContent>;
  getOperatorList?: () => Promise<EvidencePdfOperatorList>;
  objs?: EvidencePdfObjectStore;
  commonObjs?: EvidencePdfObjectStore;
};
export type EvidencePdfDocument = { numPages: number; getPage: (page: number) => Promise<EvidencePdfPage> };
export type EvidencePdfLoadingTask = { promise: Promise<EvidencePdfDocument>; destroy: () => Promise<void> };
export type EvidencePdfLoader = {
  getDocument: (input: { data: Uint8Array; useWorkerFetch: false; isEvalSupported: false; stopAtErrors: true }) => EvidencePdfLoadingTask;
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

function htmlTagEnd(html: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index]!;
    if (quote !== "") {
      if (character === quote) quote = "";
      continue;
    }
    if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function decodeHtmlEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", copy: "©", emsp: " ", ensp: " ", gt: ">", hellip: "…", lt: "<",
    mdash: "—", nbsp: " ", ndash: "–", quot: "\"", reg: "®",
  };
  if (entity[0] !== "#") return named[entity.toLowerCase()] ?? `&${entity};`;
  const hexadecimal = entity[1]?.toLowerCase() === "x";
  const digits = entity.slice(hexadecimal ? 2 : 1);
  if (!(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) return `&${entity};`;
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return "�";
  return String.fromCodePoint(codePoint);
}

/** Converts untrusted HTML to plain text without creating a DOM or retaining active content. */
function inertHtmlText(html: string): string {
  const output: string[] = [];
  const strippedStack: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    if (html[cursor] !== "<") {
      const nextTag = html.indexOf("<", cursor);
      const end = nextTag === -1 ? html.length : nextTag;
      if (strippedStack.length === 0) output.push(html.slice(cursor, end));
      cursor = end;
      continue;
    }
    if (html.startsWith("<!--", cursor)) {
      const commentEnd = html.indexOf("-->", cursor + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }
    const end = htmlTagEnd(html, cursor);
    if (end === -1) break;
    const token = html.slice(cursor + 1, end);
    const match = /^\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(token);
    if (!match) {
      if (strippedStack.length === 0) output.push("<");
      cursor += 1;
      continue;
    }
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();
    if (HTML_STRIPPED_ELEMENTS.has(name)) {
      if (closing) {
        if (strippedStack.at(-1) === name) strippedStack.pop();
      } else {
        // HTML ignores self-closing syntax on these content-bearing elements.
        // Keep stripping until the matching end tag instead of trusting `/ >`.
        strippedStack.push(name);
      }
    } else if (strippedStack.length === 0 && HTML_BLOCK_ELEMENTS.has(name)) {
      output.push("\n");
    }
    cursor = end + 1;
  }
  return output.join("")
    .replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (_match, entity: string) => decodeHtmlEntity(entity))
    .replace(/[\s\u00a0]+/gu, " ")
    .trim();
}

/** Extracts bounded section locators from an inert, whitespace-normalized HTML snapshot. */
export function extractHtmlTextSections(
  html: string,
  options: HtmlEvidenceExtractionOptions = {},
): { text: string; pages: ExtractedPage[] } {
  const maxPages = Math.min(options.maxPages ?? 64, 64);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? 2 * 1024 * 1024, 2 * 1024 * 1024);
  const text = inertHtmlText(html);
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength > maxOutputBytes) throw new Error("추출 텍스트 크기 제한을 초과했습니다.");
  if (text === "") return { text, pages: [] };

  const sections: string[] = [];
  let section = "";
  let sectionBytes = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (sectionBytes + characterBytes > HTML_SECTION_BYTES && section !== "") {
      sections.push(section.trim());
      section = "";
      sectionBytes = 0;
      if (sections.length >= maxPages) throw new Error("웹 문서 섹션 제한을 초과했습니다.");
    }
    section += character;
    sectionBytes += characterBytes;
  }
  if (section.trim() !== "") sections.push(section.trim());
  if (sections.length > maxPages) throw new Error("웹 문서 섹션 제한을 초과했습니다.");
  return {
    text,
    pages: sections.map((value, index) => ({ locator: `section:${index + 1}`, text: value })),
  };
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

function decodedImageIds(operatorList: EvidencePdfOperatorList): string[] {
  const ids = new Set<string>();
  for (const argument of operatorList.argsArray) {
    if (!Array.isArray(argument)) continue;
    for (const value of argument) {
      if (typeof value === "string" && (value.startsWith("img_") || value.includes("_img_"))) {
        ids.add(value);
      }
    }
  }
  return [...ids];
}

function getDecodedPdfObject(store: EvidencePdfObjectStore, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let callbackCalled = false;
    try {
      const existing = store.get(id, (value) => {
        callbackCalled = true;
        resolve(value);
      });
      if (!callbackCalled && existing !== undefined && existing !== null) resolve(existing);
    } catch (error) {
      reject(error);
    }
  });
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
    stopAtErrors: true,
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
      if (page.getOperatorList !== undefined && page.objs !== undefined) {
        const operators = await guard.wait(page.getOperatorList(), destroy);
        for (const imageId of decodedImageIds(operators)) {
          const objectStore = imageId.startsWith("g_") ? page.commonObjs : page.objs;
          if (objectStore === undefined) throw new Error("PDF 이미지 스트림을 확인할 수 없습니다.");
          const image = await guard.wait(getDecodedPdfObject(objectStore, imageId), destroy);
          if (image === null || image === undefined) throw new Error("PDF 이미지 스트림을 확인할 수 없습니다.");
        }
      }
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
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") {
      throw new PdfPasswordProtectedError();
    }
    throw error;
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
