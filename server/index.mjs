import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DeepSeekProvider } from "./deepseek-provider.mjs";
import { paperLibrary } from "./paper-library.mjs";
import { createPaperResolver } from "./paper-resolver.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = express();
const provider = new DeepSeekProvider();
const library = paperLibrary(root);
const paperResolver = createPaperResolver(library);
const port = Number(process.env.PORT || 4318);
app.disable("x-powered-by");
app.use(express.json({ limit: "80mb" }));
app.use(express.static(path.join(root, "client"), { extensions: ["html"] }));
app.use("/paper-files", express.static(library.root, { fallthrough: false, immutable: true, maxAge: "1h" }));

function apiKey(req) { return req.get("x-deepseek-key") || process.env.DEEPSEEK_API_KEY || ""; }
function signalFor(req) { const controller = new AbortController(); req.on("aborted", () => controller.abort()); return controller.signal; }
function route(handler) { return async (req, res) => { try { res.json(await handler(req, res)); } catch (error) { if (!res.headersSent) res.status(error.status || 500).json({ error: error.message || "服务器处理失败。" }); } }; }
function accessMessage(paper) {
  if (paper.accessStatus === "local_pdf") return `已有本地 PDF${paper.accessSource ? `（来源：${paper.accessSource}）` : ""}。`;
  if (paper.accessStatus === "open_pdf") return "已发现可公开获取的 PDF。";
  if (paper.accessStatus === "institutional_required") return "该论文可能需要学校或机构权限，请在外部页面自行登录下载。";
  if (paper.accessStatus === "abstract_only") return "当前只取得可靠摘要，可上传全文升级分析。";
  if (paper.accessStatus === "metadata_only") return "当前只有标题、作者等可靠元数据。";
  return "暂时没有找到可靠全文或摘要。";
}
function applyCachedPdfs(papers, results) {
  const byId = new Map(results.map(item => [item.id, item]));
  for (const paper of papers || []) {
    const cached = byId.get(paper.id);
    if (cached) Object.assign(paper, cached);
    paper.accessUrl ||= paper.url || "";
    paper.accessCheckedAt ||= new Date().toISOString();
    paper.accessStatus ||= paper.localPdf ? "local_pdf" : paper.pdfUrl ? "open_pdf" : paper.abstract ? "abstract_only" : paper.accessUrl ? "metadata_only" : "unavailable";
    paper.accessMessage ||= accessMessage(paper);
  }
}
function accessCounts(papers) {
  return {
    fulltext: papers.filter(paper => ["local_pdf", "open_pdf"].includes(paper.accessStatus)).length,
    abstract: papers.filter(paper => paper.accessStatus === "abstract_only").length,
    institutional: papers.filter(paper => paper.accessStatus === "institutional_required").length,
    metadata: papers.filter(paper => ["metadata_only", "unavailable"].includes(paper.accessStatus)).length
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "research-tree-studio" }));
app.get("/api/seed", route(async () => JSON.parse(await fs.readFile(path.join(root, "client", "seed-attention.json"), "utf8"))));
app.post("/api/deepseek/test", route(req => provider.test({ apiKey: apiKey(req), model: req.body.model, signal: signalFor(req) })));
app.post("/api/deepseek/analyze", route(async req => {
  const result = await provider.analyzePaper({ ...req.body, apiKey: apiKey(req), signal: signalFor(req) });
  if (req.body.file?.data) {
    result.data.paper.localPdf = await library.saveBase64(req.body.file.data, req.body.file.name);
    Object.assign(result.data.paper, { accessStatus: "local_pdf", accessSource: req.body.accessSource || "manual", analysisBasis: "fulltext", accessCheckedAt: new Date().toISOString(), accessMessage: "已上传本地全文，并基于全文重新分析。" });
  } else {
    result.data.paper.analysisBasis = req.body.analysisBasis === "metadata" ? "metadata" : "abstract";
  }
  return result;
}));
app.post("/api/deepseek/relation/stream", async (req, res) => {
  const controller = new AbortController();
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await provider.reanalyzeRelation({ ...req.body, apiKey: apiKey(req), signal: controller.signal, progress: data => send("progress", data) });
    send("result", result);
  } catch (error) {
    send("error", { error: error.message || "论文关系重新判断失败。", status: error.status || 500 });
  } finally {
    res.end();
  }
});
app.post("/api/deepseek/research", route(async req => {
  const signal = signalFor(req), result = await provider.researchTree({ ...req.body, apiKey: apiKey(req), signal });
  const cached = await paperResolver.cacheMany(result.data.papers, { signal });
  applyCachedPdfs(result.data.papers, cached);
  result.pdfCache = { downloaded: cached.filter(item => item.localPdf).length, missing: cached.filter(item => !item.localPdf).length };
  result.accessCounts = accessCounts(result.data.papers);
  return result;
}));
app.post("/api/deepseek/research/stream", async (req, res) => {
  const controller = new AbortController();
  res.setHeader("content-type", "text/event-stream; charset=utf-8");
  res.setHeader("cache-control", "no-cache, no-transform");
  res.setHeader("connection", "keep-alive");
  res.flushHeaders();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const result = await provider.researchTree({ ...req.body, apiKey: apiKey(req), signal: controller.signal, progress: data => send("progress", data) });
    const cached = await paperResolver.cacheMany(result.data.papers, { signal: controller.signal, progress: ({ completed, total, result: item }) => send("progress", { percent: 92 + Math.round(completed / Math.max(1, total) * 8), stage: "下载开放 PDF", detail: `${completed}/${total} · ${item.localPdf ? "已保存到本地" : item.accessStatus === "institutional_required" ? "需要机构权限" : "保留摘要或元数据"}` }) });
    applyCachedPdfs(result.data.papers, cached);
    result.pdfCache = { downloaded: cached.filter(item => item.localPdf).length, missing: cached.filter(item => !item.localPdf).length };
    result.accessCounts = accessCounts(result.data.papers);
    send("progress", { percent: 100, stage: "完成", detail: `${result.data.papers.length} 篇 · 全文 ${result.accessCounts.fulltext} · 摘要 ${result.accessCounts.abstract} · 机构权限 ${result.accessCounts.institutional}` });
    send("result", result);
  } catch (error) {
    send("error", { error: error.message || "研究树生成失败。", status: error.status || 500 });
  } finally {
    res.end();
  }
});
app.post("/api/papers/upload", route(async req => {
  const localPdf = await library.saveBase64(req.body.data, req.body.name || "paper.pdf");
  if (!localPdf) throw Object.assign(new Error("没有收到 PDF 内容。"), { status: 400 });
  return { ok: true, localPdf };
}));
app.post("/api/papers/cache-batch", route(async req => {
  const papers = Array.isArray(req.body.papers) ? req.body.papers.slice(0, 60) : [];
  if (!papers.length) throw Object.assign(new Error("没有收到待获取的论文。"), { status: 400 });
  const results = await paperResolver.cacheMany(papers, { signal: signalFor(req) });
  return { ok: true, papers: results, downloaded: results.filter(item => item.localPdf).length, missing: results.filter(item => !item.localPdf).length };
}));

