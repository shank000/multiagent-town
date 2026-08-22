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

import { metricsOf, avg, std, type Choice } from '../engine/metrics';

function parseArgs(): { days: number; seeds: number } {
  const get = (k: string, d: number) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
  };
  return { days: get('days', 30), seeds: get('seeds', 3) };
}

async function runCondition(cond: PartnerExperimentConfig['historyAccess'], gift: PartnerExperimentConfig['giftExchange'], days: number, seed: number): Promise<Choice[]> {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const exp = new PartnerChoiceExperiment(
    log,
    world,
    mind,
    { historyAccess: cond, giftExchange: gift },
    { seed }
  );
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

async function main(): Promise<void> {
  const { days, seeds } = parseArgs();
  const names = buildTown().allAgents().map((a) => a.id);
  interface Cell {
    mem: string;
    gift: string;
    repeat: number[];
    recip: number[];
    clus: number[];
    div: number[];
    hhi: number[];
    persistence: number[];
    hub: number[];
  }
  const cells: Cell[] = [];
  for (const mem of ['off', 'on'] as const) {
    for (const gift of ['off', 'on'] as const) {
      const acc = {
        repeat: [] as number[],
        recip: [] as number[],
        clus: [] as number[],
        div: [] as number[],
        hhi: [] as number[],
        persistence: [] as number[],
        hub: [] as number[],
      };
      for (let s = 0; s < seeds; s++) {
        const choices = await runCondition(mem, gift, days, s + 1);
        const metrics = metricsOf(choices, names);
        acc.repeat.push(...metrics.repeat);
        acc.recip.push(...metrics.recip);
        acc.clus.push(...metrics.clus);
        acc.div.push(...metrics.div);
        acc.hhi.push(...metrics.hhi);
        acc.persistence.push(...metrics.persistence);
        acc.hub.push(...metrics.hub);
      }
      cells.push({ mem, gift, ...acc });
    }
  }
  const fmt = (v: number[]) => `${avg(v).toFixed(3)}±${std(v).toFixed(3)}`;
  const cell = (mem: string, gift: string) => cells.find((c) => c.mem === mem && c.gift === gift)!;
  console.log('伙伴选择预实验（2×2 因子：记忆 × 馈礼）');
  console.log('  指标                记忆关/无礼      记忆关/馈礼      记忆开/无礼      记忆开/馈礼');
  const rows: [string, (c: Cell) => number[]][] = [
    ['同对重复率', (c) => c.repeat],
    ['互惠性(相对基线)', (c) => c.recip],
    ['聚类系数', (c) => c.clus],
    ['伙伴多样性(7日窗口)', (c) => c.div],
    ['伙伴集中度 HHI(7日窗口)', (c) => c.hhi],
    ['跨日有向矩阵持续性', (c) => c.persistence],
    ['加权入度枢纽集中度', (c) => c.hub],
  ];
  for (const [label, fn] of rows) {
    console.log(`  ${label.padEnd(16)} ${fmt(fn(cell('off', 'off')))}  ${fmt(fn(cell('off', 'on')))}  ${fmt(fn(cell('on', 'off')))}  ${fmt(fn(cell('on', 'on')))}`);
  }
  console.log(`样本：days=${days} seeds=${seeds} × 4 格子`);
}
void main();
