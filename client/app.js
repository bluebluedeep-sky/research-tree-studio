import { ANALYSIS_BASIS, accessStatusLabel, analysisBasisLabel, mergePaperAnalysis, migrateTree, migrateWorkspace, normalizePaperAccess, normalizeRelationEvidence } from "./access-model.js";

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const clone = value => structuredClone(value);
const uid = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const colors = ["#2c6ca3", "#b86721", "#40844a", "#6f5d9e", "#a14e49", "#0f7f91", "#8a6d2f"];
const relationLabels = { extends: "继承", improves: "改进", replaces: "替代", combines: "融合", contrasts: "对比", inspires: "启发", migrates_problem: "问题迁移" };
const relationColors = { extends: "#3f7468", improves: "#2c6ca3", replaces: "#a14e49", combines: "#6f5d9e", contrasts: "#b86721", inspires: "#8a6d2f", migrates_problem: "#0f7f91" };
const defaults = { model: "deepseek-v4-flash", depth: "balanced", concurrency: 2, retries: 2, savePdf: false, autoLowConfidence: false };
let workspace;
let activeTreeId = null;
let editingTreeId = null;
let createMode = "manual";
let searchMode = "lineage";
let selectedPaperId = null;
let importCandidate = null;
let researchController = null;
let researchProgressTimer = null;
let researchProgressStartedAt = 0;
let researchProgressState = { percent: 0, stage: "准备开始", detail: "正在建立连接…" };
let relationshipHoverPaperId = null;
let relationshipPinnedPaperIds = new Set();
let editingRelationshipId = null;
let relationshipClearTimer = null;
let relationshipPanelCollapsed = false;
let relationshipAiId = null;
let relationshipAiProgress = null;
let relationshipAiController = null;
let paperClickTimer = null;
const running = new Map();
const pdfRepairing = new Set();
const syncChannel = new BroadcastChannel("research-tree-studio-sync");

