// 天气纯函数 + 快照字段
import test from 'node:test';
import assert from 'node:assert/strict';
import { weatherForDay } from '../src/core/weather';
import { TimeEngine, MINUTES_PER_DAY } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { buildSnapshot } from '../src/web/snapshot';

// TimeEngine.state 是只读 getter（每次返回新对象），无法用 time.state.day = n 赋天数；
// 改为推进时钟到目标天数（brief 原测试的赋值写法无效）。
function advanceToDay(time: TimeEngine, day: number): void {
  const target = (day - 1) * MINUTES_PER_DAY;
  while (time.state.totalMinutes < target) time.tick();
}

test('weatherForDay：每 3 天第 3 天为雨，其余晴（确定性）', () => {
  assert.equal(weatherForDay(1), 'clear');
  assert.equal(weatherForDay(2), 'rain');
  assert.equal(weatherForDay(3), 'clear');
  assert.equal(weatherForDay(4), 'clear');
  assert.equal(weatherForDay(5), 'rain');
  assert.equal(weatherForDay(6), 'clear');
  assert.equal(weatherForDay(8), 'rain'); // day 8 = 8%3===2
});

test('快照携带 weather（与 day 对应）', () => {
  const world = buildTown();
  const time = new TimeEngine(60);
  advanceToDay(time, 4); // 4%3===1 → clear
  assert.equal(buildSnapshot(world, time, false, 1).weather, 'clear');
  advanceToDay(time, 5); // 5%3===2 → rain
  assert.equal(buildSnapshot(world, time, false, 2).weather, 'rain');
});
