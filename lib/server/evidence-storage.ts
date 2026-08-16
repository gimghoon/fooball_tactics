import { EvidenceValidationError } from "../domain/evidence.ts";
import {
  extractEvidenceText,
  type EvidenceFileKind,
  type ExtractedPage,
} from "./evidence-text-extractor.ts";

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
];

export type EvidenceMediaType = "application/pdf" | "text/plain" | "text/markdown";

export type ValidatedEvidenceFile = {
  kind: EvidenceFileKind;
  mediaType: EvidenceMediaType;
  sha256: string;
  bytes: Uint8Array;
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

export type EvidenceD1Statement = {
  bind(...values: unknown[]): EvidenceD1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
};

export type EvidenceD1Database = {
  prepare(query: string): EvidenceD1Statement;
};

type EvidenceSourceRow = StoredEvidenceFile;

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

function containsBytes(bytes: Uint8Array, value: string): boolean {
  const needle = new TextEncoder().encode(value);
  return bytes.some((_, index) => needle.every((byte, offset) => bytes[index + offset] === byte));
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
    if (ZIP_SIGNATURES.some((signature) => startsWith(input.bytes, signature)) || EXECUTABLE_SIGNATURES.some((signature) => startsWith(input.bytes, signature))) invalidFormat();
    if (containsBytes(input.bytes, "/Encrypt")) throw new EvidenceValidationError("암호화된 PDF는 업로드할 수 없습니다.");
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
export async function validateEvidenceFile(input: EvidenceFileInput): Promise<ValidatedEvidenceFile> {
  if (input.bytes.byteLength > MAX_EVIDENCE_FILE_BYTES) {
    throw new EvidenceValidationError("파일은 20MB 이하여야 합니다.");
  }
  const file = resolveKindAndMediaType(input);
  if (file.kind === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    } catch {
      throw new EvidenceValidationError("텍스트 파일은 UTF-8이어야 합니다.");
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", input.bytes);
  const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return { ...file, sha256, bytes: input.bytes };
}

function sourceFromRow(row: EvidenceSourceRow): StoredEvidenceFile {
  return {
    ...row,
    mediaType: row.mediaType as EvidenceMediaType,
    extractedTextKey: row.extractedTextKey ?? null,
    extractionError: row.extractionError ?? null,
  };
}

function opaqueStorageKey(bundleId: string, sourceId: string, sha256: string): string {
  return `bundles/${bundleId}/${sourceId}/${crypto.randomUUID()}-${sha256}`;
}

export class EvidenceFileStore {
  constructor(private readonly dependencies: { bucket: EvidenceR2Bucket; database: EvidenceD1Database }) {}

  async putValidatedFile(input: EvidenceFileInput & { bundleId: string }): Promise<StoredEvidenceFile> {
    const file = await validateEvidenceFile(input);
    const existing = await this.findByBundleAndHash(input.bundleId, file.sha256);
    if (existing !== null) return existing;

    const id = crypto.randomUUID();
    const storageKey = opaqueStorageKey(input.bundleId, id, file.sha256);
    let extractedTextKey: string | null = null;
    let extractionStatus: StoredEvidenceFile["extractionStatus"] = "completed";
    let extractionError: string | null = null;

    await this.dependencies.bucket.put(storageKey, file.bytes);
    try {
      const extracted = await extractEvidenceText(file.kind, file.bytes);
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
      await this.insert(source);
      return source;
    } catch (error) {
      await this.deleteFilePair(storageKey, extractedTextKey);
      const winner = await this.findByBundleAndHash(input.bundleId, file.sha256);
      if (winner !== null) return winner;
      throw error;
    }
  }

  getFile(key: string): Promise<unknown | null> {
    return this.dependencies.bucket.get(key);
  }

  async deleteFilePair(originalKey: string, extractedKey: string | null): Promise<void> {
    await Promise.all([
      this.dependencies.bucket.delete(originalKey),
      ...(extractedKey === null ? [] : [this.dependencies.bucket.delete(extractedKey)]),
    ]);
  }

  private async findByBundleAndHash(bundleId: string, contentHash: string): Promise<StoredEvidenceFile | null> {
    const row = await this.dependencies.database.prepare(`
      SELECT id, bundle_id AS bundleId, original_file_name AS originalFileName,
        media_type AS mediaType, byte_size AS byteSize, content_hash AS contentHash,
        storage_key AS storageKey, extracted_text_key AS extractedTextKey,
        extraction_status AS extractionStatus, extraction_error AS extractionError
      FROM evidence_sources WHERE bundle_id = ? AND content_hash = ? LIMIT 1
    `).bind(bundleId, contentHash).first<EvidenceSourceRow>();
    return row === null ? null : sourceFromRow(row);
  }

  private async insert(source: StoredEvidenceFile): Promise<void> {
    await this.dependencies.database.prepare(`
      INSERT INTO evidence_sources (
        id, bundle_id, original_file_name, media_type, byte_size, content_hash,
        storage_key, extracted_text_key, extraction_status, extraction_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      source.id, source.bundleId, source.originalFileName, source.mediaType, source.byteSize,
      source.contentHash, source.storageKey, source.extractedTextKey, source.extractionStatus,
      source.extractionError, Date.now(), Date.now(),
    ).run();
  }
}
