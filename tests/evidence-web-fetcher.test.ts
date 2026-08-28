import assert from "node:assert/strict";
import test from "node:test";

import { createEvidenceSourcePolicy } from "../lib/server/evidence-source-policy.ts";
import {
  EXTERNAL_FETCH_LIMITS,
  fetchExternalEvidence,
  quoteAppearsInPages,
  resolveHostWithCloudflareDns,
} from "../lib/server/evidence-web-fetcher.ts";

const policy = createEvidenceSourcePolicy("1:fifa.com,1:uefa.com");
const encoder = new TextEncoder();

function dependencies(fetchImpl: typeof fetch, options: {
  addresses?: string[];
  now?: () => number;
} = {}) {
  return {
    fetch: fetchImpl,
    resolveHost: async () => options.addresses ?? ["8.8.8.8", "2606:4700:4700::1111"],
    policy,
    now: options.now ?? (() => 1_000),
  };
}

function responseFetch(response: Response): typeof fetch {
  return (async () => response) as typeof fetch;
}

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
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
  return encoder.encode(document);
}

test("rejects non-HTTPS, credentials, IP literals, untrusted hosts, private DNS, and unsafe redirects", async () => {
  const ok = responseFetch(htmlResponse("<p>wide lane</p>"));
  const fetcher = (url: string, fetchImpl = ok, addresses?: string[]) => fetchExternalEvidence(
    { url, expectedType: "web_page", quote: "wide lane" },
    dependencies(fetchImpl, { addresses }),
  );

  await assert.rejects(() => fetcher("http://fifa.com/a"), /HTTPS/);
  await assert.rejects(() => fetcher("https://user:secret@fifa.com/a"), /자격 증명/);
  await assert.rejects(() => fetcher("https://127.0.0.1/a"), /허용/);
  await assert.rejects(() => fetcher("https://fifa.com.evil.test/a"), /허용/);
  await assert.rejects(() => fetcher("https://fifa.com/a", ok, ["10.0.0.8"]), /사설/);
  await assert.rejects(() => fetcher("https://fifa.com/a", ok, ["8.8.8.8", "::1"]), /사설/);

  const redirect = responseFetch(new Response(null, {
    status: 302,
    headers: { location: "https://169.254.169.254/latest" },
  }));
  await assert.rejects(() => fetcher("https://fifa.com/a", redirect), /허용/);
});

test("revalidates every redirect and enforces the redirect cap", async () => {
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "/again" } });
  }) as typeof fetch;

  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://fifa.com/start", expectedType: "web_page", quote: "anything" },
    dependencies(fetchImpl),
  ), /리다이렉트/);
  assert.equal(requested.length, EXTERNAL_FETCH_LIMITS.redirects + 1);
});

test("rejects oversized headers and streams, cancelling the body with no retained bytes", async () => {
  const tooLargeHeader = htmlResponse("small", { "content-length": String(EXTERNAL_FETCH_LIMITS.bytes + 1) });
  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://fifa.com/large", expectedType: "web_page", quote: "small" },
    dependencies(responseFetch(tooLargeHeader)),
  ), /크기/);

  let cancelCalls = 0;
  const oversized = new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(EXTERNAL_FETCH_LIMITS.bytes));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() { cancelCalls += 1; },
  }), { headers: { "content-type": "text/html" } });
  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://fifa.com/large", expectedType: "web_page", quote: "small" },
    dependencies(responseFetch(oversized)),
  ), /크기/);
  assert.equal(cancelCalls, 1);
});

