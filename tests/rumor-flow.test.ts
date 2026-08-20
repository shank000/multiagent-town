import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { RelationshipStore } from '../src/store/relationships';
import { RumorTracker } from '../src/engine/rumors';
import { DialogueEngine } from '../src/engine/dialogue';
import { WorldState } from '../src/core/world';
import { LLMGateway } from '../src/llm/gateway';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [{ id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 }];

test('选择性披露：关系 ≥0.3 且带谣言时传播并失真', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const rels = new RelationshipStore(db);
  const rumors = new RumorTracker(db);
  const a = makeAgent({ id: 'agent:a', name: '甲', persona: persona({ name: '甲', greetingPool: ['你好呀！', '今天不错。'] }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', persona: persona({ name: '乙', greetingPool: ['你好！', '是呀。'] }) });
  const world = new WorldState(OBJS, [a, b]);
  rels.update('agent:a', 'agent:b', { affectionDelta: 0.2, respectDelta: 0.1 }); // 0.2 ≥ 0.3? 不足——再 +0.2
  rels.update('agent:a', 'agent:b', { affectionDelta: 0.2, respectDelta: 0.1 }); // 0.4 ≥ 0.3 ✓
  const rid = rumors.seed('agent:a', '湖边埋着宝藏', 100);
  const d = new DialogueEngine(new LLMGateway({ provider: 'mock' }), store, log, 12, rels, rumors);
  d.start(a, b, 110);
  await flush();
  for (let now = 112; now <= 200; now += 2) { d.tick(world, 2, now); await flush(); }
  const carriers = rumors.carriersOf(rid);
  assert.ok(carriers.includes('agent:b'), `乙应听到谣言：${carriers.join(',')}`);
  assert.ok(rumors.rows().some((r) => r.content.includes('宝藏') && r.carrierAgent === 'agent:b'));
});
