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

test('活动预告只记录意向，真实到场后才形成参与事件、场景动作与关系证据', () => {
  const { log, world, rels, model } = setup();
  model.tick(world, 0, 300);
  const announcement = log.eventsForDay(1).find((event) => event.payload?.kind === 'town_event_announcement');
  assert.ok(announcement);
  assert.match(announcement.description, /尚未发生/);
  assert.equal(log.eventsForDay(1).some((event) => event.payload?.kind === 'town_event'), false);

  const interested = announcement.payload?.interestedIds as string[];
  assert.ok(interested.length >= 2);
  const venue = world.getObject('obj:lake')!;
  interested.slice(0, 2).forEach((id, index) => {
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
  assert.deepEqual(participants.sort(), interested.slice(0, 2).sort());
  assert.equal(event.location, venue.id);
  assert.match(event.description, /现场（已核验）.*实际到场参加/);
  assert.match(venue.state?.label ?? '', /进行中/);
  for (const id of participants) {
    const agent = world.getAgent(id);
    assert.equal(agent.state, 'acting');
    assert.equal(agent.action?.action.target, venue.id);
    assert.match(agent.action?.action.verb ?? '', /参加湖边派对/);
  }
  const evidence = rels.evidenceFor(participants[0], participants[1], 10);
  assert.ok(evidence.some((item) => item.sourceEventId === event.id && item.metadata.status === 'attendance_verified'));
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
  assert.ok(departures.length >= 2);
  for (const event of departures) {
    assert.match(event.description, /活动尚未开始/);
    const agent = world.getAgent(event.actorId!);
    assert.ok(agent.state === 'moving' || agent.state === 'acting');
    assert.equal(agent.action?.action.target, 'obj:lake');
    assert.ok(agent.state === 'acting' || agent.path.length > 1);
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
