import test from "node:test";
import assert from "node:assert/strict";
import { mergePaperAnalysis, migrateWorkspace, normalizePaperAccess } from "../client/access-model.js";
import { normalizeTree, uniqueCandidates } from "../server/deepseek-provider.mjs";
import { unresolvedAccess } from "../server/paper-resolver.mjs";

test("legacy workspaces migrate without changing identities and keep only the latest history version", () => {
  const legacy = { version: 1, trees: [{ id: "tree-1", papers: [{ id: "paper-1", title: "Legacy", localPdf: "/paper-files/preset/legacy.pdf", problem: "p" }], relations: [{ id: "rel-1", sourceId: "paper-1", targetId: "paper-2", type: "extends" }], history: [{ id: "old-1" }, { id: "old-2" }, { id: "latest" }], future: [{ id: "future-1" }, { id: "future-latest" }] }] };
  const migrated = migrateWorkspace(legacy);
  assert.equal(migrated.version, 3);
  assert.equal(migrated.trees[0].id, "tree-1");
  assert.equal(migrated.trees[0].papers[0].id, "paper-1");
  assert.equal(migrated.trees[0].papers[0].accessStatus, "local_pdf");
  assert.equal(migrated.trees[0].relations[0].id, "rel-1");
  assert.equal(migrated.trees[0].relations[0].sourceId, "paper-1");
  assert.deepEqual(migrated.trees[0].history.map(item => item.id), ["latest"]);
  assert.deepEqual(migrated.trees[0].future.map(item => item.id), ["future-latest"]);
});

test("analysis confidence is capped by the available evidence", () => {
  assert.equal(normalizePaperAccess({ title: "A", abstract: "abstract", analysisBasis: "abstract", analysisConfidence: 1 }).analysisConfidence, 0.78);
  assert.equal(normalizePaperAccess({ title: "M", analysisBasis: "metadata", analysisConfidence: 1 }).analysisConfidence, 0.45);
  assert.equal(normalizePaperAccess({ title: "F", localPdf: "/paper-files/f.pdf", analysisBasis: "fulltext", analysisConfidence: .93 }).analysisConfidence, .93);
});

test("unresolved publisher links become institutional access instead of download failures", () => {
  const result = unresolvedAccess({ title: "Paywalled", url: "https://doi.org/10.0000/example" });
  assert.equal(result.accessStatus, "institutional_required");
  assert.match(result.accessMessage, /学校或机构权限/);
  assert.equal(unresolvedAccess({ title: "Abstract", abstract: "Reliable abstract", accessSource: "OpenAlex" }).accessStatus, "abstract_only");
  assert.equal(unresolvedAccess({ title: "Metadata only" }).accessStatus, "metadata_only");
  const conference = unresolvedAccess({ title: "Conference paper", url: "https://proceedings.neurips.cc/paper_files/paper/example-Abstract-Conference.html", accessStatus: "open_pdf" });
  assert.equal(conference.accessStatus, "metadata_only");
  assert.equal(conference.accessSource, "conference");
});

test("readable mode really prioritizes open PDFs while lineage mode keeps relevance ordering", () => {
  const closed = { title: "Highly cited closed", relevanceScore: 100, citedByCount: 1000, accessStatus: "institutional_required" };
  const open = { title: "Open full text", relevanceScore: 20, citedByCount: 5, pdfUrl: "https://example.org/open.pdf", accessStatus: "open_pdf" };
  assert.equal(uniqueCandidates([[closed, open]], 5, "lineage")[0].title, closed.title);
  assert.equal(uniqueCandidates([[closed, open]], 5, "readable")[0].title, open.title);
});

test("metadata-only candidates never receive invented method or contribution claims", () => {
  const candidate = { candidateId: "candidate-1", title: "Metadata Paper", authors: "A", year: 2025, venue: "Venue", url: "https://doi.org/10.1/x", accessStatus: "institutional_required", abstract: "" };
  const data = { name: "x", description: "x", branches: [{ id: "b", name: "路线", question: "问题", color: "#000" }], papers: [{ id: "candidate-1", title: candidate.title, titleZh: "元数据论文", authors: "A", year: 2025, venue: "Venue", url: candidate.url, problem: "模型虚构的问题", method: "模型虚构的方法", contribution: "模型虚构的贡献", branchId: "b", confidence: 1, analysisBasis: "metadata", analysisConfidence: 1 }], relations: [], unverified: [] };
  const result = normalizeTree(data, [candidate], 1, "测试主题", "");
  assert.equal(result.papers[0].analysisBasis, "metadata");
  assert.match(result.papers[0].method, /不能可靠判断具体方法/);
  assert.match(result.papers[0].contribution, /不能可靠判断具体贡献/);
  assert.ok(result.papers[0].analysisConfidence <= .42);
});

test("full-text reanalysis updates the original paper identity", () => {
  const existing = normalizePaperAccess({ id: "paper-7", title: "Same", branchId: "old", analysisBasis: "abstract", analysisConfidence: .7 });
  const updated = mergePaperAnalysis(existing, { title: "Same", branchId: "new", method: "全文方法", analysisBasis: "fulltext", analysisConfidence: .9 }, { localPdf: "/paper-files/uploads/same.pdf", accessStatus: "local_pdf", analysisBasis: "fulltext" });
  assert.equal(updated.id, "paper-7");
  assert.equal(updated.branchId, "new");
  assert.equal(updated.accessStatus, "local_pdf");
  assert.equal(updated.analysisBasis, "fulltext");
});
