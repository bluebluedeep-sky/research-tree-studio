const relationType = {
  type: "string",
  enum: ["extends", "improves", "replaces", "combines", "contrasts", "inspires", "migrates_problem"]
};

export const relationAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: relationType,
    explanation: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    analysisBasis: { type: "string", enum: ["fulltext", "abstract", "metadata"] }
  },
  required: ["type", "explanation", "confidence", "analysisBasis"]
};

export const paperAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    paper: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        titleZh: { type: "string" },
        authors: { type: "string" },
        year: { type: "integer" },
        venue: { type: "string" },
        url: { type: "string" },
        problem: { type: "string" },
        method: { type: "string" },
        contribution: { type: "string" },
        analysisBasis: { type: "string", enum: ["fulltext", "abstract", "metadata"] },
        analysisConfidence: { type: "number", minimum: 0, maximum: 1 }
      },
      required: ["title", "titleZh", "authors", "year", "venue", "url", "problem", "method", "contribution", "analysisBasis", "analysisConfidence"]
    },
    placement: {
      type: "object",
      additionalProperties: false,
      properties: {
        trunkId: { type: "string" },
        branchId: { type: "string" },
        branchName: { type: "string" },
        createNewBranch: { type: "boolean" },
        reason: { type: "string" },
        confidence: { type: "number" }
      },
      required: ["trunkId", "branchId", "branchName", "createNewBranch", "reason", "confidence"]
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetPaperId: { type: "string" },
          targetTitle: { type: "string" },
          type: relationType,
          direction: { type: "string", enum: ["from_target_to_new", "from_new_to_target"] },
          explanation: { type: "string" },
          confidence: { type: "number" },
          analysisBasis: { type: "string", enum: ["fulltext", "abstract", "metadata"] }
        },
        required: ["targetPaperId", "targetTitle", "type", "direction", "explanation", "confidence", "analysisBasis"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["paper", "placement", "relations", "warnings"]
};

const seedPaper = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" }, title: { type: "string" }, titleZh: { type: "string" }, authors: { type: "string" },
    year: { type: "integer" }, venue: { type: "string" }, url: { type: "string" }, problem: { type: "string" },
    method: { type: "string" }, contribution: { type: "string" }, branchId: { type: "string" }, confidence: { type: "number" },
    analysisBasis: { type: "string", enum: ["abstract", "metadata"] }, analysisConfidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["id", "title", "titleZh", "authors", "year", "venue", "url", "problem", "method", "contribution", "branchId", "confidence", "analysisBasis", "analysisConfidence"]
};

export const initialTreeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    branches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string" }, name: { type: "string" }, question: { type: "string" }, color: { type: "string" } },
        required: ["id", "name", "question", "color"]
      }
    },
    papers: { type: "array", items: seedPaper },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { sourceId: { type: "string" }, targetId: { type: "string" }, type: relationType, explanation: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, analysisBasis: { type: "string", enum: ["abstract", "metadata"] } },
        required: ["sourceId", "targetId", "type", "explanation", "confidence", "analysisBasis"]
      }
    },
    unverified: { type: "array", items: { type: "string" } }
  },
  required: ["name", "description", "branches", "papers", "relations", "unverified"]
};
