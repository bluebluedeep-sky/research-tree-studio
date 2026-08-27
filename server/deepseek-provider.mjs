import Ajv from "ajv";
import { paperAnalysisSchema, initialTreeSchema, relationAnalysisSchema } from "./schemas.mjs";
import { extractPdfText } from "./pdf-text.mjs";
import { searchOpenAlex } from "./research-sources.mjs";

const API_BASE = "https://api.deepseek.com";
const BRANCH_COLORS = ["#2c6ca3", "#b86721", "#40844a", "#6f5d9e", "#a14e49", "#0f7f91"];
const BRANCH_LETTERS = ["A", "B", "C", "D", "E"];
const RELATION_TYPES = new Set(["extends", "improves", "replaces", "combines", "contrasts", "inspires", "migrates_problem"]);
const ANALYSIS_BASES = new Set(["fulltext", "abstract", "metadata"]);
const ajv = new Ajv({ allErrors: true, strict: false });
const validatePaper = ajv.compile(paperAnalysisSchema);
const validateTree = ajv.compile(initialTreeSchema);
const validateRelation = ajv.compile(relationAnalysisSchema);
const searchPlanSchema = {
  type: "object",
  additionalProperties: false,
  properties: { queries: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } } },
  required: ["queries"]
};
const validateSearchPlan = ajv.compile(searchPlanSchema);

function requireKey(apiKey) {
  if (!String(apiKey || "").trim()) throw Object.assign(new Error("请输入 DeepSeek API Key。"), { status: 401 });
  return String(apiKey).trim();
}

function settingsFor(depth) {
  if (depth === "fast") return { thinking: { type: "disabled" } };
  return { thinking: { type: "enabled" }, reasoning_effort: depth === "deep" ? "max" : "high" };
}

function translatedError(status, detail = "") {
  const table = {
    400: "DeepSeek 无法处理当前请求，请检查模型名称或论文内容。",
    401: "DeepSeek API Key 无效或已失效。",
    402: "DeepSeek 账户余额不足，请先充值。",
    403: "当前 DeepSeek API Key 没有调用该模型的权限。",
    413: "论文内容过大，超出处理限制。",
    422: "DeepSeek 拒绝了当前请求参数。",
    429: "DeepSeek 请求过于频繁，请稍后重试。"
  };
  return Object.assign(new Error(table[status] || detail || "DeepSeek 请求失败，请稍后重试。"), { status: status >= 400 && status < 600 ? status : 502 });
}

async function deepseekResponse(path, { apiKey, method = "POST", body, signal }) {
  const key = requireKey(apiKey);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      signal,
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("用户已取消请求。"), { status: 499, name: "AbortError" });
    throw translatedError(502, "无法连接 DeepSeek，请检查网络后重试。");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw translatedError(response.status, data?.error?.message || "");
  }
  return response;
}

async function deepseekFetch(path, options) {
  return (await deepseekResponse(path, options)).json();
}

async function deepseekStream(path, options, onDelta) {
  const response = await deepseekResponse(path, options);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", content = "", reasoningChars = 0, model = options.body.model, usage = null, finishReason = null;

  function consume(block) {
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      const chunk = JSON.parse(payload);
      if (chunk.error) throw translatedError(502, chunk.error.message || "DeepSeek 流式生成失败。");
      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoningChars += delta.reasoning_content.length;
      finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
      model = chunk.model || model;
      usage = chunk.usage || usage;
      onDelta?.({ contentChars: content.length, reasoningChars });
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) consume(block);
    if (done) break;
  }
  if (buffer.trim()) consume(buffer);
  return { choices: [{ message: { content }, finish_reason: finishReason }], model, usage, reasoningChars };
}

function schemaPrompt(schema) {
  return `必须只输出一个 JSON 对象，不要使用 Markdown。JSON 必须完全符合以下 Schema，不得省略 required 字段：\n${JSON.stringify(schema)}`;
}

function parseJsonContent(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return null;
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(unfenced); }
  catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new SyntaxError("invalid-json");
  }
}

function enumToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function canonicalRelationType(value, explanation = "") {
  const token = enumToken(value);
  if (RELATION_TYPES.has(token)) return token;
  const text = `${token} ${String(explanation || "").toLowerCase()}`;
  if (/(improv|enhanc|optim|refin|改进|改善|优化|增强|提升)/.test(text)) return "improves";
  if (/(replac|supersed|substitut|替代|取代|淘汰)/.test(text)) return "replaces";
  if (/(combin|integrat|merg|hybrid|fusion|结合|融合|组合|集成)/.test(text)) return "combines";
  if (/(contrast|compar|differ|versus|\bvs\b|对比|比较|区别|相反)/.test(text)) return "contrasts";
  if (/(inspir|motivat|启发|借鉴)/.test(text)) return "inspires";
  if (/(migrat|transfer|appl(?:y|ies|ied)|adapt|generaliz|迁移|应用|适配|泛化)/.test(text)) return "migrates_problem";
  if (/(extend|build|follow|base|depend|adopt|use|继承|扩展|延续|基于|沿用|依赖)/.test(text)) return "extends";
  return "extends";
}

function semanticRelationType(source, target, relation = {}) {
  const sourceText = `${source?.title || ""} ${source?.titleZh || ""} ${source?.method || ""} ${source?.problem || ""}`.toLowerCase();
  const targetText = `${target?.title || ""} ${target?.titleZh || ""} ${target?.method || ""} ${target?.problem || ""} ${target?.contribution || ""} ${relation.explanation || ""}`.toLowerCase();
  if (/(replac|instead of|without (?:full|standard|explicit)|替代|取代|无需传统|不再使用)/.test(targetText)) return "replaces";
  if (/(hybrid|combin|integrat|fusion|mixture|joint|local.+(?:global|linear|recurrent)|结合|融合|混合|联合|集成)/.test(targetText)) return "combines";
  if (/(contrast|versus|\bvs\b|comparison|unlike|对比|比较|不同于|相反)/.test(targetText)) return "contrasts";
  if (/(brain|hippocamp|cognit|neural memory|spiking|脑启发|海马|认知|神经机制|仿生)/.test(targetText) && !/(brain|hippocamp|cognit|脑启发|海马|认知)/.test(sourceText)) return "inspires";
  if (source?.branchId && target?.branchId && source.branchId !== target.branchId) return "migrates_problem";
  if (/(transfer|migrat|adapt.+(?:domain|task|scenario)|apply.+(?:serving|inference|vision|language)|迁移|应用于|适配.+场景|推广到)/.test(targetText)) return "migrates_problem";
  if (/(improv|enhanc|optim|faster|efficient|adaptive|dynamic|quant|compress|prun|spars|low.rank|改进|优化|提升|增强|自适应|动态|量化|压缩|剪枝|稀疏|低秩)/.test(targetText)) return "improves";
  return "extends";
}

function diversifyHomogeneousRelations(relations, papersById) {
  if (relations.length < 4) return relations;
  const counts = new Map();
  for (const relation of relations) counts.set(relation.type, (counts.get(relation.type) || 0) + 1);
  const [dominantType, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dominantCount / relations.length < 0.8) return relations;
  for (const relation of relations) {
    if (relation.type !== dominantType) continue;
    const inferred = semanticRelationType(papersById.get(relation.sourceId), papersById.get(relation.targetId), relation);
    if (inferred !== dominantType) {
      relation.type = inferred;
      relation.confidence = Math.min(Number(relation.confidence) || 0.4, 0.68);
    }
  }
  return relations;
}

function canonicalDirection(value) {
  const token = enumToken(value);
  if (token === "from_target_to_new" || token === "target_to_new" || token === "existing_to_new") return "from_target_to_new";
  if (token === "from_new_to_target" || token === "new_to_target" || token === "new_to_existing") return "from_new_to_target";
  return "from_target_to_new";
}

function canonicalBasis(value, allowedBases, fallback) {
  const token = enumToken(value).replace(/^based_on_/, "").replace(/_only$/, "").replace(/^full_text$/, "fulltext");
  return ANALYSIS_BASES.has(token) && allowedBases.has(token) ? token : fallback;
}

function finiteConfidence(value, fallback = 0.4) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

