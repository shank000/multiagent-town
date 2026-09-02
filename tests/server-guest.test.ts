// 协议访客 API：登录/环顾/行动；访客以第 7 位身份加入世界
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINUTES_PER_DAY, TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { SocialTicker } from '../src/engine/social';
import { PlayerDirector } from '../src/engine/player';
import { createTownServer } from '../src/web/server';
import { ExperimentRunner } from '../src/engine/experiment-runner';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'town-srv-'));
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
  const experiment = new ExperimentRunner(log, world, mind, { historyAccess: 'on', giftExchange: 'off' });
  const server = await createTownServer({
    world, time, loop, log, mind, player, rels: mind.rels, rumors: mind.rumors, experiment, publicDir: dir,
  });
  return { base: `http://127.0.0.1:${server.port}`, server, world, time, log, experiment };
}

test('访客协议：login → look → walk → say 全链路', async () => {
  const { base, server, world, log } = await boot();
  try {
    const r1 = await (await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '爱丽丝' }),
    })).json() as { ok: boolean; id: string };
    assert.equal(r1.ok, true);
    assert.equal(world.allAgents().length, 7);
    assert.ok(world.allAgents().some((a) => a.id === 'agent:爱丽丝'));

    const r2 = await (await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '爱丽丝' }),
    })).json() as { ok: boolean };
    assert.equal(r2.ok, true);
    assert.equal(world.allAgents().length, 7, '重复登录不重复建角色');

    const r3 = await (await fetch(`${base}/api/guest/look?name=${encodeURIComponent('爱丽丝')}`)).json() as {
      location: string; nearby: unknown[];
    };
    assert.equal(r3.location, '中央广场');
    assert.ok(Array.isArray(r3.nearby));

    const r4 = await (await fetch(`${base}/api/guest/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '爱丽丝', action: 'walk', target: 'obj:park' }),
    })).json() as { ok: boolean };
    assert.equal(r4.ok, true);

    const r5 = await (await fetch(`${base}/api/guest/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '爱丽丝', action: 'say', text: '大家好！' }),
    })).json() as { ok: boolean };
    assert.equal(r5.ok, true);
    const chats = log.eventsBetween(0, 1e9).filter((e) => e.type === 'chat' && e.actorId === 'agent:爱丽丝');
    assert.equal(chats.length, 1);
    assert.ok(chats[0].description.includes('大家好！'));

    const bad = await fetch(`${base}/api/guest/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '爱丽丝', action: 'fly', target: 'x' }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await server.close();
  }
});

test('感知系统：say 后的 look 返回环境感知（注意力分级）', async () => {
  const { base, server } = await boot();
  try {
    await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旅人乙' }),
    });
    // 让一位 NPC 在远处互动，制造 move/chat 事件（以系统记录为准：直接由脚本 say 触发 chat）
    await fetch(`${base}/api/guest/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旅人乙', action: 'say', text: '测试感知！' }),
    });
    const look = await (await fetch(`${base}/api/guest/look?name=${encodeURIComponent('旅人乙')}`)).json() as {
      perceptions: { type: string; attention: number; distance: number; text: string | null }[];
    };
    assert.ok(Array.isArray(look.perceptions));
    // 自身 say 事件不会出现在自己的感知里（actor≠me）
    const selfIncluded = look.perceptions.some((p) => p.text?.includes('测试感知'));
    assert.equal(selfIncluded, false, '自己的说话不进自己感知');
    // 另一位访客登录产生 join 事件 → 应进入感知（同点，距离 0）
    await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '旅人丙' }),
    });
    const look2 = await (await fetch(`${base}/api/guest/look?name=${encodeURIComponent('旅人乙')}`)).json() as {
      perceptions: { type: string }[];
    };
    assert.ok(look2.perceptions.some((p) => p.type === 'join'), '新居民加入应被感知');
  } finally {
    await server.close();
  }
});

test('涌现控制台 API：config/start/metrics 全链路', async () => {
  const { base, server, world, time, experiment } = await boot();
  try {
    void world;
    while (time.state.totalMinutes < MINUTES_PER_DAY + 60) time.tick();
    const cfg = await (await fetch(`${base}/api/experiment/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mem: 'on', gift: 'off' }),
    })).json() as { ok: boolean };
    assert.equal(cfg.ok, true);

    const start = await (await fetch(`${base}/api/experiment/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ days: 30 }),
    })).json() as { ok: boolean };
    assert.equal(start.ok, true);

    const st = await (await fetch(`${base}/api/experiment/state`)).json() as { running: boolean; remainingDays: number };
    assert.equal(st.running, true);
    assert.equal(st.remainingDays, 30);

    experiment.tick(2 * MINUTES_PER_DAY);
    const nextDay = await (await fetch(`${base}/api/experiment/state`)).json() as { remainingDays: number };
    assert.equal(nextDay.remainingDays, 29, 'start 使用当前世界时刻建立日界线基准');

    const met = await (await fetch(`${base}/api/experiment/metrics`)).json() as {
      ok: boolean;
      repeat: number[];
      recipRate: number[];
      recipBaseline: number[];
      seriesDays: { persistence: number[] };
      availability: { persistence: { state: string; requiredConsecutiveChoiceDays: number } };
    };
    assert.equal(met.ok, true);
    assert.ok(Array.isArray(met.repeat));
    assert.ok(Array.isArray(met.recipRate));
    assert.ok(Array.isArray(met.recipBaseline));
    assert.ok(Array.isArray(met.seriesDays.persistence));
    assert.equal(met.availability.persistence.requiredConsecutiveChoiceDays, 14);

    const stop = await (await fetch(`${base}/api/experiment/stop`, { method: 'POST' })).json() as { ok: boolean };
    assert.equal(stop.ok, true);
  } finally {
    await server.close();
  }
});

test('叙事 API：返回结构化事件（对话/馈礼/内心）', async () => {
  const { base, server } = await boot();
  try {
    await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '叙事者' }),
    });
    await fetch(`${base}/api/guest/act`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '叙事者', action: 'say', text: '记录这一刻！' }),
    });
    const r = await (await fetch(`${base}/api/narrative?limit=100`)).json() as {
      ok: boolean; items: { kind: string; actorName: string; text: string; day: number; minute: number }[];
    };
    assert.equal(r.ok, true);
    assert.ok(r.items.length > 0);
    const say = r.items.find((x) => x.kind === 'chat' && x.text.includes('记录这一刻'));
    assert.ok(say, 'say 事件应进入叙事流');
    assert.equal(say.actorName, '叙事者');
    assert.ok(say.day >= 1 && say.minute >= 0 && say.minute < 1440);
  } finally {
    await server.close();
  }
});
