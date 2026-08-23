import { EvidenceValidationError } from "../domain/evidence.ts";
import { MAX_EXTRACTION_MS } from "./evidence-text-extractor.ts";

export const MAX_PDF_PREFLIGHT_OBJECTS = 20_000;
export const MAX_PDF_PREFLIGHT_TOKENS = 500_000;
export const MAX_PDF_PREFLIGHT_TOKEN_BYTES = 4_096;
export const MAX_PDF_PREFLIGHT_NESTING = 32;
export const MAX_PDF_PREFLIGHT_STREAMS = 10_000;
export const MAX_PDF_PREDICTOR_COLORS = 32;
// PDF streams also carry image resources, so their decoded budgets must not be
// sized like extracted text. These bounds admit ordinary scans while still
// preventing a <=20 MiB upload from expanding without limit in one request.
export const MAX_PDF_FLATE_DECODED_BYTES_PER_STREAM = 64 * 1024 * 1024;
export const MAX_PDF_FLATE_DECODED_BYTES_AGGREGATE = 128 * 1024 * 1024;

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
  | { kind: "reference"; objectNumber: number; generation: number }
  | { kind: "array"; values: PdfValue[] }
  | { kind: "dictionary"; values: Map<string, PdfValue> }
  | { kind: "other"; value: string };

type PdfIndirectObject = {
  value: PdfValue;
  isStream: boolean;
};

type PdfStreamDescriptor = {
  dictionary: Map<string, PdfValue>;
  dataStart: number;
};

type PdfDecodedBudget = {
  consume: (byteLength: number) => void;
};

type PdfPredictorParameters = {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
  earlyChange: number;
};

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

const VALIDATED_FILTERS = new Set([
  "Fl", "FlateDecode", "LZW", "LZWDecode", "A85", "ASCII85Decode",
  "AHx", "ASCIIHexDecode", "RL", "RunLengthDecode", "DCT", "DCTDecode",
]);

function isPdfNumber(value: string): boolean {
  return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
}

class PdfDecodedWriter {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private current = new Uint8Array(8 * 1024);
  private currentLength = 0;
  private nextActivityCheck = 4 * 1024;

  constructor(
    private readonly budget: PdfDecodedBudget,
    private readonly retain: boolean,
    private readonly assertActive: () => void,
  ) {}

  private account(byteLength: number): void {
    this.budget.consume(byteLength);
    this.byteLength += byteLength;
    if (this.byteLength >= this.nextActivityCheck) {
      this.assertActive();
      this.nextActivityCheck = this.byteLength + 4 * 1024;
    }
  }

