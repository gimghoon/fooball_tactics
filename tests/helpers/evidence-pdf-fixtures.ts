import { deflateSync } from "node:zlib";

type PdfObjectFixture = {
  header?: string;
  body: string | Uint8Array | Array<string | Uint8Array>;
};

function assemblePdf(objects: PdfObjectFixture[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const offsets = [0];
  let length = 0;
  const encoder = new TextEncoder();
  const push = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    length += bytes.byteLength;
  };

  push("%PDF-1.4\n");
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    push(`${object.header ?? `${index + 1} 0`} obj\n`);
    for (const part of Array.isArray(object.body) ? object.body : [object.body]) push(part);
    push("\nendobj\n");
  }
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  push(offsets.slice(1).map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join(""));
  push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);

  const output = new Uint8Array(length);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

function basePage(contents = "4 0 R", resources = "/Font << /F1 5 0 R >>"): PdfObjectFixture[] {
  return [
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} >>` },
  ];
}

function content(text: string): Uint8Array {
  return new TextEncoder().encode(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`);
}

function lzwLiteralStream(bytes: Uint8Array): Uint8Array {
  const codes = [256, ...bytes, 257];
  const output = new Uint8Array(Math.ceil(codes.length * 9 / 8));
  let bitOffset = 0;
  for (const code of codes) {
    for (let bit = 8; bit >= 0; bit -= 1) {
      if ((code & (1 << bit)) !== 0) output[bitOffset >> 3] |= 1 << (7 - (bitOffset & 7));
      bitOffset += 1;
    }
  }
  return output;
}

function ascii85Stream(bytes: Uint8Array): Uint8Array {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 4) {
    const count = Math.min(4, bytes.byteLength - offset);
    let value = 0;
    for (let index = 0; index < 4; index += 1) value = value * 256 + (bytes[offset + index] ?? 0);
    if (count === 4 && value === 0) {
      encoded += "z";
      continue;
    }
    const digits = new Array<number>(5);
    for (let index = 4; index >= 0; index -= 1) {
      digits[index] = value % 85;
      value = Math.floor(value / 85);
    }
    encoded += digits.slice(0, count + 1).map((digit) => String.fromCharCode(digit + 0x21)).join("");
  }
  return new TextEncoder().encode(`${encoded}~>`);
}

function runLengthStream(bytes: Uint8Array): Uint8Array {
  const encoded: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 128) {
    const count = Math.min(128, bytes.byteLength - offset);
    encoded.push(count - 1, ...bytes.subarray(offset, offset + count));
  }
  encoded.push(128);
  return Uint8Array.from(encoded);
}

function xrefEntry(type: number, field2: number, field3: number): Uint8Array {
  return Uint8Array.of(
    type,
    field2 >>> 24,
    field2 >>> 16,
    field2 >>> 8,
    field2,
    field3 >>> 8,
    field3,
  );
}