export function normalizeModelOutput(data, { allowedBases = ["fulltext", "abstract", "metadata"], defaultBasis = "metadata", forceBasis = "" } = {}) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const allowed = new Set(allowedBases);
  const fallbackBasis = allowed.has(forceBasis) ? forceBasis : allowed.has(defaultBasis) ? defaultBasis : [...allowed][0];
  const normalizePaper = paper => {
    if (!paper || typeof paper !== "object" || Array.isArray(paper)) return paper;
    paper.analysisBasis = forceBasis || canonicalBasis(paper.analysisBasis, allowed, fallbackBasis);
    paper.analysisConfidence = finiteConfidence(paper.analysisConfidence);
    paper.confidence = finiteConfidence(paper.confidence);
    if ("year" in paper && Number.isFinite(Number(paper.year))) paper.year = Number(paper.year);
    return paper;
  };
  const normalizeRelation = relation => {
    if (!relation || typeof relation !== "object" || Array.isArray(relation)) return relation;
    const originalType = enumToken(relation.type);
    relation.type = canonicalRelationType(relation.type, relation.explanation);
    if (originalType !== relation.type) relation.confidence = Math.min(0.58, finiteConfidence(relation.confidence));
    else relation.confidence = finiteConfidence(relation.confidence);
    relation.analysisBasis = forceBasis || canonicalBasis(relation.analysisBasis, allowed, fallbackBasis);
    if ("direction" in relation || "targetPaperId" in relation) relation.direction = canonicalDirection(relation.direction);
    return relation;
  };
  const hasRelationCollection = "relations" in data || Boolean(data.paper) || Array.isArray(data.papers);
  if (hasRelationCollection && data.relations && !Array.isArray(data.relations)) data.relations = [data.relations];
  if (hasRelationCollection && !Array.isArray(data.relations)) data.relations = [];
  if (data.paper) normalizePaper(data.paper);
  if (Array.isArray(data.papers)) data.papers.forEach(normalizePaper);
  if (Array.isArray(data.relations)) data.relations.forEach(normalizeRelation);
  if ("type" in data && "explanation" in data) normalizeRelation(data);
  if (data.paper && !Array.isArray(data.warnings)) data.warnings = [];
  if (Array.isArray(data.papers) && !Array.isArray(data.unverified)) data.unverified = [];
  if (data.placement && typeof data.placement === "object") data.placement.confidence = finiteConfidence(data.placement.confidence);
  return data;
}

function sanitizeBySchema(value, schema) {
  if (!schema) return value;
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result = schema.additionalProperties === false ? {} : { ...value };
    for (const [key, childSchema] of Object.entries(schema.properties || {})) {
      if (key in value) result[key] = sanitizeBySchema(value[key], childSchema);
    }
    return result;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return [];
    return value.map(item => sanitizeBySchema(item, schema.items));
  }
  if (schema.type === "integer") {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) : value;
  }
  if (schema.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) return value;
    return Math.min(schema.maximum ?? number, Math.max(schema.minimum ?? number, number));
  }
  if (schema.type === "boolean" && typeof value !== "boolean") {
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
  }
  if (schema.type === "string" && value != null && typeof value !== "string") return Array.isArray(value) ? value.join("、") : String(value);
  return value;
}

function validationDetail(validate, limit = 8) {
  return validate.errors?.slice(0, limit).map(item => `${item.instancePath || "/"} ${item.message}`).join("；") || "未知结构错误";
}

