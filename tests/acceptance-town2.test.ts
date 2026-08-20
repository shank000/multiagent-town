// 小镇 2.0 阶段 A 验收：40×40 大图上全 routine 可达 + 家具可达 + 摄像机数据就绪

import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { GRID_W, GRID_H } from '../src/core/world';
import { buildTown, TOWN_OBJECTS } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { PlayerDirector } from '../src/engine/player';
import { SocialTicker } from '../src/engine/social';

test('小镇2.0阶段A：大图全 routine 可达、NPC 行动、家具对象就位', async () => {
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

  // ① 网格 40×40，家具对象就位
  assert.equal(GRID_W, 40);
  assert.equal(GRID_H, 40);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:bed_lin'), true);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:sofa_zhou'), true);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:cafe_table1'), true);

  // ② 每个 agent 的每个 routine 目标都可达（A* 有解）
  for (const a of world.allAgents()) {
    const from = { x: a.x, y: a.y };
    for (const slot of a.persona.routine) {
      if (!slot.target) continue;
      const to = world.targetTile(slot.target);
      assert.ok(to, `${a.name} 目标不存在: ${slot.target}`);
      const path = world.findPath(from, to);
      assert.ok(path, `${a.name} → ${slot.target} 无路径`);
    }
  }

  // ③ 跑满 1 天：每个 agent 都有移动与互动事件（大图不卡死）
  await loop.runUntil(1440);
  const events = log.eventsForDay(1);
  for (const a of world.allAgents()) {
    const mine = events.filter((e) => e.actorId === a.id);
    assert.ok(mine.some((e) => e.type === 'move'), `${a.name} 从未移动`);
    assert.ok(mine.some((e) => e.type === 'interact'), `${a.name} 从未互动`);
    assert.notEqual(a.state, 'thinking', `${a.name} 卡在 thinking`);
  }

  // ④ 门模型在大图上成立：咖啡馆门开口、顶角是墙
  const cafe = world.getObject('obj:cafe')!;
  assert.equal(world.walkable(cafe.x + Math.floor(cafe.w / 2), cafe.y + cafe.h - 1), true);
  assert.equal(world.walkable(cafe.x, cafe.y), false);
});
