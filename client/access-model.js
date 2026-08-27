export const ACCESS_STATUS = Object.freeze({
  OPEN_PDF: "open_pdf",
  LOCAL_PDF: "local_pdf",
  ABSTRACT_ONLY: "abstract_only",
  INSTITUTIONAL_REQUIRED: "institutional_required",
  METADATA_ONLY: "metadata_only",
  UNAVAILABLE: "unavailable"
});

export const ANALYSIS_BASIS = Object.freeze({
  FULLTEXT: "fulltext",
  ABSTRACT: "abstract",
  METADATA: "metadata"
});

const STATUS_LABELS = {
  open_pdf: "开放全文",
  local_pdf: "本地全文",
  abstract_only: "仅摘要",
  institutional_required: "需要机构权限",
  metadata_only: "仅元数据",
  unavailable: "待补充"
};

const BASIS_LABELS = { fulltext: "全文", abstract: "摘要", metadata: "元数据" };

function clamp(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
}

export function accessSourceFromUrl(value) {
  const url = String(value || "").toLowerCase();
  if (url.includes("arxiv.org")) return "arXiv";
  if (url.includes("openreview.net")) return "OpenReview";
  if (url.includes("openalex.org")) return "OpenAlex";
  if (/proceedings\.(?:neurips|iclr)\.cc|proceedings\.mlr\.press/.test(url)) return "conference";
  if (url.includes("doi.org")) return "publisher";
  if (/acm\.org|ieee\.org|springer\.com|sciencedirect\.com|wiley\.com|nature\.com/.test(url)) return "publisher";
  return url ? "repository" : "";
}

export function accessStatusLabel(status) { return STATUS_LABELS[status] || "待补充"; }
export function analysisBasisLabel(basis) { return BASIS_LABELS[basis] || "元数据"; }

export function accessMessageFor(status, source = "") {
  const suffix = source ? `（来源：${source}）` : "";
  if (status === ACCESS_STATUS.LOCAL_PDF) return `已有本地 PDF${suffix}`;
  if (status === ACCESS_STATUS.OPEN_PDF) return `已发现可公开获取的 PDF${suffix}`;
  if (status === ACCESS_STATUS.ABSTRACT_ONLY) return "当前只取得可靠摘要，可上传全文升级分析。";
  if (status === ACCESS_STATUS.INSTITUTIONAL_REQUIRED) return "该论文可能需要学校或机构权限，请在出版社或图书馆页面自行登录下载。";
  if (status === ACCESS_STATUS.METADATA_ONLY) return "当前只有标题、作者等可靠元数据，尚未生成全文级结论。";
  return "暂时没有找到可靠全文或摘要，可手动补充论文。";
}

export function normalizePaperAccess(input = {}) {
  const paper = { ...input };
  const accessUrl = paper.accessUrl || paper.url || "";
  const pdfUrl = paper.pdfUrl || "";
  const localPdf = paper.localPdf || "";
  const source = paper.accessSource || (localPdf ? (paper.source === "ai-search" ? "OpenAlex" : "manual") : accessSourceFromUrl(pdfUrl || accessUrl));
  let status = paper.accessStatus;
  if (localPdf) status = ACCESS_STATUS.LOCAL_PDF;
  else if (pdfUrl) status = ACCESS_STATUS.OPEN_PDF;
  else if (!Object.values(ACCESS_STATUS).includes(status)) {
    if (paper.abstract) status = ACCESS_STATUS.ABSTRACT_ONLY;
    else if (accessUrl && (source === "publisher" || /^https?:\/\/doi\.org\//i.test(accessUrl))) status = ACCESS_STATUS.INSTITUTIONAL_REQUIRED;
    else if (accessUrl || paper.title || paper.authors) status = ACCESS_STATUS.METADATA_ONLY;
    else status = ACCESS_STATUS.UNAVAILABLE;
  }

  let basis = paper.analysisBasis;
  if (!Object.values(ANALYSIS_BASIS).includes(basis)) {
    if (paper.analysisSource === "uploaded-pdf" || paper.fulltextAnalyzed === true) basis = ANALYSIS_BASIS.FULLTEXT;
    else if (paper.abstract || paper.problem || paper.method || paper.contribution) basis = ANALYSIS_BASIS.ABSTRACT;
    else basis = ANALYSIS_BASIS.METADATA;
  }
  const fallbackConfidence = basis === ANALYSIS_BASIS.FULLTEXT ? 0.88 : basis === ANALYSIS_BASIS.ABSTRACT ? 0.68 : 0.32;
  const confidenceCap = basis === ANALYSIS_BASIS.FULLTEXT ? 1 : basis === ANALYSIS_BASIS.ABSTRACT ? 0.78 : 0.45;

  return {
    ...paper,
    accessStatus: status,
    accessUrl,
    pdfUrl,
    localPdf,
    accessSource: source,
    analysisBasis: basis,
    analysisConfidence: Math.min(confidenceCap, clamp(paper.analysisConfidence ?? paper.confidence, fallbackConfidence)),
    accessCheckedAt: paper.accessCheckedAt || paper.pdfCheckedAt || "",
    accessMessage: paper.accessMessage || accessMessageFor(status, source)
  };
}

export function normalizeRelationEvidence(relation = {}, papers = []) {
  const byId = new Map(papers.map(paper => [paper.id, paper]));
  const source = byId.get(relation.sourceId);
  const target = byId.get(relation.targetId);
  const rank = { metadata: 0, abstract: 1, fulltext: 2 };
  const bases = [source?.analysisBasis, target?.analysisBasis].filter(Boolean);
  const basis = relation.analysisBasis || (bases.length ? bases.sort((a, b) => (rank[a] ?? 0) - (rank[b] ?? 0))[0] : ANALYSIS_BASIS.METADATA);
  const cap = basis === ANALYSIS_BASIS.FULLTEXT ? 1 : basis === ANALYSIS_BASIS.ABSTRACT ? 0.78 : 0.45;
  return { ...relation, analysisBasis: basis, confidence: Math.min(cap, clamp(relation.confidence, cap - 0.08)) };
}

export function migrateTree(tree = {}) {
  const migrated = { ...tree };
  migrated.papers = (tree.papers || []).map(normalizePaperAccess);
  migrated.relations = (tree.relations || []).map(relation => normalizeRelationEvidence(relation, migrated.papers));
  migrated.queue ||= [];
  migrated.pending ||= [];
  migrated.history = (tree.history || []).slice(-1);
  migrated.future = (tree.future || []).slice(-1);
  return migrated;
}

export function migrateWorkspace(input = {}) {
  const workspace = { ...input, version: Math.max(3, Number(input.version) || 1) };
  workspace.trees = (input.trees || []).map(migrateTree);
  return workspace;
}

export function mergePaperAnalysis(existing, analyzed, access = {}) {
  return normalizePaperAccess({
    ...existing,
    ...analyzed,
    ...access,
    id: existing.id,
    branchId: analyzed.branchId || existing.branchId,
    localPdf: access.localPdf || analyzed.localPdf || existing.localPdf,
    accessUrl: analyzed.accessUrl || analyzed.url || existing.accessUrl || existing.url,
    analysisBasis: access.analysisBasis || analyzed.analysisBasis || existing.analysisBasis,
    analysisConfidence: access.analysisConfidence ?? analyzed.analysisConfidence ?? existing.analysisConfidence,
    accessCheckedAt: access.accessCheckedAt || new Date().toISOString()
  });
}