function esc(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function toast(message) { const el = $("#toast"); el.textContent = message; el.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2400); }
function formatDate(value) { return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function activeTree() { return workspace.trees.find(tree => tree.id === activeTreeId); }
function relationTypeLabel(type) { return relationLabels[type] || "继承"; }
function relationTypeColor(type) { return relationColors[type] || relationColors.extends; }

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("research-tree-studio", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("app");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function dbGet(key) { const db = await openDb(); return new Promise((resolve, reject) => { const req = db.transaction("app").objectStore("app").get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }); }
async function dbPut(key, value) { const db = await openDb(); return new Promise((resolve, reject) => { const tx = db.transaction("app", "readwrite"); tx.objectStore("app").put(value, key); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }

function cleanQueueOnLoad() {
  for (const tree of workspace.trees) {
    tree.queue ||= [];
    tree.pending ||= [];
    tree.history ||= [];
    tree.future ||= [];
    for (const task of tree.queue) if (["uploading", "extracting", "analyzing"].includes(task.status)) { task.status = "interrupted"; task.error = "页面已刷新，请重新选择文件后重试。"; task.progress = 0; delete task.file; }
  }
}
async function save() { workspace.updatedAt = new Date().toISOString(); const stored = clone(workspace); if (!stored.settings?.savePdf) stored.trees.forEach(tree => tree.queue?.forEach(task => delete task.file)); await dbPut("workspace", stored); }
function treeContent(tree) { const copy = clone(tree); delete copy.history; delete copy.future; delete copy.queue; return copy; }
function recordBefore(tree, action, source = "用户", summary = "") {
  tree.future = [];
  tree.history = [{ id: uid("version"), time: new Date().toISOString(), action, source, summary, snapshot: treeContent(tree) }];
}
function restoreContent(tree, snapshot) { const history = tree.history, future = tree.future, queue = tree.queue; Object.keys(tree).forEach(k => delete tree[k]); Object.assign(tree, clone(snapshot), { history, future, queue }); }
async function undo() { const tree = activeTree(); if (!tree?.history.length) return toast("没有可撤销的更新。"); const entry = tree.history.pop(); tree.future = [{ ...entry, snapshot: treeContent(tree) }]; restoreContent(tree, entry.snapshot); await save(); renderTreeView(); toast("已撤销上一步更新。"); }
async function redo() { const tree = activeTree(); if (!tree?.future.length) return toast("没有可重做的更新。"); const entry = tree.future.pop(); tree.history = [{ ...entry, snapshot: treeContent(tree) }]; restoreContent(tree, entry.snapshot); await save(); renderTreeView(); toast("已重做更新。"); }

async function initialize() {
  localStorage.removeItem("openai-key");
  sessionStorage.removeItem("openai-key");
  workspace = await dbGet("workspace");
  if (!workspace) {
    const seed = await fetch("/api/seed").then(r => r.json());
    seed.queue = [];
    workspace = { version: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), settings: clone(defaults), trees: [seed] };
    await save();
  }
  workspace = migrateWorkspace(workspace);
  workspace.settings = { ...defaults, ...(workspace.settings || {}) };
  if (!String(workspace.settings.model || "").startsWith("deepseek-")) workspace.settings.model = defaults.model;
  const currentSeed = await fetch("/api/seed").then(r => r.json());
  const seedTree = workspace.trees.find(tree => tree.id === currentSeed.id);
  if (seedTree) {
    for (const paper of seedTree.papers) {
      const updated = currentSeed.papers.find(item => item.id === paper.id);
      if (!paper.localPdf && updated?.localPdf) paper.localPdf = updated.localPdf;
    }
    if (seedTree.locked) for (const relation of seedTree.relations || []) {
      const updated = currentSeed.relations?.find(item => item.id === relation.id || (item.sourceId === relation.sourceId && item.targetId === relation.targetId));
      if (updated) Object.assign(relation, { type: updated.type, explanation: updated.explanation, confidence: updated.confidence, analysisBasis: updated.analysisBasis });
    }
  }
  workspace = migrateWorkspace(workspace);
  cleanQueueOnLoad();
  await save();
  hydrateSettings();
  renderHome();
}

syncChannel.onmessage = event => {
  if (!["paper-local-pdf", "paper-reanalyzed"].includes(event.data?.type)) return;
  const paper = workspace?.trees?.find(tree => tree.id === event.data.treeId)?.papers?.find(item => item.id === event.data.paperId);
  if (!paper) return;
  Object.assign(paper, normalizePaperAccess({ ...paper, ...(event.data.paper || {}), localPdf: event.data.localPdf || event.data.paper?.localPdf || paper.localPdf }));
  void save();
  if (activeTreeId === event.data.treeId && selectedPaperId === paper.id) renderReader(paper.id);
};

function treeCard(tree) {
  return `<article class="tree-card" style="--card-color:${esc(tree.color)}">
    ${tree.locked ? `<button class="tree-edit" data-copy-tree="${tree.id}">复制</button>` : `<button class="tree-edit" data-edit-tree="${tree.id}">编辑</button>`}
    <button class="tree-open" data-open-tree="${tree.id}"><span class="tree-meta">${tree.papers.length} 篇 · ${formatDate(tree.updatedAt)}</span>
      <div class="tree-icon"><i class="trunk"></i><i class="branch b1"></i><i class="branch b2"></i><i class="branch b3"></i><i class="leaf l1"></i><i class="leaf l2"></i><i class="leaf l3"></i></div>
      <h2>${esc(tree.name)}</h2><p>${esc(tree.description || "尚未填写研究范围")}</p><span class="tree-enter">进入子大树 →</span>
    </button></article>`;
}
function renderHome() { $("#tree-grid").innerHTML = workspace.trees.map(treeCard).join(""); }
function showView(name) { $$(".view").forEach(el => el.classList.toggle("active", el.id === `${name}-view`)); }
function resetRelationshipState() { clearTimeout(relationshipClearTimer); clearTimeout(paperClickTimer); paperClickTimer = null; relationshipHoverPaperId = null; relationshipPinnedPaperIds = new Set(); editingRelationshipId = null; relationshipPanelCollapsed = false; relationshipAiId = null; relationshipAiProgress = null; relationshipAiController?.abort(); relationshipAiController = null; }
function openTree(id) { activeTreeId = id; selectedPaperId = null; resetRelationshipState(); showView("tree"); renderTreeView(); history.replaceState(null, "", `#tree=${encodeURIComponent(id)}`); void repairTreePdfs(activeTree()); }
function goHome() { activeTreeId = null; resetRelationshipState(); showView("home"); renderHome(); history.replaceState(null, "", location.pathname); }

function renderTreeView() {
  const tree = activeTree(); if (!tree) return goHome();
  for (const relation of tree.relations) relation.id ||= uid("rel");
  $("#tree-name").textContent = tree.name; $("#tree-description").textContent = tree.description;
  $("#undo-btn").disabled = !tree.history.length; $("#redo-btn").disabled = !tree.future.length;
  $("#branch-legend").innerHTML = tree.branches.map(b => `<span style="--c:${b.color}">${esc(b.name)}</span>`).join("");
  renderTreeSvg(tree); renderRelationshipPanel(); renderRelationshipOverview(tree); renderQueue(); renderPending(); renderBranches();
  if (selectedPaperId && tree.papers.some(p => p.id === selectedPaperId)) renderReader(selectedPaperId); else $("#paper-reader").innerHTML = `<h2>选择一个论文节点</h2><p>点击树上的论文，查看它解决的问题、所在分支以及与其他工作的关系。</p>`;
}

function wrapLines(value, max = 24, maxLines = 2) {
  const source = String(value || "").trim();
  if (!source) return [];
  const tokens = source.includes(" ") ? source.split(/\s+/) : [...source];
  const lines = [];
  let line = "";
  for (const token of tokens) {
    const spacer = source.includes(" ") && line ? " " : "";
    if ((line + spacer + token).length <= max) line += spacer + token;
    else { if (line) lines.push(line); line = token.slice(0, max); }
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) lines.push(line);
  const consumed = lines.join(source.includes(" ") ? " " : "").replace(/…$/, "");
  if (consumed.length < source.replace(/\s+/g, source.includes(" ") ? " " : "").length && lines.length) lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(1, max - 1))}…`;
  return lines.slice(0, maxLines);
}
function accessMarker(paper, x, y) {
  const status = paper.accessStatus || "unavailable";
  const symbol = status === "institutional_required" ? "锁" : "";
  return `<g class="access-marker status-${status}" aria-label="${esc(accessStatusLabel(status))}"><title>${esc(accessStatusLabel(status))}</title><circle cx="${x}" cy="${y}" r="6"/>${symbol ? `<text x="${x}" y="${y + 2.6}">${symbol}</text>` : ""}</g>`;
}
function relationGeometry(a, b, paperWidth, paperHeight) {
  if (a.x === b.x) {
    const side = a.x + paperWidth + 22, y1 = a.y + paperHeight / 2, y2 = b.y + paperHeight / 2;
    return { d: `M ${a.x + paperWidth} ${y1} C ${side} ${y1},${side} ${y2},${b.x + paperWidth} ${y2}`, labelX: side + 6, labelY: (y1 + y2) / 2 };
  }
  const left = a.x < b.x ? a : b, right = a.x < b.x ? b : a, x1 = left.x + paperWidth, y1 = left.y + paperHeight / 2, x2 = right.x, y2 = right.y + paperHeight / 2, mid = (x1 + x2) / 2;
  return { d: `M ${x1} ${y1} C ${mid} ${y1},${mid} ${y2},${x2} ${y2}`, labelX: mid, labelY: (y1 + y2) / 2 };
}
function renderTreeSvg(tree) {
  resetTreeHover();
  if (!tree.branches.length) { $("#tree-canvas").innerHTML = `<div class="empty-state"><h2>这棵树还没有分支</h2><p>先在右侧新建分支，或上传论文让 AI 自动分类。</p></div>`; return; }
  const years = [...new Set(tree.papers.map(p => Number(p.year) || new Date().getFullYear()))].sort((a, b) => a - b);
  if (!years.length) years.push(new Date().getFullYear());
  const rootX = 20, rootWidth = 132, branchX = 188, branchWidth = 214, paperStartX = 468, paperWidth = 224, paperHeight = 84, yearGap = 306, paperGap = 14;
  const width = Math.max(1200, paperStartX + years.length * yearGap + 30), positions = new Map(); let y = 72;
  const lanes = tree.branches.map(branch => {
    const papers = tree.papers.filter(p => p.branchId === branch.id);
    const maxPerYear = Math.max(1, ...years.map(year => papers.filter(p => Number(p.year) === year).length));
    const height = Math.max(188, maxPerYear * (paperHeight + paperGap) + 64); const lane = { branch, papers, top: y, center: y + height / 2, height }; y += height + 22; return lane;
  });
  const height = y + 34, rootY = height / 2 - 34, yearX = Object.fromEntries(years.map((year, i) => [year, paperStartX + i * yearGap]));
  for (const lane of lanes) for (const year of years) {
    const group = lane.papers.filter(p => Number(p.year) === year).sort((a, b) => a.title.localeCompare(b.title));
    const blockHeight = group.length * paperHeight + Math.max(0, group.length - 1) * paperGap;
    group.forEach((paper, index) => positions.set(paper.id, { x: yearX[year], y: lane.center - blockHeight / 2 + index * (paperHeight + paperGap) }));
  }
  const yearLines = years.map(year => `<g class="year-guide"><line x1="${yearX[year] + paperWidth / 2}" y1="44" x2="${yearX[year] + paperWidth / 2}" y2="${height - 18}"/><text x="${yearX[year] + paperWidth / 2}" y="29">${year}</text></g>`).join("");
  const branchBackbones = lanes.map(lane => {
    const branchTitle = wrapLines(lane.branch.name, 14, 2), question = wrapLines(lane.branch.question, 18, 1);
    const foundationPaper = [...lane.papers].sort((a, b) => a.year - b.year || a.title.localeCompare(b.title))[0];
    const lastX = lane.papers.length ? Math.max(...lane.papers.map(p => positions.get(p.id)?.x || paperStartX)) + paperWidth : paperStartX;
    const twigs = lane.papers.map(paper => { const pos = positions.get(paper.id); const cy = pos.y + paperHeight / 2; return `<path class="branch-twig" data-paper="${paper.id}" style="stroke:${lane.branch.color}" d="M ${pos.x - 18} ${lane.center} Q ${pos.x - 7} ${lane.center},${pos.x} ${cy}"/>`; }).join("");
    const branchNode = `<g class="branch-node" ${foundationPaper ? "" : 'role="button" tabindex="0"'} data-branch="${lane.branch.id}"><rect x="${branchX}" y="${lane.center - 34}" width="${branchWidth}" height="68" style="stroke:${lane.branch.color}"/><rect class="branch-accent" x="${branchX}" y="${lane.center - 34}" width="6" height="68" style="fill:${lane.branch.color}"/><text class="branch-label" x="${branchX + 16}" y="${lane.center - 12}" style="fill:${lane.branch.color}">${esc(branchTitle[0] || "研究分支")}</text>${branchTitle[1] ? `<text class="branch-label" x="${branchX + 16}" y="${lane.center + 3}" style="fill:${lane.branch.color}">${esc(branchTitle[1])}</text>` : ""}<text class="branch-question" x="${branchX + 16}" y="${lane.center + 22}">${esc(question[0] || `${lane.papers.length} 篇论文`)}</text><text class="branch-count" x="${branchX + branchWidth - 10}" y="${lane.center + 22}">${lane.papers.length}</text></g>`;
    const branchLink = foundationPaper ? `<a class="branch-link" href="${esc(paperReaderUrl(foundationPaper))}" aria-label="打开${esc(lane.branch.name)}的奠基论文">${branchNode}</a>` : branchNode;
    return `<g class="branch-paths" data-branch="${lane.branch.id}"><path class="root-branch" style="stroke:${lane.branch.color}" d="M ${rootX + rootWidth} ${rootY + 34} C 170 ${rootY + 34},160 ${lane.center},${branchX} ${lane.center}"/><line class="branch-trunk" style="stroke:${lane.branch.color}" x1="${branchX + branchWidth}" y1="${lane.center}" x2="${Math.max(branchX + branchWidth + 24, lastX)}" y2="${lane.center}"/>${twigs}</g>${branchLink}`;
  }).join("");
  const labelCells = new Set();
  const relationVisuals = tree.relations.map((rel, index) => {
    const a = positions.get(rel.sourceId), b = positions.get(rel.targetId); if (!a || !b) return null;
    const geometry = relationGeometry(a, b, paperWidth, paperHeight), main = rel.type === "extends" || rel.type === "improves", label = relationTypeLabel(rel.type), color = relationTypeColor(rel.type);
    const labelY = geometry.labelY + ((index % 3) - 1) * 11, cell = `${Math.round(geometry.labelX / 82)}:${Math.round(labelY / 24)}`, collapsed = labelCells.has(cell); labelCells.add(cell);
    const labelWidth = Math.max(34, label.length * 10 + 12);
    return {
      line: `<path class="relation ${main ? "main" : "cross"}" data-relation="${rel.id}" data-source="${rel.sourceId}" data-target="${rel.targetId}" style="--relation-color:${color}" d="${geometry.d}"/>`,
      label: `<g class="relation-label ${collapsed ? "label-collapsed" : ""}" data-relation="${rel.id}" data-source="${rel.sourceId}" data-target="${rel.targetId}" style="--relation-color:${color}" transform="translate(${geometry.labelX} ${labelY})"><title>${esc(label)}：${esc(rel.explanation || "关系说明待补充")}</title><rect x="${-labelWidth / 2}" y="-9" width="${labelWidth}" height="18" rx="3"/><text y="3">${esc(label)}</text><circle r="3.2"/></g>`
    };
  }).filter(Boolean);
  const relationLines = relationVisuals.map(item => item.line).join(""), relationLabelsSvg = relationVisuals.map(item => item.label).join("");
  const clipDefs = tree.papers.map(paper => { const pos = positions.get(paper.id); return pos ? `<clipPath id="clip-${paper.id}"><rect x="${pos.x + 8}" y="${pos.y + 6}" width="${paperWidth - 34}" height="${paperHeight - 12}"/></clipPath>` : ""; }).join("");
  const nodes = tree.papers.map(paper => {
    const pos = positions.get(paper.id); if (!pos) return "";
    const branch = tree.branches.find(b => b.id === paper.branchId) || tree.branches[0], en = wrapLines(paper.title, 30, 2), zh = wrapLines(paper.titleZh || "", 19, 2), venue = wrapLines(`${paper.venue || "来源待确认"} · ${paper.year}`, 34, 1);
    const relationCount = tree.relations.filter(relation => relation.sourceId === paper.id || relation.targetId === paper.id).length;
    return `<a class="paper-link" href="${esc(paperReaderUrl(paper))}" aria-label="单击锁定关系，双击阅读${esc(paper.titleZh || paper.title)}"><g class="paper-node" data-paper="${paper.id}" data-branch="${branch.id}"><rect x="${pos.x}" y="${pos.y}" width="${paperWidth}" height="${paperHeight}" style="stroke:${branch.color}"/><g clip-path="url(#clip-${paper.id})"><text x="${pos.x + 10}" y="${pos.y + 17}">${esc(en[0] || "Untitled paper")}</text>${en[1] ? `<text x="${pos.x + 10}" y="${pos.y + 31}">${esc(en[1])}</text>` : ""}<text class="zh" x="${pos.x + 10}" y="${pos.y + 49}">${esc(zh[0] || "中文标题待补充")}</text>${zh[1] ? `<text class="zh" x="${pos.x + 10}" y="${pos.y + 62}">${esc(zh[1])}</text>` : ""}<text class="venue" x="${pos.x + 10}" y="${pos.y + 77}">${esc(venue[0])}</text></g>${accessMarker(paper, pos.x + paperWidth - 12, pos.y + 12)}</g></a>${relationCount ? `<g class="relation-peek-control" role="button" tabindex="0" aria-label="查看${esc(paper.titleZh || paper.title)}的论文关系" data-paper="${paper.id}" transform="translate(${pos.x + paperWidth - 15} ${pos.y + paperHeight - 14})"><circle r="9"/><text y="2.6">联</text></g>` : ""}`;
  }).join("");
  const rootTitle = wrapLines(tree.name, 8, 2);
  $("#tree-canvas").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-label="${esc(tree.name)}研究树"><defs>${clipDefs}</defs>${yearLines}<g class="relation-layer">${relationLines}</g><g class="branch-layer">${branchBackbones}</g><g class="relation-label-layer">${relationLabelsSvg}</g><g class="node-layer">${nodes}</g><g class="root-node"><rect x="${rootX}" y="${rootY}" width="${rootWidth}" height="68"/><text x="${rootX + rootWidth / 2}" y="${rootY + 26}">${esc(rootTitle[0] || "研究主题")}</text>${rootTitle[1] ? `<text x="${rootX + rootWidth / 2}" y="${rootY + 43}">${esc(rootTitle[1])}</text>` : ""}<text class="root-caption" x="${rootX + rootWidth / 2}" y="${rootY + 58}">研究主干</text></g></svg>`;
  const svg = $("#tree-canvas svg");
  $$(".paper-node").forEach(node => {
    const paper = tree.papers.find(p => p.id === node.dataset.paper);
    node.addEventListener("pointerenter", event => { cancelRelationshipClear(); if (!relationshipPinnedPaperIds.size) { relationshipHoverPaperId = paper.id; highlightPaperTrace(tree, paper.id, svg); renderRelationshipPanel(paper.id); } showTooltip(paper, event, svg, width); });
    node.addEventListener("pointermove", event => positionTooltip(event, svg, width));
    node.addEventListener("pointerleave", () => clearRelationshipHover(paper.id, svg));
    node.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation(); clearTimeout(paperClickTimer);
      paperClickTimer = setTimeout(() => {
        paperClickTimer = null;
        const wasLocked = relationshipPinnedPaperIds.has(paper.id);
        pinRelationshipPaper(paper.id);
        if (!wasLocked) {
          selectedPaperId = paper.id;
          renderReader(paper.id);
        } else if (selectedPaperId === paper.id) {
          const fallbackId = [...relationshipPinnedPaperIds].at(-1) || null;
          selectedPaperId = fallbackId;
          if (fallbackId) renderReader(fallbackId);
          else $("#paper-reader").innerHTML = `<h2>选择一个论文节点</h2><p>尚未选择论文。</p>`;
        }
      }, 250);
    });
    node.addEventListener("dblclick", event => {
      event.preventDefault(); event.stopPropagation(); clearTimeout(paperClickTimer); paperClickTimer = null;
      openPaperReader(paper);
    });
  });
  svg.querySelectorAll(".relation-peek-control").forEach(control => {
    const activate = event => { event.preventDefault(); event.stopPropagation(); pinRelationshipPaper(control.dataset.paper, true); $("#relationship-panel").classList.add("mobile-open"); };
    control.addEventListener("click", activate);
    control.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) activate(event); });
  });
  $$(".branch-node").forEach(node => {
    const activate = () => { resetTreeHover(svg); const papers = tree.papers.filter(item => item.branchId === node.dataset.branch); $$(".paper-node").forEach(item => item.classList.toggle("branch-selected", item.dataset.branch === node.dataset.branch)); if (!papers.length) toast("该分支暂时没有可阅读的论文。"); };
    node.addEventListener("pointerenter", hideTooltip);
    node.addEventListener("click", activate);
    node.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); } });
  });
  svg.addEventListener("pointermove", event => { if (!event.target.closest?.(".paper-node,.relation-peek-control")) hideTooltip(); });
  svg.addEventListener("pointerleave", () => clearRelationshipHover(null, svg));
  svg.addEventListener("pointercancel", () => clearRelationshipHover(null, svg));
  const focusedPaperIds = relationshipPinnedPaperIds.size ? [...relationshipPinnedPaperIds] : relationshipHoverPaperId ? [relationshipHoverPaperId] : [];
  if (focusedPaperIds.length) highlightPaperTraces(tree, focusedPaperIds, svg);
  syncPaperLockState();
}

