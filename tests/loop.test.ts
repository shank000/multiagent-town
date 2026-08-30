import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { startLoopGroup, stopLoopGroup, WorldLoop } from '../src/engine/loop';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { LLMGateway } from '../src/llm/gateway';
import { AgentExecutor } from '../src/core/state-machine';

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
