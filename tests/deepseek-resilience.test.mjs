import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { completeJson, normalizeModelOutput } from "../server/deepseek-provider.mjs";
import { initialTreeSchema, relationAnalysisSchema } from "../server/schemas.mjs";

function streamResponse(chunks) {
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("completeJson retries without thinking when DeepSeek returns reasoning only", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (calls === 1) {
      assert.equal(request.thinking.type, "enabled");
      return streamResponse([{
        model: "deepseek-v4-flash",
        choices: [{ delta: { reasoning_content: "long reasoning" }, finish_reason: "length" }]
      }]);
    }
    assert.equal(request.thinking.type, "disabled");
    return streamResponse([{
      model: "deepseek-v4-flash",
      choices: [{ delta: { content: "{\"ok\":true}" }, finish_reason: "stop" }]
    }]);
  };

  try {
    const result = await completeJson({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      depth: "balanced",
      system: "Return JSON.",
      user: "Test",
      schema: { type: "object" },
      validate: value => value?.ok === true,
      maxTokens: 100,
      onDelta: () => {},
      onRetry: event => retries.push(event)
    });
    assert.deepEqual(result.data, { ok: true });
    assert.equal(calls, 2);
    assert.match(retries[0].reason, /没有输出最终结果/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("completeJson accepts JSON wrapped in a markdown fence", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    model: "deepseek-v4-flash",
    choices: [{ message: { content: "```json\n{\"ok\":true}\n```" }, finish_reason: "stop" }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const result = await completeJson({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      depth: "fast",
      system: "Return JSON.",
      user: "Test",
      schema: { type: "object" },
      validate: value => value?.ok === true,
      maxTokens: 100
    });
    assert.deepEqual(result.data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model relation aliases are normalized before strict schema validation", () => {
  const data = normalizeModelOutput({
    papers: [{ year: "2025", analysisBasis: "abstract_only", analysisConfidence: "0.91" }],
    relations: [
      { type: "builds_on", explanation: "follows prior work", analysisBasis: "abstract_based", confidence: 0.9 },
      { type: "optimizes", explanation: "faster inference", analysisBasis: "abstract", confidence: 0.8 },
      { type: "融合", explanation: "融合两种路线", analysisBasis: "metadata_only", confidence: 0.7 },
      { type: "applies_to", explanation: "applied to vision", analysisBasis: "metadata", confidence: 0.6 },
      { type: "unexpected_label", explanation: "unclear relation", analysisBasis: "metadata", confidence: 0.9 }
    ]
  }, { allowedBases: ["abstract", "metadata"], defaultBasis: "metadata" });

  assert.equal(data.papers[0].year, 2025);
  assert.equal(data.papers[0].analysisBasis, "abstract");
  assert.deepEqual(data.relations.map(item => item.type), ["extends", "improves", "combines", "migrates_problem", "extends"]);
  assert.ok(data.relations.every(item => ["abstract", "metadata"].includes(item.analysisBasis)));
  assert.equal(data.relations[4].confidence, 0.58);
});

test("completeJson asks DeepSeek to repair schema errors automatically", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const retries = [];
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { ok: { type: "boolean" } },
    required: ["ok"]
  };
  const validate = value => {
    validate.errors = value?.ok === true ? null : [{ instancePath: "/ok", message: "must be equal to true" }];
    return value?.ok === true;
  };
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const request = JSON.parse(options.body);
    if (calls === 2) assert.match(request.messages.at(-1).content, /未通过结构校验/);
    return new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: calls === 1 ? "{\"ok\":false}" : "{\"ok\":true}" }, finish_reason: "stop" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await completeJson({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      depth: "fast",
      system: "Return JSON.",
      user: "Test",
      schema,
      validate,
      maxTokens: 100,
      onRetry: event => retries.push(event)
    });
    assert.deepEqual(result.data, { ok: true });
    assert.equal(calls, 2);
    assert.match(retries[0].reason, /字段需要修正/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a full research tree with nonstandard relation labels survives strict validation", async () => {
  const originalFetch = globalThis.fetch;
  const validate = new Ajv({ allErrors: true, strict: false }).compile(initialTreeSchema);
  const paper = (id, year) => ({
    id,
    title: `Paper ${id}`,
    titleZh: `论文 ${id}`,
    authors: "Author",
    year,
    venue: "Venue",
    url: `https://example.com/${id}`,
    problem: "基于摘要判断：研究问题。",
    method: "基于摘要判断：研究方法。",
    contribution: "基于摘要判断：研究贡献。",
    branchId: "route-1",
    confidence: 0.7,
    analysisBasis: "abstract_based",
    analysisConfidence: 0.7,
    ignoredExtraField: "remove me"
  });
  const generated = {
    name: "Test tree",
    description: "测试研究树",
    branches: [{ id: "route-1", name: "路线", question: "问题", color: "#123456" }],
    papers: [paper("candidate-1", 2024), paper("candidate-2", 2025)],
    relations: [{
      sourceId: "candidate-1",
      targetId: "candidate-2",
      type: "builds_on",
      explanation: "后续工作沿用前序工作",
      confidence: "0.76",
      analysisBasis: "abstract_only",
      ignoredExtraField: true
    }],
    unverified: []
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: JSON.stringify(generated) }, finish_reason: "stop" }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const result = await completeJson({
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      depth: "fast",
      system: "Return a research tree.",
      user: "Test",
      schema: initialTreeSchema,
      validate,
      normalize: data => normalizeModelOutput(data, { allowedBases: ["abstract", "metadata"], defaultBasis: "metadata" }),
      maxTokens: 1000
    });
    assert.equal(calls, 1);
    assert.equal(result.data.relations[0].type, "extends");
    assert.equal(result.data.relations[0].analysisBasis, "abstract");
    assert.equal(result.data.relations[0].confidence, 0.58);
    assert.equal("ignoredExtraField" in result.data.papers[0], false);
    assert.equal("ignoredExtraField" in result.data.relations[0], false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("single-relation AI results use the same canonical relationship contract", () => {
  const validate = new Ajv({ allErrors: true, strict: false }).compile(relationAnalysisSchema);
  const normalized = normalizeModelOutput({ type: "optimizes", explanation: "后续论文降低了前序方法的推理开销", confidence: "0.82", analysisBasis: "abstract_only" }, { allowedBases: ["fulltext", "abstract", "metadata"], defaultBasis: "abstract", forceBasis: "abstract" });
  assert.equal(normalized.type, "improves");
  assert.equal(normalized.analysisBasis, "abstract");
  assert.equal(normalized.confidence, 0.58);
  assert.equal(validate(normalized), true);
});