  write(value: Uint8Array): void {
    if (value.byteLength === 0) return;
    this.account(value.byteLength);
    if (!this.retain) return;
    let offset = 0;
    while (offset < value.byteLength) {
      const copied = Math.min(this.current.byteLength - this.currentLength, value.byteLength - offset);
      this.current.set(value.subarray(offset, offset + copied), this.currentLength);
      this.currentLength += copied;
      offset += copied;
      if (this.currentLength === this.current.byteLength) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(8 * 1024);
        this.currentLength = 0;
        this.assertActive();
      }
    }
  }

  writeByte(value: number): void {
    this.account(1);
    if (!this.retain) return;
    this.current[this.currentLength++] = value & 0xff;
    if (this.currentLength === this.current.byteLength) {
      this.chunks.push(this.current);
      this.current = new Uint8Array(8 * 1024);
      this.currentLength = 0;
    }
  }

  writeRepeated(value: number, count: number): void {
    if (count <= 0) return;
    this.account(count);
    if (!this.retain) return;
    let remaining = count;
    while (remaining > 0) {
      const copied = Math.min(this.current.byteLength - this.currentLength, remaining);
      this.current.fill(value & 0xff, this.currentLength, this.currentLength + copied);
      this.currentLength += copied;
      remaining -= copied;
      if (this.currentLength === this.current.byteLength) {
        this.chunks.push(this.current);
        this.current = new Uint8Array(8 * 1024);
        this.currentLength = 0;
        this.assertActive();
      }
    }
  }

  finish(): Uint8Array | null {
    if (!this.retain) return null;
    if (this.currentLength > 0) this.chunks.push(this.current.slice(0, this.currentLength));
    const output = new Uint8Array(this.byteLength);
    let offset = 0;
    for (const [index, chunk] of this.chunks.entries()) {
      if ((index & 7) === 0) this.assertActive();
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

function assertOnlyWhitespace(
  bytes: Uint8Array,
  start: number,
  assertActive: () => void,
): void {
  for (let index = start; index < bytes.byteLength; index += 1) {
    if ((index - start & 4095) === 0) assertActive();
    if (!isWhite(bytes[index]!)) invalidPdf();
  }
}

type PdfJpegInfo = {
  width: number;
  height: number;
  bitsPerComponent: number;
  components: number;
};

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function validateJpeg(
  bytes: Uint8Array,
  budget: PdfDecodedBudget,
  assertActive: () => void,
): PdfJpegInfo {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalidPdf();
  let position = 2;
  let inEntropyData = false;
  let sawScan = false;
  let sawEnd = false;
  let info: PdfJpegInfo | undefined;
  let checkpoint = position;

  while (position < bytes.byteLength) {
    if (position - checkpoint >= 4096) {
      assertActive();
      checkpoint = position;
    }
    if (inEntropyData) {
      while (position < bytes.byteLength && bytes[position] !== 0xff) {
        position += 1;
        if (position - checkpoint >= 4096) {
          assertActive();
          checkpoint = position;
        }
      }
      if (position >= bytes.byteLength) invalidPdf();
    } else if (bytes[position] !== 0xff) invalidPdf();

    while (position < bytes.byteLength && bytes[position] === 0xff) position += 1;
    if (position >= bytes.byteLength) invalidPdf();
    const marker = bytes[position++]!;
    if (inEntropyData && marker === 0x00) continue;
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!inEntropyData) invalidPdf();
      continue;
    }
    if (marker === 0x01) continue;
    inEntropyData = false;
    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xd8 || marker === 0x00 || position + 2 > bytes.byteLength) invalidPdf();
    const segmentLength = (bytes[position]! << 8) | bytes[position + 1]!;
    if (segmentLength < 2) invalidPdf();
    const payloadStart = position + 2;
    const segmentEnd = position + segmentLength;
    if (segmentEnd > bytes.byteLength) invalidPdf();

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (info !== undefined || segmentLength < 8) invalidPdf();
      const bitsPerComponent = bytes[payloadStart]!;
      const height = (bytes[payloadStart + 1]! << 8) | bytes[payloadStart + 2]!;
      const width = (bytes[payloadStart + 3]! << 8) | bytes[payloadStart + 4]!;
      const components = bytes[payloadStart + 5]!;
      if (bitsPerComponent <= 0 || width <= 0 || height <= 0 || components <= 0
        || segmentLength !== 8 + components * 3) invalidPdf();
      info = { width, height, bitsPerComponent, components };
    } else if (marker === 0xda) {
      const components = bytes[payloadStart]!;
      if (info === undefined || components <= 0 || segmentLength !== 6 + components * 2) invalidPdf();
      sawScan = true;
      inEntropyData = true;
    }
    position = segmentEnd;
  }

  if (!sawEnd || !sawScan || info === undefined) invalidPdf();
  for (; position < bytes.byteLength; position += 1) {
    if ((position & 4095) === 0) assertActive();
    if (!isWhite(bytes[position]!)) invalidPdf();
  }
  const decodedBytes = Math.ceil(
    info.width * info.height * info.components * info.bitsPerComponent / 8,
  );
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes <= 0) invalidPdf();
  budget.consume(decodedBytes);
  return info;
}

function asciiHexDecode(
  bytes: Uint8Array,
  budget: PdfDecodedBudget,
  retain: boolean,
  assertActive: () => void,
): Uint8Array | null {
  const writer = new PdfDecodedWriter(budget, retain, assertActive);
  let highNibble: number | null = null;
  let ended = false;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    if ((index & 4095) === 0) assertActive();
    const byte = bytes[index]!;
    if (isWhite(byte)) continue;
    if (byte === 0x3e) {
      ended = true;
      assertOnlyWhitespace(bytes, index + 1, assertActive);
      break;
    }
    const value = Number.parseInt(String.fromCharCode(byte), 16);
    if (!Number.isInteger(value)) invalidPdf();
    if (highNibble === null) highNibble = value;
    else {
      writer.writeByte((highNibble << 4) | value);
      highNibble = null;
    }
  }
  if (!ended) invalidPdf();
  if (highNibble !== null) writer.writeByte(highNibble << 4);
  return writer.finish();
}

function ascii85Decode(
  bytes: Uint8Array,
  budget: PdfDecodedBudget,
  retain: boolean,
  assertActive: () => void,
): Uint8Array | null {
  const writer = new PdfDecodedWriter(budget, retain, assertActive);
  let tupleValue = 0;
  let tupleLength = 0;
  let ended = false;
  const flush = (count: number) => {
    let value = tupleValue;
    for (let index = tupleLength; index < 5; index += 1) value = value * 85 + 84;
    if (!Number.isSafeInteger(value) || value > 0xffff_ffff) invalidPdf();
    for (let shift = 24; shift >= 32 - count * 8; shift -= 8) writer.writeByte(value >>> shift);
    tupleValue = 0;
    tupleLength = 0;
  };

  for (let index = 0; index < bytes.byteLength; index += 1) {
    if ((index & 4095) === 0) assertActive();
    const byte = bytes[index]!;
    if (isWhite(byte)) continue;
    if (byte === 0x7a) {
      if (tupleLength !== 0) invalidPdf();
      writer.writeRepeated(0, 4);
      continue;
    }
    if (byte === 0x7e) {
      let end = index + 1;
      while (end < bytes.byteLength && isWhite(bytes[end]!)) {
        if ((end - index & 4095) === 0) assertActive();
        end += 1;
      }
      if (bytes[end] !== 0x3e) invalidPdf();
      assertOnlyWhitespace(bytes, end + 1, assertActive);
      ended = true;
      break;
    }
    if (byte < 0x21 || byte > 0x75) invalidPdf();
    tupleValue = tupleValue * 85 + byte - 0x21;
    tupleLength += 1;
    if (tupleLength === 5) flush(4);
  }
  if (!ended || tupleLength === 1) invalidPdf();
  if (tupleLength > 1) {
    const decodedBytes = tupleLength - 1;
    flush(decodedBytes);
  }
  return writer.finish();
}

