import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTown } from '../src/engine/seed';
import { Planner } from '../src/llm/planner';
import { assessDailyPlan, assessHourAgenda, planningContextFromWorld } from '../src/llm/plan-grounding';
import {
  assessDailyOptionSelection, assessHourOptionSelection, auditRenderedDailyPlan,
  auditRenderedHourAgenda, buildPlanningOptions, dailyPlanningOptionPool,
  fallbackDailyOptions, fallbackHourChoices, hourPlanningOptionPool, isEventAttendanceVerb,
  renderDailyPlan, renderHourAgenda,
} from '../src/llm/planning-options';
import { LLMGateway } from '../src/llm/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import { openDb } from '../src/store/db';
import { MemoryStore } from '../src/store/memory';
import { dailyPlanMessages, hourPlanMessages } from '../src/llm/prompts';
import { WorldState } from '../src/core/world';
import type { WorldObject } from '../src/core/types';
import { makeAgent, persona } from './helpers';

const world = buildTown();
const context = planningContextFromWorld(world);

interface PromptContext {
  hour?: number;
  planningOptions?: { id: string; fromMinute: number | null; toMinute: number | null }[];
}

function m0(request: LLMRequest): PromptContext {
  const content = request.messages.find((message) => message.role === 'user')?.content ?? '';
  const raw = content.match(/<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/)?.[1];
  return raw ? JSON.parse(raw) as PromptContext : {};
}

function response(parsed: unknown): LLMResponse {
  return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
}

test('日计划拒绝名册外社交对象、未知地点和内部说明，日常名词不误伤', () => {
  const outside = assessDailyPlan('上午邀请小雅一起喝咖啡，下午去 obj:mars；必须使用该动词。', context);
  assert.equal(outside.ok, false);
  assert.deepEqual(new Set(outside.issues.map((issue) => issue.code)), new Set([
    'unknown_resident', 'unknown_object', 'internal_term',
  ]));
  assert.match(outside.issues.map((issue) => issue.message).join('；'), /小雅/);

  assert.equal(assessDailyPlan('上午留在小镇照顾客人，午后帮助老人，傍晚整理小型花架。', context).ok, true);
  for (const liveRegression of [
    '为常客小雅和老周准备手冲咖啡',
    '与常客小雅聊天',
    '为一位常客小雅续上一杯拿铁',
  ]) {
    const assessment = assessDailyPlan(liveRegression, context);
    assert.equal(assessment.ok, false, liveRegression);
    assert.ok(assessment.issues.some((issue) => issue.code === 'unknown_resident' && issue.message.includes('小雅')));
  }
  assert.equal(assessDailyPlan('为一位常客续上一杯拿铁，再与顾客聊聊近况。', context).ok, true);
});

test('叙事评估拒绝程序字段、地点编号和未经证实的事件或他人状态', () => {
  for (const leakage of [
    '查看 available_actions 后再决定。',
    '调用 interactionVerbs 选择行动。',
    '前往 obj:cafe 工作。',
    'object ID 已经确认。',
    'validator 根据 schema 校验 JSON。',
  ]) {
    const assessment = assessDailyPlan(leakage, context);
    assert.equal(assessment.ok, false, leakage);
    assert.ok(assessment.issues.some((issue) => issue.code === 'internal_term'), leakage);
  }
  for (const invention of [
    '小镇夏日野花日',
    '艺术展征集信息',
    '咖啡馆有新活动',
  ]) {
    const assessment = assessDailyPlan(invention, context);
    assert.equal(assessment.ok, false, invention);
    assert.ok(assessment.issues.some((issue) => issue.code === 'unverified_event'), invention);
  }
  const roleMismatch = assessDailyPlan('沈屿是否在煮咖啡', context);
  assert.equal(roleMismatch.ok, false);
  assert.ok(roleMismatch.issues.some((issue) => issue.code === 'other_actor_assignment'));
  assert.equal(assessDailyPlan('观察周围活动，再参加日常活动。', context).ok, true);
});

test('旧文本小时评估仍只接受请求小时并规范唯一地点名', () => {
  const cafe = context.places.find((place) => place.name === '林间咖啡馆');
  assert.ok(cafe);
  const valid = assessHourAgenda([
    { time: '09:05', action: '擦拭桌面并准备营业', location: '林间咖啡馆' },
    { time: '09:20', action: '接待客人', location: cafe.id },
  ], 9, context);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.value.map((item) => item.location), [cafe.id, cafe.id]);

  const invalid = assessHourAgenda([
    { time: '10:00', action: '和小雅交流', location: '不存在的湖边别墅' },
    { time: '09:10', action: '整理货架', location: '林间咖啡馆' },
    { time: '09:10', action: '再次整理货架', location: '林间咖啡馆' },
  ], 9, context);
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.some((issue) => issue.code === 'wrong_hour'));
  assert.ok(invalid.issues.some((issue) => issue.code === 'unknown_resident'));
  assert.ok(invalid.issues.some((issue) => issue.code === 'unknown_location'));
  assert.ok(invalid.issues.some((issue) => issue.code === 'duplicate_time'));
});

