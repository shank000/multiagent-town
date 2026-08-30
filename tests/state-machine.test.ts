import test from 'node:test';
import assert from 'node:assert/strict';
import { actionDecisionJsonSchema, AgentExecutor } from '../src/core/state-machine';
import { WorldState } from '../src/core/world';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { LLMGateway } from '../src/llm/gateway';
import { MindEngine } from '../src/engine/mind';
import type { ChatMessage, LLMProvider } from '../src/llm/types';
import { makeAgent, flush, persona, StubProvider } from './helpers';
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
  const provider = new StubProvider(queue);
  const gateway = new LLMGateway({ provider, retries: 0 });
  const executor = new AgentExecutor(gateway, world, log);
  return { log, agent, executor, gateway, provider };
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

test('睡眠作息保护阻止午夜模型决策改写为白天活动', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    ...TEST_OBJECTS,
    { id: 'obj:bed', name: '床', type: 'furniture', parentId: 'obj:home', x: 1, y: 0, w: 1, h: 1 },
  ];
  const agent = makeAgent({
    id: 'agent:sleeper',
    persona: persona({ routine: [{ from: 0, to: 420, type: 'interact', target: 'obj:bed', verb: '睡觉' }] }),
  });
  const world = new WorldState(objects, [agent]);
  const gateway = new LLMGateway({
    provider: new StubProvider([{
      content: '',
      parsed: { thought: '去白天工作', action: { type: 'move_to', target: 'obj:work', verb: '去工作' }, duration_minutes: 10 },
    }]),
    retries: 0,
  });
  const executor = new AgentExecutor(gateway, world, log);

  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);

  assert.equal(agent.state, 'moving');
  assert.equal(agent.action?.action.target, 'obj:bed');
  assert.match(agent.thought ?? '', /睡觉时段/);
});

test('校验失败会携带原因重试，仍失败时使用叙事安全的 idle', async () => {
  const { log, agent, executor, gateway, provider } = setup([
    { content: '', parsed: { action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 } },
    { content: '', parsed: { action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 } },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting');
  assert.equal(agent.action?.action.type, 'idle');
  assert.doesNotMatch(agent.thought ?? '', /动作目标不存在|不能带目标/);
  assert.match(provider.requests[1]?.messages.at(-1)?.content ?? '', /动作目标不存在：obj:mars/);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'safe_fallback');
  assert.equal(diagnostic?.payload?.attempts, 2);
  const thought = log.eventsForDay(1).find((event) => event.payload?.kind === 'thought');
  assert.equal((thought?.payload?.decisionQuality as { status?: string } | undefined)?.status, 'safe_fallback');
  // 网关层两次调用都成功返回（校验失败发生在执行器），计量应记录 2 次
  assert.equal(gateway.metricSummary()[0]?.calls ?? 0, 2);
});

test('idle 携带目标会保留人物意图并规范化，不触发重复模型调用', async () => {
  const { log, agent, executor, gateway } = setup([{
    content: '',
    parsed: {
      thought: '忙完后想在家里歇一会儿',
      action: { type: 'idle', target: 'obj:home', verb: '休息' },
      duration_minutes: 10,
    },
  }]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.action?.action.type, 'idle');
  assert.equal(agent.action?.action.target, null);
  assert.equal(agent.thought, '忙完后想在家里歇一会儿');
  assert.equal(gateway.metricSummary()[0]?.calls, 1);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'normalized');
  assert.match(String((diagnostic?.payload?.reasons as string[] | undefined)?.[0]), /规范为 null/);
  assert.ok(!log.eventsForDay(1).some((event) => event.description.includes('idle 不能带目标')));
});

test('首次无效、反馈重试有效时采用修正动作并记录 repaired', async () => {
  const { log, agent, executor, provider } = setup([
    { content: '', parsed: { action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 } },
    {
      content: '',
      parsed: { thought: '去工作地工作', action: { type: 'interact', target: 'obj:work', verb: '工作' }, duration_minutes: 10 },
    },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.action?.action.target, 'obj:work');
  assert.match(provider.requests[1]?.messages.at(-1)?.content ?? '', /只修正 JSON/);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'repaired');
  assert.equal(diagnostic?.payload?.attempts, 2);
});

test('动作 JSON Schema 用互斥分支约束 idle 与有目标动作', () => {
  const schema = actionDecisionJsonSchema(['obj:home', 'obj:work']) as {
    properties: { action: { oneOf: Array<{ properties: { type: { enum: string[] }; target: { type: string; enum?: string[] } } }> } };
  };
  const [idle, targeted] = schema.properties.action.oneOf;
  assert.deepEqual(idle.properties.type.enum, ['idle']);
  assert.equal(idle.properties.target.type, 'null');
  assert.deepEqual(targeted.properties.type.enum, ['move_to', 'interact']);
  assert.deepEqual(targeted.properties.target.enum, ['obj:home', 'obj:work']);
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
  const captured: ChatMessage[][] = [];
  const spy: LLMProvider = {
    name: 'spy',
    async complete(req) {
      captured.push(req.messages);
      const parsed = { thought: '', action: { type: 'idle', target: null, verb: '休息' }, duration_minutes: 10 };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider: spy });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在咖啡馆煮咖啡招待客人', importance: 6, createdGameTime: 1 });
  mind.store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营咖啡馆', hourly: [{ time: '00:10', action: '测试议程动作', location: '咖啡馆' }], status: 'active', createdGameTime: 5 });
  const executor = new AgentExecutor(gateway, world, log, mind);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting'); // mock 无作息槽 → idle 行动
  assert.ok(captured.length >= 1);
  const text = captured[0].map((m) => m.content).join('\n');
  assert.ok(text.includes('煮咖啡'), '提示词应包含记忆内容');
  assert.ok(text.includes('测试议程动作'), '提示词应包含当前议程');
  assert.ok(text.includes('近期记忆'));
  // 检索副作用：目标记忆的 last_access 被刷新
  const mem = mind.store.recentMemories('agent:1', 20).find((m) => m.content.includes('煮咖啡'))!;
  assert.equal(mem.lastAccessGameTime, 10);
});
