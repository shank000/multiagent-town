// 实验运行器单测：按绝对日界线结算天数，并保持伙伴选择轮次的跨时刻触发语义
import test from 'node:test';
import assert from 'node:assert/strict';
import { MINUTES_PER_DAY } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { ExperimentRunner } from '../src/engine/experiment-runner';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const mind = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log });
  const runner = new ExperimentRunner(log, world, mind, { historyAccess: 'off', giftExchange: 'off' });
  return { log, world, runner };
}

function choiceTimes(log: EventLog): number[] {
  return log.eventsBetween(0, Number.MAX_SAFE_INTEGER)
    .filter((event) => (event.payload as { kind?: string } | null)?.kind === 'experiment_pair_choice')
    .map((event) => event.gameTime);
}

function tickBy(runner: ExperimentRunner, from: number, through: number, step: number): void {
  for (let now = from + step; now <= through; now += step) runner.tick(now);
}

test('30 分钟 tick：每个日界线只扣一天，19:30 准时触发选择轮次', () => {
  const { log, world, runner } = setup();
  runner.start(2, 0);

  tickBy(runner, 0, MINUTES_PER_DAY, 30);
  assert.deepEqual(runner.state(), { running: true, remainingDays: 1, mem: 'off', gift: 'off' });
  assert.deepEqual(choiceTimes(log), Array(world.allAgents().length).fill(1170));

  tickBy(runner, MINUTES_PER_DAY, 2 * MINUTES_PER_DAY, 30);
  assert.deepEqual(runner.state(), { running: false, remainingDays: 0, mem: 'off', gift: 'off' });
  assert.deepEqual(choiceTimes(log), [
    ...Array(world.allAgents().length).fill(1170),
    ...Array(world.allAgents().length).fill(MINUTES_PER_DAY + 1170),
  ]);
});

test('180 分钟 tick：跨过 19:30 时仍按原有时刻触发，日界线结算不漏扣', () => {
  const { log, world, runner } = setup();
  runner.start(2, 0);

  tickBy(runner, 0, 2 * MINUTES_PER_DAY, 180);

  assert.deepEqual(runner.state(), { running: false, remainingDays: 0, mem: 'off', gift: 'off' });
  assert.deepEqual(choiceTimes(log), [
    ...Array(world.allAgents().length).fill(1260),
    ...Array(world.allAgents().length).fill(MINUTES_PER_DAY + 1260),
  ]);
});

test('同一天内重复 tick 不重复扣减', () => {
  const { runner } = setup();
  runner.start(3, 100);

  for (const now of [100, 200, 1170, 1171, 1171, 1439, 1439]) runner.tick(now);

  assert.equal(runner.state().remainingDays, 3);
  assert.equal(runner.state().running, true);
});

test('跨多日跳跃按全部日界线结算并夹紧到零', () => {
  const { runner } = setup();
  runner.start(2, 100);

  runner.tick(3 * MINUTES_PER_DAY + 100);
  assert.deepEqual(runner.state(), { running: false, remainingDays: 0, mem: 'off', gift: 'off' });

  runner.tick(20 * MINUTES_PER_DAY);
  assert.equal(runner.state().remainingDays, 0);
});

test('stop 后以新的启动时刻重新建立日界线基准', () => {
  const { runner } = setup();
  runner.start(5, 200);
  runner.tick(MINUTES_PER_DAY + 200);
  assert.equal(runner.state().remainingDays, 4);

  runner.stop();
  runner.tick(10 * MINUTES_PER_DAY + 100);
  assert.deepEqual(runner.state(), { running: false, remainingDays: 0, mem: 'off', gift: 'off' });

  runner.start(2, 10 * MINUTES_PER_DAY + 100);
  runner.tick(10 * MINUTES_PER_DAY + 900);
  assert.equal(runner.state().remainingDays, 2);
  runner.tick(11 * MINUTES_PER_DAY);
  assert.equal(runner.state().remainingDays, 1);
  runner.tick(12 * MINUTES_PER_DAY);
  assert.deepEqual(runner.state(), { running: false, remainingDays: 0, mem: 'off', gift: 'off' });
});
