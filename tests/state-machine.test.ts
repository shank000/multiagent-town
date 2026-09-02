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
  {
    id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1,
    affordances: [{ verb: '打扫', outcome: '保持住处整洁' }],
  },
  {
    id: 'obj:work', name: '工作地', type: 'building', parentId: 'obj:town', x: 5, y: 0, w: 1, h: 1,
    affordances: [{ verb: '工作', outcome: '完成当前职责' }],
  },
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
  assert.equal(agent.thought, '我准备在「家」短暂休息。');
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
  assert.match(provider.requests[1]?.messages.at(-1)?.content ?? '', /只返回修正后的结构化结果/);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'repaired');
  assert.equal(diagnostic?.payload?.attempts, 2);
});

test('内心独白泄露程序术语时修复并记录 ungrounded_narrative', async () => {
  const { log, agent, executor } = setup([
    {
      content: '',
      parsed: {
        thought: '根据 available_actions 与 validator 必须使用该动词。',
        action: { type: 'interact', target: 'obj:work', verb: '工作' },
        duration_minutes: 10,
      },
    },
    {
      content: '',
      parsed: {
        thought: '今天的事情不少，我先去工作地把手头任务做好。',
        action: { type: 'interact', target: 'obj:work', verb: '工作' },
        duration_minutes: 10,
      },
    },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'repaired');
  assert.deepEqual(diagnostic?.payload?.rejectionCodes, ['ungrounded_narrative']);
  assert.doesNotMatch(agent.thought ?? '', /available_actions|validator|必须使用该动词/i);
  assert.equal(agent.thought, '我准备到「工作地」工作。');
});

test('模型虚构节庆动机不能进入动作状态，最终内心独白由已接受动作确定性渲染', async () => {
  const { log, agent, executor, provider } = setup([
    {
      content: '',
      parsed: {
        thought: '为了参加小镇夏日野花日，我先去工作地工作。',
        action: { type: 'interact', target: 'obj:work', verb: '工作' },
        duration_minutes: 10,
      },
    },
    {
      content: '',
      parsed: {
        thought: '今天先把手头工作做好。',
        action: { type: 'interact', target: 'obj:work', verb: '工作' },
        duration_minutes: 10,
      },
    },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);

  assert.equal(provider.calls, 2);
  assert.equal(agent.thought, '我准备到「工作地」工作。');
  assert.doesNotMatch(agent.thought ?? '', /夏日野花日/);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'repaired');
  assert.deepEqual(diagnostic?.payload?.rejectionCodes, ['ungrounded_narrative']);
  assert.ok(!log.eventsForDay(1).some((event) => event.description.includes('夏日野花日')));
});

test('公园画架的幻觉动词被拒绝，修复提示只允许作息声明动词', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
    { id: 'obj:easel', name: '公园画架', type: 'furniture', parentId: 'obj:town', x: 2, y: 2, w: 1, h: 1 },
  ];
  const agent = makeAgent({
    id: 'agent:painter', name: '画家', x: 2, y: 2, locationId: 'obj:easel',
    persona: persona({
      name: '画家', occupation: '画家',
      routine: [{ from: 480, to: 720, type: 'interact', target: 'obj:easel', verb: '在公园写生' }],
    }),
  });
  const provider = new StubProvider([
    {
      content: '',
      parsed: { thought: '修理画架', action: { type: 'interact', target: 'obj:easel', verb: '修理电器' }, duration_minutes: 10 },
    },
    {
      content: '',
      parsed: { thought: '按作息写生', action: { type: 'interact', target: 'obj:easel', verb: '在公园写生' }, duration_minutes: 10 },
    },
  ]);
  const executor = new AgentExecutor(new LLMGateway({ provider, retries: 0 }), new WorldState(objects, [agent]), log);

  executor.progress(agent, 0, 500);
  await flush();
  executor.progress(agent, 0, 500);

  assert.equal(provider.calls, 2);
  assert.equal(agent.action?.action.verb, '在公园写生');
  assert.match(provider.requests[1]?.messages.at(-1)?.content ?? '', /行动必须逐字选择.*在公园写生/);
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'repaired');
  assert.deepEqual(diagnostic?.payload?.rejectionCodes, ['ungrounded_interaction']);
  assert.ok(!log.eventsForDay(1).some((event) => event.payload?.kind === 'thought' && event.description.includes('修理电器')));
});

test('当前上下文中的 affordance 动词无需修复即可执行', async () => {
  const { log, agent, executor, provider } = setup([{
    content: '',
    parsed: { thought: '整理工作', action: { type: 'interact', target: 'obj:home', verb: '打扫' }, duration_minutes: 10 },
  }]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 25);

  assert.equal(provider.calls, 1);
  assert.equal(agent.action?.action.verb, '打扫');
  assert.equal(agent.thought, '我准备到「家」打扫。');
  assert.ok(!log.eventsForDay(1).some((event) => event.payload?.status === 'stale_rejected'));
});

