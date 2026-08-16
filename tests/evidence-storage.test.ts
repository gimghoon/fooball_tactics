import assert from "node:assert/strict";
import test from "node:test";

import {
  EvidenceFileStore,
  validateEvidenceFile,
} from "../lib/server/evidence-storage.ts";
import { extractEvidenceText } from "../lib/server/evidence-text-extractor.ts";

function textFile(bytes: Uint8Array) {
  return {
    name: "notes.txt",
    type: "text/plain",
    bytes,
  };
}

function fakePdfWithZipSignature() {
  return {
    name: "notes.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("PK%PDF-1.7"),
  };
}

function encryptedPdf() {
  return {
    name: "notes.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7\ntrailer\n<< /Encrypt 1 0 R >>"),
  };
}

function textPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(document.length);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(document);
}

test("accepts the exact 20 MiB boundary and rejects one byte over", async () => {
  const bytes = new Uint8Array(20 * 1024 * 1024 + 1).fill(0x61);
  await assert.doesNotReject(() => validateEvidenceFile(textFile(bytes.subarray(0, -1))));
  await assert.rejects(() => validateEvidenceFile(textFile(bytes)), /20MB/);
});

test("rejects MIME, extension, signature, archive, executable, and encrypted PDF mismatches", async () => {
  await assert.rejects(() => validateEvidenceFile({ name: "notes.txt", type: "application/pdf", bytes: new TextEncoder().encode("notes") }), /형식/);
  await assert.rejects(() => validateEvidenceFile({ name: "notes.pdf", type: "text/plain", bytes: new TextEncoder().encode("notes") }), /형식/);
  await assert.rejects(() => validateEvidenceFile({ name: "notes.pdf", type: "application/pdf", bytes: new TextEncoder().encode("not a pdf") }), /형식/);
  await assert.rejects(() => validateEvidenceFile(fakePdfWithZipSignature()), /형식/);
  await assert.rejects(() => validateEvidenceFile({ name: "notes.md", type: "text/markdown", bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) }), /형식/);
  await assert.rejects(() => validateEvidenceFile({ name: "notes.txt", type: "text/plain", bytes: new Uint8Array([0x4d, 0x5a]) }), /형식/);
  await assert.rejects(() => validateEvidenceFile({ name: "notes.txt", type: "text/plain", bytes: new Uint8Array([0x61, 0]) }), /형식/);
  await assert.rejects(() => validateEvidenceFile(encryptedPdf()), /암호화/);
});

test("extracts strict UTF-8 text into non-empty paragraph locators", async () => {
  const pages = await extractEvidenceText("text", new TextEncoder().encode("첫 문단\n둘째 줄\n\n\n두 번째 문단"));
  assert.deepEqual(pages, [
    { locator: "paragraph:1", text: "첫 문단\n둘째 줄" },
    { locator: "paragraph:2", text: "두 번째 문단" },
  ]);
  await assert.rejects(() => extractEvidenceText("text", new Uint8Array([0xc3, 0x28])), /UTF-8/);
});

test("extracts text-only PDF pages without a worker", async () => {
  assert.deepEqual(await extractEvidenceText("pdf", textPdf("Press forward")), [
    { locator: "page:1", text: "Press forward" },
  ]);
});

type SourceRow = {
  id: string;
  bundleId: string;
  originalFileName: string;
  mediaType: string;
  byteSize: number;
  contentHash: string;
  storageKey: string;
  extractedTextKey: string | null;
  extractionStatus: "pending" | "completed" | "failed";
  extractionError: string | null;
};

class FakeR2 {
  readonly objects = new Map<string, unknown>();
  readonly putKeys: string[] = [];

  async put(key: string, value: unknown): Promise<void> {
    this.putKeys.push(key);
    this.objects.set(key, value);
  }

  async get(key: string): Promise<unknown | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

class FakeD1Statement {
  private values: unknown[] = [];

  constructor(
    private readonly sql: string,
    private readonly database: FakeD1,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    const [bundleId, contentHash] = this.values as [string, string];
    return (this.database.rows.find((row) => row.bundleId === bundleId && row.contentHash === contentHash) ?? null) as T | null;
  }

  async run(): Promise<void> {
    assert.match(this.sql, /^\s*INSERT INTO evidence_sources/);
    const [id, bundleId, originalFileName, mediaType, byteSize, contentHash, storageKey, extractedTextKey, extractionStatus, extractionError] = this.values as [
      string, string, string, string, number, string, string, string | null, SourceRow["extractionStatus"], string | null,
    ];
    this.database.rows.push({ id, bundleId, originalFileName, mediaType, byteSize, contentHash, storageKey, extractedTextKey, extractionStatus, extractionError });
  }
}

class FakeD1 {
  readonly rows: SourceRow[] = [];

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }
}

test("persists one opaque original and extracted pair, then reuses a duplicate source", async () => {
  const bucket = new FakeR2();
  const database = new FakeD1();
  const store = new EvidenceFileStore({ bucket, database });
  const input = {
    bundleId: "bundle-1",
    name: "coach-secret-notes.md",
    type: "text/markdown",
    bytes: new TextEncoder().encode("첫 줄\n\n둘째 줄"),
  };

  const first = await store.putValidatedFile(input);
  const duplicate = await store.putValidatedFile(input);

  assert.equal(duplicate.id, first.id);
  assert.equal(database.rows.length, 1);
  assert.equal(bucket.putKeys.length, 2);
  assert.match(first.storageKey, /^bundles\/bundle-1\/[0-9a-f-]{36}\/[0-9a-f-]{36}-[a-f0-9]{64}$/);
  assert.match(first.extractedTextKey ?? "", /^bundles\/bundle-1\/[0-9a-f-]{36}\/[0-9a-f-]{36}-[a-f0-9]{64}$/);
  assert.equal(first.storageKey.includes(input.name), false);
  assert.equal(database.rows[0]?.originalFileName, input.name);
  assert.deepEqual(await store.getFile(first.storageKey), input.bytes);

  await store.deleteFilePair(first.storageKey, first.extractedTextKey);
  assert.equal(await store.getFile(first.storageKey), null);
  assert.equal(await store.getFile(first.extractedTextKey ?? "missing"), null);
});

test("preserves a scanned PDF and marks extraction as failed without OCR", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, database: new FakeD1() });

  const source = await store.putValidatedFile({
    bundleId: "bundle-1",
    name: "scan.pdf",
    type: "application/pdf",
    bytes: textPdf(""),
  });

  assert.equal(source.extractionStatus, "failed");
  assert.equal(source.extractionError, "스캔 PDF는 OCR을 지원하지 않습니다.");
  assert.equal(source.extractedTextKey, null);
  assert.equal(bucket.putKeys.length, 1);
});