function highlightPaperTrace(tree, paperId, svg) {
  highlightPaperTraces(tree, [paperId], svg);
}
function highlightPaperTraces(tree, paperIds, svg) {
  clearPaperTrace(svg);
  const targetPapers = new Set(paperIds.filter(Boolean));
  if (!targetPapers.size) return;
  const directRelations = tree.relations.filter(item => targetPapers.has(item.sourceId) || targetPapers.has(item.targetId));
  const tracedPapers = new Set(targetPapers), tracedRelations = new Set(directRelations.map(relation => relation.id));
  for (const relation of directRelations) { tracedPapers.add(relation.sourceId); tracedPapers.add(relation.targetId); }
  const tracedBranches = new Set(tree.papers.filter(paper => tracedPapers.has(paper.id)).map(paper => paper.branchId));
  svg.classList.add("trace-mode");
  svg.querySelectorAll(".relation,.relation-label").forEach(element => element.classList.toggle("trace-active", tracedRelations.has(element.dataset.relation)));
  svg.querySelectorAll(".branch-paths").forEach(group => group.classList.toggle("trace-active", tracedBranches.has(group.dataset.branch)));
  svg.querySelectorAll(".branch-twig").forEach(path => path.classList.toggle("trace-paper", tracedPapers.has(path.dataset.paper)));
  svg.querySelectorAll(".paper-node").forEach(node => { node.classList.toggle("trace-ancestor", tracedPapers.has(node.dataset.paper)); node.classList.toggle("trace-target", targetPapers.has(node.dataset.paper)); });
}
function clearPaperTrace(svg) {
  svg?.classList.remove("trace-mode");
  svg?.querySelectorAll(".trace-active,.trace-paper,.trace-ancestor,.trace-target").forEach(element => element.classList.remove("trace-active", "trace-paper", "trace-ancestor", "trace-target"));
}

