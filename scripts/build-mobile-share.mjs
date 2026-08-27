import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const htmlPath = path.join(dist, "Research-Tree-Mobile-Demo.html");
const zipPath = path.join(dist, "Research-Tree-Mobile-Demo.zip");
const staging = path.join(dist, "Research-Tree-Mobile-Demo");
const seed = JSON.parse(await fs.readFile(path.join(root, "client", "seed-attention.json"), "utf8"));
const demoPaperId = "system-1";
const demoPdfPath = path.join(root, "paper-library", "preset", `${demoPaperId}.pdf`);
const includeDemoPdf = process.env.RTS_INCLUDE_DEMO_PDF !== "0" && await fs.stat(demoPdfPath).then(() => true).catch(() => false);
const demoPdf = includeDemoPdf ? await fs.readFile(demoPdfPath) : Buffer.alloc(0);

await fs.mkdir(dist, { recursive: true });
await fs.rm(htmlPath, { force: true });
await fs.rm(zipPath, { force: true });
await fs.rm(staging, { recursive: true, force: true });

const cleanTree = {
  id: "efficient-attention-demo",
  name: seed.name,
  description: seed.description,
  branches: seed.branches.map(({ id, name, question, color }) => ({ id, name, question, color })),
  papers: seed.papers.map(paper => ({
    id: paper.id,
    title: paper.title,
    titleZh: paper.titleZh,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    problem: paper.problem,
    method: paper.method,
    contribution: paper.contribution,
    url: paper.url,
    branchId: paper.branchId,
    accessStatus: paper.id === demoPaperId && includeDemoPdf ? "local_pdf" : (paper.accessStatus === "local_pdf" ? "metadata_only" : (paper.accessStatus || "metadata_only")),
    analysisBasis: paper.analysisBasis || (paper.problem || paper.contribution ? "abstract" : "metadata"),
    confidence: Number.isFinite(Number(paper.analysisConfidence ?? paper.confidence)) ? Number(paper.analysisConfidence ?? paper.confidence) : 0.7
  })),
  relations: seed.relations.map(({ id, sourceId, targetId, type, explanation, confidence, analysisBasis }) => ({
    id, sourceId, targetId, type, explanation,
    confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : 0.78,
    analysisBasis: analysisBasis || "abstract"
  }))
};

const relationLabels = {
  extends: "继承并扩展",
  improves: "性能改进",
  replaces: "替代路径",
  combines: "融合路线",
  contrasts: "对照路线",
  inspires: "思想启发",
  migrates_problem: "问题迁移"
};

const relationColors = {
  extends: "#33765f",
  improves: "#2b6ca3",
  replaces: "#a34d3f",
  combines: "#7654a3",
  contrasts: "#a06a22",
  inspires: "#2e827f",
  migrates_problem: "#7a617f"
};

const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const clip = (value, length) => {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
};
const serializedTree = JSON.stringify(cleanTree).replaceAll("<", "\\u003c");

const years = [...new Set(cleanTree.papers.map(paper => paper.year))].sort((a, b) => a - b);
const nodeW = 252;
const nodeH = 68;
const columnGap = 350;
const rowGap = 82;
const left = 310;
const positions = new Map();
let top = 76;
const branchGeometry = [];

for (const branch of cleanTree.branches) {
  const byYear = years.map(year => cleanTree.papers.filter(paper => paper.branchId === branch.id && paper.year === year));
  const maxStack = Math.max(1, ...byYear.map(items => items.length));
  const height = Math.max(190, 100 + maxStack * rowGap);
  branchGeometry.push({ branch, top, height });
  byYear.forEach((papers, yearIndex) => {
    papers.forEach((paper, rowIndex) => {
      positions.set(paper.id, {
        x: left + yearIndex * columnGap,
        y: top + 72 + rowIndex * rowGap
      });
    });
  });
  top += height + 24;
}

const mapWidth = left + (years.length - 1) * columnGap + nodeW + 70;
const mapHeight = top + 24;
const yearGuides = years.map((year, index) => {
  const x = left + index * columnGap + nodeW / 2;
  return `<g class="year-guide"><line x1="${x}" y1="42" x2="${x}" y2="${mapHeight - 24}"/><text x="${x}" y="28">${year}</text></g>`;
}).join("");