function privateAddress(address) {
  return address === "::1" || address.startsWith("127.") || address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}
async function safeUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw Object.assign(new Error("只支持 HTTP 或 HTTPS 论文链接。"), { status: 400 });
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(x => privateAddress(x.address) || (isIP(x.address) && privateAddress(x.address)))) throw Object.assign(new Error("不能访问本机或局域网地址。"), { status: 400 });
  return url;
}
function normalizedPaperUrl(raw) {
  if (/arxiv\.org\/abs\//i.test(raw)) return raw.replace("/abs/", "/pdf/") + (raw.endsWith(".pdf") ? "" : ".pdf");
  if (/openreview\.net\/forum\?id=/i.test(raw)) return raw.replace("/forum?", "/pdf?");
  if (/^(10\.\d{4,9}\/\S+)$/i.test(raw.trim())) return `https://doi.org/${raw.trim()}`;
  return raw;
}
function textFromHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
app.post("/api/source", route(async req => {
  const raw = normalizedPaperUrl(String(req.body.url || ""));
  const url = await safeUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try { response = await fetch(url, { redirect: "follow", signal: controller.signal, headers: { "user-agent": "ResearchTreeStudio/1.0" } }); }
  finally { clearTimeout(timer); }
  if (!response.ok) throw Object.assign(new Error(`论文来源访问失败（HTTP ${response.status}）。`), { status: 400 });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("pdf") || response.url.toLowerCase().endsWith(".pdf")) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) throw Object.assign(new Error("远程 PDF 超过 50MB。"), { status: 413 });
    return { kind: "pdf", name: decodeURIComponent(path.basename(new URL(response.url).pathname)) || "paper.pdf", data: buffer.toString("base64"), sourceUrl: response.url };
  }
  const text = textFromHtml(await response.text()).slice(0, 120000);
  if (text.length < 300) throw Object.assign(new Error("网页中没有提取到足够的论文正文。"), { status: 400 });
  return { kind: "text", text, sourceUrl: response.url };
}));

app.use((error, _req, res, _next) => res.status(error.type === "entity.too.large" ? 413 : 500).json({ error: error.type === "entity.too.large" ? "文件或请求体过大。" : "本地服务发生错误。" }));
app.listen(port, "127.0.0.1", () => console.log(`Research Tree Studio: http://127.0.0.1:${port}`));
