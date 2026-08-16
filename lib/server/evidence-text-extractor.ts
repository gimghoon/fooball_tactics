export type EvidenceFileKind = "pdf" | "text";

export type ExtractedPage = {
  locator: string;
  text: string;
};

function extractTextParagraphs(bytes: Uint8Array): ExtractedPage[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("텍스트 파일은 UTF-8이어야 합니다.");
  }
  return text
    .split(/\r?\n\s*\r?\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({ locator: `paragraph:${index + 1}`, text: paragraph }));
}

async function extractPdfPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  // This module is only imported by lib/server/evidence-storage.ts. Keeping the
  // parser behind a dynamic import avoids loading it in browser-facing modules.
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
  });

  try {
    const document = await loadingTask.promise;
    const pages: ExtractedPage[] = [];
    for (let index = 1; index <= document.numPages; index += 1) {
      const content = await (await document.getPage(index)).getTextContent();
      const text = content.items
        .filter((item): item is typeof item & { str: string } => "str" in item)
        .map((item) => item.str)
        .join(" ");
      pages.push({ locator: `page:${index}`, text });
    }
    return pages;
  } finally {
    await loadingTask.destroy();
  }
}

/** Extracts text only; scanned PDFs deliberately remain unsupported in the MVP. */
export async function extractEvidenceText(kind: EvidenceFileKind, bytes: Uint8Array): Promise<ExtractedPage[]> {
  return kind === "pdf" ? extractPdfPages(bytes) : extractTextParagraphs(bytes);
}