export async function completeJson({ apiKey, model, depth, system, user, schema, validate, normalize, signal, maxTokens, onDelta, onRetry }) {
  const baseBody = {
    model: model || "deepseek-v4-flash",
    messages: [
      { role: "system", content: `${system}\n\n${schemaPrompt(schema)}` },
      { role: "user", content: user }
    ],
    response_format: { type: "json_object" },
    max_tokens: maxTokens
  };
  const run = async (runDepth, messages = baseBody.messages) => {
    const body = { ...baseBody, messages, ...settingsFor(runDepth) };
    return onDelta
      ? deepseekStream("/chat/completions", { apiKey, signal, body: { ...body, stream: true } }, onDelta)
      : deepseekFetch("/chat/completions", { apiKey, signal, body });
  };

  const normalizeAndSanitize = value => sanitizeBySchema(normalize ? normalize(value) : value, schema);

  let result = await run(depth);
  let content = result.choices?.[0]?.message?.content;
  let finishReason = result.choices?.[0]?.finish_reason;
  let data;
  let parseError = null;
  try { data = parseJsonContent(content); }
  catch (error) { parseError = error; }

  const outputIncomplete = !data || finishReason === "length";
  if (outputIncomplete && depth !== "fast") {
    onRetry?.({
      reason: !String(content || "").trim() ? "模型完成了推理，但没有输出最终结果" : finishReason === "length" ? "模型输出达到长度上限" : "模型返回内容不完整"
    });
    result = await run("fast");
    content = result.choices?.[0]?.message?.content;
    finishReason = result.choices?.[0]?.finish_reason;
    parseError = null;
    try { data = parseJsonContent(content); }
    catch (error) { parseError = error; }
  }

  if (!String(content || "").trim()) throw translatedError(502, "DeepSeek 两次生成都没有返回最终结果，请稍后重试或减少论文数量。");
  if (parseError || !data) throw translatedError(502, finishReason === "length" ? "DeepSeek 输出达到长度上限，请减少论文数量后重试。" : "DeepSeek 返回的结果不是有效 JSON，请重试。");
  data = normalizeAndSanitize(data);
  if (!validate(data)) {
    const firstDetail = validationDetail(validate);
    onRetry?.({ reason: `模型返回字段需要修正：${firstDetail}` });
    const repairMessages = [
      ...baseBody.messages,
      { role: "assistant", content: JSON.stringify(data) },
      { role: "user", content: `上一份 JSON 未通过结构校验。请只修正 JSON，不要重新检索或更换论文，不要添加 Schema 之外的字段。校验错误：${firstDetail}` }
    ];
    result = await run("fast", repairMessages);
    content = result.choices?.[0]?.message?.content;
    finishReason = result.choices?.[0]?.finish_reason;
    try { data = normalizeAndSanitize(parseJsonContent(content)); }
    catch { data = null; }
    if (!data || !validate(data)) {
      const finalDetail = data ? validationDetail(validate) : finishReason === "length" ? "修正结果达到长度上限" : "修正结果不是有效 JSON";
      throw translatedError(502, `DeepSeek 自动修正后数据仍不完整：${finalDetail}`);
    }
  }
  return { data, usage: result.usage || null, model: result.model || model };
}

function normalizedTitle(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").trim();
}

function hasChinese(value) { return /[\u3400-\u9fff]/.test(String(value || "")); }
function chineseOr(value, fallback) { return hasChinese(value) ? String(value).trim() : fallback; }
function cleanBranchName(value) { return String(value || "").replace(/^[A-EＡ-Ｅ][.、：:\s-]+/i, "").trim(); }