function cancelRelationshipClear() { clearTimeout(relationshipClearTimer); relationshipClearTimer = null; }
function scheduleRelationshipClear() {
  cancelRelationshipClear();
  relationshipClearTimer = setTimeout(() => clearRelationshipHover(), 0);
}
function clearRelationshipHover(paperId = null, svg = $("#tree-canvas svg")) {
  hideTooltip();
  if (paperId && relationshipHoverPaperId !== paperId) return;
  relationshipHoverPaperId = null;
  const tree = activeTree();
  if (relationshipPinnedPaperIds.size && tree) highlightPaperTraces(tree, [...relationshipPinnedPaperIds], svg);
  else clearPaperTrace(svg);
  renderRelationshipPanel();
}
function syncPaperLockState() {
  $$(".paper-node").forEach(node => node.classList.toggle("locked", relationshipPinnedPaperIds.has(node.dataset.paper)));
}
function pinRelationshipPaper(paperId, force = false) {
  const tree = activeTree(); if (!tree?.papers.some(paper => paper.id === paperId)) return;
  if (relationshipPinnedPaperIds.has(paperId) && !force) relationshipPinnedPaperIds.delete(paperId);
  else {
    relationshipPinnedPaperIds.delete(paperId);
    relationshipPinnedPaperIds.add(paperId);
  }
  relationshipHoverPaperId = null;
  relationshipPanelCollapsed = false;
  cancelRelationshipClear();
  renderRelationshipPanel();
  const svg = $("#tree-canvas svg");
  const focusedPaperIds = relationshipPinnedPaperIds.size ? [...relationshipPinnedPaperIds] : relationshipHoverPaperId ? [relationshipHoverPaperId] : [];
  if (focusedPaperIds.length) highlightPaperTraces(tree, focusedPaperIds, svg); else clearPaperTrace(svg);
  syncPaperLockState();
  return relationshipPinnedPaperIds.has(paperId);
}
function clearRelationshipSelection(clearPaper = false) {
  relationshipPinnedPaperIds.clear();
  relationshipHoverPaperId = null;
  editingRelationshipId = null;
  cancelRelationshipClear();
  clearPaperTrace($("#tree-canvas svg"));
  syncPaperLockState();
  if (clearPaper) {
    selectedPaperId = null;
    $$(".paper-node").forEach(node => node.classList.remove("selected"));
    $("#paper-reader").innerHTML = `<h2>选择一个论文节点</h2><p>尚未选择论文。</p>`;
  }
  renderRelationshipPanel();
}
function relationCardHtml(tree, relation, selectedPaperId, instanceKey = "single") {
  const source = tree.papers.find(paper => paper.id === relation.sourceId), target = tree.papers.find(paper => paper.id === relation.targetId);
  if (!source || !target) return "";
  const other = relation.sourceId === selectedPaperId ? target : source, color = relationTypeColor(relation.type), editing = editingRelationshipId === relation.id, runningAi = relationshipAiId === relation.id;
  const explanation = relation.explanation || "关系说明待补充。", inputId = `relationship-edit-${relation.id}-${instanceKey}`.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `<article class="relationship-card" data-relationship-card="${relation.id}" style="--relation-color:${color}">
    <div class="relationship-card-head"><span class="relationship-kind">${esc(relationTypeLabel(relation.type))}</span><span class="relationship-confidence">${Math.round((relation.confidence || 0) * 100)}%</span></div>
    <div class="relationship-paper-path"><span title="${esc(source.titleZh || source.title)}">${esc(source.titleZh || source.title)}</span><i>→</i><span title="${esc(target.titleZh || target.title)}">${esc(target.titleZh || target.title)}</span></div>
    ${editing ? `<div class="relationship-edit"><textarea id="${inputId}" maxlength="600">${esc(explanation)}</textarea><div class="relationship-edit-actions"><button type="button" data-cancel-relationship-edit="${relation.id}">取消</button><button type="button" class="primary" data-save-relationship-edit="${relation.id}" data-relationship-input="${inputId}">保存</button></div></div>` : `<p class="relationship-explanation">${esc(explanation)}</p>`}
    ${runningAi ? `<div class="relationship-progress"><i style="width:${Math.max(10, relationshipAiProgress?.percent || 10)}%"></i></div><div class="relationship-progress-text"><span>${esc(relationshipAiProgress?.stage || "准备重新判断关系")} · ${Math.round(relationshipAiProgress?.percent || 0)}%</span><button type="button" data-cancel-relationship-ai="${relation.id}">取消</button></div>` : ""}
    <div class="relationship-card-foot"><span class="relationship-basis">${esc(analysisBasisLabel(relation.analysisBasis))}判断</span><button type="button" data-locate-paper="${other.id}" title="在树中定位" aria-label="在树中定位${esc(other.titleZh || other.title)}">⊙</button><button type="button" data-read-paper="${other.id}" title="打开论文" aria-label="打开${esc(other.titleZh || other.title)}">↗</button><details class="relationship-menu"><summary title="更多操作" aria-label="更多关系操作">…</summary><div class="relationship-menu-popover"><button type="button" data-start-relationship-edit="${relation.id}" title="编辑说明" aria-label="编辑关系说明">✎</button><button type="button" data-reanalyze-relationship="${relation.id}" title="AI 重新判断" aria-label="AI 重新判断当前关系" ${runningAi ? "disabled" : ""}>↻</button><button type="button" data-remove-relation="${relation.id}" title="删除关系" aria-label="删除当前关系">×</button></div></details></div>
  </article>`;
}
function relationshipGroupHtml(tree, title, relations, selectedPaperId, instanceKey) {
  if (!relations.length) return "";
  return `<section><div class="relationship-group-title"><span>${title}</span><span>${relations.length}</span></div><div class="relationship-list">${relations.map(relation => relationCardHtml(tree, relation, selectedPaperId, instanceKey)).join("")}</div></section>`;
}
function relationshipPaperSectionHtml(tree, paper, pinned, index) {
  const incoming = tree.relations.filter(relation => relation.targetId === paper.id).sort((a, b) => (tree.papers.find(item => item.id === a.sourceId)?.year || 0) - (tree.papers.find(item => item.id === b.sourceId)?.year || 0));
  const outgoing = tree.relations.filter(relation => relation.sourceId === paper.id).sort((a, b) => (tree.papers.find(item => item.id === a.targetId)?.year || 0) - (tree.papers.find(item => item.id === b.targetId)?.year || 0));
  const instanceKey = `${paper.id}-${index}`;
  return `<section class="relationship-paper-block" data-relationship-paper="${paper.id}"><div class="relationship-paper"><div><strong>${esc(paper.titleZh || paper.title)}</strong><small>${esc(paper.title)}</small></div>${pinned ? `<button type="button" data-unpin-paper="${paper.id}" title="解除这篇论文的锁定" aria-label="解除${esc(paper.titleZh || paper.title)}的锁定">×</button>` : ""}</div>${relationshipGroupHtml(tree, "前序来源", incoming, paper.id, instanceKey)}${relationshipGroupHtml(tree, "后续影响", outgoing, paper.id, instanceKey)}${incoming.length || outgoing.length ? "" : `<p class="relationship-empty">当前论文还没有已确认的关系。</p>`}</section>`;
}
function renderRelationshipPanel(paperId = relationshipHoverPaperId) {
  const panel = $("#relationship-panel"), body = $("#relationship-panel-body"), tree = activeTree(); if (!panel || !body || !tree) return;
  for (const id of [...relationshipPinnedPaperIds]) if (!tree.papers.some(paper => paper.id === id)) relationshipPinnedPaperIds.delete(id);
  panel.classList.toggle("collapsed", relationshipPanelCollapsed);
  panel.classList.toggle("multi-selection", relationshipPinnedPaperIds.size > 1);
  const toggle = $("#toggle-relationship-btn"); toggle.textContent = relationshipPanelCollapsed ? "⌄" : "⌃"; toggle.title = relationshipPanelCollapsed ? "展开关系栏" : "收起关系栏";
  const pinnedPapers = [...relationshipPinnedPaperIds].reverse().map(id => tree.papers.find(paper => paper.id === id)).filter(Boolean);
  const previewPaper = tree.papers.find(item => item.id === paperId), papers = pinnedPapers.length ? pinnedPapers : previewPaper ? [previewPaper] : [];
  const focusPaper = papers[0], pin = $("#pin-relationship-btn"), clear = $("#clear-relationship-btn");
  pin.disabled = !focusPaper; pin.classList.toggle("active", Boolean(pinnedPapers.length)); pin.textContent = pinnedPapers.length ? `已锁 ${pinnedPapers.length} 篇` : "锁定";
  clear.disabled = !papers.length;
  if (!papers.length) { $("#relationship-panel-count").textContent = "选择论文"; body.innerHTML = `<p class="relationship-empty">把鼠标停在论文上，即可同时查看它的前序来源和后续影响。</p>`; panel.classList.remove("mobile-open"); return; }
  const relationIds = new Set(tree.relations.filter(relation => papers.some(paper => relation.sourceId === paper.id || relation.targetId === paper.id)).map(relation => relation.id));
  $("#relationship-panel-count").textContent = pinnedPapers.length ? `${pinnedPapers.length} 篇已锁定 · ${relationIds.size} 条关系` : `${relationIds.size} 条直接关系`;
  body.innerHTML = papers.map((paper, index) => relationshipPaperSectionHtml(tree, paper, Boolean(pinnedPapers.length), index)).join("");
}
function overviewRelationHtml(tree, relation) {
  const source = tree.papers.find(paper => paper.id === relation.sourceId), target = tree.papers.find(paper => paper.id === relation.targetId); if (!source || !target) return "";
  return `<article class="overview-relation" style="--relation-color:${relationTypeColor(relation.type)}"><b>${esc(relationTypeLabel(relation.type))}</b><p><strong>${esc(source.titleZh || source.title)}</strong> → <strong>${esc(target.titleZh || target.title)}</strong>：${esc(relation.explanation || "关系说明待补充。")}</p></article>`;
}
function renderRelationshipOverview(tree) {
  const overview = $("#relationship-overview"); if (!overview) return;
  const validRelations = tree.relations.filter(relation => tree.papers.some(paper => paper.id === relation.sourceId) && tree.papers.some(paper => paper.id === relation.targetId));
  const sections = tree.branches.map(branch => {
    const ids = new Set(tree.papers.filter(paper => paper.branchId === branch.id).map(paper => paper.id));
    const relations = validRelations.filter(relation => ids.has(relation.sourceId) && ids.has(relation.targetId));
    return `<details><summary><strong style="color:${branch.color}">${esc(branch.name)}</strong><span>${relations.length} 条关键关系</span></summary><div class="overview-relations">${relations.map(relation => overviewRelationHtml(tree, relation)).join("") || `<p class="relationship-empty">该分支暂时没有论文关系。</p>`}</div></details>`;
  }).join("");
  const branchByPaper = new Map(tree.papers.map(paper => [paper.id, paper.branchId])), cross = validRelations.filter(relation => branchByPaper.get(relation.sourceId) !== branchByPaper.get(relation.targetId));
  const crossSection = `<details class="overview-cross"><summary><strong>跨分支联系</strong><span>${cross.length} 条</span></summary><div class="overview-relations">${cross.map(relation => overviewRelationHtml(tree, relation)).join("") || `<p class="relationship-empty">暂时没有跨分支关系。</p>`}</div></details>`;
  overview.innerHTML = `<header><h2>研究脉络总览</h2><span>${validRelations.length} 条论文关系</span></header>${sections}${crossSection}`;
}
function locatePaper(paperId) {
  const tree = activeTree(), node = $( `.paper-node[data-paper="${CSS.escape(paperId)}"]` ); if (!tree || !node) return toast("没有在当前树中找到这篇论文。");
  pinRelationshipPaper(paperId, true); node.classList.add("located"); node.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" }); setTimeout(() => node.classList.remove("located"), 1400);
}
async function saveRelationshipExplanation(id, inputId) {
  const tree = activeTree(), relation = tree.relations.find(item => item.id === id), input = inputId ? $(`#${CSS.escape(inputId)}`) : $(".relationship-edit textarea"); if (!relation || !input) return;
  const explanation = input.value.trim(); if (!explanation) return toast("关系说明不能为空。");
  recordBefore(tree, "修改论文关系", "用户", explanation); relation.explanation = explanation; editingRelationshipId = null; await save(); renderRelationshipPanel(); renderRelationshipOverview(tree); toast("关系说明已保存，可使用撤销恢复上一版。");
}
async function reanalyzeRelationship(id) {
  const tree = activeTree(), relation = tree.relations.find(item => item.id === id); if (!relation) return;
  if (!keyValue()) return toast("请先在设置中填写 DeepSeek API Key。");
  const source = tree.papers.find(paper => paper.id === relation.sourceId), target = tree.papers.find(paper => paper.id === relation.targetId); if (!source || !target) return toast("关系中的论文节点已不存在。");
  relationshipAiController?.abort(); relationshipAiController = new AbortController(); relationshipAiId = id; relationshipAiProgress = { percent: 5, stage: "准备论文证据" }; renderRelationshipPanel();
  const paperPayload = paper => ({ id: paper.id, title: paper.title, titleZh: paper.titleZh, year: paper.year, venue: paper.venue, abstract: paper.abstract, problem: paper.problem, method: paper.method, contribution: paper.contribution, analysisBasis: paper.analysisBasis, analysisConfidence: paper.analysisConfidence, branchId: paper.branchId });
  try {
    const result = await streamApi("/api/deepseek/relation/stream", { model: workspace.settings.model, depth: workspace.settings.depth, source: paperPayload(source), target: paperPayload(target), currentRelation: relation }, relationshipAiController.signal, progress => { relationshipAiProgress = progress; renderRelationshipPanel(); });
    recordBefore(tree, "AI 重新判断论文关系", "AI", `${source.title} → ${target.title}`); Object.assign(relation, normalizeRelationEvidence({ ...relation, ...result.data }, tree.papers)); await save(); editingRelationshipId = null; toast("AI 已更新当前关系，可使用撤销恢复上一版。"); renderTreeView();
  } catch (error) { if (error.name !== "AbortError") toast(error.message); }
  finally { relationshipAiId = null; relationshipAiProgress = null; relationshipAiController = null; renderRelationshipPanel(); }
}

function paperReaderUrl(paper) {
  const params = new URLSearchParams({ tree: activeTreeId, paper: paper.id, title: paper.title || paper.titleZh || "论文" });
  if (paper.localPdf) params.set("file", paper.localPdf);
  if (paper.url) params.set("source", paper.url);
  if (paper.pdfUrl) params.set("pdf", paper.pdfUrl);
  return `/reader.html?${params}`;
}
function openNewReader(url, successMessage) {
  const reader = window.open(url, "_blank");
  if (reader) { reader.opener = null; reader.focus(); toast(successMessage); }
  else toast("浏览器拦截了新标签页，请允许此页面打开新窗口。");
}
function openPaperReader(paper) {
  if (!paper) return toast("没有找到对应的论文节点。");
  openNewReader(paperReaderUrl(paper), "已在新标签页打开论文，当前研究树已保留。");
}
function openBranchReader(branch) {
  const params = new URLSearchParams({ tree: activeTreeId, branch: branch.id });
  openNewReader(`/branch-reader.html?${params}`, "已在新标签页打开分支目录，当前研究树已保留。");
}