test("cancels a stalled response body when the shared deadline expires", async () => {
  let expired = false;
  let cancelCalls = 0;
  const stalled = new Response(new ReadableStream<Uint8Array>({
    pull() {
      expired = true;
      return new Promise<void>(() => undefined);
    },
    cancel() { cancelCalls += 1; },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/html" } });

  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://fifa.com/stall", expectedType: "web_page", quote: "never" },
    dependencies(responseFetch(stalled), { now: () => expired ? EXTERNAL_FETCH_LIMITS.timeoutMs + 1 : 0 }),
  ), /시간/);
  assert.equal(cancelCalls, 1);
});

test("extracts an inert bounded HTML snapshot and verifies normalized quotes", async () => {
  const html = [
    "<!doctype html><main><h1>Width&nbsp;Principle</h1>",
    "<script>steal()</script><style>.secret{}</style><form>submit secrets</form>",
    "<iframe>nested attack</iframe><svg><text>vector attack</text></svg>",
    "<p>Use the ＷＩＤＥ\n lane.</p></main>",
  ].join("");
  const result = await fetchExternalEvidence(
    { url: "https://fifa.com/guidance/width.html", expectedType: "web_page", quote: "use the wide lane." },
    dependencies(responseFetch(htmlResponse(html))),
  );

  assert.equal(result.finalUrl, "https://fifa.com/guidance/width.html");
  assert.equal(result.mediaType, "text/plain");
  assert.equal(result.fileName, "width.txt");
  assert.match(new TextDecoder().decode(result.bytes), /Width Principle/);
  assert.doesNotMatch(new TextDecoder().decode(result.bytes), /steal|secret|attack/);
  assert.match(result.extractedPages[0]!.locator, /^section:1$/);
  assert.equal(quoteAppearsInPages(" USE  the wide lane. ", result.extractedPages), true);
  assert.match(result.contentHash, /^[a-f0-9]{64}$/);

  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://fifa.com/guidance/width.html", expectedType: "web_page", quote: "not in the document" },
    dependencies(responseFetch(htmlResponse(html))),
  ), /인용/);
});

test("strips forged content after self-closing syntax for every active HTML element", async () => {
  for (const tag of ["script", "style", "form", "iframe", "object", "embed", "svg"]) {
    const html = `<${tag}/>forged-${tag}</${tag}><main>verified safe text</main>`;
    const result = await fetchExternalEvidence(
      { url: `https://fifa.com/guidance/${tag}`, expectedType: "web_page", quote: "verified safe text" },
      dependencies(responseFetch(htmlResponse(html))),
    );
    const snapshot = new TextDecoder().decode(result.bytes);
    assert.doesNotMatch(snapshot, new RegExp(`forged-${tag}`), tag);
    assert.match(snapshot, /verified safe text/, tag);
  }
});

test("requires MIME/signature agreement and reuses validated PDF page extraction", async () => {
  const pdf = textPdf("Press forward");
  const fetched = await fetchExternalEvidence(
    { url: "https://uefa.com/library/press.pdf", expectedType: "pdf", quote: "press forward" },
    dependencies(responseFetch(new Response(pdf, { headers: { "content-type": "application/pdf" } }))),
  );
  assert.equal(fetched.mediaType, "application/pdf");
  assert.equal(fetched.fileName, "press.pdf");
  assert.deepEqual(fetched.bytes, pdf);
  assert.deepEqual(fetched.extractedPages, [{ locator: "page:1", text: "Press forward" }]);

  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://uefa.com/library/fake.pdf", expectedType: "pdf", quote: "html" },
    dependencies(responseFetch(htmlResponse("<p>html</p>"))),
  ), /형식/);
  await assert.rejects(() => fetchExternalEvidence(
    { url: "https://uefa.com/library/fake.html", expectedType: "web_page", quote: "Press forward" },
    dependencies(responseFetch(new Response(pdf, { headers: { "content-type": "text/html" } }))),
  ), /형식/);
});

test("uses the fixed bounded DNS-over-HTTPS endpoint for A and AAAA records", async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.toString());
    assert.equal(url.origin + url.pathname, "https://cloudflare-dns.com/dns-query");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("accept"), "application/dns-json");
    const type = url.searchParams.get("type");
    return new Response(JSON.stringify({
      Status: 0,
      Answer: type === "A"
        ? [{ type: 1, data: "8.8.8.8" }]
        : [{ type: 28, data: "2606:4700:4700::1111" }],
    }), { headers: { "content-type": "application/dns-json" } });
  }) as typeof fetch;

  assert.deepEqual(await resolveHostWithCloudflareDns("fifa.com", new AbortController().signal, fetchImpl), [
    "8.8.8.8",
    "2606:4700:4700::1111",
  ]);
  assert.equal(requests.length, 2);
});

test("rejects an oversized declared DNS response before retaining its body", async () => {
  let cancelCalls = 0;
  const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("{}")); },
    cancel() { cancelCalls += 1; },
  }), {
    headers: {
      "content-type": "application/dns-json",
      "content-length": String(32 * 1024 + 1),
    },
  })) as typeof fetch;

  await assert.rejects(
    () => resolveHostWithCloudflareDns("fifa.com", new AbortController().signal, fetchImpl),
    /크기/,
  );
  assert.ok(cancelCalls >= 1);
});
