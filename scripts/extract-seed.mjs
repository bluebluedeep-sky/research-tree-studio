import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "backups", "efficient-attention-research-tree.original.html"), "utf8");
const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
const start = script.indexOf("const branches =");
const end = script.indexOf("const byTitle");
if (start < 0 || end < 0) throw new Error("无法从原始 Attention 网页提取论文数据。");
const getData = new Function(`${script.slice(start, end)}; return { branches, edges, zhTitles, aliases };`);
const { branches, zhTitles, aliases } = getData();
const colorMap = { system: "#2c6ca3", sparse: "#b86721", kv: "#40844a", alt: "#6f5d9e", brain: "#a14e49" };
const papers = [];
for (const branch of branches) {
  branch.papers.forEach((paper, index) => papers.push({
    id: `${branch.id}-${index}`,
    title: paper[0], titleZh: zhTitles[paper[0]] || paper[0], authors: paper[1],
    year: Number((paper[2].match(/20\d{2}/) || ["2024"])[0]), venue: paper[2],
    problem: paper[3], method: paper[4], contribution: paper[5], url: paper[6],
    branchId: branch.id, confidence: 1, verified: true, source: "preset"
  }));
}
const idByTitle = Object.fromEntries(papers.map(p => [p.title, p.id]));
const relations = [];
for (const [targetTitle, sourceTitles] of Object.entries(aliases)) {
  for (const sourceTitle of sourceTitles) {
    if (idByTitle[sourceTitle] && idByTitle[targetTitle]) relations.push({
      id: `rel-${relations.length + 1}`,
      sourceId: idByTitle[sourceTitle], targetId: idByTitle[targetTitle], type: "extends",
      explanation: `${targetTitle} 延续或回应了 ${sourceTitle} 的研究问题。`
    });
  }
}
const tree = {
  id: "efficient-attention",
  name: "高效 Attention",
  description: "2023–2026 的高效注意力研究脉络，重点呈现系统优化、稀疏检索、KV 记忆管理、状态替代与脑启发记忆。",
  color: "#007c70",
  locked: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  branches: branches.map(branch => ({ id: branch.id, name: branch.name, question: branch.question, color: colorMap[branch.id] })),
  papers,
  relations,
  pending: [],
  history: [],
  future: []
};
await fs.writeFile(path.join(root, "client", "seed-attention.json"), JSON.stringify(tree, null, 2), "utf8");
console.log(`Seed generated: ${papers.length} papers, ${relations.length} relations.`);
