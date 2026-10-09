#!/usr/bin/env tsx
// Retrieval evaluation: runs evals/retrieval-cases.ts through the real
// pipeline (in-memory providers offline; swap in real providers with env),
// reports candidate Recall@30, Precision@3, qualification precision,
// zero-result accuracy, and false-positive rate, then sweeps the relevance
// threshold 0.00-1.00 in 0.01 steps and prints the highest-recall threshold
// achieving >=95% qualification precision.
//
// Usage: npm run evaluate

import { retrievalCases } from "../evals/retrieval-cases.js";
import { defaultPipelineDeps, runSearch } from "../src/retrieval/pipeline.js";
import { applyRelevanceGate } from "../src/retrieval/rerank.js";
import { interpretQuery } from "../src/retrieval/intent.js";

interface Metrics {
  recallAt30: number;
  precisionAt3: number;
  qualPrecision: number;
  zeroResultAccuracy: number;
  falsePositiveRate: number;
}

async function evaluateAtThreshold(threshold: number): Promise<Metrics> {
  const deps = defaultPipelineDeps();
  deps.config.relevanceThreshold = threshold;
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
    const payload = await runSearch(deps, c.query, 8);
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
    }
    if (c.expectEmpty) {
      zeroTotal += 1;
      if (ids.length === 0) zeroOk += 1;
    }
    fpTotal += 1;
    if (!c.expectEmpty && ids.length > 0 && ids.every((id) => (c.grades[id] ?? 0) < 2)) fp += 1;
    if (c.expectEmpty && ids.length > 0) fp += 1;
  }

  void applyRelevanceGate;
  void interpretQuery;
  return {
    recallAt30: relevantTotal === 0 ? 1 : relevantRetrieved / relevantTotal,
    precisionAt3: p3Count === 0 ? 1 : p3Sum / p3Count,
    qualPrecision: qualTotal === 0 ? 1 : qualOk / qualTotal,
    zeroResultAccuracy: zeroTotal === 0 ? 1 : zeroOk / zeroTotal,
    falsePositiveRate: fpTotal === 0 ? 0 : fp / fpTotal,
  };
}

async function main(): Promise<void> {
  let best: { threshold: number; metrics: Metrics } | null = null;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const threshold = Math.round(t * 100) / 100;
    const m = await evaluateAtThreshold(threshold);
    if (m.qualPrecision >= 0.95 && (!best || m.recallAt30 > best.metrics.recallAt30)) {
      best = { threshold, metrics: m };
    }
  }
  if (!best) {
    console.log("No threshold reached 95% qualification precision on this case set.");
    process.exit(2);
  }
  console.log(`calibrated threshold: ${best.threshold.toFixed(2)}`);
  console.log(JSON.stringify(best.metrics, null, 2));
  const gates: Array<[string, number, number, boolean]> = [
    ["candidate Recall@30 >= 0.98", best.metrics.recallAt30, 0.98, best.metrics.recallAt30 >= 0.98],
    ["Precision@3 >= 0.85", best.metrics.precisionAt3, 0.85, best.metrics.precisionAt3 >= 0.85],
    ["qualification precision >= 0.95", best.metrics.qualPrecision, 0.95, best.metrics.qualPrecision >= 0.95],
    ["zero-result accuracy >= 0.90", best.metrics.zeroResultAccuracy, 0.9, best.metrics.zeroResultAccuracy >= 0.9],
    ["false-positive rate <= 0.05", best.metrics.falsePositiveRate, 0.05, best.metrics.falsePositiveRate <= 0.05],
  ];
  for (const [name, value, target, pass] of gates) {
    console.log(`${pass ? "PASS" : "FAIL"} ${name}: ${value.toFixed(3)} (target ${target})`);
  }
  if (gates.some((g) => !g[3])) process.exit(1);
}

void main();