const branchBands = branchGeometry.map(({ branch, top: branchTop, height }) => {
  const papers = cleanTree.papers.filter(paper => paper.branchId === branch.id);
  const twigLines = papers.map(paper => {
    const pos = positions.get(paper.id);
    return `<path class="branch-twig" data-paper="${esc(paper.id)}" d="M 220 ${branchTop + 46} C 262 ${branchTop + 46}, ${pos.x - 38} ${pos.y + nodeH / 2}, ${pos.x} ${pos.y + nodeH / 2}" stroke="${esc(branch.color)}"/>`;
  }).join("");
  return `<g class="branch-band" data-branch="${esc(branch.id)}">
    <rect class="branch-bg" x="12" y="${branchTop}" width="${mapWidth - 24}" height="${height}"/>
    <path class="branch-trunk" d="M 28 ${branchTop + 46} H 220" stroke="${esc(branch.color)}"/>
    ${twigLines}
    <g class="branch-label" transform="translate(28 ${branchTop + 16})">
      <rect width="192" height="58" rx="6" stroke="${esc(branch.color)}"/>
      <text x="12" y="21">${esc(clip(branch.name, 22))}</text>
      <text class="branch-question" x="12" y="41">${esc(clip(branch.question, 28))}</text>
      <text class="branch-count" x="180" y="53">${papers.length} 篇</text>
    </g>
  </g>`;
}).join("");

const relationPaths = cleanTree.relations.map(relation => {
  const source = positions.get(relation.sourceId);
  const target = positions.get(relation.targetId);
  if (!source || !target) return "";
  const sx = source.x + nodeW;
  const sy = source.y + nodeH / 2;
  const tx = target.x;
  const ty = target.y + nodeH / 2;
  const sameOrBack = tx <= sx;
  const curve = sameOrBack
    ? `M ${sx - nodeW / 2} ${source.y + nodeH} C ${sx - nodeW / 2} ${source.y + nodeH + 34}, ${tx + nodeW / 2} ${target.y + nodeH + 34}, ${tx + nodeW / 2} ${target.y + nodeH}`
    : `M ${sx} ${sy} C ${sx + 54} ${sy}, ${tx - 54} ${ty}, ${tx} ${ty}`;
  const color = relationColors[relation.type] || "#52756a";
  return `<path class="relation" data-relation="${esc(relation.id)}" data-source="${esc(relation.sourceId)}" data-target="${esc(relation.targetId)}" d="${curve}" stroke="${color}" marker-end="url(#arrow-${esc(relation.type)})"/>`;
}).join("");

const markers = Object.entries(relationColors).map(([type, color]) => `<marker id="arrow-${type}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`).join("");

const statusMeta = paper => {
  if (paper.id === demoPaperId && includeDemoPdf) return { label: "内置全文", className: "full", symbol: "文" };
  if (paper.accessStatus === "open_pdf" || paper.accessStatus === "local_pdf") return { label: "开放全文", className: "full", symbol: "文" };
  if (paper.accessStatus === "abstract_only") return { label: "摘要", className: "abstract", symbol: "摘" };
  if (paper.accessStatus === "institutional_required") return { label: "机构权限", className: "locked", symbol: "锁" };
  return { label: "待补充", className: "missing", symbol: "待" };
};

const paperNodes = cleanTree.papers.map(paper => {
  const pos = positions.get(paper.id);
  const branch = cleanTree.branches.find(item => item.id === paper.branchId);
  const status = statusMeta(paper);
  return `<g class="paper-node" data-paper-id="${esc(paper.id)}" tabindex="0" role="button" aria-label="${esc(`${paper.title}，${paper.titleZh}`)}" transform="translate(${pos.x} ${pos.y})">
    <rect width="${nodeW}" height="${nodeH}" rx="6" stroke="${esc(branch?.color || "#52756a")}"/>
    <text class="paper-title" x="12" y="20">${esc(clip(paper.title, 34))}</text>
    <text class="paper-title-zh" x="12" y="39">${esc(clip(paper.titleZh, 19))}</text>
    <text class="paper-meta" x="12" y="57">${esc(clip(`${paper.venue || "来源待补充"} · ${paper.authors || "作者待补充"}`, 38))}</text>
    <g class="status-marker ${status.className}" transform="translate(${nodeW - 27} 9)"><circle cx="10" cy="10" r="10"/><text x="10" y="13">${status.symbol}</text></g>
  </g>`;
}).join("");

