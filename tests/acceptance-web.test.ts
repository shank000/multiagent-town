// 像素小镇 e2e 验收：快照推进、NPC 闲聊、调速生效、SSE 推送

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { SocialTicker } from '../src/engine/social';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { createTownServer } from '../src/web/server';

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-e2e-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>e2e</body></html>');
  return dir;
}

test('像素小镇 e2e：一天内快照推进 + NPC 闲聊 + 调速 + SSE', async () => {
  const dir = fixtureDir();
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x 虚拟时钟
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const social = new SocialTicker(log);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social);
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 40 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.ok((await (await fetch(`${base}/`)).text()).includes('e2e'));

    // SSE 首帧
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    const sse = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    while (!sseBuf.includes('event: snapshot')) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
    }
    clearTimeout(timeout);
    assert.ok(sseBuf.includes('event: snapshot'));
    await reader.cancel(); // 流已被 getReader 锁定，用 reader.cancel 释放

    // 跑满 1 游戏日（服务端快照推送并行运行）
    await loop.runUntil(1440);

    const snap = (await (await fetch(`${base}/api/state`)).json()) as {
      clock: { day: number };
      agents: { id: string; name: string }[];
    };
    assert.equal(snap.clock.day, 2);
    assert.equal(snap.agents.length, 6);

    // 6 个 agent 一整天里至少发生一次 NPC 闲聊
    const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
    assert.ok(chats.length >= 1, `闲聊事件应为 ≥1，实际 ${chats.length}`);
    assert.match(chats[0].description, /对「.+」说：「.+」/);

    // 调速生效
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 360 }),
    });
    assert.equal(time.gameMinutesPerTick, 180);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