export function uniqueCandidates(groups, desired, searchMode = "lineage") {
  const seen = new Set();
  const openScore = item => item.pdfUrl ? 3 : item.accessStatus === "abstract_only" ? 2 : item.accessStatus === "institutional_required" ? 1 : 0;
  return groups.flat().sort((a, b) => searchMode === "readable" ? openScore(b) - openScore(a) || b.relevanceScore - a.relevanceScore || b.citedByCount - a.citedByCount : b.relevanceScore - a.relevanceScore || b.citedByCount - a.citedByCount).filter(item => {
    const key = normalizedTitle(item.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, Math.min(desired * 3, 100)).map((item, index) => ({ ...item, candidateId: `candidate-${index + 1}` }));
}

export function normalizeTree(data, candidates, desired, topic, focus) {
  const byId = new Map(candidates.map(item => [item.candidateId, item]));
  const byTitle = new Map(candidates.map(item => [normalizedTitle(item.title), item]));
  const accepted = [];
  const unverified = [...(data.unverified || [])];
  for (const paper of data.papers || []) {
    const candidate = byId.get(paper.id) || byTitle.get(normalizedTitle(paper.title));
    if (!candidate) { unverified.push(paper.title); continue; }
    const titleZh = chineseOr(paper.titleZh, `《${candidate.title}》中文标题待核对`);
    const analysisBasis = candidate.abstract ? "abstract" : "metadata";
    const basisPrefix = analysisBasis === "abstract" ? "基于摘要判断：" : "仅据元数据初步分类：";
    accepted.push({
      ...paper,
      id: candidate.candidateId,
      title: candidate.title,
      titleZh,
      authors: candidate.authors,
      year: candidate.year,
      venue: candidate.venue,
      url: candidate.url,
      accessUrl: candidate.accessUrl || candidate.url,
      pdfUrl: candidate.pdfUrl || "",
      abstract: candidate.abstract || "",
      accessStatus: candidate.accessStatus || (candidate.pdfUrl ? "open_pdf" : candidate.abstract ? "abstract_only" : "metadata_only"),
      accessSource: candidate.accessSource || "OpenAlex",
      accessCheckedAt: new Date().toISOString(),
      analysisBasis,
      analysisConfidence: Math.min(analysisBasis === "abstract" ? 0.78 : 0.42, Math.max(0, Number(paper.analysisConfidence) || Number(paper.confidence) || (analysisBasis === "abstract" ? 0.68 : 0.32))),
      problem: analysisBasis === "metadata" ? `${basisPrefix}研究问题尚待全文或摘要确认。` : `${basisPrefix}${chineseOr(paper.problem, `该论文围绕${titleZh}所对应的研究问题展开，具体表述待结合原文核对。`).replace(/^基于摘要判断：/, "")}`,
      method: analysisBasis === "metadata" ? `${basisPrefix}不能可靠判断具体方法。` : `${basisPrefix}${chineseOr(paper.method, "论文提出了面向上述问题的技术方案，具体机制待结合原文核对。").replace(/^基于摘要判断：/, "")}`,
      contribution: analysisBasis === "metadata" ? `${basisPrefix}不能可靠判断具体贡献。` : `${basisPrefix}${chineseOr(paper.contribution, "论文推进了该研究路线，主要贡献待结合原文进一步核对。").replace(/^基于摘要判断：/, "")}`,
      confidence: Math.min(analysisBasis === "abstract" ? 0.78 : 0.42, Math.max(0, Number(paper.confidence) || (analysisBasis === "abstract" ? 0.68 : 0.32)))
    });
    if (accepted.length >= desired) break;
  }

  const counts = new Map();
  for (const paper of accepted) counts.set(paper.branchId, (counts.get(paper.branchId) || 0) + 1);
  let branches = (data.branches || []).filter(branch => counts.has(branch.id)).slice(0, 5).map(branch => ({ ...branch, originalId: branch.id }));
  if (!branches.length) branches = [{ id: "main", originalId: "main", name: "核心研究路线", question: "该方向的主要问题演进" }];
  const keptIds = new Set(branches.map(branch => branch.originalId));
  for (const paper of accepted) if (!keptIds.has(paper.branchId)) paper.branchId = branches[0].originalId;

  const targetBranchCount = Math.min(5, accepted.length);
  while (branches.length < targetBranchCount) {
    const donor = branches.map(branch => ({ branch, papers: accepted.filter(paper => paper.branchId === branch.originalId).sort((a, b) => a.year - b.year || a.title.localeCompare(b.title)) })).sort((a, b) => b.papers.length - a.papers.length)[0];
    if (!donor || donor.papers.length < 2) break;
    const moved = donor.papers.pop(), originalId = `generated-route-${branches.length + 1}`;
    moved.branchId = originalId;
    branches.push({ id: originalId, originalId, name: `延伸路线：${moved.titleZh.slice(0, 16)}`, question: moved.problem });
  }

  const branchIdMap = new Map();
  branches = branches.map((branch, index) => {
    const letter = BRANCH_LETTERS[index] || String(index + 1), id = `branch-${String(letter).toLowerCase()}`;
    branchIdMap.set(branch.originalId, id);
    const fallbackName = index === 0 ? "核心方法与基础问题" : `研究路线 ${letter}`;
    return {
      id,
      name: `${letter}. ${chineseOr(cleanBranchName(branch.name), fallbackName)}`,
      question: chineseOr(branch.question, `该分支聚焦${focus || topic}中的第 ${index + 1} 条技术路线。`),
      color: BRANCH_COLORS[index]
    };
  });
  for (const paper of accepted) paper.branchId = branchIdMap.get(paper.branchId) || branches[0].id;

  const ids = new Set(accepted.map(item => item.id));
  const seenRelations = new Set();
  const relations = [];
  const papersById = new Map(accepted.map(paper => [paper.id, paper]));
  for (const original of data.relations || []) {
    const relation = { ...original };
    if (!ids.has(relation.sourceId) || !ids.has(relation.targetId) || relation.sourceId === relation.targetId) continue;
    const source = papersById.get(relation.sourceId), target = papersById.get(relation.targetId);
    if (source.year > target.year) [relation.sourceId, relation.targetId] = [relation.targetId, relation.sourceId];
    const relationBasis = source.analysisBasis === "metadata" || target.analysisBasis === "metadata" ? "metadata" : "abstract";
    relation.analysisBasis = relationBasis;
    relation.confidence = Math.min(relationBasis === "abstract" ? 0.78 : 0.42, Math.max(0, Number(relation.confidence) || (relationBasis === "abstract" ? 0.64 : 0.32)));
    relation.explanation = `${relationBasis === "abstract" ? "基于摘要判断：" : "仅据元数据初步分类："}${chineseOr(relation.explanation, `${papersById.get(relation.targetId)?.titleZh || "后续工作"}沿用了${papersById.get(relation.sourceId)?.titleZh || "前序工作"}的问题设定或方法思路。`).replace(/^(基于摘要判断：|仅据元数据初步分类：)/, "")}`;
    const key = `${relation.sourceId}|${relation.targetId}|${relation.type}`;
    if (seenRelations.has(key)) continue;
    seenRelations.add(key); relations.push(relation);
    if (relations.length >= Math.max(12, accepted.length * 2)) break;
  }
  for (const branch of branches) {
    const papers = accepted.filter(paper => paper.branchId === branch.id).sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));
    for (let index = 1; index < papers.length; index += 1) {
      const sourceId = papers[index - 1].id, targetId = papers[index].id;
      if (relations.some(rel => (rel.sourceId === sourceId && rel.targetId === targetId) || (rel.sourceId === targetId && rel.targetId === sourceId))) continue;
      const analysisBasis = papers[index].analysisBasis === "metadata" || papers[index - 1].analysisBasis === "metadata" ? "metadata" : "abstract";
      const type = semanticRelationType(papers[index - 1], papers[index]);
      const action = type === "extends" ? "延续" : type === "improves" ? "改进" : type === "combines" ? "融合" : type === "replaces" ? "替代" : type === "contrasts" ? "对照" : type === "inspires" ? "借鉴" : "迁移";
      relations.push({ sourceId, targetId, type, analysisBasis, confidence: analysisBasis === "abstract" ? 0.58 : 0.3, explanation: `${analysisBasis === "abstract" ? "基于摘要判断：" : "仅据元数据初步分类："}同一研究路线中，${papers[index].titleZh}在${papers[index - 1].titleZh}之后${action}了相关问题设定或方法路线。` });
    }
  }
  diversifyHomogeneousRelations(relations, papersById);
  return {
    ...data,
    name: topic,
    description: chineseOr(data.description, `围绕“${topic}”建立的研究脉络，重点呈现问题演进、方法继承、技术替代与分支之间的逻辑关系。`),
    branches,
    papers: accepted,
    relations,
    unverified: [...new Set(unverified)].slice(0, 100),
    formatVersion: "attention-tree-v1"
  };
}