function positionTooltip(event, svg, width) { const tip = $("#paper-tooltip"), scale = Math.max(.18, Math.min(1, svg.getBoundingClientRect().width / width)); tip.style.transform = `scale(${scale})`; const gap = 15, w = (tip.offsetWidth || 270) * scale, h = (tip.offsetHeight || 120) * scale; let x = event.clientX + gap, y = event.clientY + gap; if (x + w > innerWidth - 10) x = event.clientX - w - gap; if (y + h > innerHeight - 10) y = innerHeight - h - 10; tip.style.left = `${Math.max(8, x)}px`; tip.style.top = `${Math.max(8, y)}px`; }
function showTooltip(paper, event, svg, width) { const tip = $("#paper-tooltip"), basis = paper.analysisBasis || "metadata"; tip.innerHTML = `<b>${esc(paper.title)} / ${esc(paper.titleZh)}</b><p><strong>全文状态：</strong>${esc(accessStatusLabel(paper.accessStatus))}</p><p><strong>分析依据：</strong>${esc(analysisBasisLabel(basis))} · 置信度 ${Math.round((paper.analysisConfidence || 0) * 100)}%</p><p><strong>关系判断：</strong>${basis === ANALYSIS_BASIS.FULLTEXT ? "基于全文" : `基于${analysisBasisLabel(basis)}，待全文确认`}</p><p><strong>研究问题：</strong>${esc(paper.problem || "证据不足，尚未形成可靠描述。")}</p><p><strong>主要贡献：</strong>${esc(paper.contribution || "证据不足，尚未形成可靠描述。")}</p>`; tip.style.display = "block"; positionTooltip(event, svg, width); }
function hideTooltip() { $("#paper-tooltip").style.display = "none"; }
function resetTreeHover(svg = $("#tree-canvas svg")) { const paperIds = relationshipPinnedPaperIds.size ? [...relationshipPinnedPaperIds] : relationshipHoverPaperId ? [relationshipHoverPaperId] : []; hideTooltip(); if (paperIds.length && activeTree()) highlightPaperTraces(activeTree(), paperIds, svg); else clearPaperTrace(svg); }
function renderReader(id) { const tree = activeTree(), paper = tree.papers.find(p => p.id === id); if (!paper) return; const branch = tree.branches.find(b => b.id === paper.branchId); const relations = tree.relations.filter(r => r.sourceId === id || r.targetId === id).map(r => { const otherId = r.sourceId === id ? r.targetId : r.sourceId, other = tree.papers.find(p => p.id === otherId); return `${relationTypeLabel(r.type)}：${other?.titleZh || other?.title || otherId}（${r.explanation}；${analysisBasisLabel(r.analysisBasis)}判断）`; }); $("#paper-reader").innerHTML = `<h2>${esc(paper.title)} / ${esc(paper.titleZh)}</h2><p><strong>${esc(paper.venue)}</strong> · ${esc(paper.authors)} · ${paper.year} · ${esc(branch?.name || "待确认")}</p><p class="evidence-line"><strong>${esc(accessStatusLabel(paper.accessStatus))}</strong> · ${esc(analysisBasisLabel(paper.analysisBasis))}分析 · 置信度 ${Math.round((paper.analysisConfidence || 0) * 100)}%</p><p><strong>研究问题：</strong>${esc(paper.problem || "当前证据不足，尚未生成可靠描述。")}</p><p><strong>核心方法：</strong>${esc(paper.method || "当前证据不足，尚未生成可靠描述。")}</p><p><strong>主要贡献：</strong>${esc(paper.contribution || "当前证据不足，尚未生成可靠描述。")}</p>${relations.length ? `<p><strong>论文关系：</strong>${relations.map(esc).join("；")}</p>` : ""}<div class="reader-actions"><button data-edit-paper="${paper.id}">编辑节点</button><button data-read-paper="${paper.id}">阅读 / 补充全文</button>${paper.accessUrl || paper.url ? `<a href="${esc(paper.accessUrl || paper.url)}" target="_blank" rel="noreferrer"><button>原始来源</button></a>` : ""}</div>`; }
function renderBranchReader(id) {
  const tree = activeTree(), branch = tree.branches.find(item => item.id === id); if (!branch) return;
  const papers = tree.papers.filter(paper => paper.branchId === id).sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));
  $("#paper-reader").innerHTML = `<h2 style="color:${branch.color}">${esc(branch.name)}</h2><p><strong>研究问题：</strong>${esc(branch.question)}</p><p>共 ${papers.length} 篇论文。选择一篇即可进入本地论文阅读页；缺失或批注后的 PDF 可在阅读页直接替换。</p><div class="branch-paper-list">${papers.map(paper => `<button data-read-paper="${paper.id}"><span>${paper.year}</span><strong>${esc(paper.titleZh || paper.title)}</strong><small>${esc(paper.title)}</small></button>`).join("") || "<p>该分支暂时没有论文。</p>"}</div>`;
  $("#paper-reader").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function queueForTree() { const tree = activeTree(); tree.queue ||= []; return tree.queue; }
function statusLabel(status) { return ({ queued: "等待处理", resolving: "正在获取来源", uploading: "正在上传", extracting: "正在提取", analyzing: "正在判断研究关系", completed: "已完成", failed: "等待处理错误", cancelled: "已取消", interrupted: "已中断" })[status] || status; }
function renderQueue() { const queue = queueForTree(), done = queue.filter(x => ["completed", "cancelled"].includes(x.status)).length; $("#queue-count").textContent = `${queue.length} 个任务`; $("#total-progress").style.width = `${queue.length ? Math.round(queue.reduce((n, x) => n + (x.progress || 0), 0) / queue.length) : 0}%`; $("#queue-list").innerHTML = queue.map(item => `<article class="queue-item"><header><strong>${esc(item.name)}</strong><span>${statusLabel(item.status)}</span></header><p>${esc(item.error || item.sourceUrl || "本地 PDF")}</p><div class="task-progress"><i style="width:${item.progress || 0}%"></i></div><div class="queue-actions">${["queued", "failed", "interrupted"].includes(item.status) ? `<button data-remove-task="${item.id}">移除</button>` : ""}${["resolving", "uploading", "extracting", "analyzing"].includes(item.status) ? `<button data-cancel-task="${item.id}">取消</button>` : ""}${["failed", "interrupted", "cancelled"].includes(item.status) ? `<button data-retry-task="${item.id}">重试</button>` : ""}</div></article>`).join("") || `<p>尚未添加论文。</p>`; }

function renderPending() { const tree = activeTree(); $("#pending-list").innerHTML = tree.pending.map(item => `<article class="list-row"><header><strong>${esc(item.paper.title)}</strong><span>${Math.round(item.placement.confidence * 100)}%</span></header><p>${esc(item.placement.reason)}</p><div class="list-actions"><button data-accept-pending="${item.id}">写入树</button><button data-remove-pending="${item.id}">移除</button></div></article>`).join("") || `<p>没有等待确认的论文。</p>`; }
function renderBranches() { const tree = activeTree(); $("#branch-list").innerHTML = tree.branches.map(branch => `<article class="list-row"><header><strong style="color:${branch.color}">${esc(branch.name)}</strong><span class="list-actions"><button data-view-branch="${branch.id}">阅读</button><button data-edit-branch="${branch.id}">编辑</button></span></header><p>${esc(branch.question)}</p></article>`).join("") || `<p>尚未建立分支。</p>`; }

function keyValue() { return sessionStorage.getItem("deepseek-key") || localStorage.getItem("deepseek-key") || ""; }
function hydrateSettings() { const s = workspace?.settings || defaults; $("#api-key").value = keyValue(); $("#remember-key").checked = Boolean(localStorage.getItem("deepseek-key")); $("#model-name").value = s.model; $("#analysis-depth").value = s.depth; $("#concurrency").value = s.concurrency; $("#retries").value = s.retries; $("#save-pdf").checked = s.savePdf; $("#auto-low-confidence").checked = s.autoLowConfidence; }
async function api(endpoint, body, signal) { const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-deepseek-key": keyValue() }, body: JSON.stringify(body), signal }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || "请求失败。"); return data; }
async function repairTreePdfs(tree) {
  if (!tree || pdfRepairing.has(tree.id)) return;
  const retryBefore = Date.now() - 24 * 60 * 60 * 1000;
  const papers = tree.papers.filter(paper => !paper.localPdf && !["metadata_only", "unavailable"].includes(paper.accessStatus) && (!paper.accessCheckedAt || new Date(paper.accessCheckedAt).getTime() < retryBefore));
  if (!papers.length) return;
  pdfRepairing.add(tree.id); toast(`正在为“${tree.name}”补齐 ${papers.length} 篇开放 PDF…`);
  try {
    const result = await api("/api/papers/cache-batch", { papers: papers.map(({ id, title, abstract, accessUrl, url, pdfUrl, accessStatus }) => ({ id, title, abstract, accessUrl, url, pdfUrl, accessStatus })) });
    const byId = new Map(result.papers.map(item => [item.id, item]));
    for (const paper of papers) { const cached = byId.get(paper.id); Object.assign(paper, normalizePaperAccess({ ...paper, ...cached })); }
    await save(); if (activeTreeId === tree.id) renderTreeView();
    toast(result.downloaded ? `已补齐 ${result.downloaded} 篇本地 PDF，${result.missing} 篇没有开放版本。` : "这些论文暂未发现可公开下载的 PDF，可在阅读页手动替换。");
  } catch (error) { toast(`自动获取 PDF 失败：${error.message}`); }
  finally { pdfRepairing.delete(tree.id); }
}
async function streamApi(endpoint, body, signal, onProgress) {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-deepseek-key": keyValue() }, body: JSON.stringify(body), signal });
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "请求失败。"); }
  if (!response.body) throw new Error("浏览器无法读取生成进度，请更新浏览器后重试。");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", result = null, remoteError = null;
  const consume = block => {
    let eventName = "message", payload = "";
    for (const line of block.split(/\r?\n/)) { if (line.startsWith("event:")) eventName = line.slice(6).trim(); if (line.startsWith("data:")) payload += line.slice(5).trim(); }
    if (!payload) return;
    const data = JSON.parse(payload);
    if (eventName === "progress") onProgress?.(data);
    else if (eventName === "result") result = data;
    else if (eventName === "error") remoteError = new Error(data.error || "研究树生成失败。");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || "";
    blocks.forEach(consume); if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  if (remoteError) throw remoteError;
  if (!result) throw new Error("生成连接已结束，但没有收到研究树结果。");
  return result;
}
function fileToBase64(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }

async function addFiles(files) {
  const tree = activeTree(), queue = queueForTree();
  for (const file of files) {
    if (!file.name.toLowerCase().endsWith(".pdf")) { toast(`${file.name} 不是 PDF。`); continue; }
    const duplicate = queue.some(x => x.name === file.name && x.size === file.size);
    if (duplicate) { toast(`${file.name} 已在队列中。`); continue; }
    queue.push({ id: uid("task"), name: file.name, size: file.size, file, status: "queued", progress: 0, attempts: 0, createdAt: new Date().toISOString() });
  }
  await save(); renderQueue(); pumpQueue();
}
async function addUrl() { const url = $("#paper-url").value.trim(); if (!url) return; const queue = queueForTree(); if (queue.some(x => x.sourceUrl === url)) return toast("该链接已在队列中。"); queue.push({ id: uid("task"), name: url, sourceUrl: url, status: "queued", progress: 0, attempts: 0, createdAt: new Date().toISOString() }); $("#paper-url").value = ""; await save(); renderQueue(); pumpQueue(); }
function treeContext(tree) { return { name: tree.name, description: tree.description, branches: tree.branches, papers: tree.papers.map(p => ({ id: p.id, title: p.title, year: p.year, branchId: p.branchId, problem: p.problem })), relations: tree.relations }; }

