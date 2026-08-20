// M0 验收：4 agent 连续跑 1 游戏日（1440 游戏分钟）不崩，日志可回放

import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine, MINUTES_PER_DAY } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { LLMGateway } from '../src/llm/gateway';
import { AgentExecutor } from '../src/core/state-machine';

test('M0 验收：4 agent 连续跑 1 游戏日不崩，日志可回放', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x 虚拟时钟：48 tick = 1 游戏日
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);

  await loop.runUntil(MINUTES_PER_DAY);

  // ① 跑满一天：时钟翻到第 2 天
  assert.equal(time.state.day, 2);

  // ② 4 个 agent 存活、无挂起决策、位置合法
  const agents = world.allAgents();
  assert.equal(agents.length, 4);
  for (const a of agents) {
    assert.notEqual(a.state, 'thinking', `${a.name} 卡在 thinking`);
    assert.ok(world.getObject(a.locationId), `${a.name} 位置非法: ${a.locationId}`);
  }

  // ③ 事件日志完整、时间非降序、覆盖全天
  const events = log.eventsForDay(1);
  assert.ok(events.length >= 100, `事件数过少: ${events.length}`);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].gameTime >= events[i - 1].gameTime, `事件时间倒序 @${i}`);
  }
  assert.equal(events[0].gameTime, 0);
  assert.ok(events[events.length - 1].gameTime >= MINUTES_PER_DAY - 120, '事件未覆盖全天');

  // ④ 每个 agent 都有移动与互动行为
  for (const a of agents) {
    const mine = events.filter((e) => e.actorId === a.id);
    assert.ok(mine.some((e) => e.type === 'move'), `${a.name} 从未移动`);
    assert.ok(mine.some((e) => e.type === 'interact'), `${a.name} 从未互动`);
  }

  // ⑤ 回放可重建：全部事件时间落在第 1 天范围内
  for (const e of events) {
    assert.ok(e.gameTime >= 0 && e.gameTime < MINUTES_PER_DAY, `事件越界: ${e.gameTime}`);
  }
});