export class DeepSeekProvider {
  async test({ apiKey, model, signal }) {
    const result = await deepseekFetch("/models", { apiKey, method: "GET", signal });
    const models = (result.data || []).map(item => item.id);
    const selected = model || "deepseek-v4-flash";
    if (models.length && !models.includes(selected)) throw Object.assign(new Error(`模型“${selected}”当前不可用，可用模型：${models.join("、")}`), { status: 400 });
    return { ok: true, model: selected, models };
  }

  async reanalyzeRelation({ apiKey, model, depth, source, target, currentRelation, signal, progress }) {
    requireKey(apiKey);
    if (!source?.id || !target?.id) throw Object.assign(new Error("关系中的论文信息不完整。"), { status: 400 });
    const rank = { metadata: 0, abstract: 1, fulltext: 2 };
    const sourceBasis = ANALYSIS_BASES.has(source.analysisBasis) ? source.analysisBasis : "metadata", targetBasis = ANALYSIS_BASES.has(target.analysisBasis) ? target.analysisBasis : "metadata";
    const basis = rank[sourceBasis] <= rank[targetBasis] ? sourceBasis : targetBasis;
    const report = (percent, stage, detail = "") => progress?.({ percent, stage, detail });
    report(12, "准备论文证据", `${source.titleZh || source.title} → ${target.titleZh || target.title}`);
    let stableRetry = false;
    const result = await completeJson({
      apiKey, model, depth, signal, schema: relationAnalysisSchema, validate: validateRelation, maxTokens: 2400,
      normalize: data => normalizeModelOutput(data, { allowedBases: ["fulltext", "abstract", "metadata"], defaultBasis: basis, forceBasis: basis }),
      system: `你是严谨的论文关系分析器。只判断给定的两篇论文，不新增论文。关系方向固定为前序论文 source 指向后续论文 target。type 只能是 extends、improves、replaces、combines、contrasts、inspires、migrates_problem 之一。必须先比较研究问题、方法机制与应用场景，再选最具体的类型；只有确属沿用同一路线且没有更明确变化时才用 extends。explanation 必须使用简体中文，用 50-80 字清楚说明两篇论文在研究问题、方法或技术路线上的具体联系。当前证据级别为 ${basis}：不得声称读取过未提供的全文；abstract 必须按摘要级证据表述；metadata 只能做初步分类。证据不足时降低 confidence。`,
      user: `前序论文 source：\n${JSON.stringify(source)}\n\n后续论文 target：\n${JSON.stringify(target)}\n\n当前关系：\n${JSON.stringify(currentRelation || {})}\n\n请重新判断这一条关系并输出 JSON。`,
      onDelta: ({ contentChars, reasoningChars }) => {
        const activity = contentChars + Math.floor(reasoningChars / 3), percent = Math.min(88, 30 + Math.floor(activity / 35));
        report(percent, stableRetry ? "稳定模式重新判断" : "分析论文联系", contentChars ? `已接收 ${contentChars} 个结果字符` : `模型正在推理，已接收 ${reasoningChars} 个推理字符`);
      },
      onRetry: ({ reason }) => { stableRetry = true; report(72, "自动修正关系结果", reason); }
    });
    report(96, "校验关系说明", "检查关系类型、证据级别和置信度");
    report(100, "关系判断完成", `${result.data.type} · ${Math.round(result.data.confidence * 100)}%`);
    return result;
  }

