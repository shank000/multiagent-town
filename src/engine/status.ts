// 社会声望：Weighted PageRank + 互惠加成（Agentopia/Sociometer 机制）

import type { Relationship } from '../store/relationships';

const DAMPING = 0.85;
const ITERATIONS = 20;
const RECIPROCITY_ALPHA = 0.5;

/** 权重：喜欢与尊重的正向合并（0..1） */
function weight(r: Relationship): number {
  return (Math.max(0, r.affection) + Math.max(0, r.respect)) / 2;
}

export function computeStanding(rels: Relationship[]): Map<string, number> {
  const nodes = new Set<string>();
  for (const r of rels) {
    nodes.add(r.agentA);
    nodes.add(r.agentB);
  }
  const list = [...nodes].sort();
  const n = list.length;
  const idx = new Map(list.map((id, i) => [id, i]));
  // w[j][i] = j 对 i 的重视权重
  const w: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (const r of rels) {
    if (r.agentA === r.agentB) continue;
    w[idx.get(r.agentA)!][idx.get(r.agentB)!] = weight(r);
  }
  let score = new Array(n).fill(1 / n);
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const next = new Array(n).fill((1 - DAMPING) / n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const wji = w[j][i];
        if (wji <= 0) continue;
        const reciprocity = 1 + RECIPROCITY_ALPHA * w[i][j]; // 互惠加成
        next[i] += DAMPING * (wji * reciprocity) * score[j];
      }
    }
    const total = next.reduce((s, v) => s + v, 0);
    score = next.map((v) => (total > 0 ? v / total : 1 / n));
  }
  const out = new Map<string, number>();
  list.forEach((id, i) => out.set(id, score[i]));
  return out;
}
