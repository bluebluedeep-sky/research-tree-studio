import test from "node:test";
import assert from "node:assert/strict";
import { paperAnalysisSchema, initialTreeSchema } from "../server/schemas.mjs";

test("structured output schemas are strict at the root", () => {
  assert.equal(paperAnalysisSchema.additionalProperties, false);
  assert.equal(initialTreeSchema.additionalProperties, false);
  assert.ok(paperAnalysisSchema.required.includes("relations"));
  assert.ok(initialTreeSchema.required.includes("papers"));
});

test("all relation types are represented", () => {
  const types = paperAnalysisSchema.properties.relations.items.properties.type.enum;
  for (const value of ["extends", "improves", "replaces", "combines", "contrasts", "inspires", "migrates_problem"]) assert.ok(types.includes(value));
});
