// 涌现指标：伙伴选择预实验与涌现控制台的共享测量函数（纯函数，可 node 测试）

export interface Choice { day: number; from: string; to: string }

export function dailyMatrix(choices: Choice[], ids: string[]): Map<number, Map<string, number>> {
  const idx = new Map(ids.map((n, i) => [n, i]));
  const byDay = new Map<number, Map<string, number>>();
  for (const c of choices) {
    const a = idx.get(c.from);
    const b = idx.get(c.to);
    if (a === undefined || b === undefined) continue; // 仅记录已知参与者的选择
    const day = byDay.get(c.day) ?? new Map<string, number>();
    const key = `${a}:${b}`;
    day.set(key, (day.get(key) ?? 0) + 1);
    byDay.set(c.day, day);
  }
  return byDay;
}

export function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
export function std(values: number[]): number {
  const m = avg(values);
  return Math.sqrt(avg(values.map((v) => (v - m) ** 2)));
}

/** 同对重复率：昨日互动过的对，今日仍互动的比例 */
export function repeatRate(byDay: Map<number, Map<string, number>>): number[] {
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = new Set(byDay.get(days[i - 1])!.keys());
    const cur = new Set(byDay.get(days[i])!.keys());
    if (!prev.size) continue;
    out.push([...cur].filter((k) => prev.has(k)).length / prev.size);
  }
  return out;
}

/** 互惠性（相对基线）：A 昨日选 B，今日 B 选 A 的概率 / 当日基线概率 */
export function reciprocity(choices: Choice[]): number[] {
  const byDay = new Map<number, Choice[]>();
  for (const c of choices) {
    const day = byDay.get(c.day) ?? [];
    day.push(c);
    byDay.set(c.day, day);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const prev = byDay.get(days[i - 1])!;
    const cur = byDay.get(days[i])!;
    if (cur.length < 2) continue;
    const base = new Map<string, number>();
    for (const c of cur) base.set(c.to, (base.get(c.to) ?? 0) + 1);
    const baseP = (to: string) => (base.get(to) ?? 0) / cur.length;
    const recips: number[] = [];
    for (const c of prev) {
      if (cur.some((x) => x.from === c.to && x.to === c.from)) recips.push(1 / (baseP(c.from) * cur.length));
    }
    if (recips.length) out.push(avg(recips));
  }
  return out;
}

/** 聚类系数（无向）：三角数 / 三元组数 */
export function clustering(byDay: Map<number, Map<string, number>>, n: number): number[] {
  const out: number[] = [];
  for (const m of byDay.values()) {
    const adj: Set<number>[] = Array.from({ length: n }, () => new Set());
    for (const k of m.keys()) {
      const [a, b] = k.split(':').map(Number);
      adj[a].add(b);
      adj[b].add(a);
    }
    let triangles = 0;
    let triples = 0;
    for (const [, nb] of adj.entries()) {
      const list = [...nb];
      triples += (list.length * (list.length - 1)) / 2;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (adj[list[i]].has(list[j])) triangles++;
        }
      }
    }
    out.push(triples ? triangles / triples : 0);
  }
  return out;
}

/** 伙伴多样性：滚动窗口内每位 agent 的独立伙伴数 */
export function diversity(byDay: Map<number, Map<string, number>>, n: number, window = 7): number[] {
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let d = 0; d < days.length; d++) {
    const windowPairs = new Map<string, number>();
    for (let w = Math.max(0, d - window + 1); w <= d; w++) {
      const m = byDay.get(days[w]);
      if (!m) continue;
      for (const [k, v] of m) windowPairs.set(k, (windowPairs.get(k) ?? 0) + v);
    }
    const per = Array.from({ length: n }, () => new Set<string>());
    for (const [k] of windowPairs) {
      const [a, b] = k.split(':').map(Number);
      per[a].add(String(b));
    }
    const counts = per.map((s) => s.size).filter((c) => c > 0);
    out.push(avg(counts));
  }
  return out;
}

/** 便捷汇总：由 choices 直接给出全部序列（用于 API 与 CLI） */
export function metricsOf(choices: Choice[], ids: string[]): { repeat: number[]; recip: number[]; clus: number[]; div: number[]; pairs: Map<string, number> } {
  const byDay = dailyMatrix(choices, ids);
  const pairs = new Map<string, number>();
  for (const m of byDay.values()) for (const [k, v] of m) pairs.set(k, (pairs.get(k) ?? 0) + v);
  return {
    repeat: repeatRate(byDay),
    recip: reciprocity(choices),
    clus: clustering(byDay, ids.length),
    div: diversity(byDay, ids.length),
    pairs,
  };
}
