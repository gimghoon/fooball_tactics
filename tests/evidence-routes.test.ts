import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceValidationError } from "../lib/domain/evidence.ts";
import { serializePublicTrainingScenario } from "../lib/domain/content.ts";
import type { EvidenceAdmin } from "../lib/server/evidence-auth.ts";
import { EvidenceConflictError } from "../lib/server/evidence-service.ts";
import { EvidenceFileStore, type StoredEvidenceFile } from "../lib/server/evidence-storage.ts";
import { EvidenceJobConfigurationConflictError, EvidenceNotFoundError, EvidenceRequestValidationError, EvidenceUnavailableError } from "../lib/server/evidence-errors.ts";
import {
  bindEvidenceSchedule,
  handleEvidenceAnalyzeStart,
  handleEvidenceBundleGet,
  handleEvidenceBundleUpdate,
  handleEvidenceCardReview,
  handleEvidenceClipCreate,
  handleEvidenceCollectionCreate,
  handleEvidenceCollectionList,
  handleEvidenceFileDelete,
  handleEvidenceFileDownload,
  handleEvidenceFileImpact,
  handleEvidenceFileUpload,
  handleEvidenceJobRetry,
  handleEvidenceJobStatus,
  handleEvidenceScenarioDraft,
  runEvidenceAdminRoute,
  type EvidenceRouteRuntime,
} from "../lib/server/evidence-routes.ts";
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
  invalidPredictorPdf,
  lzwTextPdf,
  lzwFlateTextPdf,
  multiFilterTextPdf,
  runLengthFlateTextPdf,
  sharedJpegTwoPageScanPdf,
  multiFlateTextPdf,
  unsupportedFilterPdf,
} from "./helpers/evidence-pdf-fixtures.ts";

const admin: EvidenceAdmin = {
  userId: "admin-1",
  email: "admin@example.test",
  displayName: "Admin",
  fullName: "Admin User",
};

const bundle = {
  id: "bundle-1",
  title: "드리블 대응",
  purpose: "압박 탈출",
  version: 2,
  contentVersion: "bundle-version",
  createdAt: 1,
  updatedAt: 2,
};

const source = {
  id: "source-1",
  bundleId: bundle.id,
  originalFileName: "코치\"자료\r\n.txt",
  mediaType: "text/plain" as const,
  byteSize: 6,
  contentHash: "content-hash",
  storageKey: "bundles/private/original-key",
  extractedTextKey: "bundles/private/extracted-key",
  extractionStatus: "completed" as const,
  extractionError: null,
};

function runtime(overrides: Partial<EvidenceRouteRuntime> = {}): EvidenceRouteRuntime {
  return {
    admin,
    service: {
      listBundlesForAdmin: async () => [bundle],
      createBundle: async () => bundle,
      getBundleForAdmin: async (id) => id === bundle.id
        ? { ...bundle, sources: [source], videoClips: [] }
        : null,
      updateBundle: async () => bundle,
      addVideoClip: async () => bundle,
      describeDeleteImpact: async (id) => ({ sourceId: id, cardIds: [], scenarioDraftIds: [] }),
      removeSource: async () => bundle,
      reviewCard: async () => ({
        id: "card-1", bundleId: bundle.id, jobId: "job-1", bundleVersion: bundle.contentVersion,
        currentBundleVersion: bundle.contentVersion, currentReviewId: "review-1", producerModel: "secret-model",
        status: "owner_reviewed", draftContentJson: "{\"llm\":true}", currentContentJson: "{\"situation\":\"현재\"}",
        isStale: false, createdAt: 1, updatedAt: 3,
      }),
      createScenarioDraft: async () => ({
        id: "scenario-1", campaignId: "campaign-1", role: "ala", principle: "width",
        prompt: "prompt", hint: "hint", explanation: "explanation", pitchJson: "{\"secret\":true}",
        answerJson: "{\"secret\":true}", contentJson: "{\"draftContentJson\":true}", reviewStatus: "draft", orderIndex: 1,
      }),
      listCardsForJob: async () => ({ cards: [], totalCount: 0, nextOffset: null }),
    },
    fileStore: {
      putValidatedFile: async () => source,
      getFile: async () => new TextEncoder().encode("근거"),
    },
    jobs: {
      startAnalysis: async () => jobRecord(),
      retryAnalysis: async () => jobRecord(),
      getAnalysisStatus: async (id) => id === "missing" ? null : jobRecord(),
    },
    ...overrides,
  };
}

function jobRecord() {
  return {
    id: "job-1", bundleId: bundle.id, inputVersion: bundle.contentVersion,
    status: "queued" as const, analyzerModel: "secret-model", promptVersion: "secret-prompt", schemaVersion: "secret-schema",
    stage: "validate_sources" as const, leaseOwner: "secret-runner", leaseToken: "secret-token", leaseExpiresAt: 99,
    errorMessage: null, startedAt: null, completedAt: null, attemptCount: 0,
    extractedEvidenceJson: "{\"extractedText\":\"secret\"}", generatedCardsJson: "{\"llm\":\"secret\"}",
    isStale: false, createdAt: 1, updatedAt: 2,
  };
}

function context<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

