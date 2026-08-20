import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { SocialTicker } from '../src/engine/social';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('WorldLoop 集成 SocialTicker：相邻 agent 跑出 chat 事件', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:2', name: '乙', x: 0, y: 1, persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [a, b]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const social = new SocialTicker(log);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social);
  await loop.runUntil(20);
  assert.ok(log.eventsForDay(1).some((e) => e.type === 'chat'), '应产生 chat 事件');
});

test('thought 事件 payload 携带 thought 文本', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const world = new WorldState(OBJS, [a]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  await loop.runUntil(15);
  const thought = log.eventsForDay(1).find((e) => e.payload?.kind === 'thought');
  assert.ok(thought);
  assert.equal(typeof thought.payload?.thought, 'string');
});
