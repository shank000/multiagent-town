// M2 验收：寻路绕墙 + 玩家指令执行 + 广播全员知晓

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
import { createTownServer } from '../src/web/server';
import { flush } from './helpers';

test('M2 验收：寻路经门进吧台、玩家指令执行、广播全员记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-m2-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, player, publicDir: dir });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // ① 寻路：咖啡馆吧台在房间瓦片（开口），从家出发存在合法路径且全程无墙
    const lin = world.allAgents()[0]; // 林晚晴，家中心 (4,4)
    const path = world.findPath({ x: lin.x, y: lin.y }, world.targetTile('obj:cafe_counter')!)!;
    assert.ok(path, '应找到通往吧台的路');
    for (const t of path) assert.equal(world.walkable(t.x, t.y), true, `路径含墙 (${t.x},${t.y})`);
    const cafe = world.getObject('obj:cafe')!;
    const door = { x: cafe.x + Math.floor(cafe.w / 2), y: cafe.y + cafe.h - 1 };
    assert.equal(world.walkable(door.x, door.y), true); // 门开口（底边中点）
    assert.equal(world.walkable(cafe.x, cafe.y), false); // 左上角顶边是墙（无房间覆盖）

    // ② 玩家指令：让沈屿去书店（含「默语书店」对象名）
    const shen = world.allAgents().find((a) => a.name === '沈屿')!;
    const r = await fetch(`${base}/api/player/${encodeURIComponent(shen.id)}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '去默语书店看书' }),
    });
    assert.equal(r.status, 200);
    await loop.runUntil(120);
    assert.ok(
      world.targetTile('obj:bookstore') !== null &&
      (Math.abs(shen.x - world.targetTile('obj:bookstore')!.x) <= 1 && Math.abs(shen.y - world.targetTile('obj:bookstore')!.y) <= 1),
      `沈屿应前往书店，实际 (${shen.x},${shen.y})`
    );

    // ③ 广播：全员获得派对记忆（未核验活动预告为 6）
    await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '今晚湖边派对，欢迎所有人！' }),
    });
    await flush();
    for (const a of world.allAgents()) {
      const mem = mind.store.recentMemories(a.id, 50).find((m) => m.content.includes('湖边派对'));
      assert.ok(mem, `${a.name} 应记住广播`);
      assert.equal(mem.importance, 6);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
