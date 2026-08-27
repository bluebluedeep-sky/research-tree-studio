import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTree } from "../server/deepseek-provider.mjs";

test("AI research trees are normalized to the fixed Chinese Attention template", () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    candidateId: `candidate-${index + 1}`,
    title: `Efficient Attention Paper ${index + 1}`,
    authors: "Researcher",
    year: 2023 + Math.floor(index / 3),
    venue: "Conference",
    url: `https://example.org/${index + 1}`,
    pdfUrl: `https://example.org/${index + 1}.pdf`
  }));
  const data = {
    name: "English tree name",
    description: "English description",
    branches: [
      { id: "route-one", name: "Sparse attention", question: "How to improve sparsity?", color: "#000" },
      { id: "route-two", name: "Memory", question: "How to compress memory?", color: "#000" }
    ],
    papers: candidates.map((candidate, index) => ({
      id: candidate.candidateId,
      title: candidate.title,
      titleZh: "English translated title",
      authors: candidate.authors,
      year: candidate.year,
      venue: candidate.venue,
      url: candidate.url,
      problem: "English problem",
      method: "English method",
      contribution: "English contribution",
      branchId: index < 5 ? "route-one" : "route-two",
      confidence: .8
    })),
    relations: [{ sourceId: "candidate-8", targetId: "candidate-1", type: "extends", explanation: "English relation" }],
    unverified: []
  };
  const result = normalizeTree(data, candidates, 8, "高效注意力", "稀疏与记忆优化");
  const hasChinese = value => /[\u3400-\u9fff]/.test(value);

  assert.equal(result.formatVersion, "attention-tree-v1");
  assert.equal(result.name, "高效注意力");
  assert.equal(result.branches.length, 5);
  assert.deepEqual(result.branches.map(branch => branch.name.slice(0, 1)), ["A", "B", "C", "D", "E"]);
  assert.ok(result.branches.every(branch => hasChinese(branch.name) && hasChinese(branch.question)));
  assert.ok(result.papers.every(paper => hasChinese(paper.titleZh) && hasChinese(paper.problem) && hasChinese(paper.method) && hasChinese(paper.contribution)));
  assert.ok(result.papers.every(paper => paper.pdfUrl?.endsWith(".pdf")));
  assert.equal(result.relations[0].sourceId, "candidate-1");
  assert.equal(result.relations[0].targetId, "candidate-8");
  assert.ok(result.relations.every(relation => hasChinese(relation.explanation)));
  assert.ok(new Set(result.relations.map(relation => relation.type)).size > 1, "同质化的模型关系应按论文语义进一步区分");
});
