import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  EvidenceFileStore,
  validateEvidenceFile,
} from "../lib/server/evidence-storage.ts";
import { extractEvidenceText } from "../lib/server/evidence-text-extractor.ts";
import { validatePdfFlateStreams } from "../lib/server/evidence-pdf-preflight.ts";
import {
  ascii85FlateTextPdf,
  commentedIndirectLengthTextPdf,
  compressedObjectIndirectTextPdf,
  corruptJpegHuffmanImageScanPdf,
  corruptJpegImageScanPdf,
  corruptLzwPdf,
  corruptSecondFlatePdf,
  downstreamToleratedObjectHeaderPdf,
  excessivePredictorColorsPdf,
  imageBackedScanPdf,
  jpegImageScanPdf,
  indirectFilterCorruptFlatePdf,
  indirectInvalidPredictorPdf,
  indirectLengthTextPdf,
  invalidPredictorPdf,
  largeSingleRowPredictorPdf,
  lzwTextPdf,
  lzwFlateTextPdf,
  multiFlateTextPdf,
  multiFilterTextPdf,
  runLengthFlateTextPdf,
  sharedJpegTwoPageScanPdf,
  unsupportedFilterPdf,
} from "./helpers/evidence-pdf-fixtures.ts";

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

function escapedEncryptedPdf() {
  return {
    name: "notes.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7\ntrailer\n<< /Encr#79pt 1 0 R >>"),
  };
}

