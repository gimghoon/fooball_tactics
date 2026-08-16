import { EvidenceValidationError } from "../domain/evidence.ts";
import {
  extractEvidenceText,
  type EvidenceFileKind,
  type ExtractedPage,
  PdfPasswordProtectedError,
} from "./evidence-text-extractor.ts";
import {
  validatePdfFlateStreams,
  type EvidencePdfPreflightOptions,
} from "./evidence-pdf-preflight.ts";

const MAX_EVIDENCE_FILE_BYTES = 20 * 1024 * 1024;
const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x1f, 0x8b],
  [0x52, 0x61, 0x72, 0x21],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
];
const EXECUTABLE_SIGNATURES = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0x50, 0x45, 0x00, 0x00],
];
const PDF_EOF_MARKER = new TextEncoder().encode("%%EOF");
const DELETE_RECONCILIATION_ATTEMPTS = 2;

export type EvidenceMediaType = "application/pdf" | "text/plain" | "text/markdown";

export type ValidatedEvidenceFile = {
  kind: EvidenceFileKind;
  mediaType: EvidenceMediaType;
  sha256: string;
  bytes: Uint8Array;
  /** PDF.js page/content preflight, reused after the original object is stored. */
  preflightExtractedPages: ExtractedPage[] | null;
};

export type EvidenceFileInput = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type StoredEvidenceFile = {
  id: string;
  bundleId: string;
  originalFileName: string;
  mediaType: EvidenceMediaType;
  byteSize: number;
  contentHash: string;
  storageKey: string;
  extractedTextKey: string | null;
  extractionStatus: "pending" | "completed" | "failed";
  extractionError: string | null;
};

export type EvidenceR2Bucket = {
  put(key: string, value: Uint8Array | string): Promise<unknown>;
  get(key: string): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
};

export type EvidenceR2Body = { body: ReadableStream<Uint8Array> | null };
export type EvidenceR2Value = Uint8Array | string | EvidenceR2Body;

export type EvidenceD1Statement = {
  bind(...values: unknown[]): EvidenceD1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};

export type EvidenceD1Database = {
  prepare(query: string): EvidenceD1Statement;
};

/** Service-owned registration keeps a new source in the same version/audit mutation. */
export type EvidenceSourceRegistrationPort = {
  findExisting(bundleId: string, contentHash: string): Promise<StoredEvidenceFile | null>;
  register(source: StoredEvidenceFile): Promise<StoredEvidenceFile>;
};

function isEvidenceR2Body(value: unknown): value is EvidenceR2Body {
  return typeof value === "object" && value !== null && "body" in value;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function containsBytes(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  return bytes.some((_, index) => needle.every((byte, offset) => bytes[index + offset] === byte));
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from: number): number {
  for (let index = from; index <= bytes.length - needle.length; index += 1) {
    if (needle.every((byte, offset) => bytes[index + offset] === byte)) return index;
  }
  return -1;
}

function hasDecodedPdfName(bytes: Uint8Array, expected: string): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x2f) continue; // '/'
    let name = "";
    for (let cursor = index + 1; cursor < bytes.length; cursor += 1) {
      const byte = bytes[cursor];
      if (byte === 0x23 && cursor + 2 < bytes.length) { // '#'
        const hex = String.fromCharCode(bytes[cursor + 1], bytes[cursor + 2]);
        if (/^[0-9a-f]{2}$/i.test(hex)) {
          name += String.fromCharCode(Number.parseInt(hex, 16));
          cursor += 2;
          continue;
        }
      }
      if (byte <= 0x20 || "()<>[]{}/%".includes(String.fromCharCode(byte))) break;
      name += String.fromCharCode(byte);
    }
    if (name === expected) return true;
  }
  return false;
}

