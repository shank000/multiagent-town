import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { Planner } from '../src/llm/planner';
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/llm/types';
import { MemoryStore } from '../src/store/memory';

test('跨 5:00 生成日计划，跨整点生成小时计划', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 每 tick 30 游戏分钟
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const mind = new MindEngine({ db, llm: gateway, log });
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  await loop.runUntil(330); // 越过 5:00（300）与 5 点整点
  for (const a of world.allAgents()) {
    const plan = mind.store.planFor(a.id, 1);
    assert.ok(plan, `${a.name} 应有日计划`);
    assert.ok(plan.broadPlan.length > 5);
    assert.ok(plan.broadPlan !== '自由安排一天。', `${a.name} 的日计划不应是兜底文本`);
    assert.ok(plan.hourly.length >= 1, `${a.name} 应有小时议程`);
    const planMem = mind.store.recentMemories(a.id, 500).find((m) => m.kind === 'plan');
    assert.ok(planMem, `${a.name} 应有 kind=plan 记忆`);
    assert.equal(planMem.importance, 8);
  }
});

test('currentAgendaLine 返回当前时段议程或大计划', async () => {
  const db = openDb(':memory:');
  const store = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log: new EventLog(db) }).store;
  const planner = new Planner(new LLMGateway({ provider: 'mock' }), store);
  const world = buildTown();
  planner.bindWorld(world);
  const agent = world.allAgents()[0];
  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);
  const line = planner.currentAgendaLine(agent, 1, 540);
  assert.ok(line && line.length > 3);
  assert.ok(!planner.currentAgendaLine(agent, 2, 540)); // 第 2 天无计划
});

test('跨日后每位居民形成一份证据约束日记，快速时钟不漏记', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(180);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);

  await loop.runUntil(1440);

  for (const agent of world.allAgents()) {
    const daily = mind.store.dailyReflectionFor(agent.id, 1);
    assert.ok(daily, `${agent.name} 缺少第1天日记`);
    assert.equal(daily.kind, 'daily');
    assert.ok(daily.diary.length > 10);
    assert.ok(daily.guidance.length >= 1);
  }
});

test('小时规划合并过期请求，只提交最新时间段', async () => {
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const requestedHours: number[] = [];
  const provider: LLMProvider = {
    name: 'planning-coalescing',
    async complete(request: LLMRequest): Promise<LLMResponse> {
      const context = request.messages.find((message) => message.role === 'user')?.content.match(/<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/)?.[1];
      const payload = context ? JSON.parse(context) as { hour?: number; planningOptions?: { id: string }[] } : {};
      const hour = Number(payload.hour ?? -1);
      requestedHours.push(hour);
      if (requestedHours.length === 1) {
        firstStarted();
        await firstGate;
      }
      const parsed = {
        agenda: [{ time: `${String(hour).padStart(2, '0')}:00`, option_id: payload.planningOptions?.[0]?.id }],
      };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const planner = new Planner(new LLMGateway({ provider, retries: 0, maxConcurrent: 1 }), store, 'w1');
  const world = buildTown();
  planner.bindWorld(world);
  const agent = world.allAgents()[0];
  const first = planner.scheduleHour(agent, 1, 1, 60);
  await started;
  const second = planner.scheduleHour(agent, 1, 2, 120);
  const latest = planner.scheduleHour(agent, 1, 3, 180);
  releaseFirst();
  await Promise.all([first, second, latest, planner.drain()]);
  assert.deepEqual(requestedHours, [1, 3]);
  const plan = store.planFor(agent.id, 1);
  assert.deepEqual(plan?.hourly.map((item) => item.time), ['03:00']);
  db.raw.close();
});
