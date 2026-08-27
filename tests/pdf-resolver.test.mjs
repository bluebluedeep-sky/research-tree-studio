import test from "node:test";
import assert from "node:assert/strict";
import { directPdfCandidates } from "../server/paper-resolver.mjs";

test("common scholarly landing pages resolve to direct PDF candidates", () => {
  assert.deepEqual(directPdfCandidates("https://arxiv.org/abs/2401.01234"), ["https://arxiv.org/pdf/2401.01234.pdf"]);
  assert.deepEqual(directPdfCandidates("https://openreview.net/forum?id=paper-id"), ["https://openreview.net/pdf?id=paper-id"]);
  assert.deepEqual(directPdfCandidates("https://proceedings.neurips.cc/paper_files/paper/2023/hash/abc-Abstract.html"), ["https://proceedings.neurips.cc/paper_files/paper/2023/hash/abc-Paper.pdf"]);
  assert.deepEqual(directPdfCandidates("https://proceedings.iclr.cc/paper_files/paper/2025/hash/abc-Abstract-Conference.html"), ["https://proceedings.iclr.cc/paper_files/paper/2025/hash/abc-Paper-Conference.pdf"]);
  assert.deepEqual(directPdfCandidates("https://proceedings.mlr.press/v235/tang24l.html"), ["https://proceedings.mlr.press/v235/tang24l/tang24l.pdf"]);
});
