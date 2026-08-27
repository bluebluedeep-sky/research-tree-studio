import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_PDF_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT = 18000;

function privateAddress(address) {
  return address === "::1" || address.startsWith("127.") || address.startsWith("10.") || address.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

async function safeUrl(raw) {
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 HTTP 或 HTTPS 论文链接。");
  const addresses = await lookup(url.hostname, { all: true });
  if (addresses.some(item => privateAddress(item.address) || (isIP(item.address) && privateAddress(item.address)))) throw new Error("不能访问本机或局域网地址。");
  return url;
}

function normalizedTitle(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim(); }

function accessSourceFromUrl(value) {
  const url = String(value || "").toLowerCase();
  if (url.includes("arxiv.org")) return "arXiv";
  if (url.includes("openreview.net")) return "OpenReview";
  if (url.includes("openalex.org")) return "OpenAlex";
  if (/proceedings\.(?:neurips|iclr)\.cc|proceedings\.mlr\.press/.test(url)) return "conference";
  if (url.includes("doi.org")) return "publisher";
  if (/acm\.org|ieee\.org|springer\.com|sciencedirect\.com|wiley\.com|nature\.com/.test(url)) return "publisher";
  return url ? "repository" : "";
}

export function unresolvedAccess(paper) {
  const accessUrl = paper.accessUrl || paper.url || "";
  const accessSource = paper.accessSource || accessSourceFromUrl(accessUrl) || "OpenAlex";
  let accessStatus = paper.accessStatus;
  if (!accessStatus || ["open_pdf", "local_pdf"].includes(accessStatus)) {
    if (paper.abstract) accessStatus = accessSource === "publisher" ? "institutional_required" : "abstract_only";
    else if (accessUrl && accessSource === "publisher") accessStatus = "institutional_required";
    else if (accessUrl || paper.title) accessStatus = "metadata_only";
    else accessStatus = "unavailable";
  }
  const accessMessage = accessStatus === "institutional_required" ? "该论文可能需要学校或机构权限，请在外部页面自行登录下载。" : accessStatus === "abstract_only" ? "当前只取得可靠摘要，可上传全文升级分析。" : accessStatus === "metadata_only" ? "当前只有可靠元数据，尚未取得摘要或全文。" : "暂时没有找到可靠全文或摘要。";
  return { accessStatus, accessUrl, accessSource, accessCheckedAt: new Date().toISOString(), accessMessage };
}

export function directPdfCandidates(raw) {
  const value = String(raw || "").trim();
  if (!value) return [];
  const candidates = [];
  if (/arxiv\.org\/abs\//i.test(value)) candidates.push(value.replace("/abs/", "/pdf/").replace(/\/?$/, ".pdf"));
  if (/arxiv\.org\/pdf\//i.test(value)) candidates.push(value.replace(/\/?$/, ".pdf"));
  if (/openreview\.net\/forum\?id=/i.test(value)) candidates.push(value.replace("/forum?", "/pdf?"));
  if (/openreview\.net\/pdf\?id=/i.test(value)) candidates.push(value);
  if (/proceedings\.(?:neurips|iclr)\.cc\/paper_files\/paper\/\d+\/hash\//i.test(value)) {
    if (/-Abstract-Conference\.html(?:\?.*)?$/i.test(value)) candidates.push(value.replace(/-Abstract-Conference\.html(?:\?.*)?$/i, "-Paper-Conference.pdf"));
    if (/-Abstract\.html(?:\?.*)?$/i.test(value)) candidates.push(value.replace(/-Abstract\.html(?:\?.*)?$/i, "-Paper.pdf"));
  }
  const pmlr = value.match(/^(https:\/\/proceedings\.mlr\.press\/v\d+\/([^/?#]+))\.html(?:\?.*)?$/i);
  if (pmlr) candidates.push(`${pmlr[1]}/${pmlr[2]}.pdf`);
  if (/\.pdf(?:[?#].*)?$/i.test(value)) candidates.push(value);
  return [...new Set(candidates)];
}

function locationPdfUrls(work) {
  return [work?.best_oa_location, work?.primary_location, ...(work?.locations || [])].map(location => location?.pdf_url).filter(Boolean);
}

async function openAlexPdfCandidates(title, signal) {
  if (!title) return [];
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", title);
  url.searchParams.set("per-page", "5");
  url.searchParams.set("select", "title,best_oa_location,primary_location,locations");
  const response = await fetch(url, { signal, headers: { "user-agent": "ResearchTreeStudio/2.0 (local research tool)" } });
  if (!response.ok) return [];
  const body = await response.json();
  const target = normalizedTitle(title);
  return (body.results || []).sort((a, b) => Number(normalizedTitle(b.title) === target) - Number(normalizedTitle(a.title) === target)).flatMap(locationPdfUrls);
}

async function fetchWithSafeRedirects(raw, signal) {
  let current = await safeUrl(raw);
  for (let redirects = 0; redirects < 6; redirects += 1) {
    const response = await fetch(current, { redirect: "manual", signal, headers: { "user-agent": "ResearchTreeStudio/2.0 (local research tool)", accept: "application/pdf,*/*;q=0.5" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      current = await safeUrl(new URL(location, current).href);
      continue;
    }
    return response;
  }
  return null;
}

function pdfBuffer(bytes) {
  const buffer = Buffer.from(bytes);
  const header = buffer.subarray(0, 1024).indexOf(Buffer.from("%PDF"));
  return header >= 0 ? buffer.subarray(header) : null;
}

export function createPaperResolver(library) {
  async function downloadCandidate(url, name, parentSignal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const abort = () => controller.abort();
    parentSignal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchWithSafeRedirects(url, controller.signal);
      if (!response?.ok) return "";
      const declared = Number(response.headers.get("content-length")) || 0;
      if (declared > MAX_PDF_BYTES) return "";
      const buffer = pdfBuffer(await response.arrayBuffer());
      if (!buffer || buffer.length > MAX_PDF_BYTES) return "";
      return await library.saveBuffer(buffer, name);
    } catch (error) {
      if (parentSignal?.aborted) throw error;
      return "";
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    }
  }

  async function cachePaper(paper, signal) {
    const direct = [paper.pdfUrl, ...directPdfCandidates(paper.pdfUrl), ...directPdfCandidates(paper.url)].filter(Boolean);
    let openAlex = [];
    try { openAlex = await openAlexPdfCandidates(paper.title, signal); } catch (error) { if (signal?.aborted) throw error; }
    const candidates = [...new Set([...direct, ...openAlex].filter(Boolean))].slice(0, 8);
    for (const candidate of candidates) {
      const localPdf = await downloadCandidate(candidate, `${paper.title || paper.id || "paper"}.pdf`, signal);
      if (localPdf) return { id: paper.id, localPdf, pdfUrl: candidate, resolvedFrom: candidate, accessStatus: "local_pdf", accessUrl: paper.accessUrl || paper.url || candidate, accessSource: accessSourceFromUrl(candidate) || "repository", accessCheckedAt: new Date().toISOString(), accessMessage: `已取得开放 PDF（来源：${accessSourceFromUrl(candidate) || "开放仓储"}）。` };
    }
    return { id: paper.id, localPdf: "", ...unresolvedAccess(paper), error: candidates.length ? "找到候选地址，但未取得有效 PDF。" : "没有发现可公开下载的 PDF。" };
  }

  async function cacheMany(papers, { signal, progress, concurrency = 4 } = {}) {
    const source = (papers || []).filter(paper => paper && paper.id && !paper.localPdf).slice(0, 60);
    const results = [];
    let cursor = 0;
    async function worker() {
      while (cursor < source.length) {
        const paper = source[cursor++];
        const result = await cachePaper(paper, signal);
        results.push(result);
        progress?.({ completed: results.length, total: source.length, paper, result });
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, source.length || 1) }, () => worker()));
    return results;
  }

  return { cachePaper, cacheMany };
}
