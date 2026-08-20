import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { GameEvent, WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>fixture</body></html>');
  writeFileSync(join(dir, 'style.css'), 'body{}');
  writeFileSync(join(dir, 'client.js'), 'console.log(1)');
  return dir;
}

async function setup() {
  const dir = fixtureDir();
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agents = [
    makeAgent({ id: 'agent:1', name: '甲', x: 4, y: 3, locationId: 'obj:plaza', persona: persona({ name: '甲' }) }),
    makeAgent({ id: 'agent:2', name: '乙', x: 5, y: 3, locationId: 'obj:plaza', persona: persona({ name: '乙' }) }),
  ];
  const world = new WorldState(OBJS, agents);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 30 });
  return { dir, db, log, world, time, loop, server, base: `http://127.0.0.1:${server.port}` };
}

test('静态页与快照接口', async () => {
  const { server, base, world } = await setup();
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('fixture'));
    const js = await fetch(`${base}/client.js`);
    assert.equal(js.status, 200);
    const snap = (await (await fetch(`${base}/api/state`)).json()) as { agents: unknown[]; clock: { day: number }; seq: number };
    assert.equal(snap.agents.length, 2);
    assert.equal(snap.clock.day, 1);
    assert.equal(typeof snap.seq, 'number');
    assert.equal(world.allAgents().length, 2);
  } finally {
    await server.close();
  }
});

test('控制接口：调速与暂停', async () => {
  const { server, base, time } = await setup();
  try {
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 120 }),
    });
    assert.equal(time.gameMinutesPerTick, 60);
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    const snap = (await (await fetch(`${base}/api/state`)).json()) as { paused: boolean };
    assert.equal(snap.paused, true);
  } finally {
    await server.close();
  }
});

test('SSE：首帧快照 + 事件即时推送', async () => {
  const { server, base, log, world } = await setup();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const waitFor = async (marker: string): Promise<void> => {
      while (!buf.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 流提前结束');
        buf += decoder.decode(value, { stream: true });
      }
    };
    await waitFor('event: snapshot');
    const e: GameEvent = {
      id: 'e1', type: 'system', actorId: null, targetIds: [], description: '测试事件',
      location: null, gameTime: 1, payload: { kind: 'day_start' },
    };
    log.addEvent(e);
    await waitFor('event: event');
    assert.ok(buf.includes('测试事件'));
    clearTimeout(timeout);
    reader.releaseLock();
    void res.body?.cancel();
    assert.equal(world.allAgents().length, 2);
  } finally {
    await server.close();
  }
});