async function runTask(task) {
  const tree = activeTree(), controller = new AbortController(); running.set(task.id, controller); task.error = ""; task.attempts = (task.attempts || 0) + 1;
  try {
    let file, sourceText, sourceUrl = task.sourceUrl || "";
    if (task.file) { task.status = "uploading"; task.progress = 20; renderQueue(); file = { name: task.name, data: await fileToBase64(task.file) }; }
    else if (task.sourceUrl) { task.status = "resolving"; task.progress = 12; renderQueue(); const source = await api("/api/source", { url: task.sourceUrl }, controller.signal); sourceUrl = source.sourceUrl; if (source.kind === "pdf") file = { name: source.name, data: source.data }; else sourceText = source.text; }
    else throw new Error("刷新后本地 PDF 已不可用，请移除并重新选择文件。");
    task.status = "extracting"; task.progress = 42; renderQueue();
    task.status = "analyzing"; task.progress = 62; renderQueue();
    const analysisBasis = file ? "fulltext" : sourceText ? "abstract" : "metadata";
    const result = await api("/api/deepseek/analyze", { model: workspace.settings.model, depth: workspace.settings.depth, file, sourceText, sourceUrl, analysisBasis, treeContext: treeContext(tree) }, controller.signal);
    task.progress = 90; renderQueue();
    const analysis = result.data; analysis.id = uid("pending");
    if (analysis.placement.confidence < .58 && !workspace.settings.autoLowConfidence) tree.pending.push(analysis); else applyAnalysis(tree, analysis);
    task.status = "completed"; task.progress = 100; task.resultTitle = analysis.paper.title; delete task.file; await save(); renderTreeView();
  } catch (error) {
    if (error.name === "AbortError") { task.status = "cancelled"; task.error = "用户已取消。"; }
    else if (task.attempts <= workspace.settings.retries) { task.status = "queued"; task.error = `自动重试 ${task.attempts}/${workspace.settings.retries}`; }
    else { task.status = "failed"; task.error = error.message; }
    task.progress = 0; await save(); renderQueue();
  } finally { running.delete(task.id); pumpQueue(); }
}
function pumpQueue() { if (!activeTreeId || !keyValue()) return; const queue = queueForTree(), slots = workspace.settings.concurrency - running.size; queue.filter(x => x.status === "queued").slice(0, Math.max(0, slots)).forEach(runTask); }
function applyAnalysis(tree, analysis) {
  recordBefore(tree, "论文自动写入", "AI", `新增或更新 ${analysis.paper.title}`);
  let branch = tree.branches.find(b => b.id === analysis.placement.branchId);
  if (!branch && analysis.placement.createNewBranch) { branch = { id: analysis.placement.branchId || uid("branch"), name: analysis.placement.branchName, question: analysis.placement.reason, color: colors[tree.branches.length % colors.length] }; tree.branches.push(branch); }
  if (!branch) branch = tree.branches[0] || { id: "unclassified", name: "待分类", question: "尚未形成稳定研究分支", color: "#7b8981" };
  if (!tree.branches.some(b => b.id === branch.id)) tree.branches.push(branch);
  const duplicate = tree.papers.find(p => p.title.toLowerCase() === analysis.paper.title.toLowerCase() || (p.url && analysis.paper.url && p.url === analysis.paper.url));
  const incoming = normalizePaperAccess({ ...analysis.paper, branchId: branch.id, confidence: analysis.placement.confidence, verified: Boolean(analysis.paper.url), source: "ai" });
  const paper = duplicate ? mergePaperAnalysis(duplicate, incoming) : { ...incoming, id: uid("paper") };
  if (duplicate) Object.assign(duplicate, paper); else tree.papers.push(paper);
  if (paper.analysisBasis === ANALYSIS_BASIS.FULLTEXT) tree.relations = tree.relations.filter(relation => relation.sourceId !== paper.id && relation.targetId !== paper.id);
  for (const rel of analysis.relations) if (tree.papers.some(p => p.id === rel.targetPaperId)) { const sourceId = rel.direction === "from_target_to_new" ? rel.targetPaperId : paper.id, targetId = rel.direction === "from_target_to_new" ? paper.id : rel.targetPaperId; if (!tree.relations.some(r => r.sourceId === sourceId && r.targetId === targetId && r.type === rel.type)) tree.relations.push(normalizeRelationEvidence({ id: uid("rel"), sourceId, targetId, type: rel.type, explanation: rel.explanation, confidence: rel.confidence, analysisBasis: rel.analysisBasis || paper.analysisBasis }, tree.papers)); }
  tree.updatedAt = new Date().toISOString();
}

function setResearchMessage(message = "") { $("#research-message").textContent = message; $("#research-message").hidden = !message; }
function paintResearchProgress() {
  const elapsed = researchProgressStartedAt ? Math.max(0, Math.floor((Date.now() - researchProgressStartedAt) / 1000)) : 0;
  $("#research-progress-bar").style.width = `${researchProgressState.percent}%`;
  $("#research-progress-percent").textContent = `${researchProgressState.percent}%`;
  $("#research-progress-stage").textContent = researchProgressState.stage;
  $("#research-progress-detail").textContent = `${researchProgressState.detail || "正在等待服务返回…"} · 已等待 ${elapsed} 秒`;
}
function updateResearchProgress(next = {}) {
  researchProgressState = { ...researchProgressState, ...next, percent: Math.max(researchProgressState.percent, Math.min(100, Math.round(Number(next.percent ?? researchProgressState.percent)))) };
  paintResearchProgress();
}
function startResearchProgress() {
  clearInterval(researchProgressTimer); researchProgressStartedAt = Date.now(); researchProgressState = { percent: 2, stage: "正在连接服务", detail: "请求已发送，等待检索任务启动" };
  $("#research-progress").hidden = false; paintResearchProgress(); researchProgressTimer = setInterval(paintResearchProgress, 1000);
}
function stopResearchProgress(hide = true) { clearInterval(researchProgressTimer); researchProgressTimer = null; if (hide) $("#research-progress").hidden = true; }
function openTreeDialog(tree = null) { editingTreeId = tree?.id || null; createMode = "manual"; searchMode = "lineage"; stopResearchProgress(); researchProgressState = { percent: 0, stage: "准备开始", detail: "正在建立连接…" }; $("#tree-dialog-title").textContent = tree ? "编辑研究方向" : "新建研究方向"; $("#form-tree-name").value = tree?.name || ""; $("#form-tree-description").value = tree?.description || ""; $("#form-focus").value = ""; $("#form-years").value = ""; $("#ai-fields").hidden = true; setResearchMessage(); $("#create-mode").hidden = Boolean(tree); $$("#create-mode button").forEach(button => button.classList.toggle("active", button.dataset.mode === "manual")); $$("#search-mode button").forEach(button => button.classList.toggle("active", button.dataset.searchMode === searchMode)); $("#delete-tree-btn").hidden = !tree || tree.locked; $("#save-tree-btn").disabled = false; $("#save-tree-btn").textContent = tree ? "保存修改" : "创建"; $("#tree-dialog").showModal(); }
async function submitTreeForm(event) {
  event.preventDefault(); setResearchMessage(); const name = $("#form-tree-name").value.trim(), description = $("#form-tree-description").value.trim(); if (!name) return;
  if (editingTreeId) { const tree = workspace.trees.find(t => t.id === editingTreeId); recordBefore(tree, "修改研究树信息"); tree.name = name; tree.description = description; tree.updatedAt = new Date().toISOString(); await save(); $("#tree-dialog").close(); renderHome(); if (activeTreeId === tree.id) renderTreeView(); return; }
  if (createMode === "manual") { const tree = { id: uid("tree"), name, description, color: colors[workspace.trees.length % colors.length], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), branches: [], papers: [], relations: [], pending: [], queue: [], history: [], future: [] }; workspace.trees.push(tree); await save(); $("#tree-dialog").close(); renderHome(); openTree(tree.id); return; }
  if (!keyValue()) return setResearchMessage("请先在右上角“设置”中填写并测试 DeepSeek API Key，再使用 AI 检索。");
  researchController = new AbortController(); startResearchProgress(); $("#save-tree-btn").disabled = true; $("#save-tree-btn").textContent = "生成中…";
  try {
    const result = await streamApi("/api/deepseek/research/stream", { model: workspace.settings.model, depth: workspace.settings.depth, topic: name, focus: $("#form-focus").value.trim(), years: $("#form-years").value.trim(), count: Number($("#form-count").value), topVenues: $("#form-top-venues").checked, searchMode }, researchController.signal, updateResearchProgress);
    const data = result.data, now = new Date().toISOString(), tree = migrateTree({ id: uid("tree"), name, description: description || data.description, formatVersion: data.formatVersion || "attention-tree-v1", searchMode, color: colors[workspace.trees.length % colors.length], createdAt: now, updatedAt: now, branches: data.branches || [], papers: (data.papers || []).map(p => ({ ...p, source: "ai-search", verified: Boolean(p.accessUrl || p.url) })), relations: (data.relations || []).map(r => ({ ...r, id: uid("rel") })), pending: (data.unverified || []).map(title => ({ id: uid("pending"), paper: { title }, placement: { reason: "检索来源未通过验证", confidence: 0 } })), queue: [], history: [], future: [] });
    workspace.trees.push(tree); await save(); updateResearchProgress({ percent: 100, stage: "研究树生成完成", detail: `${tree.papers.length} 篇 · 全文 ${result.accessCounts?.fulltext || 0} · 摘要 ${result.accessCounts?.abstract || 0} · 机构权限 ${result.accessCounts?.institutional || 0}` }); await new Promise(resolve => setTimeout(resolve, 450)); $("#tree-dialog").close(); renderHome(); openTree(tree.id);
  } catch (error) { if (error.name !== "AbortError") setResearchMessage(error.message); }
  finally { researchController = null; stopResearchProgress(); $("#save-tree-btn").disabled = false; $("#save-tree-btn").textContent = "创建"; }
}