  async analyzePaper({ apiKey, model, depth, file, sourceText, sourceUrl, analysisBasis, treeContext, signal }) {
    const text = file?.data ? await extractPdfText(file.data) : String(sourceText || "").slice(0, 350000);
    if (text.length < 200) throw Object.assign(new Error("论文正文不足，无法分析。"), { status: 400 });
    const context = JSON.stringify(treeContext || {}).slice(0, 80000);
    const basis = file?.data ? "fulltext" : analysisBasis === "metadata" ? "metadata" : "abstract";
    return completeJson({
      apiKey, model, depth, signal, schema: paperAnalysisSchema, validate: validatePaper, maxTokens: 12000,
      normalize: data => normalizeModelOutput(data, { allowedBases: ["fulltext", "abstract", "metadata"], defaultBasis: basis, forceBasis: basis }),
      system: `你是严谨的学术研究脉络分析器。当前证据级别固定为 ${basis}。不得声称读过未取得的论文全文。analysisBasis 必须填写 ${basis}。关系 type 只能填写 extends、improves、replaces、combines、contrasts、inspires、migrates_problem 之一，禁止创造近义标签。只有 fulltext 才允许全文级方法分析；abstract 的问题、方法、贡献和关系说明必须以“基于摘要判断：”开头；metadata 只允许初步分类，不允许生成确定性的方法和贡献。证据不足时降低 analysisConfidence 和 relation confidence，并写入 warnings。中文贡献控制在约 100 字。targetPaperId 必须使用现有树中的论文 ID；没有可靠关系时 relations 返回空数组。`,
      user: `论文来源：${sourceUrl || file?.name || "本地 PDF"}\n分析依据：${basis}\n\n取得的论文内容：\n${text}\n\n现有研究树 JSON：\n${context}\n\n请输出 JSON，分析该论文的元数据、所属分支及与已有论文的逻辑关系。`
    });
  }