function appendBytes(bytes: Uint8Array, suffix: number[]): Uint8Array {
  const result = new Uint8Array(bytes.length + suffix.length);
  result.set(bytes);
  result.set(suffix, bytes.length);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function interruptiblePdfLoader(phase: "load" | "page" | "text") {
  const started = deferred<void>();
  const pending = deferred<never>();
  let destroyCalls = 0;
  const page = {
    getTextContent() {
      if (phase === "text") {
        started.resolve();
        return pending.promise;
      }
      return Promise.resolve({ items: [{ str: "ready" }] });
    },
  };
  const document = {
    numPages: 1,
    getPage() {
      if (phase === "page") {
        started.resolve();
        return pending.promise;
      }
      return Promise.resolve(page);
    },
  };
  const task = {
    get promise() {
      if (phase === "load") {
        started.resolve();
        return pending.promise;
      }
      return Promise.resolve(document);
    },
    async destroy() {
      destroyCalls += 1;
    },
  };
  return {
    loader: { getDocument: () => task },
    started: started.promise,
    destroyCalls: () => destroyCalls,
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

function corruptFlatePdf(filter = "/FlateDecode"): Uint8Array {
  const stream = "notflate";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${stream.length} /Filter ${filter} >>\nstream\n${stream}\nendstream`,
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

function textPdfWithUnreferencedPayload(payload: string): Uint8Array {
  const stream = "BT /F1 12 Tf 72 720 Td (Press forward) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${payload.length} >>\nstream\n${payload}\nendstream`,
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

function validFlateTextPdf(text: string, extraStreams: string[] = []): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const compressed = deflateSync(new TextEncoder().encode(content));
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const push = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  push("%PDF-1.4\n");
  for (const [id, object] of [
    [1, "<< /Type /Catalog /Pages 2 0 R >>"],
    [2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>"],
    [3, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"],
  ] as const) {
    offsets.push(length);
    push(`${id} 0 obj\n${object}\nendobj\n`);
  }
  offsets.push(length);
  push(`4 0 obj\n<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`);
  push(compressed);
  push("\nendstream\nendobj\n");
  offsets.push(length);
  push("5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  for (const [index, extra] of extraStreams.entries()) {
    const extraCompressed = deflateSync(new TextEncoder().encode(extra));
    offsets.push(length);
    push(`${index + 6} 0 obj\n<< /Length ${extraCompressed.byteLength} /Filter /FlateDecode >>\nstream\n`);
    push(extraCompressed);
    push("\nendstream\nendobj\n");
  }
  const xref = length;
  const size = offsets.length;
  push(`xref\n0 ${size}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const output = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
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
  await assert.rejects(() => validateEvidenceFile(escapedEncryptedPdf()), /암호화/);
  for (const suffix of [[0x50, 0x4b, 0x03, 0x04], [0x7f, 0x45, 0x4c, 0x46], [0x4d, 0x5a], [0x50, 0x45, 0, 0]]) {
    await assert.rejects(() => validateEvidenceFile({
      name: "polyglot.pdf",
      type: "application/pdf",
      bytes: appendBytes(textPdf("safe"), suffix),
    }), /형식/);
  }
  await assert.rejects(() => validateEvidenceFile({
    name: "later-eof-polyglot.pdf",
    type: "application/pdf",
    bytes: appendBytes(textPdf("safe"), [0x50, 0x4b, 0x03, 0x04, 0x25, 0x25, 0x45, 0x4f, 0x46]),
  }), /형식/);
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

test("enforces page, output, and deadline bounds before accumulating evidence text", async () => {
  await assert.rejects(() => extractEvidenceText("pdf", textPdf("one page"), { maxPages: 0 }), /페이지/);
  await assert.rejects(() => extractEvidenceText("text", new TextEncoder().encode("too long"), { maxOutputBytes: 10 }), /추출 텍스트/);
  let clock = 0;
  await assert.rejects(() => extractEvidenceText("text", new TextEncoder().encode("a"), {
    maxExtractionMs: 0,
    now: () => clock++,
  }), /시간/);
  await assert.rejects(() => extractEvidenceText("text", new TextEncoder().encode("a"), {
    abortSignal: AbortSignal.abort(),
  }), /중단/);
});

test("interrupts pending PDF.js load, page, and text promises and destroys each task", async () => {
  for (const phase of ["load", "page", "text"] as const) {
    const controller = new AbortController();
    const fake = interruptiblePdfLoader(phase);
    const extraction = extractEvidenceText("pdf", new Uint8Array(), {
      abortSignal: controller.signal,
      pdfLoader: fake.loader,
    });
    await fake.started;
    controller.abort();
    await assert.rejects(extraction, /중단/);
    assert.equal(fake.destroyCalls(), 1);
  }
});

test("times out a pending PDF.js load and destroys its task before it resolves", async () => {
  const fake = interruptiblePdfLoader("load");
  const extraction = extractEvidenceText("pdf", new Uint8Array(), {
    maxExtractionMs: 0,
    now: () => 0,
    pdfLoader: fake.loader,
  });
  await fake.started;
  await assert.rejects(extraction, /시간/);
  assert.equal(fake.destroyCalls(), 1);
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
  readonly deleteAttempts = new Map<string, number>();
  readonly deleteFailures = new Map<string, number>();

  async put(key: string, value: unknown): Promise<void> {
    this.putKeys.push(key);
    this.objects.set(key, value);
  }

  async get(key: string): Promise<unknown | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.deleteAttempts.set(key, (this.deleteAttempts.get(key) ?? 0) + 1);
    const failures = this.deleteFailures.get(key) ?? 0;
    if (failures > 0) {
      this.deleteFailures.set(key, failures - 1);
      throw new Error(`injected delete failure for ${key}`);
    }
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
    const source = { id, bundleId, originalFileName, mediaType, byteSize, contentHash, storageKey, extractedTextKey, extractionStatus, extractionError };
    if (this.database.nextUniqueConflict !== null) {
      this.database.rows.push(this.database.nextUniqueConflict);
      this.database.nextUniqueConflict = null;
      throw new Error("UNIQUE constraint failed: evidence_sources.bundle_id, evidence_sources.content_hash");
    }
    this.database.rows.push(source);
  }
}

class FakeD1 {
  readonly rows: SourceRow[] = [];
  nextUniqueConflict: SourceRow | null = null;

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(sql, this);
  }

  async findExisting(bundleId: string, contentHash: string): Promise<SourceRow | null> {
    return this.rows.find((row) => row.bundleId === bundleId && row.contentHash === contentHash) ?? null;
  }

  async register(source: SourceRow): Promise<SourceRow> {
    if (this.nextUniqueConflict !== null) {
      this.rows.push(this.nextUniqueConflict);
      this.nextUniqueConflict = null;
      throw new Error("UNIQUE constraint failed: evidence_sources.bundle_id, evidence_sources.content_hash");
    }
    this.rows.push(source);
    return source;
  }
}

test("persists one opaque original and extracted pair, then reuses a duplicate source", async () => {
  const bucket = new FakeR2();
  const database = new FakeD1();
  const store = new EvidenceFileStore({ bucket, registration: database });
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

test("reconciles both R2 keys after a one-sided pair deletion failure", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });
  bucket.objects.set("original", "original");
  bucket.objects.set("extracted", "extracted");
  bucket.deleteFailures.set("original", 1);

  await assert.doesNotReject(() => store.deleteFilePair("original", "extracted"));
  assert.equal(bucket.objects.size, 0);
  assert.equal(bucket.deleteAttempts.get("original"), 2);
  assert.equal(bucket.deleteAttempts.get("extracted"), 2);
});

test("restores the pair when one R2 deletion fails permanently", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });
  bucket.objects.set("original", "original");
  bucket.objects.set("extracted", "extracted");
  bucket.deleteFailures.set("original", 3);

  await assert.rejects(() => store.deleteFilePair("original", "extracted"), /모두/);
  assert.equal(await store.getFile("original"), "original");
  assert.equal(await store.getFile("extracted"), "extracted");
});

test("restores both R2 objects when the later authoritative mutation fails", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });
  bucket.objects.set("original", "original");
  bucket.objects.set("extracted", "extracted");

  await assert.rejects(
    () => store.deleteFilePairWithCompensation(
      "original",
      "extracted",
      async () => { throw new Error("late D1 failure"); },
      async () => true,
    ),
    /late D1 failure/,
  );
  assert.equal(await store.getFile("original"), "original");
  assert.equal(await store.getFile("extracted"), "extracted");
});

test("does not restore R2 objects when authoritative D1 says the source was deleted", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });
  bucket.objects.set("original", "original");
  bucket.objects.set("extracted", "extracted");

  await assert.rejects(
    () => store.deleteFilePairWithCompensation(
      "original",
      "extracted",
      async () => { throw new Error("lost delete CAS"); },
      async () => false,
    ),
    /lost delete CAS/,
  );
  assert.equal(await store.getFile("original"), null);
  assert.equal(await store.getFile("extracted"), null);
});

test("bounds Cloudflare R2 stream snapshots before attempting pair deletion", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  bucket.objects.set("original", {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks >= 21) controller.close();
        else {
          chunks += 1;
          controller.enqueue(chunk);
        }
      },
    }),
  });
  bucket.objects.set("extracted", "extracted");

  await assert.rejects(() => store.deleteFilePair("original", "extracted"), /복구용 파일 크기/);
  assert.equal(bucket.deleteAttempts.size, 0);
  assert.equal(await store.getFile("extracted"), "extracted");
});

test("cleans up loser objects and returns the D1 winner after a unique-content race", async () => {
  const bucket = new FakeR2();
  const database = new FakeD1();
  const input = {
    bundleId: "bundle-1",
    name: "race.md",
    type: "text/markdown",
    bytes: new TextEncoder().encode("same content"),
  };
  const validated = await validateEvidenceFile(input);
  const winner: SourceRow = {
    id: "winner",
    bundleId: input.bundleId,
    originalFileName: "winner.md",
    mediaType: "text/markdown",
    byteSize: input.bytes.byteLength,
    contentHash: validated.sha256,
    storageKey: "bundles/bundle-1/winner/original",
    extractedTextKey: "bundles/bundle-1/winner/extracted",
    extractionStatus: "completed",
    extractionError: null,
  };
  database.nextUniqueConflict = winner;

  const result = await new EvidenceFileStore({ bucket, registration: database }).putValidatedFile(input);

  assert.equal(result.id, "winner");
  assert.equal(bucket.objects.size, 0);
  assert.equal(bucket.putKeys.length, 2);
});

test("preserves a scanned PDF and marks extraction as failed without OCR", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });

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

test("rejects an unparseable PDF before persisting objects or metadata", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  const store = new EvidenceFileStore({ bucket, registration });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "broken.pdf",
    type: "application/pdf",
    bytes: new TextEncoder().encode("%PDF-1.7\n%%EOF"),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("rejects corrupt PDF page content before persisting objects or metadata", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  const store = new EvidenceFileStore({ bucket, registration });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "corrupt-stream.pdf",
    type: "application/pdf",
    bytes: corruptFlatePdf(),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("rejects PDF.js-recovered stream errors before persisting objects or metadata", async () => {
  for (const [name, bytes] of [
    ["invalid-predictor.pdf", invalidPredictorPdf()],
    ["unsupported-filter.pdf", unsupportedFilterPdf()],
    ["tolerated-object-header.pdf", downstreamToleratedObjectHeaderPdf()],
  ] as const) {
    const bucket = new FakeR2();
    const registration = new FakeD1();
    const store = new EvidenceFileStore({ bucket, registration });

    await assert.rejects(() => store.putValidatedFile({
      bundleId: "bundle-1",
      name,
      type: "application/pdf",
      bytes,
    }), /PDF 파일을 확인할 수 없습니다/);

    assert.equal(bucket.objects.size, 0, name);
    assert.equal(registration.rows.length, 0, name);
  }
});

test("rejects malformed indirect, LZW, and later filter stages before any persistence", async () => {
  for (const [name, bytes] of [
    ["corrupt-lzw.pdf", corruptLzwPdf()],
    ["corrupt-jpeg.pdf", corruptJpegImageScanPdf()],
    ["corrupt-jpeg-huffman.pdf", corruptJpegHuffmanImageScanPdf()],
    ["excessive-predictor-colors.pdf", excessivePredictorColorsPdf()],
    ["indirect-corrupt-flate.pdf", indirectFilterCorruptFlatePdf()],
    ["corrupt-second-flate.pdf", corruptSecondFlatePdf()],
    ["indirect-invalid-predictor.pdf", indirectInvalidPredictorPdf()],
  ] as const) {
    const bucket = new FakeR2();
    const registration = new FakeD1();

    await assert.rejects(() => new EvidenceFileStore({ bucket, registration }).putValidatedFile({
      bundleId: "bundle-1",
      name,
      type: "application/pdf",
      bytes,
    }), /PDF 파일을 확인할 수 없습니다/);

    assert.equal(bucket.objects.size, 0, name);
    assert.equal(bucket.putKeys.length, 0, name);
    assert.equal(registration.rows.length, 0, name);
  }
});

test("accepts image scans, indirect stream lengths, and supported filter pipelines", async () => {
  for (const [name, bytes, expectedStatus] of [
    ["image-scan.pdf", imageBackedScanPdf(), "failed"],
    ["jpeg-image-scan.pdf", jpegImageScanPdf(), "failed"],
    ["shared-jpeg-two-page-scan.pdf", sharedJpegTwoPageScanPdf(), "failed"],
    ["indirect-length.pdf", indirectLengthTextPdf(), "completed"],
    ["commented-indirect-length.pdf", commentedIndirectLengthTextPdf(), "completed"],
    ["compressed-object-indirect.pdf", compressedObjectIndirectTextPdf(), "completed"],
    ["multi-filter.pdf", multiFilterTextPdf(), "completed"],
    ["ascii85-flate.pdf", ascii85FlateTextPdf(), "completed"],
    ["runlength-flate.pdf", runLengthFlateTextPdf(), "completed"],
    ["lzw-flate.pdf", lzwFlateTextPdf(), "completed"],
    ["multi-flate.pdf", multiFlateTextPdf(), "completed"],
    ["lzw.pdf", lzwTextPdf(), "completed"],
  ] as const) {
    const bucket = new FakeR2();
    const registration = new FakeD1();
    const source = await new EvidenceFileStore({ bucket, registration }).putValidatedFile({
      bundleId: "bundle-1",
      name,
      type: "application/pdf",
      bytes,
    });

    assert.equal(source.extractionStatus, expectedStatus, name);
    assert.equal(registration.rows.length, 1, name);
    assert.equal(bucket.objects.size, expectedStatus === "failed" ? 1 : 2, name);
  }
});

test("decodes escaped Flate filter names and arrays before persistence", async () => {
  for (const filter of ["/Flate#44ecode", "[/F#6c]"]) {
    const bucket = new FakeR2();
    const registration = new FakeD1();
    const store = new EvidenceFileStore({ bucket, registration });

    await assert.rejects(() => store.putValidatedFile({
      bundleId: "bundle-1",
      name: "escaped-corrupt-stream.pdf",
      type: "application/pdf",
      bytes: corruptFlatePdf(filter),
    }), /PDF 파일을 확인할 수 없습니다/);

    assert.equal(bucket.objects.size, 0);
    assert.equal(registration.rows.length, 0);
  }
});

test("does not interpret filter-like bytes inside an enclosing stream payload", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  const store = new EvidenceFileStore({ bucket, registration });

  const source = await store.putValidatedFile({
    bundleId: "bundle-1",
    name: "payload-tokens.pdf",
    type: "application/pdf",
    bytes: textPdfWithUnreferencedPayload("<< /Length 8 /Filter /FlateDecode >> stream notflate endstream"),
  });

  assert.equal(source.extractionStatus, "completed");
  assert.equal(registration.rows.length, 1);
  assert.equal(bucket.objects.size, 2);
});

test("bounds each decoded Flate stream before any persistence", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  let cancelCalls = 0;
  const store = new EvidenceFileStore({
    bucket,
    registration,
    preflightOptions: {
      maxDecodedBytesPerStream: 64,
      decompressionStream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(40));
          controller.enqueue(new Uint8Array(40));
        },
        cancel() { cancelCalls += 1; },
      }),
    },
  });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "compressed-bomb.pdf",
    type: "application/pdf",
    bytes: validFlateTextPdf("Press forward"),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(cancelCalls, 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("bounds retained ASCII85, RunLength, LZW, and ASCIIHex wrapper stages", async () => {
  for (const [name, bytes] of [
    ["asciihex-flate.pdf", multiFilterTextPdf()],
    ["ascii85-flate.pdf", ascii85FlateTextPdf()],
    ["runlength-flate.pdf", runLengthFlateTextPdf()],
    ["lzw-flate.pdf", lzwFlateTextPdf()],
  ] as const) {
    const bucket = new FakeR2();
    const registration = new FakeD1();
    const store = new EvidenceFileStore({
      bucket,
      registration,
      preflightOptions: { maxDecodedBytesPerStream: 8 },
    });

    await assert.rejects(() => store.putValidatedFile({
      bundleId: "bundle-1",
      name,
      type: "application/pdf",
      bytes,
    }), /PDF 파일을 확인할 수 없습니다/);
    assert.equal(bucket.putKeys.length, 0, name);
    assert.equal(registration.rows.length, 0, name);
  }
});

test("checks the shared deadline throughout a large single predictor row", async () => {
  let clockChecks = 0;
  await validatePdfFlateStreams(largeSingleRowPredictorPdf(), {
    now: () => {
      clockChecks += 1;
      return 0;
    },
  });

  assert.ok(clockChecks > 128, `expected bounded predictor checkpoints, received ${clockChecks}`);
});

test("bounds aggregate decoded Flate bytes across multiple streams", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  const store = new EvidenceFileStore({
    bucket,
    registration,
    preflightOptions: {
      maxDecodedBytesPerStream: 1024,
      maxDecodedBytesAggregate: 200,
    },
  });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "aggregate-bomb.pdf",
    type: "application/pdf",
    bytes: validFlateTextPdf("ok", ["A".repeat(150), "B".repeat(150)]),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("cancels Flate decoding on its shared deadline before persistence", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  let cancelCalls = 0;
  let delayedChunk: ReturnType<typeof setTimeout> | undefined;
  const store = new EvidenceFileStore({
    bucket,
    registration,
    preflightOptions: {
      maxExtractionMs: 5,
      decompressionStream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          delayedChunk = setTimeout(() => {
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          }, 100);
        },
        cancel() {
          cancelCalls += 1;
          clearTimeout(delayedChunk);
        },
      }),
    },
  });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "slow-compressed.pdf",
    type: "application/pdf",
    bytes: validFlateTextPdf("Press forward"),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(cancelCalls, 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("cancels Flate decoding on abort before persistence", async () => {
  const bucket = new FakeR2();
  const registration = new FakeD1();
  const controller = new AbortController();
  let cancelCalls = 0;
  const store = new EvidenceFileStore({
    bucket,
    registration,
    preflightOptions: {
      abortSignal: controller.signal,
      decompressionStream: () => {
        queueMicrotask(() => controller.abort());
        return new ReadableStream<Uint8Array>({
          cancel() { cancelCalls += 1; },
        }, { highWaterMark: 0 });
      },
    },
  });

  await assert.rejects(() => store.putValidatedFile({
    bundleId: "bundle-1",
    name: "aborted-compressed.pdf",
    type: "application/pdf",
    bytes: validFlateTextPdf("Press forward"),
  }), /PDF 파일을 확인할 수 없습니다/);

  assert.equal(cancelCalls, 1);
  assert.equal(bucket.objects.size, 0);
  assert.equal(registration.rows.length, 0);
});

test("accepts a valid FlateDecode text page and reuses its completed preflight", async () => {
  const bucket = new FakeR2();
  const store = new EvidenceFileStore({ bucket, registration: new FakeD1() });

  const source = await store.putValidatedFile({
    bundleId: "bundle-1",
    name: "compressed.pdf",
    type: "application/pdf",
    bytes: validFlateTextPdf("Press forward"),
  });

  assert.equal(source.extractionStatus, "completed");
  assert.notEqual(source.extractedTextKey, null);
  assert.equal(bucket.putKeys.length, 2);
});
