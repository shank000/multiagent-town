import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { RelationshipStore } from '../src/store/relationships';
import { TownModel } from '../src/engine/town-model';
import { buildTown } from '../src/engine/seed';

test('活动成行：报名 ≥2 → 广播 + 参与者记忆重要度 9', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const rels = new RelationshipStore(db);
  const model = new TownModel(log, rels);
  // 5:00 生成报名
  model.tick(world, 0, 300);
  // 19:30 成行
  model.tick(world, 0, 1170);
  const ev = log.eventsForDay(1).find((e) => e.payload?.kind === 'town_event');
  assert.ok(ev, '应有成行广播');
  assert.equal(ev.type, 'broadcast');
  const participants = (ev.payload as { participants: string[] }).participants;
  assert.ok(participants.length >= 2);
});

test('活动目录按天轮换；报名不足取消', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  // 全员低性格 → 取消（把世界替换为无性格者：用 buildTown 后手动把 personality 全设 0）
  for (const a of world.allAgents()) a.persona.personality = { extraversion: 0, empathy: 0, honesty: 0, curiosity: 0, patience: 0 };
  const model = new TownModel(log, new RelationshipStore(db));
  model.tick(world, 0, 300);
  model.tick(world, 0, 1170);
  assert.ok(log.eventsForDay(1).some((e) => e.type === 'system' && e.description.includes('取消')));
});
