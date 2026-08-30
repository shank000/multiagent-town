import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTown } from '../src/engine/seed';
import { TownLifeEngine } from '../src/engine/town-life';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { PerceptionEngine } from '../src/engine/perception';

test('生活物件提供可供性、感官线索、见证范围与可达目标', () => {
  const world = buildTown();
  const ids = [
    'obj:notice_board', 'obj:market_stall', 'obj:plaza_fountain', 'obj:park_bench',
    'obj:bird_feeder', 'obj:water_pump', 'obj:community_garden', 'obj:tool_rack', 'obj:bus_stop',
  ];
  for (const id of ids) {
    const object = world.getObject(id);
    assert.ok(object, `${id} 应存在`);
    assert.ok(object.description);
    assert.ok((object.affordances?.length ?? 0) >= 2);
    assert.ok((object.sensoryCues?.length ?? 0) >= 2);
    assert.ok((object.observationRadius ?? 0) >= 5);
    const tile = world.centerOf(object);
    assert.equal(world.walkable(tile.x, tile.y), true, `${id} 中心应可达`);
  }
});

test('跨时间窗口补齐日常事件、按距离选择观察者并更新现场状态', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const agents = world.allAgents();
  const feeder = world.getObject('obj:bird_feeder')!;
  const center = world.centerOf(feeder);
  agents[0].x = center.x;
  agents[0].y = center.y;
  agents[1].x = center.x + 1;
  agents[1].y = center.y;
  for (const agent of agents.slice(2)) { agent.x = 40; agent.y = 35; }
  const model = new TownLifeEngine(log);

  model.tick(world, 420, 420);
  const events = log.eventsForDay(1).filter((event) => event.payload?.kind === 'ambient_life');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload?.objectId, 'obj:bird_feeder');
  assert.deepEqual(events[0].payload?.observerIds, [agents[0].id, agents[1].id]);
  assert.deepEqual(events[0].payload?.memoryAgentIds, [agents[0].id, agents[1].id]);
  assert.equal(feeder.state?.label, '鸟群聚集');

  model.tick(world, 0, 420);
  assert.equal(log.eventsForDay(1).filter((event) => event.payload?.kind === 'ambient_life').length, 1, '同一边界不应重复触发');
  model.tick(world, 750, 1170);
  assert.equal(log.eventsForDay(1).filter((event) => event.payload?.kind === 'ambient_life').length, 4, '大步长应补齐当日余下三个生活时段');
  assert.equal(feeder.state, undefined, '过期现场状态应被清理');
});

test('无行动者的环境事件进入附近居民感知缓冲', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const feeder = world.getObject('obj:bird_feeder')!;
  const center = world.centerOf(feeder);
  const observer = world.allAgents()[0];
  observer.x = center.x;
  observer.y = center.y;
  const perception = new PerceptionEngine(world, log);
  const model = new TownLifeEngine(log);

  model.tick(world, 420, 420);
  const entries = perception.drain(observer.id);
  assert.ok(entries.some((entry) => entry.type === 'environment' && entry.from === feeder.name));
  assert.ok(entries.some((entry) => entry.text?.includes('麻雀')));
  perception.dispose();
});
