import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine, MINUTES_PER_DAY } from '../src/core/time';

test('tick 按配置推进游戏分钟', () => {
  const t = new TimeEngine(0.5);
  t.tick();
  t.tick();
  assert.equal(t.state.totalMinutes, 1);
  assert.equal(t.state.day, 1);
  assert.equal(t.state.minutesOfDay, 1);
});

test('跨天翻转', () => {
  const t = new TimeEngine(30);
  for (let i = 0; i < MINUTES_PER_DAY / 30; i++) t.tick();
  assert.equal(t.state.day, 2);
  assert.equal(t.state.minutesOfDay, 0);
  assert.equal(t.state.totalMinutes, 1440);
});

test('format 输出中文时钟', () => {
  assert.equal(TimeEngine.format({ day: 1, minutesOfDay: 570, totalMinutes: 570 }), '第1天 09:30');
  assert.equal(TimeEngine.format({ day: 2, minutesOfDay: 0, totalMinutes: 1440 }), '第2天 00:00');
});

test('minuteOfDay 取当日分钟', () => {
  assert.equal(TimeEngine.minuteOfDay(1440 + 95), 95);
});
