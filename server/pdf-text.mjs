import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_CHARS = 350000;

export async function extractPdfText(base64) {
  if (!base64) throw Object.assign(new Error("没有收到 PDF 内容。"), { status: 400 });
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > MAX_PDF_BYTES) {
    throw Object.assign(new Error(buffer.length ? "PDF 超过 50MB。" : "PDF 内容为空。"), { status: buffer.length ? 413 : 400 });
  }

  let document;
  try {
    document = await getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: true
    }).promise;
  } catch {
    throw Object.assign(new Error("无法读取这个 PDF，请确认文件未损坏且没有加密。"), { status: 400 });
  }

  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str || "").join(" ").replace(/\s+/g, " ").trim();
    if (text) pages.push(`\n[第 ${pageNumber} 页]\n${text}`);
    if (pages.join("").length >= MAX_TEXT_CHARS) break;
  }
  const result = pages.join("").slice(0, MAX_TEXT_CHARS).trim();
  if (result.length < 200) throw Object.assign(new Error("PDF 中没有提取到足够的文字，可能是扫描版论文。"), { status: 400 });
  return result;
}