function hasUnsafePdfTrailer(bytes: Uint8Array): boolean {
  const eof = indexOfBytes(bytes, PDF_EOF_MARKER, 0);
  if (eof === -1) return false;
  const trailingBytes = bytes.subarray(eof + PDF_EOF_MARKER.length);
  // MVP evidence uploads reject incremental PDFs: after the first PDF EOF,
  // only whitespace is allowed. This treats any archive/executable payload
  // (including one that embeds a later %%EOF marker) as a polyglot, without
  // scanning regular compressed object streams before the PDF boundary.
  return trailingBytes.some((byte) => ![0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(byte));
}

function extensionFor(name: string): string {
  const extension = name.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return extension ?? "";
}

function invalidFormat(): never {
  throw new EvidenceValidationError("파일 형식이 올바르지 않습니다.");
}

function isUnsafeTextSignature(bytes: Uint8Array): boolean {
  return ZIP_SIGNATURES.some((signature) => startsWith(bytes, signature))
    || EXECUTABLE_SIGNATURES.some((signature) => startsWith(bytes, signature))
    || bytes.includes(0);
}

function resolveKindAndMediaType(input: EvidenceFileInput): Pick<ValidatedEvidenceFile, "kind" | "mediaType"> {
  const extension = extensionFor(input.name);
  if (extension === "pdf") {
    if (input.type !== "application/pdf" || !startsWith(input.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) invalidFormat();
    if (hasUnsafePdfTrailer(input.bytes)) invalidFormat();
    if (containsBytes(input.bytes, "/Encrypt") || hasDecodedPdfName(input.bytes, "Encrypt")) {
      throw new EvidenceValidationError("암호화된 PDF는 업로드할 수 없습니다.");
    }
    return { kind: "pdf", mediaType: "application/pdf" };
  }

  if (extension === "txt" && input.type === "text/plain") {
    if (isUnsafeTextSignature(input.bytes)) invalidFormat();
    return { kind: "text", mediaType: "text/plain" };
  }
  if ((extension === "md" || extension === "markdown") && (input.type === "text/markdown" || input.type === "text/plain")) {
    if (isUnsafeTextSignature(input.bytes)) invalidFormat();
    return { kind: "text", mediaType: "text/markdown" };
  }
  return invalidFormat();
}

/** Validates file identity and bytes before any R2 object is written. */
export async function validateEvidenceFile(
  input: EvidenceFileInput,
  preflightOptions: EvidencePdfPreflightOptions = {},
): Promise<ValidatedEvidenceFile> {
  if (input.bytes.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    throw new EvidenceValidationError("파일은 20MB 이하여야 합니다.");
  }
  const file = resolveKindAndMediaType(input);
  let preflightExtractedPages: ExtractedPage[] | null = null;
  if (file.kind === "pdf") {
    try {
      const budget = await validatePdfFlateStreams(input.bytes, preflightOptions);
      preflightExtractedPages = await extractEvidenceText(file.kind, input.bytes, {
        maxExtractionMs: budget.remainingMs(),
        now: preflightOptions.now,
        abortSignal: preflightOptions.abortSignal,
      });
    } catch (error) {
      if (error instanceof PdfPasswordProtectedError) throw new EvidenceValidationError(error.message);
      throw new EvidenceValidationError("PDF 파일을 확인할 수 없습니다.");
    }
  }
  if (file.kind === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new EvidenceValidationError("텍스트 파일은 UTF-8이어야 합니다.");
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", input.bytes);
  const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return { ...file, sha256, bytes: input.bytes, preflightExtractedPages };
}

function opaqueStorageKey(bundleId: string, sourceId: string, sha256: string): string {
  return `bundles/${bundleId}/${sourceId}/${crypto.randomUUID()}-${sha256}`;
}

export class EvidenceFileStore {
  constructor(private readonly dependencies: {
    bucket: EvidenceR2Bucket;
    registration: EvidenceSourceRegistrationPort;
    preflightOptions?: EvidencePdfPreflightOptions;
  }) {}

  async putValidatedFile(
    input: EvidenceFileInput & { bundleId: string },
    requestPreflightOptions: EvidencePdfPreflightOptions = {},
  ): Promise<StoredEvidenceFile> {
    const file = await validateEvidenceFile(input, {
      ...this.dependencies.preflightOptions,
      ...requestPreflightOptions,
    });
    const existing = await this.dependencies.registration.findExisting(input.bundleId, file.sha256);
    if (existing !== null) return existing;

    const id = crypto.randomUUID();
    const storageKey = opaqueStorageKey(input.bundleId, id, file.sha256);
    let extractedTextKey: string | null = null;
    let extractionStatus: StoredEvidenceFile["extractionStatus"] = "completed";
    let extractionError: string | null = null;

    await this.dependencies.bucket.put(storageKey, file.bytes);
    try {
      const extracted = file.preflightExtractedPages ?? await extractEvidenceText(file.kind, file.bytes);
      if (file.kind === "pdf" && extracted.some((page) => page.text.trim() === "")) {
        extractionStatus = "failed";
        extractionError = "스캔 PDF는 OCR을 지원하지 않습니다.";
      } else {
        extractedTextKey = opaqueStorageKey(input.bundleId, id, file.sha256);
        await this.dependencies.bucket.put(extractedTextKey, JSON.stringify(extracted satisfies ExtractedPage[]));
      }
    } catch (error) {
      extractionStatus = "failed";
      extractionError = error instanceof Error ? error.message : "텍스트 추출에 실패했습니다.";
    }

    const source: StoredEvidenceFile = {
      id,
      bundleId: input.bundleId,
      originalFileName: input.name,
      mediaType: file.mediaType,
      byteSize: file.bytes.byteLength,
      contentHash: file.sha256,
      storageKey,
      extractedTextKey,
      extractionStatus,
      extractionError,
    };
    try {
      return await this.dependencies.registration.register(source);
    } catch (error) {
      await this.deleteFilePair(storageKey, extractedTextKey);
      const winner = await this.dependencies.registration.findExisting(input.bundleId, file.sha256);
      if (winner !== null) return winner;
      throw error;
    }
  }

  getFile(key: string): Promise<unknown | null> {
    return this.dependencies.bucket.get(key);
  }

  async deleteFilePair(originalKey: string, extractedKey: string | null): Promise<void> {
    const keys = [originalKey, ...(extractedKey === null ? [] : [extractedKey])];
    const snapshots = await Promise.all(keys.map((key) => this.snapshotFile(key)));
    let errors: unknown[] = [];
    for (let attempt = 0; attempt < DELETE_RECONCILIATION_ATTEMPTS; attempt += 1) {
      const results = await Promise.allSettled(keys.map((key) => this.dependencies.bucket.delete(key)));
      errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (errors.length === 0) return;
    }
    const restoration = await Promise.allSettled(snapshots.map((snapshot, index) =>
      snapshot === null ? undefined : this.dependencies.bucket.put(keys[index]!, snapshot),
    ));
    const restoreErrors = restoration.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    throw new AggregateError([...errors, ...restoreErrors], "근거 파일 쌍을 모두 삭제하지 못했습니다.");
  }

  /** Restores the R2 pair after D1 rejection only while D1 still owns the source. */
  async deleteFilePairWithCompensation<T>(
    originalKey: string,
    extractedKey: string | null,
    mutation: () => Promise<T>,
    shouldRestore: () => Promise<boolean>,
  ): Promise<T> {
    const keys = [originalKey, ...(extractedKey === null ? [] : [extractedKey])];
    const snapshots = await Promise.all(keys.map((key) => this.snapshotFile(key)));
    await this.deleteFilePair(originalKey, extractedKey);
    try {
      return await mutation();
    } catch (error) {
      let restore: boolean;
      try {
        restore = await shouldRestore();
      } catch (authorityError) {
        throw new AggregateError([error, authorityError], "근거 삭제 복구 여부를 확인하지 못했습니다.");
      }
      if (!restore) throw error;
      const restored = await Promise.allSettled(snapshots.map((snapshot, index) => snapshot === null ? undefined : this.dependencies.bucket.put(keys[index]!, snapshot)));
      const restoreErrors = restored.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (restoreErrors.length) throw new AggregateError([error, ...restoreErrors], "근거 삭제를 복구하지 못했습니다.");
      throw error;
    }
  }

  private async snapshotFile(key: string): Promise<Uint8Array | string | null> {
    const object = await this.dependencies.bucket.get(key);
    if (object === null || typeof object === "string") return object;
    if (object instanceof Uint8Array) return object.slice();
    if (!isEvidenceR2Body(object) || object.body === null) {
      throw new EvidenceValidationError("삭제 복구용 파일 본문을 읽을 수 없습니다.");
    }

    const reader = object.body.getReader();
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > MAX_EVIDENCE_FILE_BYTES) {
          await reader.cancel("Evidence file snapshot exceeds the deletion recovery limit.");
          throw new EvidenceValidationError("삭제 복구용 파일 크기 제한을 초과했습니다.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const snapshot = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      snapshot.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return snapshot;
  }

}
