import { EvidenceValidationError } from "../domain/evidence.ts";
import { MAX_EXTRACTION_MS } from "./evidence-text-extractor.ts";

export const MAX_PDF_PREFLIGHT_OBJECTS = 20_000;
export const MAX_PDF_PREFLIGHT_TOKENS = 500_000;
export const MAX_PDF_PREFLIGHT_TOKEN_BYTES = 4_096;
export const MAX_PDF_PREFLIGHT_NESTING = 32;
export const MAX_PDF_PREFLIGHT_STREAMS = 10_000;
export const MAX_PDF_FLATE_DECODED_BYTES_PER_STREAM = 2 * 1024 * 1024;
/** Intentionally below the 5 MiB extracted-text output budget. */
export const MAX_PDF_FLATE_DECODED_BYTES_AGGREGATE = 4 * 1024 * 1024;

export type EvidencePdfPreflightOptions = {
  maxDecodedBytesPerStream?: number;
  maxDecodedBytesAggregate?: number;
  maxExtractionMs?: number;
  now?: () => number;
  abortSignal?: AbortSignal;
  /** Server-only seam for deterministic decompression budget tests. */
  decompressionStream?: (compressed: Uint8Array) => ReadableStream<Uint8Array>;
};

type Token = {
  kind: "number" | "keyword" | "name" | "delimiter" | "other";
  value: string;
  start: number;
  end: number;
};

type PdfValue =
  | { kind: "number"; value: number }
  | { kind: "name"; value: string }
  | { kind: "reference" }
  | { kind: "array"; values: PdfValue[] }
  | { kind: "dictionary"; values: Map<string, PdfValue> }
  | { kind: "other" };

function invalidPdf(): never {
  throw new EvidenceValidationError("PDF 파일을 확인할 수 없습니다.");
}

function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, maximum);
}

function isWhite(byte: number): boolean {
  return byte === 0 || byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 32;
}

function isDelimiter(byte: number): boolean {
  return [0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25].includes(byte);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function decodePdfName(raw: string): string {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== "#") {
      decoded += raw[index];
      continue;
    }
    const escaped = raw.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/i.test(escaped)) invalidPdf();
    decoded += String.fromCharCode(Number.parseInt(escaped, 16));
    index += 2;
  }
  return decoded;
}

