import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { MemoryWriter } from '../src/engine/memory-writer';
import { flush } from './helpers';
import type { GameEvent } from '../src/core/types';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const writer = new MemoryWriter(store, new LLMGateway({ provider: 'mock' }));
  writer.attach(log);
  return { log, store };
}

test('动作事件 → 主角观察记忆', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 600, '林晚晴 开始「煮咖啡」，约 15 分钟', 'interact', 'agent:林晚晴'));
  await flush();
  const mems = store.recentMemories('agent:林晚晴', 10);
  assert.equal(mems.length, 1);
  assert.ok(mems[0].content.startsWith('第1天 10:00，'));
  assert.equal(mems[0].kind, 'observation');
});

test('chat 事件双方都记；day_start 与 thought 跳过', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 700, '「林晚晴」对「陈默」说：「你好呀！」', 'chat', 'agent:林晚晴', { kind: 'chat', line: '你好呀！', fromId: 'agent:林晚晴', toId: 'agent:陈默' }));
  log.addEvent(ev('e2', 701, '第1天开始。', 'system', null, { kind: 'day_start' }));
  log.addEvent(ev('e3', 702, '林晚晴 心想：「休息」', 'system', 'agent:林晚晴', { kind: 'thought', thought: '休息' }));
  await flush();
  assert.ok(store.countFor('agent:林晚晴') >= 1);
  assert.ok(store.countFor('agent:陈默') >= 1);
  assert.ok(!store.recentMemories('agent:林晚晴', 20).some((m) => m.content.includes('心想')));
  assert.ok(!store.recentMemories('agent:林晚晴', 20).some((m) => m.content.includes('第1天开始')));
});

test('importance 经 mock 打分（派对→9）', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 800, '林晚晴 广播「今晚湖边派对！」', 'broadcast', 'agent:林晚晴'));
  await flush();
  assert.equal(store.recentMemories('agent:林晚晴', 1)[0].importance, 9);
});

test('reflection 事件与非 agent 事件不写库', async () => {
  const { log, store } = setup();
  // 反思已由引擎直接写入 insight，事件不再重复入库
  log.addEvent(ev('e1', 900, '林晚晴 反思自己。', 'system', 'agent:林晚晴', { kind: 'reflection', insights: ['我最近常去咖啡馆。'] }));
  // 非 agent：obj:cafe 无 agent 参与，不打分不写库
  log.addEvent(ev('e2', 901, '咖啡馆 开始营业。', 'system', 'obj:cafe'));
  await flush();
  assert.equal(store.countFor('agent:林晚晴'), 0);
  assert.equal(store.recentMemories('agent:林晚晴', 10).length, 0);
});

function ev(id: string, gameTime: number, description: string, type: GameEvent['type'], actorId: string | null, payload: Record<string, unknown> | null = null): GameEvent {
  return { id, type, actorId, targetIds: [], description, location: 'obj:cafe', gameTime, payload };
}