function runLengthDecode(
  bytes: Uint8Array,
  budget: PdfDecodedBudget,
  retain: boolean,
  assertActive: () => void,
): Uint8Array | null {
  const writer = new PdfDecodedWriter(budget, retain, assertActive);
  let position = 0;
  let nextActivityCheck = 0;
  let ended = false;
  while (position < bytes.byteLength) {
    if (position >= nextActivityCheck) {
      assertActive();
      nextActivityCheck = position + 4 * 1024;
    }
    const length = bytes[position++]!;
    if (length === 128) {
      ended = true;
      assertOnlyWhitespace(bytes, position, assertActive);
      break;
    }
    if (length < 128) {
      const count = length + 1;
      if (position + count > bytes.byteLength) invalidPdf();
      writer.write(bytes.subarray(position, position + count));
      position += count;
      continue;
    }
    if (position >= bytes.byteLength) invalidPdf();
    writer.writeRepeated(bytes[position++]!, 257 - length);
  }
  if (!ended) invalidPdf();
  return writer.finish();
}

function lzwDecode(
  bytes: Uint8Array,
  earlyChange: number,
  budget: PdfDecodedBudget,
  retain: boolean,
  assertActive: () => void,
): Uint8Array | null {
  const writer = new PdfDecodedWriter(budget, retain, assertActive);
  const literals = Array.from({ length: 256 }, (_, value) => Uint8Array.of(value));
  const dictionary = new Array<Uint8Array | undefined>(4_096);
  let nextCode = 258;
  let codeLength = 9;
  let previous: Uint8Array | null = null;
  let bitOffset = 0;
  let codesRead = 0;
  let ended = false;

  const reset = () => {
    dictionary.fill(undefined);
    for (let index = 0; index < literals.length; index += 1) dictionary[index] = literals[index];
    nextCode = 258;
    codeLength = 9;
    previous = null;
  };
  const readCode = (): number | null => {
    if (bitOffset + codeLength > bytes.byteLength * 8) return null;
    let code = 0;
    for (let bit = 0; bit < codeLength; bit += 1) {
      const absolute = bitOffset + bit;
      code = (code << 1) | ((bytes[absolute >> 3]! >> (7 - (absolute & 7))) & 1);
    }
    bitOffset += codeLength;
    return code;
  };

  reset();
  while (true) {
    if ((codesRead++ & 1023) === 0) assertActive();
    const code = readCode();
    if (code === null) invalidPdf();
    if (code === 256) {
      reset();
      continue;
    }
    if (code === 257) {
      ended = true;
      break;
    }

    let entry = code < nextCode ? dictionary[code] : undefined;
    if (entry === undefined && code === nextCode && previous !== null) {
      entry = new Uint8Array(previous.byteLength + 1);
      entry.set(previous);
      entry[entry.byteLength - 1] = previous[0]!;
    }
    if (entry === undefined) invalidPdf();
    writer.write(entry);

    if (previous !== null && nextCode < 4_096) {
      const next = new Uint8Array(previous.byteLength + 1);
      next.set(previous);
      next[next.byteLength - 1] = entry[0]!;
      dictionary[nextCode] = next;
      nextCode += 1;
      if (codeLength < 12 && nextCode + earlyChange === 1 << codeLength) codeLength += 1;
    }
    previous = entry;
  }
  if (!ended) invalidPdf();
  for (let trailingBit = bitOffset; trailingBit < bytes.byteLength * 8; trailingBit += 1) {
    if ((trailingBit - bitOffset & 4095) === 0) assertActive();
    if (((bytes[trailingBit >> 3]! >> (7 - (trailingBit & 7))) & 1) !== 0) invalidPdf();
  }
  return writer.finish();
}

class PdfObjectParser {
  private position = 0;
  private tokens = 0;
  private objects = 0;
  private streams = 0;
  private readonly indirectObjects = new Map<string, PdfIndirectObject>();
  private readonly streamDescriptors: PdfStreamDescriptor[] = [];

