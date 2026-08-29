// 预实验分析 CLI：伙伴选择实验（关系记忆开/关 × N 天 × 多种子）
// 指标：有向边重复率、互惠性、日网络聚类、伙伴多样性、集中度与双 7 日结构持续性。
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

function parseArgs(): { days: number; seeds: number; format: 'table' | 'json' } {
  const get = (k: string, d: number) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : d;
  };
  const days = get('days', 30);
  const seeds = get('seeds', 3);
  if (!Number.isSafeInteger(days) || days <= 0 || days > 365) throw new Error('--days must be an integer in [1, 365]');
  if (!Number.isSafeInteger(seeds) || seeds <= 0 || seeds > 100) throw new Error('--seeds must be an integer in [1, 100]');
  const formatIndex = process.argv.indexOf('--format');
  const rawFormat = formatIndex >= 0 ? process.argv[formatIndex + 1] : 'table';
  if (rawFormat !== 'table' && rawFormat !== 'json') throw new Error('--format must be table or json');
  return { days, seeds, format: rawFormat };
}

async function runCondition(cond: PartnerExperimentConfig['historyAccess'], gift: PartnerExperimentConfig['giftExchange'], days: number, seed: number): Promise<Choice[]> {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(180);
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
    exp.round(target);
    for (const e of log.eventsForDay(d + 1)) {
      const p = e.payload as { kind?: string; fromId?: string; toId?: string } | null;
      if (p?.kind === 'experiment_pair_choice' && e.gameTime >= target) {
        choices.push({ day: d + 1, from: p.fromId ?? '', to: p.toId ?? '' });
      }
    }
  }
  await gateway.drain();
  await mind.dispose();
  db.raw.close();
  return choices;
}

async function main(): Promise<void> {
  const { days, seeds, format } = parseArgs();
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
        acc.repeat.push(avg(metrics.repeat));
        acc.recip.push(avg(metrics.recip));
        acc.clus.push(avg(metrics.clus));
        acc.div.push(avg(metrics.div));
        acc.hhi.push(avg(metrics.hhi));
        acc.persistence.push(avg(metrics.persistence));
        acc.hub.push(avg(metrics.hub));
      }
      cells.push({ mem, gift, ...acc });
    }
  }
  const fmt = (v: number[]) => `${avg(v).toFixed(3)}±${std(v).toFixed(3)}`;
  const cell = (mem: string, gift: string) => cells.find((c) => c.mem === mem && c.gift === gift)!;
  if (format === 'json') {
    console.log(JSON.stringify({
      schemaVersion: 'local-reference-pilot/v1',
      evidenceLevel: 'local_reference_positive_control',
      days,
      seeds: Array.from({ length: seeds }, (_, index) => index + 1),
      aggregation: 'each metric is averaged over valid days within each independent seed run',
      cells,
    }, null, 2));
    return;
  }
  console.log('伙伴选择预实验（2×2 因子：记忆 × 馈礼）');
  console.log('  指标                记忆关/无礼      记忆关/馈礼      记忆开/无礼      记忆开/馈礼');
  const rows: [string, (c: Cell) => number[]][] = [
    ['同对重复率', (c) => c.repeat],
    ['互惠性(相对基线)', (c) => c.recip],
    ['聚类系数', (c) => c.clus],
    ['伙伴多样性(7日窗口)', (c) => c.div],
    ['伙伴集中度 HHI(7日窗口)', (c) => c.hhi],
    ['双7日矩阵持续性', (c) => c.persistence],
    ['加权入度枢纽集中度', (c) => c.hub],
  ];
  for (const [label, fn] of rows) {
    console.log(`  ${label.padEnd(16)} ${fmt(fn(cell('off', 'off')))}  ${fmt(fn(cell('off', 'on')))}  ${fmt(fn(cell('on', 'off')))}  ${fmt(fn(cell('on', 'on')))}`);
  }
  console.log(`样本：days=${days}，每格独立 seed run n=${seeds}；± 为 seed 级时间均值的总体标准差`);
}
void main();
