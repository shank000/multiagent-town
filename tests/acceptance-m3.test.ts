// M3 验收：关系生长（渐进不爆炸）、活动成行、谣言传播 ≥2 人、声望榜可用

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
import { PlayerDirector } from '../src/engine/player';
import { SocialTicker } from '../src/engine/social';
import { createTownServer } from '../src/web/server';
import { flush } from './helpers';

test('M3 验收：关系/活动/谣言/声望', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-m3-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  const server = await createTownServer({ world, time, loop, log, mind, player, rels: mind.rels, rumors: mind.rumors, publicDir: dir });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    // 谣言种子：林晚晴
    const lin = world.allAgents()[0];
    await fetch(`${base}/api/rumor`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '湖边埋着宝藏', sourceId: lin.id }),
    });
    await loop.runUntil(5760); // 四天：先形成正向熟悉关系，再在后续自发会话中选择性披露

    // ① 关系：总 |affection| > 0.1 且逐对 ≤ 0.7（渐进由单次 ±0.2 夹紧保证，Task 1 单测；此处防两天内爆炸）
    const rels = mind.rels.allPairs();
    const total = rels.reduce((s, r) => s + Math.abs(r.affection), 0);
    assert.ok(total > 0.1, `关系密度过低: ${total}`);
    assert.ok(rels.every((r) => Math.abs(r.affection) <= 0.7), '单对关系超上限');

    // ② 活动成行
    const ev = log.eventsForDay(1).find((e) => e.payload?.kind === 'town_event');
    assert.ok(ev, '应有活动成行广播');
    assert.ok((ev.payload as { participants: string[] }).participants.length >= 2);

    // ③ 谣言：≥2 人知晓
    const seedRow = mind.rumors.rows().find((r) => r.hops === 0)!;
    const carriers = mind.rumors.carriersOf(seedRow.id);
    assert.ok(carriers.length >= 2, `谣言传播不足: ${carriers.join(',')}`);
    assert.equal(new Set(carriers).size, carriers.length, '同一源传闻不应回传给已有携带者');

    // ④ 声望榜：6 项有限值
    const st = (await (await fetch(`${base}/api/status`)).json()) as { id: string; score: number }[];
    assert.equal(st.length, 6);
    assert.ok(st.every((s) => Number.isFinite(s.score)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