class PdfObjectParser {
  private position = 0;
  private tokens = 0;
  private objects = 0;
  private streams = 0;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly validateFlate: (compressed: Uint8Array) => Promise<void>,
    private readonly assertActive: () => void,
  ) {}

  async parse(): Promise<void> {
    while (true) {
      const first = this.nextToken();
      if (first === null) return;
      if (first.kind !== "number") continue;
      const afterFirst = this.position;
      const second = this.nextToken();
      const third = this.nextToken();
      if (second?.kind !== "number" || third?.kind !== "keyword" || third.value !== "obj") {
        this.position = afterFirst;
        continue;
      }
      this.objects += 1;
      if (this.objects > MAX_PDF_PREFLIGHT_OBJECTS) invalidPdf();
      this.assertActive();
      await this.parseIndirectObject();
    }
  }

  private async parseIndirectObject(): Promise<void> {
    const valueStart = this.nextToken();
    if (valueStart === null) invalidPdf();
    if (valueStart.kind !== "delimiter" || valueStart.value !== "<<") {
      this.skipToEndObject(valueStart);
      return;
    }

    const dictionary = this.parseDictionary(1);
    const following = this.nextToken();
    if (following?.kind !== "keyword" || following.value !== "stream") {
      this.skipToEndObject(following);
      return;
    }

    this.streams += 1;
    if (this.streams > MAX_PDF_PREFLIGHT_STREAMS) invalidPdf();
    const length = dictionary.get("Length");
    if (length?.kind !== "number" || !Number.isSafeInteger(length.value) || length.value < 0) invalidPdf();
    const filter = dictionary.get("Filter");
    const filters = this.filters(filter);
    const dataStart = this.streamDataStart(following.end);
    const dataEnd = dataStart + length.value;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < dataStart || dataEnd > this.bytes.byteLength) invalidPdf();

    if (filters.length > 1) invalidPdf();
    if (filters[0] === "FlateDecode" || filters[0] === "Fl") {
      await this.validateFlate(this.bytes.slice(dataStart, dataEnd));
    }

    this.position = dataEnd;
    const endStream = this.nextToken();
    const endObject = this.nextToken();
    if (endStream?.kind !== "keyword" || endStream.value !== "endstream"
      || endObject?.kind !== "keyword" || endObject.value !== "endobj") invalidPdf();
  }

  private filters(value: PdfValue | undefined): string[] {
    if (value === undefined) return [];
    if (value.kind === "name") return [value.value];
    if (value.kind === "array" && value.values.every((item) => item.kind === "name")) {
      return value.values.map((item) => (item as { kind: "name"; value: string }).value);
    }
    invalidPdf();
  }

  private streamDataStart(afterKeyword: number): number {
    if (this.bytes[afterKeyword] === 13 && this.bytes[afterKeyword + 1] === 10) return afterKeyword + 2;
    if (this.bytes[afterKeyword] === 10 || this.bytes[afterKeyword] === 13) return afterKeyword + 1;
    invalidPdf();
  }

  private skipToEndObject(initial: Token | null): void {
    let token = initial;
    while (token !== null) {
      if (token.kind === "keyword" && token.value === "endobj") return;
      if (token.kind === "keyword" && token.value === "stream") invalidPdf();
      token = this.nextToken();
    }
    invalidPdf();
  }

  private parseDictionary(depth: number): Map<string, PdfValue> {
    if (depth > MAX_PDF_PREFLIGHT_NESTING) invalidPdf();
    const values = new Map<string, PdfValue>();
    while (true) {
      const key = this.nextToken();
      if (key === null) invalidPdf();
      if (key.kind === "delimiter" && key.value === ">>") return values;
      if (key.kind !== "name") invalidPdf();
      const decoded = decodePdfName(key.value);
      if (values.has(decoded)) invalidPdf();
      values.set(decoded, this.parseValue(depth + 1));
    }
  }

  private parseValue(depth: number): PdfValue {
    if (depth > MAX_PDF_PREFLIGHT_NESTING) invalidPdf();
    const token = this.nextToken();
    if (token === null) invalidPdf();
    if (token.kind === "name") return { kind: "name", value: decodePdfName(token.value) };
    if (token.kind === "number") {
      const afterNumber = this.position;
      const generation = this.nextToken();
      const reference = this.nextToken();
      if (generation?.kind === "number" && reference?.kind === "keyword" && reference.value === "R") {
        return { kind: "reference" };
      }
      this.position = afterNumber;
      const value = Number(token.value);
      return Number.isFinite(value) ? { kind: "number", value } : invalidPdf();
    }
    if (token.kind === "delimiter" && token.value === "<<") {
      return { kind: "dictionary", values: this.parseDictionary(depth + 1) };
    }
    if (token.kind === "delimiter" && token.value === "[") {
      const values: PdfValue[] = [];
      while (true) {
        const next = this.peekToken();
        if (next === null) invalidPdf();
        if (next.kind === "delimiter" && next.value === "]") {
          this.nextToken();
          return { kind: "array", values };
        }
        values.push(this.parseValue(depth + 1));
      }
    }
    if (token.kind === "delimiter" && ["]", ">>"].includes(token.value)) invalidPdf();
    return { kind: "other" };
  }

  private peekToken(): Token | null {
    const saved = this.position;
    const token = this.nextToken();
    this.position = saved;
    return token;
  }

  private nextToken(): Token | null {
    this.skipSpaceAndComments();
    if (this.position >= this.bytes.byteLength) return null;
    this.tokens += 1;
    if (this.tokens > MAX_PDF_PREFLIGHT_TOKENS) invalidPdf();
    if ((this.tokens & 1023) === 0) this.assertActive();
    const start = this.position;
    const byte = this.bytes[this.position]!;

    if (byte === 0x28) return this.literalString(start);
    if (byte === 0x3c && this.bytes[this.position + 1] !== 0x3c) return this.hexString(start);
    if (byte === 0x2f) {
      this.position += 1;
      const nameStart = this.position;
      while (this.position < this.bytes.byteLength
        && !isWhite(this.bytes[this.position]!) && !isDelimiter(this.bytes[this.position]!)) this.position += 1;
      if (this.position - nameStart > MAX_PDF_PREFLIGHT_TOKEN_BYTES) invalidPdf();
      return { kind: "name", value: ascii(this.bytes, nameStart, this.position), start, end: this.position };
    }
    const pair = ascii(this.bytes, start, Math.min(start + 2, this.bytes.byteLength));
    if (["<<", ">>"].includes(pair)) {
      this.position += 2;
      return { kind: "delimiter", value: pair, start, end: this.position };
    }
    if ([0x5b, 0x5d, 0x7b, 0x7d].includes(byte)) {
      this.position += 1;
      return { kind: "delimiter", value: String.fromCharCode(byte), start, end: this.position };
    }
    this.position += 1;
    while (this.position < this.bytes.byteLength
      && !isWhite(this.bytes[this.position]!) && !isDelimiter(this.bytes[this.position]!)) this.position += 1;
    if (this.position - start > MAX_PDF_PREFLIGHT_TOKEN_BYTES) invalidPdf();
    const value = ascii(this.bytes, start, this.position);
    return { kind: /^[-+]?\d+$/.test(value) ? "number" : "keyword", value, start, end: this.position };
  }

  private literalString(start: number): Token {
    this.position += 1;
    let depth = 1;
    let checkpoint = this.position;
    while (this.position < this.bytes.byteLength) {
      const byte = this.bytes[this.position++]!;
      if (this.position - checkpoint >= 4096) {
        this.assertActive();
        checkpoint = this.position;
      }
      if (byte === 0x5c) {
        if (this.position < this.bytes.byteLength) this.position += 1;
      } else if (byte === 0x28) depth += 1;
      else if (byte === 0x29 && --depth === 0) {
        return { kind: "other", value: "string", start, end: this.position };
      }
    }
    invalidPdf();
  }

  private hexString(start: number): Token {
    this.position += 1;
    let checkpoint = this.position;
    while (this.position < this.bytes.byteLength) {
      if (this.position - checkpoint >= 4096) {
        this.assertActive();
        checkpoint = this.position;
      }
      if (this.bytes[this.position++] === 0x3e) {
        return { kind: "other", value: "hex", start, end: this.position };
      }
    }
    invalidPdf();
  }

  private skipSpaceAndComments(): void {
    let checkpoint = this.position;
    while (this.position < this.bytes.byteLength) {
      if (isWhite(this.bytes[this.position]!)) {
        this.position += 1;
        if (this.position - checkpoint >= 4096) {
          this.assertActive();
          checkpoint = this.position;
        }
        continue;
      }
      if (this.bytes[this.position] !== 0x25) return;
      while (this.position < this.bytes.byteLength && ![10, 13].includes(this.bytes[this.position]!)) {
        this.position += 1;
        if (this.position - checkpoint >= 4096) {
          this.assertActive();
          checkpoint = this.position;
        }
      }
    }
  }
}

