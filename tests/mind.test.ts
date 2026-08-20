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
    assert.ok(plan.hourly.length >= 1, `${a.name} 应有小时议程`);
  }
});

test('currentAgendaLine 返回当前时段议程或大计划', async () => {
  const db = openDb(':memory:');
  const store = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log: new EventLog(db) }).store;
  const planner = new Planner(new LLMGateway({ provider: 'mock' }), store);
  const agent = buildTown().allAgents()[0];
  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);
  const line = planner.currentAgendaLine(agent, 1, 540);
  assert.ok(line && line.length > 3);
  assert.ok(!planner.currentAgendaLine(agent, 2, 540)); // 第 2 天无计划
});