test('唯一声明谓词映射执行 canonical 动词并记录规范化证据', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 4, h: 4 },
    {
      id: 'obj:cafe_counter', name: '咖啡馆吧台', type: 'room', parentId: 'obj:town', x: 0, y: 0, w: 1, h: 1,
      affordances: [
        { verb: '开店准备', outcome: '准备营业' },
        { verb: '煮咖啡招待客人', outcome: '完成咖啡馆接待' },
      ],
    },
  ];
  const agent = makeAgent({ id: 'agent:owner', x: 0, y: 0, locationId: 'obj:cafe_counter' });
  const provider = new StubProvider([{
    content: '',
    parsed: {
      thought: '给客人煮咖啡',
      action: { type: 'interact', target: 'obj:cafe_counter', verb: '煮咖啡' },
      duration_minutes: 10,
    },
  }]);
  const executor = new AgentExecutor(
    new LLMGateway({ provider, retries: 0 }),
    new WorldState(objects, [agent]),
    log,
  );

  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);

  assert.equal(provider.calls, 1);
  assert.equal(agent.action?.action.verb, '煮咖啡招待客人');
  const diagnostic = log.eventsForDay(1).find((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostic?.payload?.status, 'normalized');
  assert.deepEqual(diagnostic?.payload?.normalization, {
    code: 'interaction_verb_canonicalized',
    detail: '交互动词「煮咖啡」已按唯一声明谓词规范为「煮咖啡招待客人」',
  });
  assert.match(String((diagnostic?.payload?.reasons as string[] | undefined)?.[0]), /唯一声明谓词规范/);
  db.raw.close();
});

test('跨过有效期的快速 tick 响应被丢弃，并在当前时刻重新决策', async () => {
  const { log, agent, executor, provider } = setup([
    {
      content: '',
      parsed: { thought: '旧安排', action: { type: 'interact', target: 'obj:home', verb: '打扫' }, duration_minutes: 10 },
    },
    {
      content: '',
      parsed: { thought: '当前安排', action: { type: 'interact', target: 'obj:home', verb: '打扫' }, duration_minutes: 10 },
    },
  ]);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 30);
  await flush();
  executor.progress(agent, 0, 30);

  assert.equal(provider.calls, 2);
  assert.equal(agent.thought, '我准备到「家」打扫。');
  const diagnostics = log.eventsForDay(1).filter((event) => event.payload?.kind === 'action_decision_quality');
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].payload?.status, 'stale_rejected');
  assert.deepEqual(diagnostics[0].payload?.rejectionCodes, ['stale_context']);
  const thoughts = log.eventsForDay(1).filter((event) => event.payload?.kind === 'thought');
  assert.equal(thoughts.length, 1);
  assert.match(thoughts[0].description, /我准备到「家」打扫/);
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

test('公共物件互动写入附近旁观者记忆与有向观察证据', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
    {
      id: 'obj:board', name: '公告栏', type: 'furniture', parentId: 'obj:town', x: 2, y: 2, w: 1, h: 1,
      description: '公共公告栏', affordances: [{ verb: '阅读公告', outcome: '知道公共消息' }],
      sensoryCues: ['纸张声'], observationRadius: 3,
    },
  ];
  const actor = makeAgent({ id: 'agent:actor', name: '甲', x: 2, y: 2, locationId: 'obj:board' });
  const observer = makeAgent({ id: 'agent:observer', name: '乙', x: 3, y: 2, locationId: 'obj:town' });
  const distant = makeAgent({ id: 'agent:distant', name: '丙', x: 10, y: 7, locationId: 'obj:town' });
  const world = new WorldState(objects, [actor, observer, distant]);
  const gateway = new LLMGateway({
    provider: new StubProvider([
      { content: '', parsed: { thought: '看看邻里消息', action: { type: 'interact', target: 'obj:board', verb: '阅读公告' }, duration_minutes: 10 } },
      { content: '', parsed: { importance: 6 } },
    ]),
    retries: 0,
  });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);

  executor.progress(actor, 0, 10);
  await flush();
  executor.progress(actor, 0, 10);
  await mind.drain();

  const event = log.eventsForDay(1).find((item) => item.payload?.kind === 'public_object_interaction');
  assert.ok(event);
  assert.deepEqual(event.payload?.observerIds, [observer.id]);
  assert.deepEqual(event.payload?.memoryAgentIds, [actor.id, observer.id]);
  assert.ok(mind.store.recentMemories(observer.id, 10).some((memory) => memory.sourceEventId === event.id));
  assert.ok(!mind.store.recentMemories(distant.id, 10).some((memory) => memory.sourceEventId === event.id));
  const evidence = mind.rels.evidenceFor(observer.id, actor.id).find((item) => item.sourceEventId === event.id);
  assert.equal(evidence?.sourceKind, 'observation');
  assert.equal(evidence?.metadata.objectId, 'obj:board');
  await mind.dispose();
});