function renderPaperRelations(id) { const tree = activeTree(), relations = tree.relations.filter(r => r.sourceId === id || r.targetId === id); $("#paper-relations").innerHTML = relations.map(rel => { const otherId = rel.sourceId === id ? rel.targetId : rel.sourceId, other = tree.papers.find(p => p.id === otherId); return `<article class="relation-row"><div><strong>${esc(relationTypeLabel(rel.type))} · ${esc(other?.titleZh || other?.title || otherId)}</strong><p>${esc(rel.explanation)}</p></div><button type="button" data-remove-relation="${rel.id}">移除</button></article>`; }).join("") || `<p>当前论文还没有关系线。</p>`; }
function openPaperEditor(id) { const tree = activeTree(), p = tree.papers.find(x => x.id === id); if (!p) return; $("#paper-id").value = p.id; $("#paper-title").value = p.title; $("#paper-title-zh").value = p.titleZh; $("#paper-authors").value = p.authors; $("#paper-year").value = p.year; $("#paper-venue").value = p.venue; $("#paper-link").value = p.url; $("#paper-problem").value = p.problem; $("#paper-method").value = p.method; $("#paper-contribution").value = p.contribution; $("#paper-branch").innerHTML = tree.branches.map(b => `<option value="${b.id}" ${b.id === p.branchId ? "selected" : ""}>${esc(b.name)}</option>`).join(""); $("#relation-target").innerHTML = tree.papers.filter(x => x.id !== id).map(x => `<option value="${x.id}">${esc(x.title)}</option>`).join(""); $("#relation-explanation").value = ""; renderPaperRelations(id); $("#paper-dialog").showModal(); }
async function addRelation() { const tree = activeTree(), sourceId = $("#paper-id").value, targetId = $("#relation-target").value, explanation = $("#relation-explanation").value.trim(); if (!sourceId || !targetId || !explanation) return toast("请选择目标论文并填写关系说明。"); recordBefore(tree, "新增论文关系", "用户", explanation); tree.relations.push(normalizeRelationEvidence({ id: uid("rel"), sourceId, targetId, type: $("#relation-type").value, explanation }, tree.papers)); await save(); renderPaperRelations(sourceId); renderTreeSvg(tree); renderRelationshipPanel(); renderRelationshipOverview(tree); }
async function removeRelation(id) { const tree = activeTree(), rel = tree.relations.find(r => r.id === id); if (!rel || !confirm("确定移除这条论文关系吗？")) return; recordBefore(tree, "删除论文关系", "用户", rel.explanation); tree.relations = tree.relations.filter(r => r.id !== id); editingRelationshipId = null; await save(); if ($("#paper-dialog").open) renderPaperRelations($("#paper-id").value); renderTreeView(); toast("关系已移除，可使用撤销恢复。"); }
async function savePaper(event) { event.preventDefault(); const tree = activeTree(), p = tree.papers.find(x => x.id === $("#paper-id").value); if (!p) return; recordBefore(tree, "手动修改论文", "用户", p.title); Object.assign(p, { title: $("#paper-title").value.trim(), titleZh: $("#paper-title-zh").value.trim(), authors: $("#paper-authors").value.trim(), year: Number($("#paper-year").value), venue: $("#paper-venue").value.trim(), url: $("#paper-link").value.trim(), problem: $("#paper-problem").value.trim(), method: $("#paper-method").value.trim(), contribution: $("#paper-contribution").value.trim(), branchId: $("#paper-branch").value }); tree.updatedAt = new Date().toISOString(); await save(); $("#paper-dialog").close(); renderTreeView(); }
async function deletePaper() { const tree = activeTree(), id = $("#paper-id").value, p = tree.papers.find(x => x.id === id); if (!p || !confirm(`确定删除“${p.title}”吗？`)) return; recordBefore(tree, "删除论文", "用户", p.title); tree.papers = tree.papers.filter(x => x.id !== id); tree.relations = tree.relations.filter(r => r.sourceId !== id && r.targetId !== id); selectedPaperId = null; await save(); $("#paper-dialog").close(); renderTreeView(); }

function openBranchEditor(id = "") { const tree = activeTree(), branch = tree.branches.find(b => b.id === id); $("#branch-id").value = branch?.id || ""; $("#branch-name").value = branch?.name || ""; $("#branch-question").value = branch?.question || ""; $("#branch-color").value = branch?.color || colors[tree.branches.length % colors.length]; $("#delete-branch-btn").hidden = !branch; $("#branch-dialog").showModal(); }
async function saveBranch(event) { event.preventDefault(); const tree = activeTree(), id = $("#branch-id").value; recordBefore(tree, id ? "修改分支" : "新增分支"); const data = { name: $("#branch-name").value.trim(), question: $("#branch-question").value.trim(), color: $("#branch-color").value }; if (id) Object.assign(tree.branches.find(b => b.id === id), data); else tree.branches.push({ id: uid("branch"), ...data }); await save(); $("#branch-dialog").close(); renderTreeView(); }
async function deleteBranch() { const tree = activeTree(), id = $("#branch-id").value, branch = tree.branches.find(b => b.id === id); if (!branch) return; const count = tree.papers.filter(p => p.branchId === id).length; if (count) return toast(`该分支还有 ${count} 篇论文，请先移动或删除它们。`); if (!confirm(`确定删除分支“${branch.name}”吗？`)) return; recordBefore(tree, "删除分支"); tree.branches = tree.branches.filter(b => b.id !== id); await save(); $("#branch-dialog").close(); renderTreeView(); }

function renderHistory() { const tree = activeTree(); $("#history-list").innerHTML = [...tree.history].reverse().map(entry => `<article class="history-row"><header><strong>${esc(entry.action)}</strong><button data-restore-version="${entry.id}">恢复</button></header><p>${formatDate(entry.time)} · ${esc(entry.source)} · ${esc(entry.summary)}</p></article>`).join("") || `<p>还没有版本记录。</p>`; $("#history-dialog").showModal(); }
async function restoreVersion(id) { const tree = activeTree(), entry = tree.history.find(x => x.id === id); if (!entry || !confirm("确定恢复到这个版本吗？当前状态会先保存，因此仍可撤销。")) return; recordBefore(tree, "恢复历史版本", "用户", entry.action); restoreContent(tree, entry.snapshot); await save(); $("#history-dialog").close(); renderTreeView(); }