test('计划选项目录稳定去重、按作息排序、排除活动出席并始终由本人行动', () => {
  const objects: WorldObject[] = [
    { id: 'obj:town', name: '测试镇', type: 'town', parentId: null, x: 0, y: 0, w: 8, h: 8 },
    {
      id: 'obj:home', name: '测试员家', type: 'room', parentId: 'obj:town', x: 1, y: 1, w: 1, h: 1,
      affordances: [
        { verb: '整理房间', outcome: '房间整洁' },
        { verb: '参加读书会', outcome: '活动完成' },
      ],
    },
    { id: 'obj:work', name: '工作室', type: 'room', parentId: 'obj:town', x: 2, y: 1, w: 1, h: 1, affordances: [{ verb: '工作', outcome: '完成工作' }] },
  ];
  const agent = makeAgent({
    id: 'agent:self', name: '本人', locationId: 'obj:home', homeObjectId: 'obj:home',
    persona: persona({
      name: '本人',
      routine: [
        { from: 600, to: 660, type: 'interact', target: 'obj:home', verb: '整理房间' },
        { from: 480, to: 540, type: 'interact', target: 'obj:work', verb: '工作' },
      ],
    }),
  });
  const neighbor = makeAgent({ id: 'agent:neighbor', name: '邻居', locationId: 'obj:work', homeObjectId: 'obj:home', persona: persona({ name: '邻居' }) });
  const customWorld = new WorldState(objects, [agent, neighbor]);
  const options = buildPlanningOptions(agent, customWorld);
  const again = buildPlanningOptions(agent, customWorld);

  assert.deepEqual(options.map((option) => option.id), again.map((option) => option.id));
  assert.ok(options.every((option) => option.actorId === agent.id));
  assert.ok(options.filter((option) => option.kind === 'social').every((option) => option.counterpartId === neighbor.id));
  assert.ok(options.every((option) => !isEventAttendanceVerb(option.verb)));
  assert.equal(options.some((option) => option.verb === '参加读书会'), false);
  const duplicate = options.filter((option) => option.locationId === 'obj:home' && option.verb === '整理房间');
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].kind, 'routine');
  assert.deepEqual(options.filter((option) => option.kind === 'routine').map((option) => option.fromMinute), [480, 600]);
  assert.deepEqual(fallbackDailyOptions(options, agent.id).filter((option) => option.kind === 'routine').map((option) => option.fromMinute), [480, 600]);
});

test('闭世界选择契约拒绝未知、重复、他人选项、跨小时与模型附加 prose', () => {
  const agent = world.allAgents()[0];
  const other = world.allAgents()[1];
  const own = buildPlanningOptions(agent, world);
  const foreign = buildPlanningOptions(other, world)[0];
  const dailyPool = dailyPlanningOptionPool(own, agent);
  const validDaily = { option_ids: dailyPool.slice(0, 3).map((option) => option.id) };
  assert.equal(assessDailyOptionSelection(validDaily, dailyPool, agent.id).ok, true);
  assert.equal(assessDailyOptionSelection({ ...validDaily, prose: '小镇夏日野花日' }, dailyPool, agent.id).ok, false);
  assert.equal(assessDailyOptionSelection({ option_ids: [dailyPool[0].id, dailyPool[0].id, dailyPool[1].id] }, dailyPool, agent.id).ok, false);
  assert.equal(assessDailyOptionSelection({ option_ids: ['plan:fake', dailyPool[0].id, dailyPool[1].id] }, dailyPool, agent.id).ok, false);
  const wrongActor = assessDailyOptionSelection({ option_ids: [foreign.id, dailyPool[0].id, dailyPool[1].id] }, [foreign, ...dailyPool], agent.id);
  assert.ok(wrongActor.issues.some((issue) => issue.code === 'wrong_actor'));

  const hourPool = hourPlanningOptionPool(own, agent, 9);
  assert.equal(assessHourOptionSelection({ agenda: [{ time: '09:00', option_id: hourPool[0].id }] }, 9, hourPool, agent.id).ok, true);
  assert.equal(assessHourOptionSelection({ agenda: [{ time: '10:00', option_id: hourPool[0].id }] }, 9, hourPool, agent.id).ok, false);
  assert.equal(assessHourOptionSelection({ agenda: [{ time: '09:00', option_id: hourPool[0].id, action: '自由发挥' }] }, 9, hourPool, agent.id).ok, false);
});

