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
import { BackendRuntimeLog } from '../src/runtime/backend-log';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>fixture</body></html>');
  writeFileSync(join(dir, 'style.css'), 'body{}');
  writeFileSync(join(dir, 'client.js'), 'console.log(1)');
  writeFileSync(join(dir, 'logs.html'), '<!doctype html><html><body>后端运行日志</body></html>');
  writeFileSync(join(dir, 'logs.js'), 'console.log(2)');
  return dir;
}

async function setup(enableRuntimeLog = false, gateway = new LLMGateway({ provider: 'mock' })) {
  const dir = fixtureDir();
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agents = [
    makeAgent({ id: 'agent:1', name: '甲', x: 4, y: 3, locationId: 'obj:plaza', persona: persona({ name: '甲' }) }),
    makeAgent({ id: 'agent:2', name: '乙', x: 5, y: 3, locationId: 'obj:plaza', persona: persona({ name: '乙' }) }),
  ];
  const world = new WorldState(OBJS, agents);
  const time = new TimeEngine(5);
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  const runtimeLog = enableRuntimeLog
    ? new BackendRuntimeLog(join(dir, 'runtime.jsonl'), { captureConsole: false })
    : undefined;
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 30, llm: gateway, runtimeLog });
  return { dir, db, log, world, time, loop, gateway, runtimeLog, server, base: `http://127.0.0.1:${server.port}` };
}

test('静态页与快照接口', async () => {
  const { server, base, world } = await setup();
  try {
    const pageResponse = await fetch(`${base}/`);
    assert.equal(pageResponse.headers.get('cache-control'), 'no-cache');
    const page = await pageResponse.text();
    assert.ok(page.includes('fixture'));
    const js = await fetch(`${base}/client.js`);
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('cache-control'), 'no-cache');
    const css = await fetch(`${base}/style.css`);
    assert.equal(css.headers.get('cache-control'), 'no-cache');
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
      oldestActiveMs: 0,
      oldestWaitMs: 0,
      backpressured: false,
      pressureReason: null,
      activeByPriority: { dialogue: 0, action: 0, planning: 0, reflection: 0, background: 0 },
      byPriority: { dialogue: 0, action: 0, planning: 0, reflection: 0, background: 0 },
      byScope: {},
      performance: {
        provider: 'mock', sampleCount: 0, generationTokensPerSecond: null, promptTokensPerSecond: null,
        effectiveTokensPerSecond: null, p50LatencyMs: null, p90LatencyMs: null,
        p90LoadMs: null, p90PromptMs: null, p90GenerationMs: null,
        p90DialogueLatencyMs: null, p90QueueWaitMs: null,
        recommendedMaxWorldSpeed: null, burstMaxWorldSpeed: 60, confidence: 'unavailable',
      },
      templateMetrics: [],
      cognitionBudget: { modelRequests: 0, groundedContinuations: 0, playerBypasses: 0 },
      timeline: {
        mode: 'manual', selectedSpeed: 10, effectiveSpeed: 10,
        recommendedSpeed: null, manualSpeedLimit: 60, manualSpeedLimitReason: 'mock_capacity',
        adaptiveCeiling: 60, synchronizing: false,
        paused: false, reason: 'manual', stableEvaluations: 0, lastChangedAt: null,
      },
    });
  } finally {
    await server.close();
  }
});

test('真实 provider 未形成吞吐证据前限制手动速度并由服务端拒绝越界请求', async () => {
  const gateway = new LLMGateway({
    provider: {
      name: 'local-real-test',
      async complete() {
        return { content: '{}', parsed: {}, usage: { inputTokens: 1, outputTokens: 1, costYuan: 0 } };
      },
    },
  });
  const { server, base, time } = await setup(false, gateway);
  try {
    assert.equal(time.gameMinutesPerTick * 2, 0.2);
    const status = await (await fetch(`${base}/api/llm/status`)).json() as {
      timeline: { manualSpeedLimit: number; manualSpeedLimitReason: string };
    };
    assert.equal(status.timeline.manualSpeedLimit, 0.2);
    assert.equal(status.timeline.manualSpeedLimitReason, 'warming_up');

    const unsafe = await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 1 }),
    });
    assert.equal(unsafe.status, 409);
    const refusal = await unsafe.json() as { error: string; manualSpeedLimit: number };
    assert.equal(refusal.manualSpeedLimit, 0.2);
    assert.match(refusal.error, /吞吐预热|0\.2×/);
    assert.equal(time.gameMinutesPerTick * 2, 0.2);

    const safe = await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 0.1 }),
    });
    assert.equal(safe.status, 200);
    assert.equal(time.gameMinutesPerTick * 2, 0.1);
  } finally {
    await server.close();
  }
});

