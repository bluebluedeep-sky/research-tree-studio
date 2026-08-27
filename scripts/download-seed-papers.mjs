import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = path.join(root, "client", "seed-attention.json");
const output = path.join(root, "paper-library", "preset");
const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
await fs.mkdir(output, { recursive: true });
const knownFallbacks = {
  "sparse-1": "https://openreview.net/attachment?id=PTcMzQgKmn&name=pdf",
  "sparse-3": "https://arxiv.org/pdf/2508.19740.pdf",
  "kv-0": "https://arxiv.org/pdf/2306.14048.pdf",
  "kv-8": "https://arxiv.org/pdf/2410.03111.pdf",
  "kv-9": "https://arxiv.org/pdf/2407.11550.pdf",
  "kv-11": "https://openreview.net/pdf?id=Tdl89SZItB",
  "alt-4": "https://arxiv.org/pdf/2312.06635.pdf",
  "brain-3": "https://arxiv.org/pdf/2506.17310.pdf"
};

function directCandidates(raw) {
  const urls = [];
  if (/arxiv\.org\/abs\//i.test(raw)) urls.push(raw.replace("/abs/", "/pdf/").replace(/\/$/, "") + ".pdf");
  if (/openreview\.net\/forum\?id=/i.test(raw)) urls.push(raw.replace("/forum?", "/pdf?"));
  if (/proceedings\.mlr\.press\/v\d+\/[^/]+\.html/i.test(raw)) {
    const match = raw.match(/(https:\/\/proceedings\.mlr\.press\/v\d+)\/([^/]+)\.html/i);
    if (match) urls.push(`${match[1]}/${match[2]}/${match[2]}.pdf`);
  }
  if (/aclanthology\.org\//i.test(raw)) urls.push(raw.replace(/\/$/, "") + ".pdf");
  if (/-Abstract-(Conference|Datasets_and_Benchmarks_Track)\.html$/i.test(raw)) urls.push(raw.replace("/hash/", "/file/").replace(/-Abstract-(Conference|Datasets_and_Benchmarks_Track)\.html$/i, "-Paper-$1.pdf"));
  if (/\/abstract_files\/paper\//i.test(raw)) urls.push(raw.replace("/abstract_files/", "/paper_files/").replace(/-Abstract\.html$/i, "-Paper.pdf"));
  if (/\.pdf(?:\?|$)/i.test(raw)) urls.push(raw);
  return urls;
}

function normalize(value) { return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
async function openAlexCandidates(title) {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", title);
  url.searchParams.set("per-page", "5");
  url.searchParams.set("select", "title,best_oa_location,primary_location,locations");
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { "user-agent": "ResearchTreeStudio/2.0 (local research tool)" } });
    if (!response.ok) return [];
    const data = await response.json();
    const target = normalize(title);
    const works = (data.results || []).sort((a, b) => Number(normalize(b.title).includes(target)) - Number(normalize(a.title).includes(target)));
    return works.flatMap(work => [work.best_oa_location, work.primary_location, ...(work.locations || [])]).flatMap(location => [location?.pdf_url]).filter(Boolean);
  } catch { return []; }
}

async function linksFromPage(raw) {
  try {
    const response = await fetch(raw, { redirect: "follow", signal: AbortSignal.timeout(12000), headers: { "user-agent": "Mozilla/5.0 ResearchTreeStudio/2.0" } });
    if (!response.ok || (response.headers.get("content-type") || "").includes("pdf")) return [];
    const html = await response.text();
    return [...html.matchAll(/href=["']([^"']+\.pdf(?:\?[^"']*)?)["']/gi)].map(match => new URL(match[1], response.url).href);
  } catch { return []; }
}

async function fetchPdf(url) {
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(18000), headers: { "user-agent": "Mozilla/5.0 ResearchTreeStudio/2.0" } });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < 1000 || String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") return null;
    return { url, bytes };
  } catch { return null; }
}

async function downloadFirst(candidates, destination) {
  for (let index = 0; index < candidates.length; index += 4) {
    const batch = await Promise.all(candidates.slice(index, index + 4).map(fetchPdf));
    const found = batch.find(Boolean);
    if (found) { await fs.writeFile(destination, found.bytes); return found.url; }
  }
  return "";
}

const results = [];
for (const paper of seed.papers) {
  const destination = path.join(output, `${paper.id}.pdf`);
  const exists = await fs.stat(destination).then(stat => stat.size > 1000).catch(() => false);
  if (exists) { paper.localPdf = `/paper-files/preset/${paper.id}.pdf`; results.push({ id: paper.id, status: "existing" }); continue; }
  const candidates = [...new Set([
    knownFallbacks[paper.id],
    ...directCandidates(paper.url || ""),
    ...(await linksFromPage(paper.url || "")),
    ...(await openAlexCandidates(paper.title))
  ].filter(Boolean))];
  const downloadedUrl = await downloadFirst(candidates, destination);
  const downloaded = Boolean(downloadedUrl);
  if (downloaded) results.push({ id: paper.id, status: "downloaded", url: downloadedUrl });
  if (downloaded) paper.localPdf = `/paper-files/preset/${paper.id}.pdf`;
  else results.push({ id: paper.id, status: "missing", tried: candidates.length });
  console.log(`${paper.id}: ${downloaded ? "downloaded" : "missing"}`);
}

await fs.writeFile(seedPath, JSON.stringify(seed, null, 2) + "\n", "utf8");
await fs.writeFile(path.join(output, "download-report.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
const downloaded = results.filter(item => item.status !== "missing").length;
console.log(`Local papers: ${downloaded}/${results.length}`);
