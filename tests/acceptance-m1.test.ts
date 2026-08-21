// M1 验收：1 游戏日闭环（记忆/计划/反思/对话摘要）+ 访谈引用真实记忆 + 心智面板 API

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { SocialTicker } from '../src/engine/social';
import { interviewAgent } from '../src/engine/interview';
import { createTownServer } from '../src/web/server';

test('M1 验收：闭环跑通 + 访谈引用记忆 + mind API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-m1-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  const server = await createTownServer({ world, time, loop, log, mind, publicDir: dir });
  try {
    await loop.runUntil(1440);

    // ① 每 agent 记忆 ≥15
    for (const a of world.allAgents()) {
      assert.ok(mind.store.countFor(a.id) >= 15, `${a.name} 记忆过少: ${mind.store.countFor(a.id)}`);
    }
    // ② 反思 ≥1 次
    const totalRefs = world.allAgents().reduce((s, a) => s + mind.store.reflectionsFor(a.id).length, 0);
    assert.ok(totalRefs >= 1, '一整天没有任何反思');
    // ③ 日计划已生成
    for (const a of world.allAgents()) {
      assert.ok(mind.store.planFor(a.id, 1), `${a.name} 缺少日计划`);
    }
    // ④ 对话摘要 ≥1 条（双方记忆流）
    const summaries = world.allAgents().reduce((s, a) => s + mind.store.recentMemories(a.id, 500).filter((m) => m.kind === 'dialogue_summary').length, 0);
    assert.ok(summaries >= 2, `对话摘要应 ≥2（双写），实际 ${summaries}`);
    // ⑤ 访谈引用真实记忆
    const lin = world.allAgents()[0];
    const answer = await interviewAgent({ agent: lin, question: '你今天做了什么？', llm: gateway, store: mind.store, now: 1440 });
    assert.ok(answer.includes('我记得'));
    const dayMemories = mind.store.recentMemories(lin.id, 500).filter((m) => m.createdGameTime < 1440);
    const quoted = dayMemories.some((m) => answer.includes(m.content.slice(0, 12)));
    assert.ok(quoted, '访谈回答未引用任何真实记忆');
    // ⑥ mind API
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent(lin.id)}/mind`);
    const body = (await res.json()) as { memories: unknown[]; reflections: unknown[] };
    assert.ok(body.memories.length >= 15);
    assert.ok(body.reflections.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
