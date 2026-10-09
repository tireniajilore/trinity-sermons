#!/usr/bin/env tsx
// Retrieval evaluation: runs evals/retrieval-cases.ts through the real
// pipeline (in-memory providers offline) and reports candidate Recall@30,
// Precision@3, qualification precision, zero-result accuracy, and
// false-positive rate against the release gates. The pipeline is
// deterministic (no reranker to calibrate), so there is no threshold sweep —
// the overlap floor lives in config/retrieval.json and is tuned by hand
// against this set.
//
// Usage: npm run evaluate

import { retrievalCases } from "../evals/retrieval-cases.js";
import { defaultPipelineDeps, runSearch } from "../src/retrieval/pipeline.js";

async function main(): Promise<void> {
  const deps = defaultPipelineDeps();
  let relevantRetrieved = 0;
  let relevantTotal = 0;
  let p3Sum = 0;
  let p3Count = 0;
  let qualOk = 0;
  let qualTotal = 0;
  let zeroOk = 0;
  let zeroTotal = 0;
  let fp = 0;
  let fpTotal = 0;

  for (const c of retrievalCases) {
    const payload = await runSearch(deps, c.query, 8, "strict");
    const ids = payload.results.map((r) => r.sermonId);
    const relevant = Object.entries(c.grades)
      .filter(([, g]) => g >= 2)
      .map(([id]) => id);
    relevantTotal += relevant.length;
    relevantRetrieved += relevant.filter((id) => ids.includes(id)).length;

    const top3 = ids.slice(0, 3);
    if (top3.length > 0) {
      p3Sum += top3.filter((id) => (c.grades[id] ?? 0) >= 2).length / top3.length;
      p3Count += 1;
    }
    for (const id of ids) {
      qualTotal += 1;
      if ((c.grades[id] ?? 0) >= 2) qualOk += 1;
      else console.log(`  FP [${c.id}]: ${id} (grade ${c.grades[id] ?? 0})`);
    }
    if (c.expectEmpty) {
      zeroTotal += 1;
      if (ids.length === 0) zeroOk += 1;
      else console.log(`  ZERO-FAIL [${c.id}]: returned ${ids.join(",")}`);
    } else {
      const missing = relevant.filter((id) => !ids.includes(id));
      if (missing.length > 0) console.log(`  MISS [${c.id}]: ${missing.join(",")}`);
    }
    fpTotal += 1;
    if (ids.length > 0 && ids.every((id) => (c.grades[id] ?? 0) < 2)) fp += 1;
  }

  const metrics = {
    recallAt30: relevantTotal === 0 ? 1 : relevantRetrieved / relevantTotal,
    precisionAt3: p3Count === 0 ? 1 : p3Sum / p3Count,
    qualPrecision: qualTotal === 0 ? 1 : qualOk / qualTotal,
    zeroResultAccuracy: zeroTotal === 0 ? 1 : zeroOk / zeroTotal,
    falsePositiveRate: fpTotal === 0 ? 0 : fp / fpTotal,
  };
  console.log(JSON.stringify(metrics, null, 2));
  const gates: Array<[string, number, number, boolean]> = [
    ["candidate Recall@30 >= 0.98", metrics.recallAt30, 0.98, metrics.recallAt30 >= 0.98],
    ["Precision@3 >= 0.85", metrics.precisionAt3, 0.85, metrics.precisionAt3 >= 0.85],
    ["qualification precision >= 0.95", metrics.qualPrecision, 0.95, metrics.qualPrecision >= 0.95],
    ["zero-result accuracy >= 0.90", metrics.zeroResultAccuracy, 0.9, metrics.zeroResultAccuracy >= 0.9],
    ["false-positive rate <= 0.05", metrics.falsePositiveRate, 0.05, metrics.falsePositiveRate <= 0.05],
  ];
  for (const [name, value, target, pass] of gates) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${value.toFixed(3)} (target ${target})`);
  }
  if (gates.some((g) => !g[3])) process.exit(1);
}

void main();
