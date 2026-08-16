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

export function indirectLengthTextPdf(): Uint8Array {
  const bytes = content("Press forward");
  return assemblePdf([
    ...basePage(),
    { body: [`<< /Length 6 0 R >>\nstream\n`, bytes, "\nendstream"] },
    { body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { body: String(bytes.byteLength) },
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
