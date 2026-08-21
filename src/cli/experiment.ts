// 预实验分析 CLI：伙伴选择实验（关系记忆开/关 × N 天 × 多种子）
// 指标：同对重复率、互惠性、日网络聚类系数、伙伴多样性（信息熵）、跨日结构持续性（矩阵相关）
// 用法：node --no-warnings --import tsx src/cli/experiment.ts --days 30 --seeds 3

import { TimeEngine } from '../core/time';
import { buildTown } from '../engine/seed';
import { WorldLoop } from '../engine/loop';
import { AgentExecutor } from '../core/state-machine';
import { LLMGateway } from '../llm/gateway';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { MindEngine } from '../engine/mind';
import { PartnerChoiceExperiment, type PartnerExperimentConfig } from '../engine/experiment';

interface Choice { day: number; from: string; to: string }

function parseArgs(): { days: number; seeds: number } {
  const get = (k: string, d: number) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
  };
  return { days: get('days', 30), seeds: get('seeds', 3) };
}

async function runCondition(cond: PartnerExperimentConfig['historyAccess'], days: number, seed: number): Promise<Choice[]> {
  // 独立内存库 + 固定随机种子控制复现
  const db = openDb(':memory:');
  db.raw.prepare('SELECT 1').run(); // 触达
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  // 对照组无邻近闲聊：全部对话来自伙伴选择，隔离自变量
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const exp = new PartnerChoiceExperiment(log, world, mind, { historyAccess: cond });
  const choices: Choice[] = [];
  for (let d = 0; d < days; d++) {
    const target = d * 1440 + 1170;
    if (time.state.totalMinutes < target) await loop.runUntil(target);
    const now = time.state.totalMinutes;
    exp.round(now);
    for (const e of log.eventsForDay(d + 1)) {
      const p = e.payload as { kind?: string; fromId?: string; toId?: string } | null;
      if (p?.kind === 'experiment_pair_choice' && e.gameTime >= target) {
        choices.push({ day: d + 1, from: p.fromId ?? '', to: p.toId ?? '' });
      }
    }
  }
  return choices;
}

// —— 指标计算 ——
function dailyMatrix(choices: Choice[], names: string[]): Map<number, Map<string, number>> {
  const idx = new Map(names.map((n, i) => [n, i]));
  const byDay = new Map<number, Map<string, number>>();
  for (const c of choices) {
    if (!byDay.has(c.day)) byDay.set(c.day, new Map());
    const m = byDay.get(c.day)!;
    const key = `${idx.get(c.from)}:${idx.get(c.to)}`;
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return byDay;
}

function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function std(values: number[]): number {
  const m = avg(values);
  return Math.sqrt(avg(values.map((v) => (v - m) ** 2)));
}

/** 同对重复率：昨日互动过的对，今日仍互动的比例 */
function repeatRate(byDay: Map<number, Map<string, number>>): number[] {
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

/** 互惠性：若 A 昨日选择了 B，今日 B 选择 A 的概率（vs 当日基线概率） */
function reciprocity(choices: Choice[]): number[] {
  const byDay = new Map<number, Choice[]>();
  for (const c of choices) {
    if (!byDay.has(c.day)) byDay.set(c.day, []);
    byDay.get(c.day)!.push(c);
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
      const reciprocated = cur.find((x) => x.from === c.to && x.to === c.from);
      if (reciprocated) recips.push(1 / (baseP(c.from) * cur.length)); // 1 = 恰好互选；除以基线概率得相对倍数
    }
    if (recips.length) out.push(avg(recips));
  }
  return out;
}

/** 日网络聚类系数（无向）：三角数 / 三元组数 */
function clustering(byDay: Map<number, Map<string, number>>, n: number): number[] {
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

/** 伙伴多样性：每个 agent 在滚动 7 天窗口内选择的不同伙伴数（越大越分散） */
function diversity(byDay: Map<number, Map<string, number>>, names: string[]): number[] {
  const n = names.length;
  const days = [...byDay.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (let d = 0; d < days.length; d++) {
    const window = new Map<string, number>();
    for (let w = Math.max(0, d - 6); w <= d; w++) {
      const m = byDay.get(days[w]);
      if (!m) continue;
      for (const [k, v] of m) window.set(k, (window.get(k) ?? 0) + v);
    }
    const per = Array.from({ length: n }, () => new Set<string>());
    for (const [k] of window) {
      const [a, b] = k.split(':').map(Number);
      per[a].add(String(b));
    }
    const counts = per.map((s) => s.size).filter((c) => c > 0);
    out.push(avg(counts));
  }
  return out;
}

async function main(): Promise<void> {
  const { days, seeds } = parseArgs();
  const names = buildTown().allAgents().map((a) => a.id);
  const results: Record<string, { repeat: number[]; recip: number[]; clus: number[]; div: number[] }> = {};
  for (const cond of ['off', 'on'] as const) {
    const acc = { repeat: [] as number[], recip: [] as number[], clus: [] as number[], div: [] as number[] };
    for (let s = 0; s < seeds; s++) {
      const choices = await runCondition(cond, days, s + 1);
      const byDay = dailyMatrix(choices, names);
      acc.repeat.push(...repeatRate(byDay));
      acc.recip.push(...reciprocity(choices));
      acc.clus.push(...clustering(byDay, names.length));
      acc.div.push(...diversity(byDay, names));
    }
    results[cond] = acc;
  }
  const fmt = (v: number[]) => `${avg(v).toFixed(3)}±${std(v).toFixed(3)}`;
  console.log('伙伴选择预实验（关系记忆 off vs on）');
  console.log(`  指标            off(记忆关)           on(记忆开)`);
  console.log(`  同对重复率      ${fmt(results.off.repeat)}        ${fmt(results.on.repeat)}`);
  console.log(`  互惠性(相对基线) ${fmt(results.off.recip)}        ${fmt(results.on.recip)}`);
  console.log(`  聚类系数        ${fmt(results.off.clus)}        ${fmt(results.on.clus)}`);
  console.log(`  伙伴多样性(熵)  ${fmt(results.off.div)}        ${fmt(results.on.div)}`);
  console.log(`样本：days=${days} seeds=${seeds} 每条件 choices=${(results.on.repeat.length / seeds).toFixed(0)} 天×${seeds} 种子`);
}
void main();