function jsonRequest(path: string, body: unknown, method = "POST") {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function streamingRequest(
  bodyStream: ReadableStream<Uint8Array>,
  contentType: string,
  contentLength?: number,
  signal?: AbortSignal,
) {
  const headers = new Headers({ "content-type": contentType });
  if (contentLength !== undefined) headers.set("content-length", String(contentLength));
  return new Request("http://localhost/api/admin/evidence/bundle-1/files", {
    method: "POST",
    headers,
    body: bodyStream,
    duplex: "half",
    signal,
  } as RequestInit & { duplex: "half" });
}

function onePagePdf(stream: string, filter = ""): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length}${filter} >>\nstream\n${stream}\nendstream`,
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

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test("every evidence endpoint authorizes before parsing or creating runtime resources", async () => {
  const request = jsonRequest("/api/admin/evidence", "{broken");
  Object.defineProperties(request, {
    json: { value: () => { throw new Error("body parsed before authorization"); } },
    formData: { value: () => { throw new Error("form parsed before authorization"); } },
    arrayBuffer: { value: () => { throw new Error("bytes read before authorization"); } },
  });
  const endpoints = [
    () => handleEvidenceCollectionList(runtime()),
    () => handleEvidenceCollectionCreate(request, runtime()),
    () => handleEvidenceBundleGet(context({ bundleId: "missing" }), runtime()),
    () => handleEvidenceBundleUpdate(request, context({ bundleId: "missing" }), runtime()),
    () => handleEvidenceFileUpload(request, context({ bundleId: "missing" }), runtime()),
    () => handleEvidenceFileDownload(context({ bundleId: "missing", sourceId: "missing" }), runtime()),
    () => handleEvidenceFileImpact(context({ bundleId: "missing", sourceId: "missing" }), runtime()),
    () => handleEvidenceFileDelete(context({ bundleId: "missing", sourceId: "missing" }), runtime()),
    () => handleEvidenceClipCreate(request, context({ bundleId: "missing" }), runtime()),
    () => handleEvidenceAnalyzeStart(context({ bundleId: "missing" }), runtime()),
    () => handleEvidenceJobStatus(new Request("http://test/"), context({ jobId: "missing" }), runtime()),
    () => handleEvidenceJobRetry(context({ jobId: "missing" }), runtime()),
    () => handleEvidenceCardReview(request, context({ cardId: "missing" }), runtime()),
    () => handleEvidenceScenarioDraft(request, context({ cardId: "missing" }), runtime()),
  ];

  for (const status of [401, 403] as const) {
    for (const endpoint of endpoints) {
      let runtimeCreated = false;
      const response = await runEvidenceAdminRoute(
        request,
        async () => Response.json({ error: "denied" }, { status }),
        () => {
          runtimeCreated = true;
          throw new Error("runtime must not be created");
        },
        endpoint,
      );
      assert.equal(response.status, status);
      assert.equal(runtimeCreated, false);
    }
  }
});

test("list, create, get, and update expose safe bundle projections", async () => {
  const list = await handleEvidenceCollectionList(runtime());
  assert.equal(list.status, 200);
  assert.deepEqual(await body(list), { bundles: [bundle] });

  const created = await handleEvidenceCollectionCreate(jsonRequest("/api/admin/evidence", {
    title: bundle.title, purpose: bundle.purpose,
  }), runtime());
  assert.equal(created.status, 201);

  const detail = await handleEvidenceBundleGet(context({ bundleId: bundle.id }), runtime());
  assert.equal(detail.status, 200);
  const serialized = JSON.stringify(await body(detail));
  for (const secret of [source.storageKey, source.extractedTextKey, "storageKey", "extractedTextKey"]) {
    assert.equal(serialized.includes(secret), false);
  }

  const updated = await handleEvidenceBundleUpdate(jsonRequest("/", { title: "변경", purpose: "변경" }, "PATCH"), context({ bundleId: bundle.id }), runtime());
  assert.equal(updated.status, 200);
});

test("source projections redact arbitrary extraction provider errors", async () => {
  const response = await handleEvidenceBundleGet(context({ bundleId: bundle.id }), runtime({
    service: {
      ...runtime().service,
      getBundleForAdmin: async () => ({
        ...bundle,
        sources: [{ ...source, extractionStatus: "failed", extractionError: `R2 ${source.storageKey} provider-secret` }],
        videoClips: [],
      }),
    },
  }));
  const serialized = JSON.stringify(await body(response));
  assert.equal(serialized.includes(source.storageKey), false);
  assert.equal(serialized.includes("provider-secret"), false);
});

test("malformed JSON is 400, authorized missing resources are 404, and CAS failures are 409", async () => {
  const malformed = await handleEvidenceCollectionCreate(jsonRequest("/", "{broken"), runtime());
  assert.equal(malformed.status, 400);

  const missing = await handleEvidenceBundleGet(context({ bundleId: "missing" }), runtime());
  assert.equal(missing.status, 404);

  const conflictRuntime = runtime({
    service: {
      ...runtime().service,
      updateBundle: async () => { throw new EvidenceConflictError(); },
    },
  });
  const conflict = await handleEvidenceBundleUpdate(jsonRequest("/", { title: "변경" }, "PATCH"), context({ bundleId: bundle.id }), conflictRuntime);
  assert.equal(conflict.status, 409);
});

test("multipart upload returns 413 for oversize, 415 for mismatch, and never returns storage keys", async () => {
  const oversized = new FormData();
  oversized.set("file", new File([new Uint8Array(20 * 1024 * 1024 + 1)], "large.txt", { type: "text/plain" }));
  const tooLarge = await handleEvidenceFileUpload(new Request("http://localhost", { method: "POST", body: oversized }), context({ bundleId: bundle.id }), runtime());
  assert.equal(tooLarge.status, 413);

  const mismatched = new FormData();
  mismatched.set("file", new File(["not a pdf"], "notes.pdf", { type: "application/pdf" }));
  const mismatchRuntime = runtime({
    fileStore: {
      ...runtime().fileStore,
      putValidatedFile: async () => { throw new EvidenceValidationError("파일 형식이 올바르지 않습니다."); },
    },
  });
  const unsupported = await handleEvidenceFileUpload(new Request("http://localhost", { method: "POST", body: mismatched }), context({ bundleId: bundle.id }), mismatchRuntime);
  assert.equal(unsupported.status, 415);

  const valid = new FormData();
  valid.set("file", new File(["근거"], "notes.txt", { type: "text/plain" }));
  const uploaded = await handleEvidenceFileUpload(new Request("http://localhost", { method: "POST", body: valid }), context({ bundleId: bundle.id }), runtime());
  assert.equal(uploaded.status, 201);
  const serialized = JSON.stringify(await body(uploaded));
  assert.equal(serialized.includes("storageKey"), false);
  assert.equal(serialized.includes("extractedTextKey"), false);
});

test("multipart upload caps the whole envelope before parsing extra parts", async () => {
  const encoder = new TextEncoder();
  const boundary = "envelope-boundary";
  let phase = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cancelled) return;
      if (phase === 0) {
        phase += 1;
        controller.enqueue(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="small.txt"\r\nContent-Type: text/plain\r\n\r\nx\r\n--${boundary}\r\nContent-Disposition: form-data; name="junk"\r\n\r\n`));
        return;
      }
      phase += 1;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });

  const response = await handleEvidenceFileUpload(
    streamingRequest(stream, `multipart/form-data; boundary=${boundary}`),
    context({ bundleId: bundle.id }),
    runtime(),
  );

  assert.equal(response.status, 413);
});