  constructor(
    private bytes: Uint8Array,
    private readonly inflate: (
      compressed: Uint8Array,
      budget: PdfDecodedBudget,
      retain: boolean,
    ) => Promise<Uint8Array | null>,
    private readonly createDecodedBudget: () => PdfDecodedBudget,
    private readonly assertActive: () => void,
  ) {}

  async parse(): Promise<void> {
    while (true) {
      const first = this.nextToken();
      if (first === null) break;
      if (first.kind !== "number" && !(first.kind === "keyword" && isPdfNumber(first.value))) continue;
      const afterFirst = this.position;
      const second = this.nextToken();
      const third = this.nextToken();
      const candidateHeader = second !== null && isPdfNumber(second.value)
        && third?.kind === "keyword" && third.value === "obj";
      if (candidateHeader && (first.kind !== "number" || second.kind !== "number")) invalidPdf();
      if (!candidateHeader) {
        this.position = afterFirst;
        continue;
      }
      this.objects += 1;
      if (this.objects > MAX_PDF_PREFLIGHT_OBJECTS) invalidPdf();
      this.assertActive();
      const objectNumber = Number(first.value);
      const generation = Number(second.value);
      if (!Number.isSafeInteger(objectNumber) || objectNumber < 0
        || !Number.isSafeInteger(generation) || generation < 0) invalidPdf();
      this.parseIndirectObject(this.referenceKey(objectNumber, generation));
    }

    const objectStreams = this.streamDescriptors.filter((descriptor) => this.isObjectStream(descriptor));
    for (const descriptor of objectStreams) {
      this.assertActive();
      await this.parseObjectStream(descriptor);
    }
    const parsedObjectStreams = new Set(objectStreams);
    for (const descriptor of this.streamDescriptors) {
      if (parsedObjectStreams.has(descriptor)) continue;
      this.assertActive();
      await this.validateStream(descriptor);
    }
  }

  private isObjectStream(descriptor: PdfStreamDescriptor): boolean {
    const type = descriptor.dictionary.get("Type");
    if (type === undefined) return false;
    const resolved = this.resolveReference(type, true);
    return resolved.kind === "name" && resolved.value === "ObjStm";
  }

  private withBytes<T>(bytes: Uint8Array, parse: () => T): T {
    const savedBytes = this.bytes;
    const savedPosition = this.position;
    this.bytes = bytes;
    this.position = 0;
    try {
      return parse();
    } finally {
      this.bytes = savedBytes;
      this.position = savedPosition;
    }
  }

  private async parseObjectStream(descriptor: PdfStreamDescriptor): Promise<void> {
    const decoded = await this.decodeStream(descriptor, true);
    if (decoded === null) invalidPdf();
    const count = this.integerParameter(descriptor.dictionary, ["N"], -1);
    const first = this.integerParameter(descriptor.dictionary, ["First"], -1);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_PDF_PREFLIGHT_OBJECTS
      || !Number.isSafeInteger(first) || first < 0 || first > decoded.byteLength
      || this.objects + count > MAX_PDF_PREFLIGHT_OBJECTS) invalidPdf();

    const entries = this.withBytes(decoded.subarray(0, first), () => {
      const parsed: Array<{ objectNumber: number; offset: number }> = [];
      for (let index = 0; index < count; index += 1) {
        const objectNumber = this.nextToken();
        const offset = this.nextToken();
        if (objectNumber?.kind !== "number" || offset?.kind !== "number") invalidPdf();
        const numericObject = Number(objectNumber.value);
        const numericOffset = Number(offset.value);
        if (!Number.isSafeInteger(numericObject) || numericObject <= 0
          || !Number.isSafeInteger(numericOffset) || numericOffset < 0) invalidPdf();
        parsed.push({ objectNumber: numericObject, offset: numericOffset });
      }
      if (this.nextToken() !== null) invalidPdf();
      return parsed;
    });
    if (entries.length > 0 && entries[0]!.offset !== 0) invalidPdf();