export function compressedObjectIndirectTextPdf(): Uint8Array {
  const encoder = new TextEncoder();
  const contentBytes = content("Press forward");
  const compressedContent = deflateSync(contentBytes);
  const lengthValue = String(compressedContent.byteLength);
  const decodeParmsValue = "<< /Predictor 1 >>";
  const objectStreamHeader = `6 0 7 ${encoder.encode(`${lengthValue} `).byteLength} `;
  const objectStreamBody = encoder.encode(`${objectStreamHeader}${lengthValue} ${decodeParmsValue}`);
  const compressedObjects = deflateSync(objectStreamBody);
  const chunks: Uint8Array[] = [];
  const offsets = new Map<number, number>();
  let byteLength = 0;
  const push = (value: string | Uint8Array) => {
    const bytes = typeof value === "string" ? encoder.encode(value) : value;
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  };
  const object = (objectNumber: number, body: Array<string | Uint8Array>) => {
    offsets.set(objectNumber, byteLength);
    push(`${objectNumber} 0 obj\n`);
    for (const part of body) push(part);
    push("\nendobj\n");
  };

  push("%PDF-1.5\n%âãÏÓ\n");
  object(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  object(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  object(3, [
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ",
    "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  ]);
  object(4, [
    "<< /Length 6 0 R /Filter /FlateDecode /DecodeParms 7 0 R >>\nstream\n",
    compressedContent,
    "\nendstream",
  ]);
  object(5, ["<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]);
  object(8, [
    `<< /Type /ObjStm /N 2 /First ${encoder.encode(objectStreamHeader).byteLength} /Length ${compressedObjects.byteLength} /Filter /FlateDecode >>\nstream\n`,
    compressedObjects,
    "\nendstream",
  ]);

  const xrefOffset = byteLength;
  offsets.set(9, xrefOffset);
  const xref = new Uint8Array(10 * 7);
  xref.set(xrefEntry(0, 0, 0xffff), 0);
  for (const objectNumber of [1, 2, 3, 4, 5, 8, 9]) {
    xref.set(xrefEntry(1, offsets.get(objectNumber)!, 0), objectNumber * 7);
  }
  xref.set(xrefEntry(2, 8, 0), 6 * 7);
  xref.set(xrefEntry(2, 8, 1), 7 * 7);
  object(9, [
    `<< /Type /XRef /Size 10 /Root 1 0 R /W [1 4 2] /Index [0 10] /Length ${xref.byteLength} >>\nstream\n`,
    xref,
    "\nendstream",
  ]);
  push(`startxref\n${xrefOffset}\n%%EOF`);

  const output = new Uint8Array(byteLength);
  let cursor = 0;
  for (const chunk of chunks) {
    output.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return output;
}

export function invalidPredictorPdf(): Uint8Array {
  const compressed = deflateSync(content("Press forward"));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode /DecodeParms << /Predictor 999 /Columns 1 >> >>\nstream\n`,
        compressed,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function largeSingleRowPredictorPdf(columns = 1024 * 1024): Uint8Array {
  const compressed = deflateSync(new Uint8Array(columns));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 1 /BitsPerComponent 8 /Columns ${columns} >> >>\nstream\n`,
        compressed,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function excessivePredictorColorsPdf(): Uint8Array {
  const compressed = deflateSync(new Uint8Array(1));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode /DecodeParms << /Predictor 2 /Colors 536870912 /BitsPerComponent 1 /Columns 1 >> >>\nstream\n`,
        compressed,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function unsupportedFilterPdf(): Uint8Array {
  const bytes = content("Press forward");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length ${bytes.byteLength} /Filter /MadeUp >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function downstreamToleratedObjectHeaderPdf(): Uint8Array {
  const bytes = new TextEncoder().encode("notflate");
  return assemblePdf([
    ...basePage(),
    {
      header: "4.0 0",
      body: [`<< /Length ${bytes.byteLength} /Filter /FlateDecode >>\nstream\n`, bytes, "\nendstream"],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function imageBackedScanPdf(): Uint8Array {
  const image = deflateSync(new Uint8Array(900 * 900 * 3));
  const drawImage = new TextEncoder().encode("q 900 0 0 900 0 0 cm /Im0 Do Q");
  return assemblePdf([
    ...basePage("4 0 R", "/XObject << /Im0 5 0 R >>"),
    { body: [`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, "\nendstream"] },
    {
      body: [
        `<< /Type /XObject /Subtype /Image /Width 900 /Height 900 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.byteLength} /Filter /FlateDecode >>\nstream\n`,
        image,
        "\nendstream",
      ],
    },
  ]);
}

export function jpegImageScanPdf(): Uint8Array {
  const image = Buffer.from(
    "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpAB//Z",
    "base64",
  );
  const drawImage = new TextEncoder().encode("q 1 0 0 1 0 0 cm /Im0 Do Q");
  return assemblePdf([
    ...basePage("4 0 R", "/XObject << /Im0 5 0 R >>"),
    { body: [`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, "\nendstream"] },
    {
      body: [
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.byteLength} /Filter /DCTDecode >>\nstream\n`,
        image,
        "\nendstream",
      ],
    },
  ]);
}

export function sharedJpegTwoPageScanPdf(): Uint8Array {
  const encodedImage = Buffer.from(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAaADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQABAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A+L6KKK/lM/38P//Z",
    "base64",
  );
  const imageParts: Uint8Array[] = [encodedImage.subarray(0, 2)];
  let imageOffset = 2;
  while (imageOffset + 4 <= encodedImage.byteLength && encodedImage[imageOffset] === 0xff) {
    const marker = encodedImage[imageOffset + 1]!;
    if (marker === 0xda) {
      imageParts.push(encodedImage.subarray(imageOffset));
      break;
    }
    const segmentLength = (encodedImage[imageOffset + 2]! << 8) | encodedImage[imageOffset + 3]!;
    if (marker < 0xe0 || marker > 0xef) imageParts.push(encodedImage.subarray(imageOffset, imageOffset + 2 + segmentLength));
    imageOffset += 2 + segmentLength;
  }
  const image = Buffer.concat(imageParts);
  const drawImage = new TextEncoder().encode("q 1 0 0 1 0 0 cm /Im0 Do Q");
  return assemblePdf([
    { body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { body: "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>" },
    { body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 7 0 R >> >> /Contents 5 0 R >>" },
    { body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 7 0 R >> >> /Contents 6 0 R >>" },
    { body: [`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, "\nendstream"] },
    { body: [`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, "\nendstream"] },
    {
      body: [
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.byteLength} /Filter /DCTDecode >>\nstream\n`,
        image,
        "\nendstream",
      ],
    },
  ]);
}

export function corruptJpegImageScanPdf(): Uint8Array {
  const image = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  const drawImage = new TextEncoder().encode("q 1 0 0 1 0 0 cm /Im0 Do Q");
  return assemblePdf([
    ...basePage("4 0 R", "/XObject << /Im0 5 0 R >>"),
    { body: [`<< /Length ${drawImage.byteLength} >>\nstream\n`, drawImage, "\nendstream"] },
    {
      body: [
        `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${image.byteLength} /Filter /DCTDecode >>\nstream\n`,
        image,
        "\nendstream",
      ],
    },
  ]);
}

export function corruptJpegHuffmanImageScanPdf(): Uint8Array {
  const pdf = jpegImageScanPdf();
  const start = pdf.findIndex((value, index) => value === 0xff && pdf[index + 1] === 0xd8);
  if (start < 0) throw new Error("JPEG fixture is missing its SOI marker");
  pdf[start + 164] = 0xff;
  return pdf;
}

export function indirectLengthTextPdf(): Uint8Array {
  const bytes = content("Press forward");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length 6 0 R >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { body: String(bytes.byteLength) },
  ]);
}

export function commentedIndirectLengthTextPdf(): Uint8Array {
  const bytes = content("Press forward");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length 6 0 R >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { body: `% a legal comment before the value\n${bytes.byteLength}` },
  ]);
}

export function corruptLzwPdf(): Uint8Array {
  const bytes = new TextEncoder().encode("notlzw");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length ${bytes.byteLength} /Filter /LZWDecode >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function indirectFilterCorruptFlatePdf(): Uint8Array {
  const bytes = new TextEncoder().encode("notflate");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length ${bytes.byteLength} /Filter 6 0 R >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { body: "/FlateDecode" },
  ]);
}

export function corruptSecondFlatePdf(): Uint8Array {
  const firstStage = deflateSync(new TextEncoder().encode("notflate"));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${firstStage.byteLength} /Filter [/FlateDecode /FlateDecode] >>\nstream\n`,
        firstStage,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function indirectInvalidPredictorPdf(): Uint8Array {
  const compressed = deflateSync(content("Press forward"));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode /DecodeParms 6 0 R >>\nstream\n`,
        compressed,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { body: "<< /Predictor 999 /Columns 1 >>" },
  ]);
}

export function lzwTextPdf(): Uint8Array {
  const encoded = lzwLiteralStream(content("Press forward"));
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length ${encoded.byteLength} /Filter /LZWDecode >>\nstream\n`, encoded, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function ascii85FlateTextPdf(): Uint8Array {
  const encoded = ascii85Stream(deflateSync(content("Press forward")));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${encoded.byteLength} /Filter [/ASCII85Decode /FlateDecode] >>\nstream\n`,
        encoded,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function runLengthFlateTextPdf(): Uint8Array {
  const encoded = runLengthStream(deflateSync(content("Press forward")));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${encoded.byteLength} /Filter [/RunLengthDecode /FlateDecode] >>\nstream\n`,
        encoded,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function lzwFlateTextPdf(): Uint8Array {
  const encoded = lzwLiteralStream(deflateSync(content("Press forward")));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${encoded.byteLength} /Filter [/LZWDecode /FlateDecode] >>\nstream\n`,
        encoded,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function multiFlateTextPdf(): Uint8Array {
  const encoded = deflateSync(deflateSync(content("Press forward")));
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${encoded.byteLength} /Filter [/FlateDecode /FlateDecode] >>\nstream\n`,
        encoded,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}

export function multiFilterTextPdf(): Uint8Array {
  const compressed = deflateSync(content("Press forward"));
  const encoded = new TextEncoder().encode(`${Buffer.from(compressed).toString("hex").toUpperCase()}>`);
  return assemblePdf([
    ...basePage(),
    {
      body: [
        `<< /Length ${encoded.byteLength} /Filter [/ASCIIHexDecode /FlateDecode] >>\nstream\n`,
        encoded,
        "\nendstream",
      ],
    },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
  ]);
}