test("chunked multipart overflow is 413 without a Content-Length header", async () => {
  const encoder = new TextEncoder();
  const boundary = "chunked-boundary";
  let phase = 0;
  const request = streamingRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase += 1;
        controller.enqueue(encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.txt"\r\nContent-Type: text/plain\r\n\r\n`,
        ));
        return;
      }
      if (phase <= 21) {
        phase += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(0x61));
        return;
      }
      controller.enqueue(encoder.encode(`\r\n--${boundary}--\r\n`));
      controller.close();
    },
  }), `multipart/form-data; boundary=${boundary}`);

  const response = await handleEvidenceFileUpload(request, context({ bundleId: bundle.id }), runtime());

  assert.equal(response.status, 413);
});

test("Content-Length rejects an oversized multipart request without reading its stream", async () => {
  let reads = 0;
  const request = streamingRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.close();
    },
  }, { highWaterMark: 0 }), "multipart/form-data; boundary=unused", 21 * 1024 * 1024);

  const response = await handleEvidenceFileUpload(request, context({ bundleId: bundle.id }), runtime());

  assert.equal(response.status, 413);
  assert.equal(reads, 0);
});

test("multipart upload rejects duplicate file and unexpected form parts", async () => {
  const duplicate = new FormData();
  duplicate.append("file", new File(["one"], "one.txt", { type: "text/plain" }));
  duplicate.append("file", new File(["two"], "two.txt", { type: "text/plain" }));
  const duplicateResponse = await handleEvidenceFileUpload(
    new Request("http://localhost", { method: "POST", body: duplicate }),
    context({ bundleId: bundle.id }),
    runtime(),
  );
  assert.equal(duplicateResponse.status, 400);

  const unexpected = new FormData();
  unexpected.append("file", new File(["one"], "one.txt", { type: "text/plain" }));
  unexpected.append("notes", "unexpected");
  const unexpectedResponse = await handleEvidenceFileUpload(
    new Request("http://localhost", { method: "POST", body: unexpected }),
    context({ bundleId: bundle.id }),
    runtime(),
  );
  assert.equal(unexpectedResponse.status, 400);
});

test("PDF preflight rejects corrupt content and preserves valid scan/text behavior through the real route", async () => {
  const objects = new Map<string, unknown>();
  const rows: StoredEvidenceFile[] = [];
  const store = new EvidenceFileStore({
    bucket: {
      async put(key, value) { objects.set(key, value); },
      async get(key) { return objects.get(key) ?? null; },
      async delete(key) { objects.delete(key); },
    },
    registration: {
      async findExisting() { return null; },
      async register(value) { rows.push(value); return value; },
    },
  });
  async function upload(bytes: Uint8Array, name: string) {
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    return handleEvidenceFileUpload(
      new Request("http://localhost", { method: "POST", body: form }),
      context({ bundleId: bundle.id }),
      runtime({ fileStore: store }),
    );
  }

  for (const [filter, name] of [
    [" /Filter /FlateDecode", "corrupt.pdf"],
    [" /Filter /Flate#44ecode", "escaped-corrupt.pdf"],
    [" /Filter [/F#6c]", "escaped-abbreviated-corrupt.pdf"],
  ] as const) {
    const corrupt = await upload(onePagePdf("notflate", filter), name);
    assert.equal(corrupt.status, 415);
    assert.equal(objects.size, 0);
    assert.equal(rows.length, 0);
  }

  const scan = await upload(onePagePdf(""), "scan.pdf");
  assert.equal(scan.status, 201);
  assert.equal(((await body(scan)).source as Record<string, unknown>).extractionStatus, "failed");
  assert.equal(rows[0]?.extractionStatus, "failed");
  assert.equal(objects.size, 1);

  const text = await upload(onePagePdf("BT /F1 12 Tf 72 720 Td (Press forward) Tj ET"), "text.pdf");
  assert.equal(text.status, 201);
  assert.equal(rows[1]?.extractionStatus, "completed");
  assert.equal(objects.size, 3);
});