function exportJson(value, filename) { const blob = new Blob([JSON.stringify(value, (key, val) => key === "file" ? undefined : val, 2)], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function prepareExport(value) { const copy = clone(value), includeLocalPdf = Boolean($("#export-local-pdf-map")?.checked); const trees = copy.trees || (copy.tree ? [copy.tree] : []); for (const tree of trees) { tree.queue = []; if (!includeLocalPdf) for (const paper of tree.papers || []) { delete paper.localPdf; if (paper.accessStatus === "local_pdf") paper.accessStatus = paper.pdfUrl ? "open_pdf" : paper.abstract ? "abstract_only" : paper.accessUrl ? "metadata_only" : "unavailable"; } } delete copy.apiKey; delete copy.credentials; return copy; }
function exportWorkspace() { exportJson(prepareExport(workspace), `research-tree-workspace-${new Date().toISOString().slice(0, 10)}.json`); }
function exportCurrentTree() { const tree = activeTree(); if (!tree) return exportWorkspace(); exportJson(prepareExport({ version: workspace.version, tree: clone(tree) }), `${tree.name}-research-tree.json`); }
function exportCurrentHtml() { const tree = activeTree(); if (!tree) return; const svg = $("#tree-canvas").innerHTML, papers = tree.papers.map(p => `<article><h2>${esc(p.title)} / ${esc(p.titleZh)}</h2><p>${esc(p.venue)} · ${esc(p.authors)} · ${p.year}</p><p><b>研究问题：</b>${esc(p.problem)}</p><p><b>核心方法：</b>${esc(p.method)}</p><p><b>主要贡献：</b>${esc(p.contribution)}</p>${p.url ? `<a href="${esc(p.url)}">打开论文</a>` : ""}</article>`).join(""); const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(tree.name)}</title><style>body{margin:0;background:#f4f7f4;color:#17211d;font:14px/1.55 Arial,"Microsoft YaHei",sans-serif}main{width:min(1400px,calc(100% - 28px));margin:auto;padding:28px 0}h1{font-size:28px}p{color:#5f6e66}.tree{overflow:auto;background:#fff;border:1px solid #d2ddd5}.tree svg{display:block;width:100%;height:auto;min-width:1000px}.papers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:18px}.papers article{background:#fff;border-left:4px solid #007c70;padding:12px}.papers h2{font-size:15px;margin:0}.papers p{margin:5px 0}@media(max-width:700px){.papers{grid-template-columns:1fr}}</style><main><h1>${esc(tree.name)}</h1><p>${esc(tree.description)}</p><section class="tree">${svg}</section><section class="papers">${papers}</section></main></html>`; const blob = new Blob([html], { type: "text/html;charset=utf-8" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${tree.name}-read-only.html`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
async function importData(mode) { if (!importCandidate) return; if (mode === "replace" && !confirm("覆盖会替换当前全部研究树，确定继续吗？")) return; if (mode === "replace") workspace = migrateWorkspace(importCandidate); else { const incoming = importCandidate.trees || (importCandidate.tree ? [importCandidate.tree] : []); for (const source of incoming) { const tree = migrateTree(source), existing = workspace.trees.find(t => t.id === tree.id); if (existing) tree.id = uid("tree"); workspace.trees.push(tree); } workspace = migrateWorkspace(workspace); } cleanQueueOnLoad(); await save(); $("#import-dialog").close(); renderHome(); toast("工作区导入完成，旧版访问字段已自动迁移。"); }

function hydrateSettingsDialog() { hydrateSettings(); $("#connection-result").textContent = ""; $("#settings-dialog").showModal(); }
async function saveSettings(event) { event.preventDefault(); const key = $("#api-key").value.trim(); if ($("#remember-key").checked) { localStorage.setItem("deepseek-key", key); sessionStorage.removeItem("deepseek-key"); } else { sessionStorage.setItem("deepseek-key", key); localStorage.removeItem("deepseek-key"); } workspace.settings = { model: $("#model-name").value.trim(), depth: $("#analysis-depth").value, concurrency: Number($("#concurrency").value), retries: Number($("#retries").value), savePdf: $("#save-pdf").checked, autoLowConfidence: $("#auto-low-confidence").checked }; await save(); $("#settings-dialog").close(); toast("设置已保存。"); pumpQueue(); }

document.addEventListener("click", async event => {
  const close = event.target.closest("[data-close]"); if (close) { const dialog = $(`#${close.dataset.close}`); if (dialog.id === "tree-dialog") { if (researchController) researchController.abort(); stopResearchProgress(); } dialog.close(); return; }
  const open = event.target.closest("[data-open-tree]"); if (open) return openTree(open.dataset.openTree);
  const editTree = event.target.closest("[data-edit-tree]"); if (editTree) return openTreeDialog(workspace.trees.find(t => t.id === editTree.dataset.editTree));
  const copyTree = event.target.closest("[data-copy-tree]"); if (copyTree) { const source = workspace.trees.find(t => t.id === copyTree.dataset.copyTree), copy = clone(source); copy.id = uid("tree"); copy.name = `${source.name}（副本）`; copy.locked = false; copy.createdAt = copy.updatedAt = new Date().toISOString(); copy.history = []; copy.future = []; copy.queue = []; workspace.trees.push(copy); await save(); renderHome(); return toast("已创建可编辑副本。"); }
  const editPaper = event.target.closest("[data-edit-paper]"); if (editPaper) return openPaperEditor(editPaper.dataset.editPaper);
  const readPaper = event.target.closest("[data-read-paper]"); if (readPaper) return openPaperReader(activeTree().papers.find(p => p.id === readPaper.dataset.readPaper));
  const viewBranch = event.target.closest("[data-view-branch]"); if (viewBranch) { const branch = activeTree().branches.find(item => item.id === viewBranch.dataset.viewBranch); if (branch) return openBranchReader(branch); }
  const editBranch = event.target.closest("[data-edit-branch]"); if (editBranch) return openBranchEditor(editBranch.dataset.editBranch);
  const cancelTask = event.target.closest("[data-cancel-task]"); if (cancelTask) return running.get(cancelTask.dataset.cancelTask)?.abort();
  const removeTask = event.target.closest("[data-remove-task]"); if (removeTask) { const tree = activeTree(); tree.queue = tree.queue.filter(t => t.id !== removeTask.dataset.removeTask); await save(); return renderQueue(); }
  const retryTask = event.target.closest("[data-retry-task]"); if (retryTask) { const task = queueForTree().find(t => t.id === retryTask.dataset.retryTask); task.status = "queued"; task.error = ""; task.attempts = 0; await save(); renderQueue(); return pumpQueue(); }
  const accept = event.target.closest("[data-accept-pending]"); if (accept) { const tree = activeTree(), item = tree.pending.find(x => x.id === accept.dataset.acceptPending); applyAnalysis(tree, item); tree.pending = tree.pending.filter(x => x.id !== item.id); await save(); return renderTreeView(); }
  const removePending = event.target.closest("[data-remove-pending]"); if (removePending) { const tree = activeTree(); tree.pending = tree.pending.filter(x => x.id !== removePending.dataset.removePending); await save(); return renderPending(); }
  const restore = event.target.closest("[data-restore-version]"); if (restore) return restoreVersion(restore.dataset.restoreVersion);
  const locate = event.target.closest("[data-locate-paper]"); if (locate) return locatePaper(locate.dataset.locatePaper);
  const unpinPaper = event.target.closest("[data-unpin-paper]"); if (unpinPaper) {
    const paperId = unpinPaper.dataset.unpinPaper, wasSelected = selectedPaperId === paperId;
    pinRelationshipPaper(paperId);
    if (wasSelected) {
      const fallbackId = [...relationshipPinnedPaperIds].at(-1) || null;
      selectedPaperId = fallbackId;
      if (fallbackId) renderReader(fallbackId); else $("#paper-reader").innerHTML = `<h2>选择一个论文节点</h2><p>尚未选择论文。</p>`;
    }
    return;
  }
  const startRelationshipEdit = event.target.closest("[data-start-relationship-edit]"); if (startRelationshipEdit) { editingRelationshipId = startRelationshipEdit.dataset.startRelationshipEdit; return renderRelationshipPanel(); }
  const cancelRelationshipEdit = event.target.closest("[data-cancel-relationship-edit]"); if (cancelRelationshipEdit) { editingRelationshipId = null; return renderRelationshipPanel(); }
  const saveRelationshipEdit = event.target.closest("[data-save-relationship-edit]"); if (saveRelationshipEdit) return saveRelationshipExplanation(saveRelationshipEdit.dataset.saveRelationshipEdit, saveRelationshipEdit.dataset.relationshipInput);
  const reanalyze = event.target.closest("[data-reanalyze-relationship]"); if (reanalyze) return reanalyzeRelationship(reanalyze.dataset.reanalyzeRelationship);
  const cancelRelationshipAi = event.target.closest("[data-cancel-relationship-ai]"); if (cancelRelationshipAi) return relationshipAiController?.abort();
  const removeRel = event.target.closest("[data-remove-relation]"); if (removeRel) return removeRelation(removeRel.dataset.removeRelation);
});

$("#home-btn").onclick = goHome; $("#back-btn").onclick = goHome; $("#new-tree-btn").onclick = () => openTreeDialog(); $("#edit-tree-btn").onclick = () => openTreeDialog(activeTree());
$("#undo-btn").onclick = undo; $("#redo-btn").onclick = redo; $("#history-btn").onclick = renderHistory;
$("#pin-relationship-btn").onclick = () => { const paperId = relationshipHoverPaperId || [...relationshipPinnedPaperIds].at(-1); if (paperId) pinRelationshipPaper(paperId); };
$("#clear-relationship-btn").onclick = () => clearRelationshipSelection(true);
$("#toggle-relationship-btn").onclick = () => { relationshipPanelCollapsed = !relationshipPanelCollapsed; $("#relationship-panel").classList.toggle("mobile-open", !relationshipPanelCollapsed && Boolean(relationshipPinnedPaperIds.size || relationshipHoverPaperId)); renderRelationshipPanel(); };
$("#relationship-panel").addEventListener("pointerenter", cancelRelationshipClear);
$("#relationship-panel").addEventListener("pointerleave", scheduleRelationshipClear);
$("#settings-btn").onclick = hydrateSettingsDialog; $("#settings-form").onsubmit = saveSettings; $("#toggle-key").onclick = () => { $("#api-key").type = $("#api-key").type === "password" ? "text" : "password"; };
$("#delete-key-btn").onclick = () => { localStorage.removeItem("deepseek-key"); sessionStorage.removeItem("deepseek-key"); $("#api-key").value = ""; $("#connection-result").textContent = "本地密钥已删除。"; };
$("#test-key-btn").onclick = async () => { const key = $("#api-key").value.trim(); sessionStorage.setItem("deepseek-key", key); $("#connection-result").textContent = "正在测试…"; try { const result = await api("/api/deepseek/test", { model: $("#model-name").value.trim() }); $("#connection-result").textContent = `连接成功：${result.model}`; } catch (error) { $("#connection-result").textContent = error.message; } };
$("#tree-form").onsubmit = submitTreeForm; $("#create-mode").onclick = event => { const button = event.target.closest("[data-mode]"); if (!button) return; createMode = button.dataset.mode; setResearchMessage(); stopResearchProgress(); $$("#create-mode button").forEach(x => x.classList.toggle("active", x === button)); $("#ai-fields").hidden = createMode !== "ai"; };
$("#search-mode").onclick = event => { const button = event.target.closest("[data-search-mode]"); if (!button) return; searchMode = button.dataset.searchMode; $$("#search-mode button").forEach(item => item.classList.toggle("active", item === button)); };
$("#delete-tree-btn").onclick = async () => { const tree = workspace.trees.find(t => t.id === editingTreeId); if (!tree || tree.locked || !confirm(`确定删除“${tree.name}”吗？`)) return; workspace.trees = workspace.trees.filter(t => t.id !== tree.id); await save(); $("#tree-dialog").close(); if (activeTreeId === tree.id) goHome(); else renderHome(); };
$("#paper-form").onsubmit = savePaper; $("#delete-paper-btn").onclick = deletePaper; $("#add-relation-btn").onclick = addRelation; $("#branch-form").onsubmit = saveBranch; $("#delete-branch-btn").onclick = deleteBranch; $("#add-branch-btn").onclick = () => openBranchEditor();
$("#pdf-input").onchange = event => { addFiles(event.target.files); event.target.value = ""; }; $("#add-url-btn").onclick = addUrl; $("#paper-url").onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); addUrl(); } };
const drop = $("#drop-zone"); drop.ondragover = event => { event.preventDefault(); drop.style.background = "#e7f3ef"; }; drop.ondragleave = () => drop.style.background = ""; drop.ondrop = event => { event.preventDefault(); drop.style.background = ""; addFiles(event.dataTransfer.files); };
$("#cancel-all-btn").onclick = async () => { running.forEach(controller => controller.abort()); for (const task of queueForTree()) if (task.status !== "completed") { task.status = "cancelled"; task.progress = 0; } await save(); renderQueue(); };
$$('[data-side-tab]').forEach(button => button.onclick = () => { $$('[data-side-tab]').forEach(x => x.classList.toggle("active", x === button)); $$(".side-tab").forEach(tab => tab.classList.toggle("active", tab.id === `side-${button.dataset.sideTab}`)); });
$("#export-btn").onclick = () => activeTreeId ? $("#export-dialog").showModal() : exportWorkspace(); $("#export-tree-json").onclick = exportCurrentTree; $("#export-tree-html").onclick = exportCurrentHtml; $("#export-workspace-here").onclick = exportWorkspace; $("#import-btn").onclick = () => { importCandidate = null; $("#workspace-file").value = ""; $("#import-preview").textContent = "尚未选择文件。"; $("#merge-import-btn").disabled = true; $("#replace-import-btn").disabled = true; $("#import-dialog").showModal(); };
$("#workspace-file").onchange = async event => { try { importCandidate = JSON.parse(await event.target.files[0].text()); const trees = importCandidate.trees || (importCandidate.tree ? [importCandidate.tree] : []); $("#import-preview").textContent = `检测到 ${trees.length} 棵研究树、${trees.reduce((n, t) => n + (t.papers?.length || 0), 0)} 篇论文。`; $("#merge-import-btn").disabled = false; $("#replace-import-btn").disabled = !importCandidate.trees; } catch { importCandidate = null; $("#import-preview").textContent = "文件格式无效。"; } };
$("#merge-import-btn").onclick = () => importData("merge"); $("#import-form").onsubmit = event => { event.preventDefault(); importData("replace"); };
window.addEventListener("beforeunload", event => { if (running.size) { event.preventDefault(); event.returnValue = ""; } });
window.addEventListener("blur", () => resetTreeHover());
document.addEventListener("visibilitychange", () => { if (document.hidden) resetTreeHover(); });

await initialize();
const hashTree = new URLSearchParams(location.hash.slice(1)).get("tree"); if (hashTree && workspace.trees.some(t => t.id === hashTree)) openTree(hashTree);