    for (const [index, entry] of entries.entries()) {
      const nextOffset = entries[index + 1]?.offset ?? decoded.byteLength - first;
      if (nextOffset <= entry.offset) invalidPdf();
      const start = first + entry.offset;
      const end = first + nextOffset;
      if (start < first || end > decoded.byteLength) invalidPdf();
      const value = this.withBytes(decoded.subarray(start, end), () => {
        const parsed = this.parseValue(1);
        if (this.nextToken() !== null) invalidPdf();
        return parsed;
      });
      const key = this.referenceKey(entry.objectNumber, 0);
      if (this.indirectObjects.has(key)) invalidPdf();
      this.objects += 1;
      this.indirectObjects.set(key, { value, isStream: false });
    }
  }

  private parseIndirectObject(key: string): void {
    if (this.indirectObjects.has(key)) invalidPdf();
    const value = this.parseValue(1);
    const following = this.nextToken();
    if (value.kind !== "dictionary" || following?.kind !== "keyword" || following.value !== "stream") {
      if (following?.kind !== "keyword" || following.value !== "endobj") invalidPdf();
      this.indirectObjects.set(key, { value, isStream: false });
      return;
    }

    this.indirectObjects.set(key, { value, isStream: true });
    this.parseStream(value.values, following);
  }

  private parseStream(dictionary: Map<string, PdfValue>, streamToken: Token): void {
    this.streams += 1;
    if (this.streams > MAX_PDF_PREFLIGHT_STREAMS) invalidPdf();
    const dataStart = this.streamDataStart(streamToken.end);
    const availableLength = this.tryStreamLength(dictionary.get("Length"));
    const endStreamStart = availableLength === null
      ? this.findEndStream(dataStart)
      : dataStart + availableLength;
    this.consumeStreamEnd(endStreamStart);
    this.streamDescriptors.push({ dictionary, dataStart });
  }

  private filters(value: PdfValue | undefined): string[] {
    if (value === undefined) return [];
    const resolved = this.resolveReference(value);
    if (resolved.kind === "name") return [resolved.value];
    if (resolved.kind === "array") {
      return resolved.values.map((item) => {
        const filter = this.resolveReference(item);
        if (filter.kind !== "name") invalidPdf();
        return filter.value;
      });
    }
    invalidPdf();
  }

  private referenceKey(objectNumber: number, generation: number): string {
    return `${objectNumber}:${generation}`;
  }

  private resolveReference(
    value: PdfValue,
    allowMissing = false,
    seen = new Set<string>(),
  ): PdfValue {
    if (value.kind !== "reference") return value;
    const key = this.referenceKey(value.objectNumber, value.generation);
    if (seen.has(key) || seen.size >= MAX_PDF_PREFLIGHT_NESTING) invalidPdf();
    const target = this.indirectObjects.get(key);
    if (target === undefined) {
      if (allowMissing) return value;
      invalidPdf();
    }
    if (target.isStream) invalidPdf();
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    return this.resolveReference(target.value, allowMissing, nextSeen);
  }

  private tryStreamLength(value: PdfValue | undefined): number | null {
    if (value === undefined) invalidPdf();
    const resolved = this.resolveReference(value, true);
    if (resolved.kind === "reference") return null;
    if (resolved.kind !== "number" || !Number.isSafeInteger(resolved.value) || resolved.value < 0) invalidPdf();
    return resolved.value;
  }

  private streamLength(value: PdfValue | undefined): number {
    if (value === undefined) invalidPdf();
    const resolved = this.resolveReference(value);
    if (resolved.kind !== "number" || !Number.isSafeInteger(resolved.value) || resolved.value < 0) invalidPdf();
    return resolved.value;
  }

  private decodeParameters(
    filters: string[],
    value: PdfValue | undefined,
  ): Array<Map<string, PdfValue> | undefined> {
    if (value === undefined) return Array.from({ length: filters.length });
    const resolved = this.resolveReference(value);
    const parameter = (item: PdfValue): Map<string, PdfValue> | undefined => {
      const candidate = this.resolveReference(item);
      if (candidate.kind === "other" && candidate.value === "null") return undefined;
      if (candidate.kind !== "dictionary") invalidPdf();
      return candidate.values;
    };
    if (resolved.kind === "array") {
      if (resolved.values.length > filters.length) invalidPdf();
      return filters.map((_, index) => resolved.values[index] === undefined
        ? undefined
        : parameter(resolved.values[index]!));
    }
    if (filters.length !== 1) invalidPdf();
    return [parameter(resolved)];
  }

  private integerParameter(
    dictionary: Map<string, PdfValue> | undefined,
    names: string[],
    fallback: number,
  ): number {
    if (dictionary === undefined) return fallback;
    const values = names.flatMap((name) => dictionary.has(name) ? [dictionary.get(name)!] : []);
    if (values.length > 1) invalidPdf();
    if (values.length === 0) return fallback;
    const resolved = this.resolveReference(values[0]!);
    if (resolved.kind !== "number" || !Number.isInteger(resolved.value)) invalidPdf();
    return resolved.value;
  }

  private predictorParameters(
    dictionary: Map<string, PdfValue> | undefined,
    isLzw: boolean,
  ): PdfPredictorParameters {
    const predictor = this.integerParameter(dictionary, ["Predictor"], 1);
    const colors = this.integerParameter(dictionary, ["Colors"], 1);
    const bitsPerComponent = this.integerParameter(dictionary, ["BitsPerComponent", "BPC"], 8);
    const columns = this.integerParameter(dictionary, ["Columns"], 1);
    const earlyChange = this.integerParameter(dictionary, ["EarlyChange"], 1);
    if (![1, 2, 10, 11, 12, 13, 14, 15].includes(predictor)
      || !Number.isSafeInteger(colors) || colors <= 0 || colors > MAX_PDF_PREDICTOR_COLORS
      || ![1, 2, 4, 8, 16].includes(bitsPerComponent)
      || !Number.isSafeInteger(columns) || columns <= 0
      || ![0, 1].includes(earlyChange)
      || (!isLzw && dictionary?.has("EarlyChange"))) invalidPdf();
    const rowBits = columns * colors * bitsPerComponent;
    if (!Number.isSafeInteger(rowBits) || rowBits <= 0) invalidPdf();
    return { predictor, colors, bitsPerComponent, columns, earlyChange };
  }

  private validateDctStream(
    descriptor: PdfStreamDescriptor,
    bytes: Uint8Array,
    parameters: Map<string, PdfValue> | undefined,
    budget: PdfDecodedBudget,
  ): void {
    const subtype = descriptor.dictionary.get("Subtype");
    if (subtype === undefined) invalidPdf();
    const resolvedSubtype = this.resolveReference(subtype);
    if (resolvedSubtype.kind !== "name" || resolvedSubtype.value !== "Image") invalidPdf();
    const type = descriptor.dictionary.get("Type");
    if (type !== undefined) {
      const resolvedType = this.resolveReference(type);
      if (resolvedType.kind !== "name" || resolvedType.value !== "XObject") invalidPdf();
    }
    const colorTransform = this.integerParameter(parameters, ["ColorTransform"], -1);
    if (![-1, 0, 1].includes(colorTransform)) invalidPdf();
    const jpeg = validateJpeg(bytes, budget, this.assertActive);
    const width = this.integerParameter(descriptor.dictionary, ["Width", "W"], 0);
    const height = this.integerParameter(descriptor.dictionary, ["Height", "H"], 0);
    const bitsPerComponent = this.integerParameter(
      descriptor.dictionary,
      ["BitsPerComponent", "BPC"],
      0,
    );
    if (width !== jpeg.width || height !== jpeg.height
      || bitsPerComponent !== jpeg.bitsPerComponent) invalidPdf();
  }

  private async validateStream(descriptor: PdfStreamDescriptor): Promise<void> {
    await this.decodeStream(descriptor, false);
  }

  private async decodeStream(
    descriptor: PdfStreamDescriptor,
    retainFinal: boolean,
  ): Promise<Uint8Array | null> {
    const length = this.streamLength(descriptor.dictionary.get("Length"));
    const dataEnd = descriptor.dataStart + length;
    if (!Number.isSafeInteger(dataEnd) || dataEnd < descriptor.dataStart || dataEnd > this.bytes.byteLength) invalidPdf();
    const saved = this.position;
    this.consumeStreamEnd(dataEnd);
    this.position = saved;

    const filters = this.filters(descriptor.dictionary.get("Filter"));
    for (const filter of filters) if (!VALIDATED_FILTERS.has(filter)) invalidPdf();
    const parameters = this.decodeParameters(
      filters,
      descriptor.dictionary.get("DecodeParms") ?? descriptor.dictionary.get("DP"),
    );
    const budget = this.createDecodedBudget();
    let current: Uint8Array | null = this.bytes.subarray(descriptor.dataStart, dataEnd);

    for (const [index, filter] of filters.entries()) {
      if (current === null) invalidPdf();
      const hasLaterStage = index + 1 < filters.length;
      const parameter = parameters[index];
      if (filter === "AHx" || filter === "ASCIIHexDecode") {
        if (parameter !== undefined) invalidPdf();
        current = asciiHexDecode(current, budget, hasLaterStage || retainFinal, this.assertActive);
        continue;
      }
      if (filter === "A85" || filter === "ASCII85Decode") {
        if (parameter !== undefined) invalidPdf();
        current = ascii85Decode(current, budget, hasLaterStage || retainFinal, this.assertActive);
        continue;
      }
      if (filter === "RL" || filter === "RunLengthDecode") {
        if (parameter !== undefined) invalidPdf();
        current = runLengthDecode(current, budget, hasLaterStage || retainFinal, this.assertActive);
        continue;
      }
      if (filter === "DCT" || filter === "DCTDecode") {
        if (hasLaterStage || retainFinal) invalidPdf();
        this.validateDctStream(descriptor, current, parameter, budget);
        current = null;
        continue;
      }

      const isLzw = filter === "LZW" || filter === "LZWDecode";
      const predictor = this.predictorParameters(parameter, isLzw);
      const retain = hasLaterStage || predictor.predictor !== 1 || retainFinal;
      let decoded = isLzw
        ? lzwDecode(current, predictor.earlyChange, budget, retain, this.assertActive)
        : await this.inflate(current, budget, retain);
      if (predictor.predictor !== 1) {
        if (decoded === null) invalidPdf();
        decoded = this.applyPredictor(decoded, predictor);
      }
      current = decoded;
    }
    if (!retainFinal) return null;
    return current ?? invalidPdf();
  }

  private applyPredictor(bytes: Uint8Array, parameters: PdfPredictorParameters): Uint8Array {
    if (parameters.predictor === 1) return bytes;
    const rowBytes = Math.ceil(parameters.columns * parameters.colors * parameters.bitsPerComponent / 8);
    const pixelBytes = Math.ceil(parameters.colors * parameters.bitsPerComponent / 8);
    if (!Number.isSafeInteger(rowBytes) || rowBytes <= 0
      || !Number.isSafeInteger(pixelBytes) || pixelBytes <= 0) invalidPdf();
    if (parameters.predictor === 2) return this.applyTiffPredictor(bytes, rowBytes, parameters);
    return this.applyPngPredictor(bytes, rowBytes, pixelBytes);
  }

  private applyTiffPredictor(
    bytes: Uint8Array,
    rowBytes: number,
    parameters: PdfPredictorParameters,
  ): Uint8Array {
    if (bytes.byteLength % rowBytes !== 0) invalidPdf();
    const output = bytes;
    let rowIndex = 0;
    for (let rowStart = 0; rowStart < bytes.byteLength; rowStart += rowBytes, rowIndex += 1) {
      if ((rowIndex & 63) === 0) this.assertActive();
      const raw = bytes.subarray(rowStart, rowStart + rowBytes);
      const row = output.subarray(rowStart, rowStart + rowBytes);
      if (parameters.bitsPerComponent === 1 && parameters.colors === 1) {
        let carry = 0;
        for (let index = 0; index < rowBytes; index += 1) {
          if (index > 0 && (index & 4095) === 0) this.assertActive();
          let value = raw[index]! ^ carry;
          value ^= value >> 1;
          value ^= value >> 2;
          value ^= value >> 4;
          carry = (value & 1) << 7;
          row[index] = value;
        }
        continue;
      }
      if (parameters.bitsPerComponent === 8) {
        for (let index = 0; index < rowBytes; index += 1) {
          if (index > 0 && (index & 4095) === 0) this.assertActive();
          row[index] = index < parameters.colors
            ? raw[index]!
            : row[index - parameters.colors]! + raw[index]!;
        }
        continue;
      }
      if (parameters.bitsPerComponent === 16) {
        const bytesPerPixel = parameters.colors * 2;
        if (rowBytes < bytesPerPixel || rowBytes % 2 !== 0) invalidPdf();
        row.set(raw.subarray(0, bytesPerPixel));
        for (let index = bytesPerPixel; index < rowBytes; index += 2) {
          if (index > bytesPerPixel && (index & 4095) === 0) this.assertActive();
          const value = (raw[index]! << 8) + raw[index + 1]!
            + (row[index - bytesPerPixel]! << 8) + row[index - bytesPerPixel + 1]!;
          row[index] = value >>> 8;
          row[index + 1] = value;
        }
        continue;
      }

      const components = new Uint8Array(parameters.colors);
      const mask = (1 << parameters.bitsPerComponent) - 1;
      let inputBuffer = 0;
      let inputBits = 0;
      let inputIndex = 0;
      let outputBuffer = 0;
      let outputBits = 0;
      let outputIndex = 0;
      let componentsProcessed = 0;
      for (let column = 0; column < parameters.columns; column += 1) {
        for (let component = 0; component < parameters.colors; component += 1) {
          if ((componentsProcessed++ & 4095) === 0) this.assertActive();
          while (inputBits < parameters.bitsPerComponent) {
            if (inputIndex >= raw.byteLength) invalidPdf();
            inputBuffer = (inputBuffer << 8) | raw[inputIndex++]!;
            inputBits += 8;
          }
          components[component] = (components[component]!
            + ((inputBuffer >> (inputBits - parameters.bitsPerComponent)) & mask)) & mask;
          inputBits -= parameters.bitsPerComponent;
          outputBuffer = (outputBuffer << parameters.bitsPerComponent) | components[component]!;
          outputBits += parameters.bitsPerComponent;
          if (outputBits >= 8) {
            row[outputIndex++] = (outputBuffer >> (outputBits - 8)) & 0xff;
            outputBits -= 8;
          }
        }
      }
      if (outputBits > 0) {
        row[outputIndex++] = ((outputBuffer << (8 - outputBits))
          + (inputBuffer & ((1 << (8 - outputBits)) - 1))) & 0xff;
      }
      if (outputIndex !== rowBytes) invalidPdf();
    }
    return output;
  }

  private applyPngPredictor(bytes: Uint8Array, rowBytes: number, pixelBytes: number): Uint8Array {
    const encodedRowBytes = rowBytes + 1;
    if (bytes.byteLength % encodedRowBytes !== 0) invalidPdf();
    const rows = bytes.byteLength / encodedRowBytes;
    const output = bytes.subarray(0, rows * rowBytes);
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      if ((rowIndex & 63) === 0) this.assertActive();
      const encodedStart = rowIndex * encodedRowBytes;
      const filter = bytes[encodedStart]!;
      if (filter > 4) invalidPdf();
      const raw = bytes.subarray(encodedStart + 1, encodedStart + encodedRowBytes);
      const rowStart = rowIndex * rowBytes;
      const row = output.subarray(rowStart, rowStart + rowBytes);
      const previous = rowIndex === 0 ? null : output.subarray(rowStart - rowBytes, rowStart);
      for (let index = 0; index < rowBytes; index += 1) {
        if (index > 0 && (index & 4095) === 0) this.assertActive();
        const left = index < pixelBytes ? 0 : row[index - pixelBytes]!;
        const up = previous?.[index] ?? 0;
        const upLeft = index < pixelBytes ? 0 : previous?.[index - pixelBytes] ?? 0;
        if (filter === 0) row[index] = raw[index]!;
        else if (filter === 1) row[index] = raw[index]! + left;
        else if (filter === 2) row[index] = raw[index]! + up;
        else if (filter === 3) row[index] = raw[index]! + Math.floor((left + up) / 2);
        else {
          const estimate = left + up - upLeft;
          const leftDistance = Math.abs(estimate - left);
          const upDistance = Math.abs(estimate - up);
          const upLeftDistance = Math.abs(estimate - upLeft);
          const predicted = leftDistance <= upDistance && leftDistance <= upLeftDistance
            ? left
            : upDistance <= upLeftDistance ? up : upLeft;
          row[index] = raw[index]! + predicted;
        }
      }
    }
    return output;
  }

  private streamDataStart(afterKeyword: number): number {
    if (this.bytes[afterKeyword] === 13 && this.bytes[afterKeyword + 1] === 10) return afterKeyword + 2;
    if (this.bytes[afterKeyword] === 10 || this.bytes[afterKeyword] === 13) return afterKeyword + 1;
    invalidPdf();
  }

  private consumeStreamEnd(dataEnd: number): void {
    if (!Number.isSafeInteger(dataEnd) || dataEnd < 0 || dataEnd > this.bytes.byteLength) invalidPdf();
    this.position = dataEnd;
    const endStream = this.nextToken();
    const endObject = this.nextToken();
    if (endStream?.kind !== "keyword" || endStream.value !== "endstream"
      || endObject?.kind !== "keyword" || endObject.value !== "endobj") invalidPdf();
  }

  private findEndStream(dataStart: number): number {
    const marker = "endstream";
    for (let index = dataStart; index <= this.bytes.byteLength - marker.length; index += 1) {
      if ((index - dataStart & 4095) === 0) this.assertActive();
      if (ascii(this.bytes, index, index + marker.length) !== marker) continue;
      if (index > dataStart && !isWhite(this.bytes[index - 1]!)) continue;
      const after = this.bytes[index + marker.length];
      if (after !== undefined && !isWhite(after) && !isDelimiter(after)) continue;
      const saved = this.position;
      this.position = index;
      const endStream = this.nextToken();
      const endObject = this.nextToken();
      this.position = saved;
      if (endStream?.start === index && endStream.kind === "keyword" && endStream.value === marker
        && endObject?.kind === "keyword" && endObject.value === "endobj") return index;
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
        const objectNumber = Number(token.value);
        const generationNumber = Number(generation.value);
        if (!Number.isSafeInteger(objectNumber) || objectNumber < 0
          || !Number.isSafeInteger(generationNumber) || generationNumber < 0) invalidPdf();
        return { kind: "reference", objectNumber, generation: generationNumber };
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
    return { kind: "other", value: token.value };
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
  const defaultDecompression = (compressed: Uint8Array) => {
    // A decoded wrapper stage may return a subarray whose backing buffer is
    // larger than the view. Copy the exact view so trailing capacity is never
    // passed to the zlib decoder as stream data.
    const exact = compressed.slice();
    return new Blob([exact.buffer]).stream().pipeThrough(new DecompressionStream("deflate"));
  };
  const createDecodedBudget = (): PdfDecodedBudget => {
    let streamBytes = 0;
    return {
      consume(byteLength) {
        if (!Number.isSafeInteger(byteLength) || byteLength < 0) invalidPdf();
        streamBytes += byteLength;
        aggregateBytes += byteLength;
        if (streamBytes > perStreamLimit || aggregateBytes > aggregateLimit) invalidPdf();
      },
    };
  };

  await new PdfObjectParser(bytes, async (compressed, budget, retain) => {
    assertActive();
    const reader = (options.decompressionStream ?? defaultDecompression)(compressed).getReader();
    const writer = new PdfDecodedWriter(budget, retain, assertActive);
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
        writer.write(result.value);
      }
    } catch {
      invalidPdf();
    } finally {
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    return writer.finish();
  }, createDecodedBudget, assertActive).parse();
  assertActive();
  return { remainingMs: () => Math.max(0, deadline - now()) };
}