test('后端日志页面支持只读筛选、完整保存且不接受任意文件路径', async () => {
  const { server, base, runtimeLog } = await setup(true);
  try {
    runtimeLog!.warn('dialogue', 'conversation=c1 apiKey=do-not-store');
    runtimeLog!.error('ollama', 'request failed');
    assert.equal((await fetch(`${base}/logs.html`)).status, 200);
    assert.equal((await fetch(`${base}/logs.js`)).status, 200);

    const response = await fetch(`${base}/api/runtime-logs?level=warn&q=conversation&limit=20&path=C:%5CWindows`);
    assert.equal(response.status, 200);
    const snapshot = await response.json() as {
      filePath: string; entries: { level: string; source: string; message: string }[];
    };
    assert.equal(snapshot.filePath, runtimeLog!.filePath);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].level, 'warn');
    assert.equal(snapshot.entries[0].source, 'dialogue');
    assert.match(snapshot.entries[0].message, /\[REDACTED\]/);
    assert.doesNotMatch(snapshot.entries[0].message, /do-not-store/);

    const download = await fetch(`${base}/api/runtime-logs/download?path=C:%5CWindows`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /attachment/);
    const content = await download.text();
    assert.match(content, /"source":"ollama"/);
    assert.doesNotMatch(content, /do-not-store/);
    assert.equal((await fetch(`${base}/api/runtime-logs?limit=9999`)).status, 400);
  } finally {
    await server.close();
    runtimeLog!.close();
  }
});

test('模型运行方式接口公开三种模式并在安全边界内应用到共享网关', async () => {
  const { server, base, gateway, log } = await setup();
  try {
    const initial = await (await fetch(`${base}/api/llm/config`)).json() as {
      config: { mode: string; revision: number; hasCredential: boolean };
      safety: { ready: boolean; reasons: string[] };
      supportedModes: string[];
      credentialPolicy: string;
    };
    assert.equal(initial.config.mode, 'mock');
    assert.equal(initial.config.revision, 1);
    assert.equal(initial.config.hasCredential, false);
    assert.deepEqual(initial.supportedModes, ['mock', 'ollama', 'api']);
    assert.equal(initial.credentialPolicy, 'memory_only');
    assert.equal(initial.safety.ready, false);
    assert.ok(initial.safety.reasons.some((reason) => reason.includes('暂停')));

    const runningApply = await fetch(`${base}/api/llm/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }),
    });
    assert.equal(runningApply.status, 409);

    await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'pause' }),
    });
    const probeResponse = await fetch(`${base}/api/llm/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }),
    });
    assert.equal(probeResponse.status, 200);
    const probe = await probeResponse.json() as { probe: { mode: string; provider: string } };
    assert.equal(probe.probe.mode, 'mock');
    assert.equal(probe.probe.provider, 'mock');

    const appliedResponse = await fetch(`${base}/api/llm/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }),
    });
    assert.equal(appliedResponse.status, 200);
    const applied = await appliedResponse.json() as { config: { mode: string; revision: number } };
    assert.equal(applied.config.mode, 'mock');
    assert.equal(applied.config.revision, 2);
    assert.equal(gateway.runtimeSnapshot().revision, 2);
    const audit = log.eventsOfKind('llm_runtime_config_changed');
    assert.equal(audit.length, 1);
    assert.equal((audit[0].payload as { mode?: string }).mode, 'mock');

    const invalidApi = await fetch(`${base}/api/llm/test`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'api', apiKey: '' }),
    });
    assert.equal(invalidApi.status, 400);
    assert.match(await invalidApi.text(), /API Key/);
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
    log.addEvent({
      id: 'story-2', type: 'move', actorId: 'agent:1', targetIds: ['obj:bed'],
      description: '甲 到达床。', location: 'obj:bed', gameTime: 0,
      payload: null,
    });
    assert.equal(log.eventsOfKind('action_decision_quality').length, 1);
    const narrative = await (await fetch(`${base}/api/narrative?limit=100`)).json() as {
      items: Array<{ id: string; kind: string; researchTier: string; researchLabel: string }>;
    };
    const routine = narrative.items.find((item) => item.id === 'story-1');
    assert.equal(routine?.researchTier, 'routine');
    assert.equal(routine?.researchLabel, '例行记录');
    const legacyRoutine = narrative.items.find((item) => item.id === 'story-2');
    assert.equal(legacyRoutine?.kind, 'move');
    assert.equal(legacyRoutine?.researchTier, 'routine');
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
    assert.equal(activity?.researchTier, 'signal');
    assert.equal(activity?.researchLabel, '事件结果');
    assert.equal(activity?.venueId, 'obj:plaza');
    assert.equal(activity?.participantCount, 2);
    assert.deepEqual(activity?.sensoryCues, ['摊位交谈声']);
    const gift = narrative.items.find((item) => item.id === 'gift-fulfilled');
    assert.equal(gift?.eventStatus, 'fulfilled');
    assert.equal(gift?.researchTier, 'signal');
    assert.equal(gift?.researchLabel, '馈礼与关系');
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