test('目录池保持有界，小时池优先当前作息且渲染结果可还原来源', () => {
  const agent = world.allAgents()[0];
  const options = buildPlanningOptions(agent, world);
  const dailyPool = dailyPlanningOptionPool(options, agent);
  const active = agent.persona.routine.find((slot) => slot.target && !isEventAttendanceVerb(slot.verb));
  assert.ok(active);
  const activeHour = Math.floor(active.from / 60);
  const hourPool = hourPlanningOptionPool(options, agent, activeHour);
  assert.ok(dailyPool.length <= 18);
  assert.ok(hourPool.length <= 14);
  assert.equal(hourPool[0].kind, 'routine');
  assert.equal(hourPool[0].verb, active.verb);

  const dailySelected = fallbackDailyOptions(options, agent.id);
  const broad = renderDailyPlan(dailySelected, world);
  assert.equal(auditRenderedDailyPlan(broad, options, world).ok, true);
  const hourChoices = fallbackHourChoices(options, agent.id, activeHour);
  const agenda = renderHourAgenda(hourChoices, options);
  assert.equal(auditRenderedHourAgenda(agenda, activeHour, options).ok, true);
  assert.equal(auditRenderedHourAgenda([{ time: `${String(activeHour).padStart(2, '0')}:00`, action: '查看艺术展征集信息', location: options[0].locationId }], activeHour, options).ok, false);
  assert.equal(auditRenderedHourAgenda([{ time: `${String(activeHour).padStart(2, '0')}:00`, action: '沈屿是否在煮咖啡', location: options[0].locationId }], activeHour, options).ok, false);
});

test('非法附加叙事触发一次低温修复，只有选项渲染文本进入计划与记忆', async () => {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'planning-single-repair',
    async complete(request): Promise<LLMResponse> {
      requests.push(request);
      const payload = m0(request);
      const ids = payload.planningOptions?.map((option) => option.id) ?? [];
      if (request.template === 'daily_plan') {
        return response(requests.length === 1 ? { option_ids: ids.slice(0, 3), prose: '小镇夏日野花日' } : { option_ids: ids.slice(0, 3) });
      }
      const hour = payload.hour ?? 9;
      return response(requests.length === 3
        ? { agenda: [{ time: `${String(hour).padStart(2, '0')}:00`, option_id: 'plan:fake' }] }
        : { agenda: [{ time: `${String(hour).padStart(2, '0')}:00`, option_id: ids[0] }] });
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store);
  planner.bindWorld(world);
  const agent = world.allAgents().find((candidate) => candidate.name === '白露') ?? world.allAgents()[0];
  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);

  assert.equal(requests.length, 4);
  assert.equal(requests[1].temperature, 0.1);
  assert.equal(requests[3].temperature, 0.1);
  assert.equal((requests[0].jsonSchema as { additionalProperties?: boolean }).additionalProperties, false);
  assert.equal((((requests[2].jsonSchema as { properties?: { agenda?: { items?: { additionalProperties?: boolean } } } }).properties?.agenda?.items)?.additionalProperties), false);
  const catalog = buildPlanningOptions(agent, world);
  const plan = store.planFor(agent.id, 1);
  assert.ok(plan);
  assert.equal(auditRenderedDailyPlan(plan.broadPlan, catalog, world).ok, true);
  assert.equal(auditRenderedHourAgenda(plan.hourly.filter((item) => item.time.startsWith('09:')), 9, catalog).ok, true);
  const planMemory = store.recentMemories(agent.id, 20).find((memory) => memory.kind === 'plan');
  assert.ok(planMemory);
  assert.ok(planMemory.content.includes(plan.broadPlan));
  assert.doesNotMatch(`${plan.broadPlan}\n${JSON.stringify(plan.hourly)}\n${planMemory.content}`, /夏日野花日|plan:fake|prose/i);
  db.raw.close();
});

test('提交时重新读取当前世界，过期选项不会静默映射到另一真实实体', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requestStarted = new Promise<void>((resolve) => { started = resolve; });
  const provider: LLMProvider = {
    name: 'planning-world-revalidation',
    async complete(request): Promise<LLMResponse> {
      const ids = m0(request).planningOptions?.map((option) => option.id) ?? [];
      started();
      await gate;
      return response({ option_ids: ids.slice(0, 3) });
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store);
  const agent = world.allAgents()[0];
  planner.bindWorld(world);
  const pending = planner.dailyPlan(agent, 3, 3000);
  await requestStarted;

  const replacementObjects: WorldObject[] = [
    { id: 'obj:new-town', name: '新镇', type: 'town', parentId: null, x: 0, y: 0, w: 8, h: 8 },
    { id: 'obj:new-a', name: '新工作间', type: 'room', parentId: 'obj:new-town', x: 1, y: 1, w: 1, h: 1, affordances: [{ verb: '整理工具', outcome: '工具整齐' }] },
    { id: 'obj:new-b', name: '新庭院', type: 'room', parentId: 'obj:new-town', x: 2, y: 1, w: 1, h: 1, affordances: [{ verb: '打扫庭院', outcome: '庭院整洁' }] },
  ];
  const replacement = new WorldState(replacementObjects, [agent]);
  planner.bindWorld(replacement);
  release();
  await pending;

  const plan = store.planFor(agent.id, 3);
  assert.ok(plan);
  const currentOptions = buildPlanningOptions(agent, replacement);
  assert.equal(auditRenderedDailyPlan(plan.broadPlan, currentOptions, replacement).ok, true);
  assert.match(plan.broadPlan, /新工作间|新庭院/);
  assert.doesNotMatch(plan.broadPlan, /林间咖啡馆|咖啡馆吧台/);
  db.raw.close();
});