  async researchTree({ apiKey, model, depth, topic, focus, years, count, topVenues, searchMode = "lineage", signal, progress }) {
    requireKey(apiKey);
    const desired = Math.min(Math.max(Number(count) || 30, 5), 60);
    const report = (percent, stage, detail = "") => progress?.({ percent, stage, detail });

    report(5, "检索论文元数据", "DeepSeek 正在把研究主题转换为英文论文检索式");
    const plan = await completeJson({
      apiKey, model, depth: "fast", signal, schema: searchPlanSchema, validate: validateSearchPlan, maxTokens: 1000,
      system: "你是学术检索规划器。把用户的中文或英文主题转换为 2-4 条简洁、互补的英文论文检索词。检索词必须聚焦技术概念，不要包含年份、顶会名称或解释文字。",
      user: `研究主题：${topic}\n重点方向：${focus || "未指定"}\n请输出 JSON。`
    });
    const queries = [...new Set(plan.data.queries.map(query => query.trim()).filter(Boolean))].slice(0, 4);
    report(16, "检索式已生成", queries.join(" · "));

    let completed = 0;
    const groups = await Promise.all(queries.map(async query => {
      const papers = await searchOpenAlex({ query, years, count: desired, searchMode, signal });
      completed += 1;
      report(16 + Math.round(completed / queries.length * 22), "查询开放获取版本", `已完成 ${completed}/${queries.length} 路检索，当前获得 ${papers.length} 条候选`);
      return papers;
    }));
    const candidates = uniqueCandidates(groups, desired, searchMode);
    if (candidates.length < 3) throw Object.assign(new Error("公开论文库返回的候选太少，请换一个更具体的研究主题重试。"), { status: 400 });
    report(42, "候选论文准备完成", `已去重并筛选 ${candidates.length} 篇可验证论文`);

    let stableRetry = false;
    const result = await completeJson({
      apiKey, model, depth, signal, schema: initialTreeSchema, validate: validateTree, maxTokens: 24000,
      normalize: data => normalizeModelOutput(data, { allowedBases: ["abstract", "metadata"], defaultBasis: "metadata" }),
      system: "你是学术研究脉络策展人。候选论文已由公开论文数据库检索获得，只能选择候选列表中的论文，不得虚构。你必须严格复用固定的 Attention 研究树模板：一个研究主题主干；恰好五条非空主题分支；论文在分支内按时间由左向右演进；每篇后续论文连接 1-2 篇真正相关的前序工作；避免全连接。关系 type 只能填写 extends、improves、replaces、combines、contrasts、inspires、migrates_problem 之一，禁止使用 builds_on、uses、optimizes 等近义标签。必须逐条比较问题、机制和应用场景并选择最具体的关系；不要把整棵树机械地全部标成 extends，只有真正沿用同一路线且不存在更明确变化时才用 extends。若证据确实只支持同一种关系可以保留，但 explanation 必须给出对应证据。五条分支必须是问题或技术路线，不能只是按年份分组。branches 按核心主线到延伸路线排序。除论文原始 title、作者、会议期刊名称和 URL 外，其余解释字段必须使用简体中文。不得声称阅读过候选论文全文：有摘要的论文 analysisBasis 必须为 abstract，说明以“基于摘要判断：”开头；没有摘要的论文 analysisBasis 必须为 metadata，只能初步分类，不得虚构具体方法和贡献。证据不足时降低 analysisConfidence 和关系 confidence。论文 id 必须原样使用 candidateId。",
      user: `研究主题：${topic}\n重点方向：${focus || "未指定"}\n时间范围：${years || "不限"}\n目标数量：${desired}\n${topVenues ? "优先选择高影响力会议和期刊。" : "不限定发表场所。"}\n检索模式：${searchMode === "readable" ? "可阅读全文优先，优先选择 pdfUrl 非空的论文，开放全文不足时再补充重要摘要论文。" : "研究脉络优先，重要论文即使需要机构权限也可以进入树。"}\n\n固定版式要求：\n1. 根节点是研究主题。\n2. 输出恰好 5 条非空主题分支，后续程序会固定标记为 A-E 并使用 Attention 树的配色。\n3. 每条分支先放奠基工作，再放继承、改进、替代或融合它的后续工作。\n4. 关系方向一律从较早论文指向较新论文。\n5. 所有解释字段使用简体中文。\n\n公开论文候选 JSON：\n${JSON.stringify(candidates)}\n\n请输出 JSON，建立与固定 Attention 模板同构的研究树。`,
      onDelta: ({ contentChars, reasoningChars }) => {
        const activity = contentChars + Math.floor(reasoningChars / 3);
        const percent = Math.min(88, 44 + Math.floor(activity / 450));
        const detail = contentChars ? `已接收 ${contentChars.toLocaleString("zh-CN")} 个结果字符` : `模型正在推理，已接收 ${reasoningChars.toLocaleString("zh-CN")} 个推理字符`;
        report(percent, stableRetry ? "稳定模式重新生成" : "分析全文或摘要", stableRetry ? `${detail} · 正在恢复上一次未完成的输出` : detail);
      },
      onRetry: ({ reason }) => {
        stableRetry = true;
        report(72, "自动重试生成结果", `${reason}，已切换稳定输出模式，无需重新提交`);
      }
    });
    report(92, "建立论文关系", "清理无效引用、过密连线和未分类论文");
    result.data = normalizeTree(result.data, candidates, desired, topic, focus);
    report(92, "研究脉络整理完成", `${result.data.papers.length} 篇论文 · ${result.data.branches.length} 条分支 · ${result.data.relations.length} 条关系`);
    return result;
  }
}
