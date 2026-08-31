import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { startLoopGroup, stopLoopGroup, WorldLoop } from '../src/engine/loop';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { LLMGateway } from '../src/llm/gateway';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldState } from '../src/core/world';
import type { LLMProvider, LLMResponse } from '../src/llm/types';
import type { WorldObject } from '../src/core/types';
import { makeAgent } from './helpers';

test('种子小镇：6 个 agent、对象树完整、出生在家', () => {
  const world = buildTown();
  assert.equal(world.allAgents().length, 6);
  assert.ok(world.hasObject('obj:cafe_counter'));
  assert.ok(world.hasObject('obj:post_office'));
  for (const a of world.allAgents()) {
    assert.equal(a.locationId, a.homeObjectId);
    assert.ok(world.getObject(a.locationId));
  }
});

test('runUntil 推进时钟、产出事件、agent 不卡在 thinking', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  await loop.runUntil(60);
  assert.equal(time.state.totalMinutes, 60);
  assert.equal(db.getMeta('game_time'), '60');
  const evs = log.eventsForDay(1);
  assert.equal(evs[0].description, '第1天开始，小镇从晨光中醒来。');
  assert.ok(evs.length > 3);
  for (const a of world.allAgents()) assert.notEqual(a.state, 'thinking');
});

test('Mock 决策保留下一 tick 离散轨迹，不把模拟时龄判为过期', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 4, h: 4 },
    {
      id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1,
      affordances: [{ verb: '打扫', outcome: '保持整洁' }],
    },
  ];
  const agent = makeAgent({ id: 'agent:1', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(objects, [agent]);
  const executor = new AgentExecutor(new LLMGateway({ provider: 'mock' }), world, log);
  const time = new TimeEngine(30);
  const loop = new WorldLoop(time, world, executor, log, db);

  await loop.step();
  assert.equal(time.state.totalMinutes, 30);
  assert.equal(agent.state, 'thinking', 'Mock 响应应在下一 tick 消费');

  await loop.step();
  assert.equal(time.state.totalMinutes, 60);
  assert.notEqual(agent.state, 'thinking');
  assert.equal(
    log.eventsForDay(1).some((event) => event.payload?.kind === 'action_decision_quality'
      && event.payload?.status === 'stale_rejected'),
    false,
  );
  db.raw.close();
});

test('真实异步模式的快速响应在请求时刻结算', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 4, h: 4 },
    {
      id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1,
      affordances: [{ verb: '打扫', outcome: '保持整洁' }],
    },
  ];
  const agent = makeAgent({ id: 'agent:1', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(objects, [agent]);
  const provider: LLMProvider = {
    name: 'immediate-real-mode',
    async complete(): Promise<LLMResponse> {
      return {
        content: '',
        parsed: {
          thought: '打扫住处',
          action: { type: 'interact', target: 'obj:home', verb: '打扫' },
          duration_minutes: 10,
        },
        usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 },
      };
    },
  };
  const executor = new AgentExecutor(new LLMGateway({ provider, retries: 0 }), world, log);
  const time = new TimeEngine(30);
  const loop = new WorldLoop(time, world, executor, log, db);

  await loop.step();
  assert.equal(time.state.totalMinutes, 30);
  assert.equal(agent.state, 'acting');
  assert.equal(agent.action?.action.verb, '打扫');
  db.raw.close();
});

test('过期响应重取在无外层时间治理器时冻结时钟，避免粗 tick 活锁', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 4, h: 4 },
    {
      id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1,
      affordances: [{ verb: '打扫', outcome: '保持整洁' }],
    },
  ];
  const agent = makeAgent({ id: 'agent:1', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(objects, [agent]);
  const response = (): LLMResponse => ({
    content: '',
    parsed: { thought: '打扫住处', action: { type: 'interact', target: 'obj:home', verb: '打扫' }, duration_minutes: 10 },
    usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 },
  });
  let calls = 0;
  let releaseRetry: (() => void) | undefined;
  const provider: LLMProvider = {
    name: 'deferred-retry',
    async complete() {
      calls++;
      if (calls === 1) return response();
      return new Promise<LLMResponse>((resolve) => {
        releaseRetry = () => resolve(response());
      });
    },
  };
  const executor = new AgentExecutor(new LLMGateway({ provider, retries: 0 }), world, log);
  const time = new TimeEngine(30);
  const loop = new WorldLoop(time, world, executor, log, db);

  await loop.step({ awaitDecisions: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await loop.step({ awaitDecisions: false });
  assert.equal(time.state.totalMinutes, 60);
  assert.equal(calls, 2);

  await loop.step();
  assert.equal(time.state.totalMinutes, 60, '替代决策未落定时不得推进虚拟时间');
  releaseRetry?.();
  await executor.drain();
  await loop.step();
  assert.equal(time.state.totalMinutes, 60, '替代决策在同一虚拟时刻结算');
  assert.equal(agent.action?.action.verb, '打扫');

  await loop.step({ awaitDecisions: false });
  assert.equal(time.state.totalMinutes, 90);
  db.raw.close();
});

test('跨天写第2天开始事件', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  await loop.runUntil(1440 + 30);
  const day2 = log.eventsForDay(2);
  assert.ok(day2.some((e) => e.description === '第2天开始。'));
});

test('实时循环在认知背压期间冻结虚拟时钟，解除后继续推进', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  let blocked = true;
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, undefined, undefined, {
    isBackpressured: () => blocked,
  });
  try {
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(time.state.totalMinutes, 0);
    blocked = false;
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.ok(time.state.totalMinutes >= 30);
  } finally {
    loop.stop();
    await loop.drain();
    db.raw.close();
  }
});

test('平行世界协调器在推进与背压批次中保持时钟严格一致', async () => {
  let blocked = false;
  const records = Array.from({ length: 3 }, () => {
    const db = openDb(':memory:');
    const log = new EventLog(db);
    const world = buildTown();
    const time = new TimeEngine(30);
    const gateway = new LLMGateway({ provider: 'mock' });
    const loop = new WorldLoop(time, world, new AgentExecutor(gateway, world, log), log, db, {}, undefined, undefined, undefined, {
      isBackpressured: () => blocked,
    });
    return { db, time, loop };
  });
  const loops = records.map((record) => record.loop);
  try {
    startLoopGroup(loops);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(records.map((record) => record.time.state.totalMinutes), [30, 30, 30]);
    blocked = true;
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(records.map((record) => record.time.state.totalMinutes), [30, 30, 30]);
    blocked = false;
    await new Promise((resolve) => setTimeout(resolve, 650));
    const totals = records.map((record) => record.time.state.totalMinutes);
    assert.ok(totals[0] > 30);
    assert.deepEqual(totals, [totals[0], totals[0], totals[0]]);
  } finally {
    stopLoopGroup(loops);
    await Promise.all(loops.map((loop) => loop.drain()));
    for (const record of records) record.db.raw.close();
  }
});
