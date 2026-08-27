import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

export function paperLibrary(root) {
  const libraryRoot = path.join(root, "paper-library");
  const uploadsRoot = path.join(libraryRoot, "uploads");

  async function saveBuffer(input, name = "paper.pdf") {
    const buffer = Buffer.from(input || "");
    if (!buffer.length) return "";
    if (buffer.length > 50 * 1024 * 1024) throw Object.assign(new Error("PDF 超过 50MB。"), { status: 413 });
    if (buffer.subarray(0, 4).toString("ascii") !== "%PDF") throw Object.assign(new Error("所选文件不是有效的 PDF。"), { status: 400 });
    const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
    await fs.mkdir(uploadsRoot, { recursive: true });
    const filename = `${hash}.pdf`;
    await fs.writeFile(path.join(uploadsRoot, filename), buffer, { flag: "wx" }).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = { id: hash, originalName: name, savedAt: new Date().toISOString(), bytes: buffer.length };
    await fs.writeFile(path.join(uploadsRoot, `${hash}.json`), JSON.stringify(metadata, null, 2), "utf8");
    return `/paper-files/uploads/${filename}`;
  }

  async function saveBase64(base64, name = "paper.pdf") { return saveBuffer(Buffer.from(base64 || "", "base64"), name); }

  return { root: libraryRoot, saveBase64, saveBuffer };
}