export type EvidencePdfPreflightBudget = {
  remainingMs: () => number;
};

export async function validatePdfFlateStreams(
  bytes: Uint8Array,
  options: EvidencePdfPreflightOptions = {},
): Promise<EvidencePdfPreflightBudget> {
  const now = options.now ?? performance.now.bind(performance);
  const startedAt = now();
  const deadline = startedAt + limit(options.maxExtractionMs, MAX_EXTRACTION_MS);
  const perStreamLimit = limit(options.maxDecodedBytesPerStream, MAX_PDF_FLATE_DECODED_BYTES_PER_STREAM);
  const aggregateLimit = limit(options.maxDecodedBytesAggregate, MAX_PDF_FLATE_DECODED_BYTES_AGGREGATE);
  let aggregateBytes = 0;

  const assertActive = () => {
    if (options.abortSignal?.aborted || now() > deadline) invalidPdf();
  };
  const defaultDecompression = (compressed: Uint8Array) => new Blob([compressed.buffer])
    .stream().pipeThrough(new DecompressionStream("deflate"));

  await new PdfObjectParser(bytes, async (compressed) => {
    assertActive();
    const reader = (options.decompressionStream ?? defaultDecompression)(compressed).getReader();
    let streamBytes = 0;
    let complete = false;
    const onAbort = () => void reader.cancel().catch(() => undefined);
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      while (true) {
        assertActive();
        const remaining = Math.max(0, deadline - now());
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new EvidenceValidationError("PDF 파일을 확인할 수 없습니다.")),
            remaining,
          );
        });
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await Promise.race([reader.read(), timeout]);
        } finally {
          clearTimeout(timeoutId);
        }
        assertActive();
        if (result.done) {
          complete = true;
          break;
        }
        streamBytes += result.value.byteLength;
        aggregateBytes += result.value.byteLength;
        if (streamBytes > perStreamLimit || aggregateBytes > aggregateLimit) invalidPdf();
      }
    } catch {
      invalidPdf();
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }, assertActive).parse();
  assertActive();
  return { remainingMs: () => Math.max(0, deadline - now()) };
}
