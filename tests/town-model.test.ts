import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { RelationshipStore } from '../src/store/relationships';
import { TownModel } from '../src/engine/town-model';
import { buildTown } from '../src/engine/seed';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const rels = new RelationshipStore(db);
  const model = new TownModel(log, rels);
  return { db, log, world, rels, model };
}

function attendanceSequence(seed: number, days = 12): string {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const model = new TownModel(log, new RelationshipStore(db), { seed });
  const world = buildTown();
  try {
    const sequence: string[][] = [];
    for (let day = 1; day <= days; day += 1) {
      model.tick(world, 0, (day - 1) * 1440 + 300);
      const event = log.eventsForDay(day).find((item) => item.payload?.kind === 'town_event_announcement');
      sequence.push(event?.payload?.selectedIds as string[]);
    }
    return JSON.stringify(sequence);
  } finally {
    db.raw.close();
  }
}

test('公开活动出席排序对同一种子可复现，并随种子改变', () => {
  assert.equal(attendanceSequence(41), attendanceSequence(41));
  assert.notEqual(attendanceSequence(41), attendanceSequence(42));
});

test('活动预告区分兴趣与容量选择，真实到场形成场景事件但不自动推断亲密关系', () => {
  const { log, world, rels, model } = setup();
  model.tick(world, 0, 300);
  const announcement = log.eventsForDay(1).find((event) => event.payload?.kind === 'town_event_announcement');
  assert.ok(announcement);
  assert.match(announcement.description, /尚未发生/);
  assert.equal(log.eventsForDay(1).some((event) => event.payload?.kind === 'town_event'), false);

  const interested = announcement.payload?.interestedIds as string[];
  const selected = announcement.payload?.selectedIds as string[];
  assert.ok(interested.length > selected.length);
  assert.equal(selected.length, 3);
  assert.equal(announcement.payload?.attendanceCapacity, 3);
  assert.equal(announcement.payload?.selectionMethod, 'seeded_trait_rank/v1');
  const venue = world.getObject('obj:lake')!;
  selected.slice(0, 2).forEach((id, index) => {
    const agent = world.getAgent(id);
    agent.x = venue.x + index;
    agent.y = venue.y;
    agent.locationId = venue.id;
    agent.state = 'idle';
  });
  model.tick(world, 0, 1170);

  const event = log.eventsForDay(1).find((item) => item.payload?.kind === 'town_event');
  assert.ok(event);
  const participants = event.payload?.participants as string[];
  assert.deepEqual(participants.sort(), selected.slice(0, 2).sort());
  assert.equal(event.location, venue.id);
  assert.match(event.description, /现场（已核验）.*实际到场参加/);
  assert.match(venue.state?.label ?? '', /进行中/);
  for (const id of participants) {
    const agent = world.getAgent(id);
    assert.equal(agent.state, 'acting');
    assert.equal(agent.action?.action.target, venue.id);
    assert.match(agent.action?.action.verb ?? '', /参加湖边派对/);
  }
  assert.deepEqual(rels.allPairs(), []);
  assert.deepEqual(rels.allEvidence(), []);
});

test('有兴趣但没有到场不会形成共同活动，现场核验后明确取消', () => {
  const { log, world, rels, model } = setup();
  model.tick(world, 0, 300);
  model.tick(world, 0, 1170);
  assert.equal(log.eventsForDay(1).some((event) => event.payload?.kind === 'town_event'), false);
  const cancelled = log.eventsForDay(1).find((event) => event.payload?.kind === 'town_event_cancelled');
  assert.ok(cancelled);
  assert.match(cancelled.description, /实际到场.*活动取消/);
  assert.equal(world.allAgents().some((agent) => rels.evidenceFor(agent.id, undefined, 100)
    .some((item) => item.sourceKind === 'shared_activity')), false);
});

test('活动开始前只为空闲且有兴趣的居民安排可达路线，移动记录保持未发生状态', () => {
  const { log, world, model } = setup();
  model.tick(world, 0, 300);
  model.tick(world, 0, 1110);
  const departures = log.eventsForDay(1).filter((event) => event.payload?.kind === 'town_event_departure');
  const announcement = log.eventsForDay(1).find((event) => event.payload?.kind === 'town_event_announcement');
  assert.ok(announcement);
  assert.equal(departures.length, (announcement.payload?.selectedIds as string[]).length);
  for (const event of departures) {
    assert.match(event.description, /活动尚未开始/);
    const agent = world.getAgent(event.actorId!);
    assert.ok(agent.state === 'moving' || agent.state === 'acting');
    assert.equal(agent.action?.action.target, 'obj:lake');
    assert.ok(agent.state === 'acting' || agent.path.length > 1);
  }
});

test('60 日公开活动保持容量边界与日间变化，且单凭共同在场不会生成完全关系图', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const rels = new RelationshipStore(db);
  const model = new TownModel(log, rels, { seed: 41 });
  try {
    const repeatedLakeSelections = new Set<string>();
    for (let day = 1; day <= 60; day += 1) {
      const dayStart = (day - 1) * 1440;
      for (const agent of world.allAgents()) {
        agent.x = 0;
        agent.y = 0;
        agent.state = 'idle';
        agent.action = null;
        agent.path = [];
        agent.pathProgress = 0;
      }
      model.tick(world, 0, dayStart + 300);
      const announcement = log.eventsForDay(day).find((event) => event.payload?.kind === 'town_event_announcement');
      assert.ok(announcement);
      const selected = announcement.payload?.selectedIds as string[];
      assert.ok(selected.length <= Number(announcement.payload?.attendanceCapacity));
      assert.ok(selected.length < (announcement.payload?.interestedIds as string[]).length);
      if (announcement.payload?.name === '湖边派对') repeatedLakeSelections.add([...selected].sort().join('|'));
      const venue = world.getObject(String(announcement.payload?.venueId));
      assert.ok(venue);
      selected.forEach((id, index) => {
        const agent = world.getAgent(id);
        agent.x = venue.x + index;
        agent.y = venue.y;
        agent.locationId = venue.id;
      });
      model.tick(world, 0, dayStart + 1170);
      const event = log.eventsForDay(day).find((item) => item.payload?.kind === 'town_event');
      assert.ok(event);
      assert.deepEqual([...(event.payload?.participants as string[])].sort(), [...selected].sort());
    }

    assert.ok(repeatedLakeSelections.size >= 3, '相同活动跨日应出现多种人格加权出席组合');
    assert.equal(log.eventsOfKind('town_event').length, 60);
    assert.equal(rels.allPairs().length, 0, '共同在场本身不构造任意二元关系边');
    assert.equal(rels.allEvidence().length, 0);
  } finally {
    db.raw.close();
  }
});

test('活动目录按天轮换；无意向居民时取消且不虚构参与者', () => {
  const { log, world, model } = setup();
  for (const agent of world.allAgents()) {
    agent.persona.personality = { extraversion: 0, empathy: 0, honesty: 0, curiosity: 0, patience: 0 };
  }
  model.tick(world, 0, 300);
  model.tick(world, 0, 1170);
  const cancelled = log.eventsForDay(1).find((event) => event.payload?.kind === 'town_event_cancelled');
  assert.ok(cancelled);
  assert.deepEqual(cancelled.payload?.attendeeIds, []);
});
