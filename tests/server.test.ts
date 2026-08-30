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
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 30, llm: gateway });
  return { dir, db, log, world, time, loop, gateway, server, base: `http://127.0.0.1:${server.port}` };
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
      body: JSON.stringify({ action: 'speed', value: 60 }),
    });
    assert.equal(time.gameMinutesPerTick, 30);
    const adaptive = await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'adaptive-speed' }),
    });
    assert.equal(adaptive.status, 200);
    assert.equal(((await adaptive.json()) as { speed: number }).speed, 1);
    assert.equal(time.gameMinutesPerTick, 0.5);
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

test('推理状态接口公开有界队列与背压指标', async () => {
  const { server, base } = await setup();
  try {
    const response = await fetch(`${base}/api/llm/status`);
    assert.equal(response.status, 200);
    const status = await response.json() as {
      active: number; queued: number; maxConcurrent: number; maxQueued: number; backpressured: boolean;
    };
    assert.deepEqual(status, {
      active: 0,
      queued: 0,
      maxConcurrent: 8,
      maxQueued: 256,
      oldestWaitMs: 0,
      backpressured: false,
      pressureReason: null,
      byPriority: { dialogue: 0, action: 0, planning: 0, reflection: 0, background: 0 },
      byScope: {},
      performance: {
        provider: 'mock', sampleCount: 0, generationTokensPerSecond: null,
        effectiveTokensPerSecond: null, p50LatencyMs: null, p90LatencyMs: null,
        recommendedMaxWorldSpeed: null, burstMaxWorldSpeed: 60, confidence: 'unavailable',
      },
    });
  } finally {
    await server.close();
  }
});

test('动作质量记录保留在事件库且不进入叙事接口', async () => {
  const { server, base, log } = await setup();
  try {
    log.addEvent({
      id: 'quality-1', type: 'system', actorId: 'agent:1', targetIds: [],
      description: '甲 的动作决策完成了结构质量校正。', location: 'obj:plaza', gameTime: 0,
      payload: { kind: 'action_decision_quality', status: 'normalized', attempts: 1, validator: 'action-decision/v2' },
    });
    log.addEvent({
      id: 'story-1', type: 'interact', actorId: 'agent:1', targetIds: ['obj:plaza'],
      description: '甲 开始整理广场。', location: 'obj:plaza', gameTime: 0,
      payload: { kind: 'interact' },
    });
    assert.equal(log.eventsOfKind('action_decision_quality').length, 1);
    const narrative = await (await fetch(`${base}/api/narrative?limit=100`)).json() as {
      items: Array<{ id: string; kind: string }>;
    };
    assert.ok(narrative.items.some((item) => item.id === 'story-1'));
    assert.ok(!narrative.items.some((item) => item.kind === 'action_decision_quality'));
  } finally {
    await server.close();
  }
});

test('叙事接口投影活动现场与馈礼履约的场景证据', async () => {
  const { server, base, log } = await setup();
  try {
    log.addEvent({
      id: 'event-verified', type: 'broadcast', actorId: null, targetIds: ['agent:1', 'agent:2'],
      description: '活动现场（已核验）：甲、乙在中央广场实际到场参加广场集市。',
      location: 'obj:plaza', gameTime: 0,
      payload: {
        kind: 'town_event', status: 'active', venueId: 'obj:plaza', venueName: '中央广场',
        participants: ['agent:1', 'agent:2'], observerIds: [], sensoryCues: ['摊位交谈声'],
      },
    });
    log.addEvent({
      id: 'gift-fulfilled', type: 'system', actorId: 'agent:1', targetIds: ['agent:2'],
      description: '花店订单（已履约）：甲购买鲜花并交给乙。', location: 'obj:flower_counter', gameTime: 0,
      payload: {
        kind: 'gift', status: 'fulfilled', sourceObjectId: 'obj:flower_counter', sourceObjectName: '花店服务台',
        deliveryLocationId: 'obj:plaza', deliveryLocationName: '中央广场',
      },
    });
    const narrative = await (await fetch(`${base}/api/narrative?limit=100`)).json() as {
      items: Array<Record<string, unknown>>;
    };
    const activity = narrative.items.find((item) => item.id === 'event-verified');
    assert.equal(activity?.eventStatus, 'active');
    assert.equal(activity?.venueId, 'obj:plaza');
    assert.equal(activity?.participantCount, 2);
    assert.deepEqual(activity?.sensoryCues, ['摊位交谈声']);
    const gift = narrative.items.find((item) => item.id === 'gift-fulfilled');
    assert.equal(gift?.eventStatus, 'fulfilled');
    assert.equal(gift?.sourceObjectName, '花店服务台');
    assert.equal(gift?.deliveryLocationName, '中央广场');
  } finally {
    await server.close();
  }
});

test('SSE 客户端断开后服务不崩（写守卫）', async () => {
  const { server, base, log } = await setup();
  try {
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel(); // 模拟浏览器标签页关闭
    await new Promise((r) => setTimeout(r, 100)); // 让服务端感知断开
    log.addEvent({
      id: 'e9', type: 'system', actorId: null, targetIds: [], description: '断开后事件',
      location: null, gameTime: 2, payload: null,
    });
    await new Promise((r) => setTimeout(r, 100));
    const snap = (await (await fetch(`${base}/api/state`)).json()) as { agents: unknown[] };
    assert.equal(snap.agents.length, 2);
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