test('两次无效输出走确定性 fallback，旧计划可读但不再混入新写入', async () => {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'planning-fallback',
    async complete(request): Promise<LLMResponse> {
      requests.push(request);
      return response(request.template === 'daily_plan'
        ? { broad_plan: '咖啡馆有新活动' }
        : { agenda: [{ time: '12:00', action: '查看艺术展征集信息', location: 'obj:mars' }] });
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store, 'grounding-test');
  planner.bindWorld(world);
  const agent = world.allAgents()[0];
  store.savePlan({
    agentId: agent.id, day: 2, broadPlan: '旧版自由文本计划。', status: 'active', createdGameTime: 100,
    hourly: [{ time: '08:15', action: '旧版自由行动', location: 'obj:town' }],
  });
  assert.equal(planner.currentAgendaLine(agent, 2, 8 * 60 + 15), '08:15 旧版自由行动（小镇）');

  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);
  assert.equal(requests.length, 4);
  const catalog = buildPlanningOptions(agent, world);
  const plan = store.planFor(agent.id, 1);
  assert.ok(plan);
  assert.equal(auditRenderedDailyPlan(plan.broadPlan, catalog, world).ok, true);
  assert.equal(auditRenderedHourAgenda(plan.hourly, 9, catalog).ok, true);
  assert.doesNotMatch(JSON.stringify(plan), /咖啡馆有新活动|艺术展|obj:mars|broad_plan/);
  assert.doesNotMatch(store.recentMemories(agent.id, 20).find((memory) => memory.kind === 'plan')?.content ?? '', /咖啡馆有新活动|艺术展|obj:mars/);
  db.raw.close();
});

test('已有自由文本小时议程不会通过闭世界提交边界累积', async () => {
  const provider: LLMProvider = {
    name: 'planning-existing-agenda-audit',
    async complete(request): Promise<LLMResponse> {
      const payload = m0(request);
      return response({ agenda: [{ time: '09:00', option_id: payload.planningOptions?.[0]?.id }] });
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const agent = world.allAgents()[0];
  store.savePlan({
    agentId: agent.id, day: 1, broadPlan: '旧版自由文本计划。', status: 'active', createdGameTime: 500,
    hourly: [
      { time: '08:00', action: '前往不存在的地点', location: 'obj:mars' },
      { time: '08:15', action: '完成晨间准备', location: 'obj:cafe' },
      { time: '10:00', action: '调用 schema 决定行动', location: 'obj:cafe' },
    ],
  });
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store);
  planner.bindWorld(world);
  await planner.decomposeHour(agent, 1, 9, 540);
  const persisted = store.planFor(agent.id, 1);
  assert.ok(persisted);
  assert.deepEqual(persisted.hourly.map((item) => item.time), ['09:00']);
  assert.equal(auditRenderedDailyPlan(persisted.broadPlan, buildPlanningOptions(agent, world), world).ok, true);
  assert.doesNotMatch(JSON.stringify(persisted), /obj:mars|schema|完成晨间准备/i);
  db.raw.close();
});

test('规划提示显式列出闭世界选项并保持有界，结构说明不受叙事过滤影响', () => {
  const agent = world.allAgents()[0];
  const options = buildPlanningOptions(agent, world);
  const dailyPool = dailyPlanningOptionPool(options, agent);
  const hourPool = hourPlanningOptionPool(options, agent, 9);
  const daily = dailyPlanMessages(agent, 1, [], [], {}, context, dailyPool);
  const hourly = hourPlanMessages(agent, 9, renderDailyPlan(fallbackDailyOptions(options, agent.id), world), context, hourPool);
  for (const messages of [daily, hourly]) {
    const text = messages.map((message) => message.content).join('\n');
    assert.ok(text.includes('当前居民名册'));
    assert.ok(text.includes('当前可去地点'));
    assert.ok(text.includes('option_id'));
    assert.ok(text.includes('TownModel'));
    assert.ok(text.includes('白露'));
    assert.ok(text.includes('obj:town'));
    assert.ok(text.length < 12_000, `提示长度 ${text.length}`);
  }
});