test("recovered PDF stream errors return 415 and pre-aborted uploads return 400 with zero writes", async () => {
  for (const [name, bytes, aborted] of [
    ["invalid-predictor.pdf", invalidPredictorPdf(), false],
    ["unsupported-filter.pdf", unsupportedFilterPdf(), false],
    ["tolerated-object-header.pdf", downstreamToleratedObjectHeaderPdf(), false],
    ["aborted.pdf", onePagePdf("BT /F1 12 Tf 72 720 Td (Press forward) Tj ET"), true],
  ] as const) {
    const objects = new Map<string, unknown>();
    const rows: StoredEvidenceFile[] = [];
    const store = new EvidenceFileStore({
      bucket: {
        async put(key, value) { objects.set(key, value); },
        async get(key) { return objects.get(key) ?? null; },
        async delete(key) { objects.delete(key); },
      },
      registration: {
        async findExisting() { return null; },
        async register(value) { rows.push(value); return value; },
      },
    });
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    const controller = new AbortController();
    if (aborted) controller.abort();
    const response = await handleEvidenceFileUpload(
      new Request("http://localhost", { method: "POST", body: form, signal: controller.signal }),
      context({ bundleId: bundle.id }),
      runtime({ fileStore: store }),
    );

    assert.equal(response.status, aborted ? 400 : 415, name);
    assert.equal(objects.size, 0, name);
    assert.equal(rows.length, 0, name);
  }
});

test("real upload route rejects indirect, LZW, and later-stage stream failures with zero writes", async () => {
  for (const [name, bytes] of [
    ["corrupt-lzw.pdf", corruptLzwPdf()],
    ["corrupt-jpeg.pdf", corruptJpegImageScanPdf()],
    ["corrupt-jpeg-huffman.pdf", corruptJpegHuffmanImageScanPdf()],
    ["excessive-predictor-colors.pdf", excessivePredictorColorsPdf()],
    ["indirect-corrupt-flate.pdf", indirectFilterCorruptFlatePdf()],
    ["corrupt-second-flate.pdf", corruptSecondFlatePdf()],
    ["indirect-invalid-predictor.pdf", indirectInvalidPredictorPdf()],
  ] as const) {
    const objects = new Map<string, unknown>();
    const rows: StoredEvidenceFile[] = [];
    const store = new EvidenceFileStore({
      bucket: {
        async put(key, value) { objects.set(key, value); },
        async get(key) { return objects.get(key) ?? null; },
        async delete(key) { objects.delete(key); },
      },
      registration: {
        async findExisting() { return null; },
        async register(value) { rows.push(value); return value; },
      },
    });
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "application/pdf" }));

    const response = await handleEvidenceFileUpload(
      new Request("http://localhost", { method: "POST", body: form }),
      context({ bundleId: bundle.id }),
      runtime({ fileStore: store }),
    );

    assert.equal(response.status, 415, name);
    assert.equal(objects.size, 0, name);
    assert.equal(rows.length, 0, name);
  }
});

test("real upload route preserves image scans, commented lengths, and validated filter chains", async () => {
  for (const [name, bytes, expectedStatus] of [
    ["image-scan.pdf", imageBackedScanPdf(), "failed"],
    ["jpeg-image-scan.pdf", jpegImageScanPdf(), "failed"],
    ["shared-jpeg-two-page-scan.pdf", sharedJpegTwoPageScanPdf(), "failed"],
    ["commented-indirect-length.pdf", commentedIndirectLengthTextPdf(), "completed"],
    ["compressed-object-indirect.pdf", compressedObjectIndirectTextPdf(), "completed"],
    ["asciihex-flate.pdf", multiFilterTextPdf(), "completed"],
    ["ascii85-flate.pdf", ascii85FlateTextPdf(), "completed"],
    ["runlength-flate.pdf", runLengthFlateTextPdf(), "completed"],
    ["lzw-flate.pdf", lzwFlateTextPdf(), "completed"],
    ["double-flate.pdf", multiFlateTextPdf(), "completed"],
    ["lzw.pdf", lzwTextPdf(), "completed"],
  ] as const) {
    const objects = new Map<string, unknown>();
    const rows: StoredEvidenceFile[] = [];
    const store = new EvidenceFileStore({
      bucket: {
        async put(key, value) { objects.set(key, value); },
        async get(key) { return objects.get(key) ?? null; },
        async delete(key) { objects.delete(key); },
      },
      registration: {
        async findExisting() { return null; },
        async register(value) { rows.push(value); return value; },
      },
    });
    const form = new FormData();
    form.set("file", new File([bytes], name, { type: "application/pdf" }));

    const response = await handleEvidenceFileUpload(
      new Request("http://localhost", { method: "POST", body: form }),
      context({ bundleId: bundle.id }),
      runtime({ fileStore: store }),
    );

    assert.equal(response.status, 201, name);
    assert.equal(((await body(response)).source as Record<string, unknown>).extractionStatus, expectedStatus, name);
    assert.equal(rows.length, 1, name);
    assert.equal(objects.size, expectedStatus === "failed" ? 1 : 2, name);
  }
});

