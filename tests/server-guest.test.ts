// 协议访客 API：登录/环顾/行动；访客以第 7 位身份加入世界
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
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
import { PlayerDirector } from '../src/engine/player';
import { createTownServer } from '../src/web/server';

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
  const server = await createTownServer({
    world, time, loop, log, mind, player, rels: mind.rels, rumors: mind.rumors, publicDir: dir,
  });
  return { base: `http://127.0.0.1:${server.port}`, server, world, log };
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
