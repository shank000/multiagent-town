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
import { MindEngine } from '../src/engine/mind';
import { PlayerDirector } from '../src/engine/player';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'web-player-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:2', name: '乙', x: 1, y: 0, persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [a, b]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, player, publicDir: dir });
  return { dir, db, log, world, mind, player, server, base: `http://127.0.0.1:${server.port}` };
}

test('玩家指令 API：act 设置、delete 清除', async () => {
  const { player, server, base, world, dir } = await setup();
  try {
    const r = await fetch(`${base}/api/player/${encodeURIComponent('agent:1')}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '去公园写生' }),
    });
    assert.equal(r.status, 200);
    assert.equal(player.current('agent:1', world.allAgents()[0].actionEndsAt + 0), '去公园写生');
    await fetch(`${base}/api/player/${encodeURIComponent('agent:1')}/act`, { method: 'DELETE' });
    assert.equal(player.current('agent:1', 0), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('广播：全员 agent 获得记忆（未核验派对预告 → importance 6）', async () => {
  const { mind, server, base, dir } = await setup();
  try {
    const r = await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '今晚湖边派对，欢迎所有人！' }),
    });
    assert.equal(r.status, 200);
    await flush();
    for (const id of ['agent:1', 'agent:2']) {
      const mems = mind.store.recentMemories(id, 20);
      assert.ok(mems.some((m) => m.content.includes('湖边派对')), `${id} 应记住广播`);
      assert.equal(mems.find((m) => m.content.includes('湖边派对'))!.importance, 6);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