test("request abort during stalled multipart parsing cancels input and persists nothing", async () => {
  const encoder = new TextEncoder();
  const boundary = "abort-boundary";
  let pulls = 0;
  let cancelCalls = 0;
  let secondPull!: () => void;
  const secondPullStarted = new Promise<void>((resolve) => { secondPull = resolve; });
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(encoder.encode(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\npartial`,
        ));
        return;
      }
      secondPull();
      return new Promise<void>(() => undefined);
    },
    cancel() { cancelCalls += 1; },
  }, { highWaterMark: 0 });
  const objects = new Map<string, unknown>();
  const rows: StoredEvidenceFile[] = [];
  const store = new EvidenceFileStore({
    bucket: {
      async put(key, value) { objects.set(key, value); },
      async get(key) { return objects.get(key) ?? null; },
      async delete(key) { objects.delete(key); },
    },
    registration: {
      async findExisting() { return null; },
      async register(value) { rows.push(value); return value; },
    },
  });
  const controller = new AbortController();
  const responsePromise = handleEvidenceFileUpload(
    streamingRequest(source, `multipart/form-data; boundary=${boundary}`, undefined, controller.signal),
    context({ bundleId: bundle.id }),
    runtime({ fileStore: store }),
  );
  await secondPullStarted;
  controller.abort();

  const response = await Promise.race([
    responsePromise,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error("multipart upload cancellation was not observed")),
      100,
    )),
  ]);

  assert.equal(response.status, 400);
  assert.equal(cancelCalls, 1);
  assert.equal(objects.size, 0);
  assert.equal(rows.length, 0);
});

test("request abort after body EOF but before multipart resolution persists nothing", async () => {
  const encoder = new TextEncoder();
  const boundary = "abort-after-eof-boundary";
  const multipart = encoder.encode([
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="notes.txt"',
    "Content-Type: text/plain",
    "",
    "Press forward",
    `--${boundary}--`,
    "",
  ].join("\r\n"));
  const abortController = new AbortController();
  let pulls = 0;
  const bodyStream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      pulls += 1;
      if (pulls === 1) {
        streamController.enqueue(multipart);
        return;
      }
      streamController.close();
      const abortLater = (remaining: number) => {
        if (remaining === 0) abortController.abort();
        else queueMicrotask(() => abortLater(remaining - 1));
      };
      abortLater(2);
    },
  });
  let putCalls = 0;

  const response = await handleEvidenceFileUpload(
    streamingRequest(
      bodyStream,
      `multipart/form-data; boundary=${boundary}`,
      undefined,
      abortController.signal,
    ),
    context({ bundleId: bundle.id }),
    runtime({
      fileStore: {
        putValidatedFile: async () => {
          putCalls += 1;
          return source;
        },
        getFile: async () => encoder.encode("evidence"),
      },
    }),
  );

  assert.equal(abortController.signal.aborted, true);
  assert.equal(response.status, 400);
  assert.deepEqual(await body(response), { error: "파일 업로드가 중단되었습니다." });
  assert.equal(putCalls, 0);
});

test("upload preserves typed registration conflicts/not-found after cleanup without leaking raw messages", async () => {
  for (const [error, status] of [
    [new EvidenceConflictError("SECRET_CAS"), 409],
    [new EvidenceNotFoundError("SECRET_DELETED_BUNDLE"), 404],
  ] as const) {
    const objects = new Map<string, unknown>();
    const store = new EvidenceFileStore({
      bucket: {
        async put(key, value) { objects.set(key, value); },
        async get(key) { return objects.get(key) ?? null; },
        async delete(key) { objects.delete(key); },
      },
      registration: {
        async findExisting() { return null; },
        async register() { throw error; },
      },
    });
    const form = new FormData();
    form.set("file", new File(["valid"], "notes.txt", { type: "text/plain" }));
    const response = await handleEvidenceFileUpload(
      new Request("http://localhost", { method: "POST", body: form }),
      context({ bundleId: bundle.id }),
      runtime({ fileStore: store }),
    );
    assert.equal(response.status, status);
    assert.equal(objects.size, 0);
    const serialized = JSON.stringify(await body(response));
    assert.equal(serialized.includes(error.message), false);
  }
});

test("upload authorization completes before the counting stream reads any byte", async () => {
  let reads = 0;
  const request = streamingRequest(new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  }, { highWaterMark: 0 }), "multipart/form-data; boundary=auth-first");

  const response = await runEvidenceAdminRoute(
    request,
    async () => Response.json({ error: "denied" }, { status: 401 }),
    async () => runtime(),
    (authorized) => handleEvidenceFileUpload(request, context({ bundleId: bundle.id }), authorized),
  );

  assert.equal(response.status, 401);
  assert.equal(reads, 0);
});

test("clip validation is 400 and a missing authorized bundle is 404", async () => {
  const invalid = await handleEvidenceClipCreate(jsonRequest("/", {
    url: "http://example.test/video", startMs: 10, endMs: 5, observation: "관찰",
  }), context({ bundleId: bundle.id }), runtime({
    service: {
      ...runtime().service,
      addVideoClip: async () => { throw new EvidenceValidationError("영상 시간 범위가 올바르지 않습니다."); },
    },
  }));
  assert.equal(invalid.status, 400);

  const missing = await handleEvidenceClipCreate(jsonRequest("/", {
    url: "https://example.test/video", startMs: 0, endMs: 5, observation: "관찰",
  }), context({ bundleId: "missing" }), runtime({
    service: {
      ...runtime().service,
      addVideoClip: async () => { throw new EvidenceNotFoundError("근거 묶음을 찾을 수 없습니다."); },
    },
  }));
  assert.equal(missing.status, 404);
});

test("analysis start and retry expose safe status while GET polling remains read-only", async () => {
  const calls: string[] = [];
  const jobRuntime = runtime({
    jobs: {
      startAnalysis: async () => { calls.push("start"); return jobRecord(); },
      retryAnalysis: async () => { calls.push("retry"); return jobRecord(); },
      getAnalysisStatus: async () => { calls.push("get"); return jobRecord(); },
    },
  });
  const started = await handleEvidenceAnalyzeStart(context({ bundleId: bundle.id }), jobRuntime);
  const polled = await handleEvidenceJobStatus(new Request("http://test/"), context({ jobId: "job-1" }), jobRuntime);
  const retried = await handleEvidenceJobRetry(context({ jobId: "job-1" }), jobRuntime);
  assert.equal(started.status, 202);
  assert.equal(polled.status, 200);
  assert.equal(retried.status, 202);
  assert.deepEqual(calls, ["start", "get", "retry"]);
  for (const response of [started, polled, retried]) {
    const serialized = JSON.stringify(await body(response));
    for (const secret of ["analyzerModel", "secret-model", "promptVersion", "schemaVersion", "leaseToken", "leaseOwner", "extractedEvidenceJson", "generatedCardsJson", "extractedText", "llm"]) {
      assert.equal(serialized.includes(secret), false);
    }
  }
  const incompatible = await handleEvidenceJobRetry(context({ jobId: "job-1" }), runtime({
    jobs: { ...runtime().jobs, retryAnalysis: async () => { throw new EvidenceJobConfigurationConflictError(); } },
  }));
  assert.equal(incompatible.status, 409);
});

test("job polling replaces any persisted provider error with a stable public message", async () => {
  const response = await handleEvidenceJobStatus(new Request("http://test/"), context({ jobId: "job-1" }), runtime({
    jobs: {
      ...runtime().jobs,
      getAnalysisStatus: async () => ({ ...jobRecord(), status: "failed", errorMessage: "HTTP 500 provider-secret-key" }),
    },
  }));
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await body(response));
  assert.equal(serialized.includes("provider-secret-key"), false);
  assert.equal(serialized.includes("HTTP 500"), false);
});

test("review-ready job polling returns discoverable cards and bounded citation excerpts", async () => {
  const longExcerpt = `근거-${"가".repeat(3_000)}`;
  const response = await handleEvidenceJobStatus(new Request("http://test/"), context({ jobId: "job-1" }), runtime({
    jobs: {
      ...runtime().jobs,
      getAnalysisStatus: async () => ({ ...jobRecord(), status: "review_ready" }),
    },
    service: {
      ...runtime().service,
      listCardsForJob: async () => ({ cards: [{
        id: "card-1", bundleId: bundle.id, jobId: "job-1", bundleVersion: bundle.contentVersion,
        currentBundleVersion: bundle.contentVersion, currentReviewId: null, producerModel: "secret-model",
        status: "analysis_draft", draftContentJson: "{\"llm\":true}",
        currentContentJson: "{\"situation\":\"측면 압박\"}", isStale: false, createdAt: 1, updatedAt: 2,
        citationCount: 1,
        citations: [{
          chunkId: "chunk-1", sourceId: source.id, videoClipId: null, locationLabel: "문서 1쪽",
          content: longExcerpt, contentHash: "secret-hash",
        }],
      }], totalCount: 1, nextOffset: null }),
    },
  }));
  assert.equal(response.status, 200);
  const responseBody = await body(response);
  const cards = responseBody.cards as Array<Record<string, unknown>>;
  assert.equal(cards[0]?.id, "card-1");
  assert.deepEqual(cards[0]?.content, { situation: "측면 압박" });
  const citations = cards[0]?.citations as Array<Record<string, unknown>>;
  assert.equal(citations[0]?.chunkId, "chunk-1");
  assert.equal((citations[0]?.excerpt as string).length <= 2_001, true);
  const serialized = JSON.stringify(responseBody);
  for (const secret of ["producerModel", "secret-model", "draftContentJson", "currentContentJson", "contentHash", "secret-hash"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("job polling caps cards, citations, and aggregate UTF-8 excerpts with continuation metadata", async () => {
  let requestedOffset = -1;
  const card = {
    id: "card", bundleId: bundle.id, jobId: "job-1", bundleVersion: bundle.contentVersion,
    currentBundleVersion: bundle.contentVersion, currentReviewId: null, producerModel: "model",
    status: "analysis_draft" as const, draftContentJson: "{}", currentContentJson: "{}",
    isStale: false, createdAt: 1, updatedAt: 2, citationCount: 30,
    citations: Array.from({ length: 30 }, (_, index) => ({
      chunkId: `chunk-${index}`, sourceId: source.id, videoClipId: null,
      locationLabel: `page:${index}`, content: "가".repeat(4_000), contentHash: "hash",
    })),
  };
  const response = await handleEvidenceJobStatus(
    new Request("http://test/?cursor=20"), context({ jobId: "job-1" }), runtime({
      jobs: { ...runtime().jobs, getAnalysisStatus: async () => ({ ...jobRecord(), status: "review_ready" }) },
      service: {
        ...runtime().service,
        listCardsForJob: async (_jobId, _admin, options) => {
          requestedOffset = options?.offset ?? -1;
          return { cards: Array.from({ length: 50 }, (_, index) => ({ ...card, id: `card-${index}` })), totalCount: 70, nextOffset: 40 };
        },
      },
    }),
  );
  const value = await body(response);
  const cards = value.cards as Array<{ citations: Array<{ excerpt: string }> }>;
  const excerptBytes = cards.flatMap((item) => item.citations)
    .reduce((sum, citation) => sum + new TextEncoder().encode(citation.excerpt).byteLength, 0);

  assert.equal(requestedOffset, 20);
  assert.equal(cards.length, 20);
  assert.equal(cards.every((item) => item.citations.length <= 20), true);
  assert.equal(excerptBytes <= 32 * 1024, true);
  assert.equal(JSON.stringify(value).includes("가".repeat(4_000)), false);
  assert.deepEqual(value.pagination, { count: 20, totalCount: 70, nextCursor: "40" });
});

test("admin JSON responses are private no-store and malicious upstream messages are never routed or leaked", async () => {
  const success = await handleEvidenceCollectionList(runtime());
  const detail = await handleEvidenceBundleGet(context({ bundleId: bundle.id }), runtime());
  const status = await handleEvidenceJobStatus(new Request("http://test/"), context({ jobId: "job-1" }), runtime());
  const impact = await handleEvidenceFileImpact(context({ bundleId: bundle.id, sourceId: source.id }), runtime());
  const knownError = await handleEvidenceCollectionCreate(new Request("http://test/", { method: "POST", body: "{" }), runtime());
  const unknown = await handleEvidenceClipCreate(
    jsonRequest("/", {}), context({ bundleId: bundle.id }), runtime({
      service: { ...runtime().service, addVideoClip: async () => {
        throw new Error("찾을 수 없습니다 필요합니다 구성되지 않았습니다 SECRET_TOKEN");
      } },
    }),
  );
  const typedMalicious = await handleEvidenceClipCreate(
    jsonRequest("/", {}), context({ bundleId: bundle.id }), runtime({
      service: { ...runtime().service, addVideoClip: async () => {
        throw new EvidenceConflictError("SECRET_TYPED");
      } },
    }),
  );
  const guarded = await runEvidenceAdminRoute(
    new Request("http://test/"),
    async () => Response.json({ error: "denied" }, { status: 403, headers: { "access-control-allow-origin": "*" } }),
    async () => runtime(),
    async () => Response.json({ unreachable: true }),
  );

  for (const response of [success, detail, status, impact, knownError, unknown, typedMalicious, guarded]) {
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.has("access-control-allow-origin"), false);
  }
  assert.equal(unknown.status, 500);
  assert.equal(JSON.stringify(await body(unknown)).includes("SECRET_TOKEN"), false);
  assert.equal(typedMalicious.status, 409);
  assert.equal(JSON.stringify(await body(typedMalicious)).includes("SECRET_TYPED"), false);
});

test("production schedule adapter forwards the exact continuation to waitUntil", async () => {
  const continuation = Promise.resolve("continued");
  let scheduled: Promise<unknown> | null = null;
  bindEvidenceSchedule((promise) => { scheduled = promise; })(continuation);
  assert.equal(scheduled, continuation);
});

test("unavailable analysis configuration is 503 without leaking provider details", async () => {
  const response = await runEvidenceAdminRoute(
    new Request("http://localhost"),
    async () => admin,
    () => { throw new Error("EVIDENCE_LLM_API_KEY=provider-secret"); },
    async () => Response.json({ unreachable: true }),
  );
  assert.equal(response.status, 503);
  const serialized = JSON.stringify(await body(response));
  assert.equal(serialized.includes("provider-secret"), false);
  assert.equal(serialized.includes("EVIDENCE_LLM_API_KEY"), false);
});

test("card review and scenario conversion map stale conflicts and omit immutable internal snapshots", async () => {
  const reviewed = await handleEvidenceCardReview(jsonRequest("/", {
    status: "owner_reviewed", expectedUpdatedAt: 2, content: { situation: "현재" },
  }), context({ cardId: "card-1" }), runtime());
  assert.equal(reviewed.status, 200);
  const reviewJson = JSON.stringify(await body(reviewed));
  for (const secret of ["draftContentJson", "currentContentJson", "producerModel", "secret-model", "llm"]) {
    assert.equal(reviewJson.includes(secret), false);
  }

  const scenario = await handleEvidenceScenarioDraft(jsonRequest("/", {
    expectedUpdatedAt: 3, campaignId: "campaign-1", role: "ala", principle: "width",
    prompt: "prompt", hint: "hint", explanation: "explanation", orderIndex: 1, content: {},
  }), context({ cardId: "card-1" }), runtime());
  assert.equal(scenario.status, 201);
  const scenarioJson = JSON.stringify(await body(scenario));
  for (const secret of ["pitchJson", "answerJson", "contentJson", "draftContentJson"]) {
    assert.equal(scenarioJson.includes(secret), false);
  }

  const stale = await handleEvidenceCardReview(jsonRequest("/", {}), context({ cardId: "card-1" }), runtime({
    service: {
      ...runtime().service,
      reviewCard: async () => { throw new EvidenceConflictError(); },
    },
  }));
  assert.equal(stale.status, 409);
});

test("malformed review and scenario inputs are 400 while unavailable source storage is 503", async () => {
  const invalidReview = await handleEvidenceCardReview(jsonRequest("/", {}), context({ cardId: "card-1" }), runtime({
    service: {
      ...runtime().service,
      reviewCard: async () => { throw new EvidenceRequestValidationError("카드 검수 상태가 올바르지 않습니다."); },
    },
  }));
  assert.equal(invalidReview.status, 400);

  const invalidScenario = await handleEvidenceScenarioDraft(jsonRequest("/", {}), context({ cardId: "card-1" }), runtime({
    service: {
      ...runtime().service,
      createScenarioDraft: async () => { throw new EvidenceRequestValidationError("campaignId이 필요합니다."); },
    },
  }));
  assert.equal(invalidScenario.status, 400);

  const unavailable = await handleEvidenceFileDelete(context({ bundleId: bundle.id, sourceId: source.id }), runtime({
    service: {
      ...runtime().service,
      removeSource: async () => { throw new AggregateError([new Error("R2 provider-secret")], "delete failed"); },
    },
  }));
  assert.equal(unavailable.status, 503);
  assert.equal(JSON.stringify(await body(unavailable)).includes("provider-secret"), false);

  const snapshotFailure = await handleEvidenceFileDelete(context({ bundleId: bundle.id, sourceId: source.id }), runtime({
    service: {
      ...runtime().service,
      removeSource: async () => { throw new EvidenceUnavailableError("근거 파일 저장소를 사용할 수 없습니다."); },
    },
  }));
  assert.equal(snapshotFailure.status, 503);
  assert.equal(JSON.stringify(await body(snapshotFailure)).includes("provider-secret"), false);
});

test("authenticated download streams bytes with safe attachment headers and no internal key", async () => {
  const response = await handleEvidenceFileDownload(context({ bundleId: bundle.id, sourceId: source.id }), runtime());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "근거");
  const disposition = response.headers.get("content-disposition") ?? "";
  assert.match(disposition, /^attachment; /);
  assert.equal(disposition.includes("\r"), false);
  assert.equal(disposition.includes("\n"), false);
  assert.equal(disposition.includes(source.storageKey), false);
  assert.match(disposition, /filename\*=UTF-8''/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");

  const missing = await handleEvidenceFileDownload(context({ bundleId: bundle.id, sourceId: "missing" }), runtime());
  assert.equal(missing.status, 404);
});

test("delete impact is listed first and linked sources are blocked with 409", async () => {
  const impactRuntime = runtime({
    service: {
      ...runtime().service,
      describeDeleteImpact: async (id) => ({ sourceId: id, cardIds: ["card-1"], scenarioDraftIds: ["scenario-1"] }),
      removeSource: async () => { throw new EvidenceConflictError("연결된 카드 또는 시나리오 초안이 있어 근거를 삭제할 수 없습니다."); },
    },
  });
  const impact = await handleEvidenceFileImpact(context({ bundleId: bundle.id, sourceId: source.id }), impactRuntime);
  assert.equal(impact.status, 200);
  assert.deepEqual(await body(impact), { impact: { sourceId: source.id, cardIds: ["card-1"], scenarioDraftIds: ["scenario-1"] } });

  const removed = await handleEvidenceFileDelete(context({ bundleId: bundle.id, sourceId: source.id }), impactRuntime);
  assert.equal(removed.status, 409);
});

test("public campaign, room, and training projections contain no evidence workflow fields", () => {
  const publicScenario = serializePublicTrainingScenario({
    id: "scenario-1", campaignId: "campaign-1", role: "ala", principle: "width", prompt: "선택", orderIndex: 0,
    reviewStatus: "reviewed", sourceTitle: null, sourceUrl: null, reviewerName: null,
    reviewedAt: null, reviewedContentJson: null, contentJson: "", pitchJson: JSON.stringify({
      players: [{ id: "actor", x: 10, y: 10, team: "us" }], ball: { x: 10, y: 10 }, zones: [],
    }), answerJson: JSON.stringify({ kind: "circle", cx: 20, cy: 20, radius: 5 }),
    hint: "private hint", explanation: "private explanation",
    extractedText: "private", draftContentJson: "private", llm: "private", storageKey: "private",
  } as never);
  const campaign = { id: "campaign-1", title: "캠페인", scenarios: [publicScenario] };
  const room = { members: [{ id: "member-1", nickname: "선수", completedStage: 1 }], teamMastery: { width: 0 } };
  const train = { campaign, scenario: publicScenario };
  for (const projection of [campaign, room, train]) {
    const serialized = JSON.stringify(projection);
    for (const secret of ["extractedText", "draftContentJson", "llm", "storageKey"]) {
      assert.equal(serialized.includes(secret), false);
    }
  }
});