const svg = `<svg id="research-map" viewBox="0 0 ${mapWidth} ${mapHeight}" width="${mapWidth}" height="${mapHeight}" aria-label="高效 Attention 研究树">
  <defs>${markers}</defs>
  ${yearGuides}
  ${branchBands}
  <g class="relation-layer">${relationPaths}</g>
  <g class="paper-layer">${paperNodes}</g>
</svg>`;

const branchDirectory = cleanTree.branches.map(branch => {
  const papers = cleanTree.papers.filter(paper => paper.branchId === branch.id).sort((a, b) => a.year - b.year);
  return `<details class="directory-group"><summary><span style="--branch:${esc(branch.color)}">${esc(branch.name)}</span><small>${papers.length} 篇</small></summary><div>${papers.map(paper => `<button type="button" data-directory-paper="${esc(paper.id)}"><b>${esc(paper.title)}</b><span>${esc(paper.titleZh)}</span><small>${paper.year} · ${esc(paper.venue)}</small></button>`).join("")}</div></details>`;
}).join("");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=5,user-scalable=yes,viewport-fit=cover">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f5f8f6">
<title>${esc(cleanTree.name)} · 手机体验版</title>
<style>
:root{--ink:#17211d;--muted:#617168;--line:#cedbd3;--paper:#f5f8f6;--white:#fff;--teal:#08796e;--teal-soft:#e8f3ef;--shadow:0 14px 40px rgba(26,53,43,.18);font-family:Arial,"Microsoft YaHei","PingFang SC",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--paper);font-size:14px;line-height:1.55;letter-spacing:0}button,a{font:inherit}button{color:inherit}.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:54px;padding:8px max(14px,env(safe-area-inset-left));background:rgba(255,255,255,.96);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}.brand{display:flex;align-items:center;gap:9px;min-width:0}.brand-mark{display:grid;place-items:center;width:30px;height:30px;background:var(--teal);color:#fff;font-weight:800}.brand-text{min-width:0}.brand-text b,.brand-text small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.brand-text b{font-size:13px}.brand-text small{color:var(--muted);font-size:10px}.ghost{min-height:34px;padding:6px 10px;border:1px solid var(--line);border-radius:5px;background:#fff;color:var(--teal);font-size:12px}.hero{width:min(1160px,calc(100% - 28px));margin:auto;padding:24px 0 14px}.kicker{margin:0;color:var(--teal);font-size:10px;font-weight:800}.hero h1{margin:4px 0 5px;font-size:clamp(22px,6vw,34px);line-height:1.2}.hero p{max-width:760px;margin:0;color:var(--muted)}.summary{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px}.summary span{padding:4px 8px;border:1px solid var(--line);background:#fff;border-radius:4px;font-size:11px}.map-section{width:min(1500px,calc(100% - 20px));margin:auto;background:#fff;border:1px solid var(--line)}.map-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 11px;border-bottom:1px solid var(--line);font-size:11px}.map-toolbar p{margin:0;color:var(--muted)}.zoom-state{min-width:48px;padding:3px 7px;border:1px solid var(--line);border-radius:4px;background:#fff;color:var(--teal);font-size:10px;font-variant-numeric:tabular-nums}.legend{display:flex;gap:8px;flex-wrap:wrap}.legend span{display:inline-flex;align-items:center;gap:4px}.legend i{width:7px;height:7px;border-radius:50%;background:var(--c)}.map-scroller{height:min(68dvh,720px);min-height:430px;overflow:auto;overscroll-behavior:contain;background:#fbfdfb;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y}.map-scroller svg{display:block;width:${mapWidth}px;height:${mapHeight}px;min-width:0;min-height:0;user-select:none;-webkit-user-select:none}.year-guide line{stroke:#e1e9e4;stroke-width:1}.year-guide text{fill:#4f6259;font-size:14px;font-weight:750;text-anchor:middle}.branch-bg{fill:#fff;stroke:#e4ebe7}.branch-trunk,.branch-twig{fill:none;stroke-linecap:round}.branch-trunk{stroke-width:4}.branch-twig{stroke-width:1.5;opacity:.4}.branch-label rect{fill:#fff;stroke-width:2}.branch-label text{fill:#243c34;font-size:12px;font-weight:750}.branch-label .branch-question{fill:#607169;font-size:9px;font-weight:500}.branch-label .branch-count{text-anchor:end;fill:#607169;font-size:8px;font-weight:500}.relation{fill:none;stroke-width:1.7;opacity:.34;transition:opacity .15s,stroke-width .15s,filter .15s}.paper-node{cursor:pointer;outline:none;transition:opacity .15s}.paper-node>rect{fill:#fff;stroke-width:1.6;filter:drop-shadow(0 2px 2px rgba(30,55,46,.08));transition:stroke-width .15s,filter .15s,fill .15s}.paper-node text{pointer-events:none}.paper-title{fill:#17211d;font-size:10.5px;font-weight:750}.paper-title-zh{fill:#2a675c;font-size:10px}.paper-meta{fill:#697970;font-size:8.5px}.status-marker circle{stroke:#fff;stroke-width:1.5}.status-marker text{fill:#fff;font-size:7px;font-weight:750;text-anchor:middle}.status-marker.full circle{fill:#2c8751}.status-marker.abstract circle{fill:#cf9721}.status-marker.locked circle{fill:#9c5638}.status-marker.missing circle{fill:#909a94}.map-active .paper-node{opacity:.22}.map-active .branch-twig,.map-active .relation{opacity:.05}.map-active .paper-node.locked,.map-active .paper-node.connected{opacity:1}.map-active .paper-node.locked>rect{fill:#edf8f4;stroke-width:4;filter:drop-shadow(0 3px 4px rgba(0,98,82,.24))}.map-active .paper-node.connected>rect{stroke-width:2.5}.map-active .branch-twig.highlighted{opacity:1;stroke-width:3}.map-active .relation.highlighted{opacity:1;stroke-width:4;filter:drop-shadow(0 2px 2px rgba(24,63,49,.2))}.tip{width:min(1160px,calc(100% - 28px));margin:10px auto 0;color:var(--muted);font-size:11px}.directory{width:min(1160px,calc(100% - 28px));margin:22px auto 70px}.directory header{display:flex;align-items:end;justify-content:space-between;gap:10px;margin-bottom:8px}.directory h2{margin:0;font-size:18px}.directory header p{margin:0;color:var(--muted);font-size:11px}.directory-group{border-top:1px solid var(--line);background:#fff}.directory-group:last-child{border-bottom:1px solid var(--line)}.directory-group summary{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px;cursor:pointer}.directory-group summary span{border-left:4px solid var(--branch);padding-left:8px;font-weight:750}.directory-group summary small{color:var(--muted)}.directory-group>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;background:var(--line);border-top:1px solid var(--line)}.directory-group button{display:grid;gap:1px;padding:10px 12px;text-align:left;border:0;background:#fff}.directory-group button b,.directory-group button span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.directory-group button b{font-size:11px}.directory-group button span{color:#2e665b;font-size:10px}.directory-group button small{color:var(--muted);font-size:9px}.reader-backdrop{position:fixed;inset:0;z-index:79;display:none;background:rgba(16,34,27,.35)}.reader-backdrop.open{display:block}.reader{position:fixed;left:0;right:0;bottom:0;z-index:80;max-height:min(78dvh,720px);padding-bottom:env(safe-area-inset-bottom);background:#fff;border-top:1px solid #91aea3;box-shadow:0 -16px 42px rgba(18,42,33,.24);transform:translateY(calc(100% + 20px));transition:transform .2s ease}.reader.open{transform:translateY(0)}.reader-handle{width:40px;height:4px;margin:7px auto 2px;background:#c5d2cc;border-radius:4px}.reader-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:8px 14px 10px;border-bottom:1px solid var(--line)}.reader-head div{min-width:0}.reader-head h2{margin:0;font-size:15px;line-height:1.3}.reader-head p{margin:3px 0 0;color:#2d675c;font-size:11px}.icon{flex:0 0 auto;width:32px;height:32px;border:0;background:#eef4f1;border-radius:50%;font-size:18px}.reader-body{max-height:calc(min(78dvh,720px) - 88px);overflow:auto;padding:12px 14px 20px;overscroll-behavior:contain}.reader-meta{display:flex;gap:6px;flex-wrap:wrap}.reader-meta span{padding:3px 6px;background:#eff4f1;color:#4f655c;border-radius:3px;font-size:10px}.reader-grid{display:grid;gap:10px;margin-top:12px}.reader-grid section{border-left:3px solid var(--teal);padding-left:10px}.reader-grid h3{margin:0 0 2px;font-size:11px}.reader-grid p{margin:0;color:#4f6058;font-size:11px}.relation-block{margin-top:14px}.relation-block h3{margin:0 0 6px;font-size:12px}.relation-card{padding:9px 0;border-top:1px solid #e0e8e3}.relation-card:first-of-type{border-top:0}.relation-card header{display:flex;align-items:center;justify-content:space-between;gap:8px}.relation-card b{font-size:10px;color:var(--relation-color)}.relation-card small{color:var(--muted);font-size:9px}.relation-card p{margin:4px 0 0;color:#4f6058;font-size:10px}.relation-path{color:#2c5e54!important;font-weight:650}.reader-actions{position:sticky;bottom:-20px;display:flex;gap:7px;margin:16px -14px -20px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));background:rgba(255,255,255,.97);border-top:1px solid var(--line)}.reader-actions button,.reader-actions a{flex:1;display:grid;place-items:center;min-height:38px;padding:7px;border:1px solid var(--teal);border-radius:5px;background:#fff;color:var(--teal);text-decoration:none;font-size:11px}.reader-actions .primary{background:var(--teal);color:#fff}.privacy{padding:12px 14px;background:#eaf3ef;color:#416158;font-size:10px}.empty{color:var(--muted);font-size:10px}@media(max-width:650px){.hero{padding-top:18px}.map-section{width:100%;border-left:0;border-right:0}.map-toolbar{align-items:flex-start;flex-direction:column}.map-scroller{height:64dvh;min-height:390px}.directory-group>div{grid-template-columns:1fr}.directory{margin-bottom:46px}.reader{max-height:82dvh}.reader-body{max-height:calc(82dvh - 88px)}}@media(min-width:900px){.reader{left:auto;right:18px;bottom:18px;width:430px;border:1px solid #91aea3}.reader-backdrop.open{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style>
</head>
<body>
<header class="topbar"><div class="brand"><span class="brand-mark">Y</span><div class="brand-text"><b>研究树工作台</b><small>手机只读体验版 · 无个人数据</small></div></div><button class="ghost" id="clear-selection" type="button">清除选定</button></header>
<main>
  <section class="hero"><p class="kicker">RESEARCH LINEAGE</p><h1>${esc(cleanTree.name)}</h1><p>${esc(cleanTree.description)}</p><div class="summary"><span>${cleanTree.branches.length} 条研究分支</span><span>${cleanTree.papers.length} 篇论文</span><span>${cleanTree.relations.length} 条论文关系</span><span>2023—2026</span></div></section>
  <section class="map-section"><header class="map-toolbar"><p>单指滑动树；在树内双指捏合缩放。点论文可同时锁定多个节点。</p><div class="legend"><button class="zoom-state" id="zoom-indicator" type="button" title="恢复 100%" aria-label="当前缩放 100%，点按恢复">100%</button><span><i style="--c:#2c8751"></i>全文</span><span><i style="--c:#cf9721"></i>摘要</span><span><i style="--c:#9c5638"></i>权限</span><span><i style="--c:#909a94"></i>待补充</span></div></header><div class="map-scroller" id="map-scroller">${svg}</div></section>
  <p class="tip">提示：点论文节点会锁定并高亮它的关系，再点一次解除；详情在屏幕底部出现。内置示例 PDF 可离线阅读。</p>
  <section class="directory"><header><div><p class="kicker">PAPER DIRECTORY</p><h2>论文目录</h2></div><p>目录与树节点联动</p></header>${branchDirectory}</section>
</main>
<div class="reader-backdrop" id="reader-backdrop"></div>
<aside class="reader" id="reader" aria-live="polite"><div class="reader-handle"></div><header class="reader-head"><div><h2 id="reader-title">选择一篇论文</h2><p id="reader-title-zh"></p></div><button class="icon" id="close-reader" type="button" aria-label="关闭">×</button></header><div class="reader-body" id="reader-body"></div></aside>
<footer class="privacy">隐私说明：本文件只包含公开论文元数据、一棵示例树${includeDemoPdf ? "及一篇公开示例 PDF" : "和论文来源链接"}；不包含制作者的 API Key、上传记录、批注、浏览器数据或个人研究树。</footer>
<script>
const TREE=${serializedTree};
const DEMO_PDF_BASE64="${demoPdf.toString("base64")}";
const DEMO_PAPER_ID=${JSON.stringify(demoPaperId)};
const HAS_DEMO_PDF=${JSON.stringify(includeDemoPdf)};
const RELATION_LABELS=${JSON.stringify(relationLabels)};
const RELATION_COLORS=${JSON.stringify(relationColors)};
const selected=new Set();
let activePaperId=null;
const byId=new Map(TREE.papers.map(paper=>[paper.id,paper]));
const branchById=new Map(TREE.branches.map(branch=>[branch.id,branch]));
const map=document.getElementById("research-map");
const reader=document.getElementById("reader");
const backdrop=document.getElementById("reader-backdrop");
const escHtml=value=>String(value??"").replace(/[&<>\"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'\"':"&quot;","'":"&#39;"}[char]));
const evidenceLabel=basis=>basis==="fulltext"?"基于全文":basis==="abstract"?"基于摘要":"基于元数据";
const accessLabel=paper=>HAS_DEMO_PDF&&paper.id===DEMO_PAPER_ID?"内置全文":paper.accessStatus==="open_pdf"||paper.accessStatus==="local_pdf"?"开放全文":paper.accessStatus==="abstract_only"?"仅摘要":paper.accessStatus==="institutional_required"?"可能需要机构权限":"待补充全文";
function relatedTo(id){return TREE.relations.filter(relation=>relation.sourceId===id||relation.targetId===id)}
function updateHighlight(){
  map.classList.toggle("map-active",selected.size>0);
  document.querySelectorAll(".paper-node").forEach(node=>{const id=node.dataset.paperId;node.classList.toggle("locked",selected.has(id));node.classList.remove("connected")});
  document.querySelectorAll(".relation,.branch-twig").forEach(line=>line.classList.remove("highlighted"));
  for(const id of selected){
    document.querySelector('.branch-twig[data-paper="'+CSS.escape(id)+'"]')?.classList.add("highlighted");
    for(const relation of relatedTo(id)){
      document.querySelector('.relation[data-relation="'+CSS.escape(relation.id)+'"]')?.classList.add("highlighted");
      document.querySelector('.paper-node[data-paper-id="'+CSS.escape(relation.sourceId)+'"]')?.classList.add("connected");
      document.querySelector('.paper-node[data-paper-id="'+CSS.escape(relation.targetId)+'"]')?.classList.add("connected");
    }
  }
}
function relationCard(relation,id){
  const incoming=relation.targetId===id;
  const other=byId.get(incoming?relation.sourceId:relation.targetId);
  const current=byId.get(id);
  const confidence=Math.round((relation.confidence??.78)*100);
  return '<article class="relation-card" style="--relation-color:'+(RELATION_COLORS[relation.type]||"#52756a")+'"><header><b>'+(incoming?"前序 · ":"后续 · ")+escHtml(RELATION_LABELS[relation.type]||relation.type)+'</b><small>'+confidence+'% · '+evidenceLabel(relation.analysisBasis)+'</small></header><p class="relation-path">'+escHtml(incoming?other?.title:current?.title)+' → '+escHtml(incoming?current?.title:other?.title)+'</p><p>'+escHtml(relation.explanation||"关系说明待补充")+'</p></article>';
}
function renderReader(id){
  const paper=byId.get(id);if(!paper)return;
  const branch=branchById.get(paper.branchId);
  const relations=relatedTo(id);
  document.getElementById("reader-title").textContent=paper.title;
  document.getElementById("reader-title-zh").textContent=paper.titleZh;
  const primary=HAS_DEMO_PDF&&paper.id===DEMO_PAPER_ID?'<button type="button" class="primary" id="open-demo-pdf">打开内置 PDF</button>':paper.url?'<a class="primary" href="'+escHtml(paper.url)+'" target="_blank" rel="noopener">打开论文来源</a>':'';
  const secondary=paper.url?'<a href="'+escHtml(paper.url)+'" target="_blank" rel="noopener">官方页面</a>':'';
  document.getElementById("reader-body").innerHTML='<div class="reader-meta"><span>'+paper.year+'</span><span>'+escHtml(paper.venue||"来源待补充")+'</span><span>'+escHtml(branch?.name||"未分类")+'</span><span>'+accessLabel(paper)+'</span><span>'+evidenceLabel(paper.analysisBasis)+'</span><span>置信度 '+Math.round((paper.confidence??.7)*100)+'%</span></div><div class="reader-grid"><section><h3>研究问题</h3><p>'+escHtml(paper.problem||"当前资料不足，待补充。")+'</p></section><section><h3>核心方法</h3><p>'+escHtml(paper.method||"当前资料不足，待补充。")+'</p></section><section><h3>主要贡献</h3><p>'+escHtml(paper.contribution||"当前资料不足，待补充。")+'</p></section></div><section class="relation-block"><h3>论文关系 · '+relations.length+' 条</h3>'+(relations.length?relations.map(relation=>relationCard(relation,id)).join(""):'<p class="empty">当前没有已确认的直接关系。</p>')+'</section><div class="reader-actions">'+primary+secondary+'</div>';
  document.getElementById("open-demo-pdf")?.addEventListener("click",openDemoPdf);
  reader.classList.add("open");backdrop.classList.add("open");
}
function selectPaper(id,{toggle=true,scroll=false}={}){
  if(toggle&&selected.has(id)){selected.delete(id);activePaperId=[...selected].at(-1)||null}else{selected.add(id);activePaperId=id}
  updateHighlight();
  if(activePaperId){renderReader(activePaperId)}else{closeReader()}
  if(scroll){document.querySelector('.paper-node[data-paper-id="'+CSS.escape(id)+'"]')?.scrollIntoView({behavior:"smooth",block:"center",inline:"center"})}
}
function closeReader(){reader.classList.remove("open");backdrop.classList.remove("open")}
function clearSelection(){selected.clear();activePaperId=null;updateHighlight();closeReader()}
function openDemoPdf(){
  try{const binary=atob(DEMO_PDF_BASE64);const bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);const url=URL.createObjectURL(new Blob([bytes],{type:"application/pdf"}));const tab=window.open(url,"_blank");if(!tab)location.href=url;setTimeout(()=>URL.revokeObjectURL(url),120000)}catch(error){alert("当前浏览器无法直接打开内置 PDF，请选择右侧官方页面。")}
}
document.querySelectorAll(".paper-node").forEach(node=>{node.addEventListener("click",()=>selectPaper(node.dataset.paperId));node.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();selectPaper(node.dataset.paperId)}})});
document.querySelectorAll("[data-directory-paper]").forEach(button=>button.addEventListener("click",()=>selectPaper(button.dataset.directoryPaper,{toggle:false,scroll:true})));
document.getElementById("close-reader").addEventListener("click",closeReader);
document.getElementById("reader-backdrop").addEventListener("click",closeReader);
document.getElementById("clear-selection").addEventListener("click",clearSelection);
const scroller=document.getElementById("map-scroller");
const zoomIndicator=document.getElementById("zoom-indicator");
const MAP_WIDTH=${mapWidth};
const MAP_HEIGHT=${mapHeight};
let mapScale=1;
let pinchState=null;
function clampScale(value){return Math.min(2.4,Math.max(.5,value))}
function setMapScale(next,{clientX,clientY,contentX,contentY}={}){
  const scale=clampScale(next);
  const rect=scroller.getBoundingClientRect();
  const localX=Number.isFinite(clientX)?clientX-rect.left:scroller.clientWidth/2;
  const localY=Number.isFinite(clientY)?clientY-rect.top:scroller.clientHeight/2;
  const anchorX=Number.isFinite(contentX)?contentX:(scroller.scrollLeft+localX)/mapScale;
  const anchorY=Number.isFinite(contentY)?contentY:(scroller.scrollTop+localY)/mapScale;
  mapScale=scale;
  map.setAttribute("width",String(MAP_WIDTH*mapScale));
  map.setAttribute("height",String(MAP_HEIGHT*mapScale));
  map.style.width=(MAP_WIDTH*mapScale)+"px";
  map.style.height=(MAP_HEIGHT*mapScale)+"px";
  scroller.scrollLeft=Math.max(0,anchorX*mapScale-localX);
  scroller.scrollTop=Math.max(0,anchorY*mapScale-localY);
  const percent=Math.round(mapScale*100);
  zoomIndicator.textContent=percent+"%";
  zoomIndicator.setAttribute("aria-label","当前缩放 "+percent+"%，点按恢复");
}
function touchDistance(touches){return Math.hypot(touches[0].clientX-touches[1].clientX,touches[0].clientY-touches[1].clientY)}
function touchMidpoint(touches){return {x:(touches[0].clientX+touches[1].clientX)/2,y:(touches[0].clientY+touches[1].clientY)/2}}
scroller.addEventListener("touchstart",event=>{
  if(event.touches.length!==2)return;
  const mid=touchMidpoint(event.touches),rect=scroller.getBoundingClientRect();
  pinchState={distance:touchDistance(event.touches),scale:mapScale,contentX:(scroller.scrollLeft+mid.x-rect.left)/mapScale,contentY:(scroller.scrollTop+mid.y-rect.top)/mapScale};
},{passive:true});
scroller.addEventListener("touchmove",event=>{
  if(!pinchState||event.touches.length!==2)return;
  event.preventDefault();
  const mid=touchMidpoint(event.touches);
  setMapScale(pinchState.scale*touchDistance(event.touches)/pinchState.distance,{clientX:mid.x,clientY:mid.y,contentX:pinchState.contentX,contentY:pinchState.contentY});
},{passive:false});
scroller.addEventListener("touchend",event=>{if(event.touches.length<2)pinchState=null},{passive:true});
scroller.addEventListener("touchcancel",()=>{pinchState=null},{passive:true});
scroller.addEventListener("wheel",event=>{
  if(!event.ctrlKey&&!event.metaKey)return;
  event.preventDefault();
  setMapScale(mapScale*Math.exp(-event.deltaY*.002),{clientX:event.clientX,clientY:event.clientY});
},{passive:false});
let safariGestureScale=1;
scroller.addEventListener("gesturestart",event=>{event.preventDefault();safariGestureScale=mapScale},{passive:false});
scroller.addEventListener("gesturechange",event=>{event.preventDefault();setMapScale(safariGestureScale*event.scale,{clientX:event.clientX,clientY:event.clientY})},{passive:false});
zoomIndicator.addEventListener("click",()=>setMapScale(1));
requestAnimationFrame(()=>{scroller.scrollLeft=Math.max(0,${left}-24)});
</script>
</body>
</html>`;

await fs.writeFile(htmlPath, html, "utf8");
await fs.mkdir(staging, { recursive: true });
await fs.copyFile(htmlPath, path.join(staging, path.basename(htmlPath)));
await fs.writeFile(path.join(staging, "README-Mobile.txt"), [
  "研究树工作台 - 手机只读体验版",
  "",
  "最简单的方法：把 Research-Tree-Mobile-Demo.html 作为文件发送到微信。",
  "",
  "安卓手机：",
  "1. 在微信中下载 HTML 文件。",
  "2. 点右上角菜单，选择“用其他应用打开”。",
  "3. 选择 Chrome、Edge 或系统浏览器。",
  "",
  "iPhone / iPad：",
  "1. 在微信中下载文件并选择“存储到文件”。",
  "2. 到“文件”App 中找到 HTML，选择共享或用 Safari 打开。",
  "",
  "若微信不允许直接发送 HTML，可发送本 ZIP。朋友解压后再按上面的方式打开 HTML。",
  "网页无需联网即可浏览研究树、关系说明和内置示例 PDF；打开其他论文官方页面时需要联网。",
  "",
  "本手机版是只读体验版，不包含 AI 检索和编辑功能，也不包含任何个人资料或 API Key。"
].join("\r\n"), "utf8");

const archive = spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, path.basename(staging)], { cwd: dist, stdio: "inherit" });
if (archive.status !== 0) throw new Error("手机版备用压缩包生成失败。");
await fs.rm(staging, { recursive: true, force: true });

console.log(htmlPath);
console.log(zipPath);
