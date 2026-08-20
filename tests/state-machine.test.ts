import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldState } from '../src/core/world';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import { makeAgent, flush, StubProvider } from './helpers';
import type { WorldObject } from '../src/core/types';

const TEST_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1 },
  { id: 'obj:work', name: '工作地', type: 'building', parentId: 'obj:town', x: 5, y: 0, w: 1, h: 1 },
];

function setup(queue: (Error | { content: string; parsed?: unknown })[]) {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(TEST_OBJECTS, [agent]);
  const gateway = new LLMGateway({ provider: new StubProvider(queue), retries: 0 });
  const executor = new AgentExecutor(gateway, world, log);
  return { log, agent, executor, gateway };
}

test('全链路：思考 → 移动 → 行动 → 完成', async () => {
  const { log, agent, executor } = setup([
    { content: '', parsed: { thought: '去上班', action: { type: 'interact', target: 'obj:work', verb: '工作' }, duration_minutes: 20 } },
  ]);
  executor.progress(agent, 0, 10);   // idle → thinking
  assert.equal(agent.state, 'thinking');
  await flush();
  executor.progress(agent, 0, 10);   // 消费决策 → moving
  assert.equal(agent.state, 'moving');
  executor.progress(agent, 10, 20);  // dt=10 一步走完 → acting
  assert.equal(agent.state, 'acting');
  assert.equal(agent.actionEndsAt, 40);
  executor.progress(agent, 0, 40);   // 到点完成 → idle
  assert.equal(agent.state, 'idle');
  const evs = log.eventsForDay(1);
  assert.ok(evs.some((e) => e.type === 'interact' && e.description.includes('开始「工作」')));
  assert.ok(evs.some((e) => e.type === 'interact' && e.description.includes('完成「工作」')));
});

test('move_to 到达即完成并记录 move 事件', async () => {
  const { log, agent, executor } = setup([
    { content: '', parsed: { thought: '', action: { type: 'move_to', target: 'obj:work', verb: '去工作' }, duration_minutes: 10 } },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'moving');
  executor.progress(agent, 10, 20);
  assert.equal(agent.state, 'idle');
  assert.equal(agent.x, 5);
  assert.equal(agent.locationId, 'obj:work');
  assert.ok(log.eventsForDay(1).some((e) => e.type === 'move' && e.description.includes('到达「工作地」')));
});

test('校验失败 → 重试一次 → 仍失败降级 idle', async () => {
  const { agent, executor, gateway } = setup([
    { content: '', parsed: { action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 } },
    { content: '', parsed: { action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 } },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting');
  assert.equal(agent.action?.action.type, 'idle');
  // 网关层两次调用都成功返回（校验失败发生在执行器），计量应记录 2 次
  assert.equal(gateway.metricSummary()[0]?.calls ?? 0, 2);
});

test('interact 目标即当前所在 → 原地执行', async () => {
  const { log, agent, executor } = setup([
    { content: '', parsed: { thought: '', action: { type: 'interact', target: 'obj:home', verb: '打扫' }, duration_minutes: 10 } },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting');
  assert.equal(agent.actionEndsAt, 20);
  assert.ok(log.eventsForDay(1).some((e) => e.description.includes('开始「打扫」')));
});

test('thinking 期间不重复发起决策', async () => {
  const { agent, executor, gateway } = setup([{ content: '', parsed: { thought: '', action: { type: 'idle', target: null, verb: '休息' }, duration_minutes: 10 } }]);
  executor.progress(agent, 0, 10);
  executor.progress(agent, 0, 20);
  executor.progress(agent, 0, 30);
  assert.equal(agent.state, 'thinking');
  await flush();
  assert.equal((gateway.metricSummary()[0] ?? { calls: 0 }).calls, 1);
});

test('注入 mind 后决策提示词包含记忆与议程', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(TEST_OBJECTS, [agent]);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在咖啡馆煮咖啡招待客人', importance: 6, createdGameTime: 1 });
  const executor = new AgentExecutor(gateway, world, log, mind);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting'); // mock 无作息槽 → idle 行动
  const mems = mind.store.recentMemories('agent:1', 5);
  assert.ok(mems.some((m) => m.content.includes('煮咖啡')));
  assert.equal(mems[0].lastAccessGameTime, 10); // 检索更新了 last_access
});
