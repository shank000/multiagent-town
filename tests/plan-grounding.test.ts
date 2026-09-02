import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTown } from '../src/engine/seed';
import { Planner } from '../src/llm/planner';
import {
  assessDailyPlan, assessHourAgenda, planningContextFromWorld,
} from '../src/llm/plan-grounding';
import { LLMGateway } from '../src/llm/gateway';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import { openDb } from '../src/store/db';
import { MemoryStore } from '../src/store/memory';
import { dailyPlanMessages, hourPlanMessages } from '../src/llm/prompts';

const world = buildTown();
const context = planningContextFromWorld(world);

test('日计划拒绝名册外社交对象、未知地点和内部说明，日常名词不误伤', () => {
  const outside = assessDailyPlan('上午邀请小雅一起喝咖啡，下午去 obj:mars；必须使用该动词。', context);
  assert.equal(outside.ok, false);
  assert.deepEqual(new Set(outside.issues.map((issue) => issue.code)), new Set([
    'unknown_resident', 'unknown_object', 'internal_term',
  ]));
  assert.match(outside.issues.map((issue) => issue.message).join('；'), /小雅/);

  const natural = assessDailyPlan('上午留在小镇照顾客人，午后帮助老人，傍晚整理小型花架。', context);
  assert.equal(natural.ok, true);

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

test('叙事评估拒绝模型把程序字段或地点编号写进内容', () => {
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
});

test('小时安排只接受请求小时并把唯一地点名规范为当前对象 id', () => {
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

test('名册外小雅触发一次低温修复后仅保存修正版日计划', async () => {
  let call = 0;
  const provider: LLMProvider = {
    name: 'planning-single-repair',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      call += 1;
      const parsed = call === 1
        ? { broad_plan: '上午与常客小雅聊天，下午整理花束。' }
        : { broad_plan: '上午整理花束，下午照看店面，傍晚按时休息。' };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store);
  planner.bindWorld(world);
  const agent = world.allAgents().find((candidate) => candidate.name === '白露') ?? world.allAgents()[0];
  await planner.dailyPlan(agent, 1, 300);
  assert.equal(call, 2);
  assert.equal(store.planFor(agent.id, 1)?.broadPlan, '上午整理花束，下午照看店面，傍晚按时休息。');
  assert.doesNotMatch(store.recentMemories(agent.id, 20).find((memory) => memory.kind === 'plan')?.content ?? '', /小雅/);
  db.raw.close();
});

test('小时计划再次落库时仅保留当前世界中可验证的既有议程', async () => {
  const cafe = context.places.find((place) => place.id === 'obj:cafe');
  assert.ok(cafe);
  const provider: LLMProvider = {
    name: 'planning-existing-agenda-audit',
    async complete(): Promise<LLMResponse> {
      const parsed = { agenda: [{ time: '09:00', action: '准备当天工作', location: cafe.name }] };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const agent = world.allAgents()[0];
  store.savePlan({
    agentId: agent.id, day: 1, broadPlan: '按日常节奏完成工作。', status: 'active', createdGameTime: 500,
    hourly: [
      { time: '08:00', action: '前往不存在的地点', location: 'obj:mars' },
      { time: '08:15', action: '完成晨间准备', location: cafe.name },
      { time: '10:00', action: '调用 schema 决定行动', location: cafe.id },
    ],
  });
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store);
  planner.bindWorld(world);
  await planner.decomposeHour(agent, 1, 9, 540);
  const persisted = store.planFor(agent.id, 1)?.hourly ?? [];
  assert.deepEqual(persisted.map((item) => item.time), ['08:15', '09:00']);
  assert.ok(persisted.every((item) => context.places.some((place) => place.id === item.location)));
  assert.doesNotMatch(JSON.stringify(persisted), /obj:mars|schema/i);
  db.raw.close();
});

test('规划结果第一次越界时低温修复，第二次仍失败时只落库 grounded fallback', async () => {
  const requests: LLMRequest[] = [];
  const provider: LLMProvider = {
    name: 'planning-grounding-sequence',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      const parsed = request.template === 'daily_plan'
        ? { broad_plan: '邀请小雅一起去 obj:mars，按 affordance 行动。' }
        : { agenda: [{ time: '12:00', action: '必须使用该动词', location: 'obj:mars' }] };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0 }), store, 'grounding-test');
  planner.bindWorld(world);
  const agent = world.allAgents()[0];

  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);

  assert.equal(requests.length, 4);
  assert.equal(requests[1].temperature, 0.1);
  assert.equal(requests[3].temperature, 0.1);
  assert.match(requests[1].messages.at(-1)?.content ?? '', /小雅.*不在当前名册|居民「小雅」/);
  const plan = store.planFor(agent.id, 1);
  assert.ok(plan);
  assert.equal(assessDailyPlan(plan.broadPlan, context).ok, true);
  assert.equal(assessHourAgenda(plan.hourly, 9, context).ok, true);
  assert.ok(plan.hourly.every((item) => context.places.some((place) => place.id === item.location)));
  const planMemories = store.recentMemories(agent.id, 20).filter((memory) => memory.kind === 'plan');
  assert.equal(planMemories.length, 1);
  assert.doesNotMatch(planMemories[0].content, /小雅|obj:mars|affordance|必须使用该动词/i);
  db.raw.close();
});

test('规划提示显式列出当前实体且保持有界', () => {
  const agent = world.allAgents()[0];
  const daily = dailyPlanMessages(agent, 1, [], [], {}, context);
  const hourly = hourPlanMessages(agent, 9, '按日常节奏完成工作。', context);
  for (const messages of [daily, hourly]) {
    const text = messages.map((message) => message.content).join('\n');
    assert.ok(text.includes('当前居民名册'));
    assert.ok(text.includes('当前可去地点'));
    assert.ok(text.includes('白露'));
    assert.ok(text.includes('obj:town'));
    assert.ok(text.length < 12_000, `提示长度 ${text.length}`);
  }
});
