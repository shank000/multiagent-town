import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import type { GameEvent } from '../src/core/types';

function ev(id: string, gameTime: number, description: string, type: GameEvent['type'], payload: Record<string, unknown> | null = null): GameEvent {
  return { id, type, actorId: 'agent:1', targetIds: ['obj:a'], description, location: 'obj:cafe', gameTime, payload };
}

test('openDb 建表并支持 meta 读写', () => {
  const db = openDb(':memory:');
  db.setMeta('game_time', '42');
  assert.equal(db.getMeta('game_time'), '42');
  assert.equal(db.getMeta('none'), null);
  const row = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events'").get();
  assert.ok(row);
});

test('事件写入与按天回放（时间升序）', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  log.addEvent(ev('e1', 10, '事件A', 'system'));
  log.addEvent(ev('e2', 1440, '第2天事件', 'system'));
  log.addEvent(ev('e3', 1439, '事件B', 'interact'));
  assert.equal(log.count(), 3);
  assert.deepEqual(log.eventsForDay(1).map((e) => e.id), ['e1', 'e3']);
  assert.deepEqual(log.eventsForDay(2).map((e) => e.id), ['e2']);
});

test('事件订阅与 payload 往返', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const got: GameEvent[] = [];
  const off = log.subscribe((e) => got.push(e));
  log.addEvent(ev('e1', 5, 'X', 'move', { verb: '走' }));
  off();
  log.addEvent(ev('e2', 6, 'Y', 'move'));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].payload, { verb: '走' });
  const read = log.eventsForDay(1)[0];
  assert.equal(read.actorId, 'agent:1');
  assert.deepEqual(read.targetIds, ['obj:a']);
});

test('最近事件查询在数据库层限量并保持同刻写入顺序', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  log.addEvent(ev('e1', 10, 'A', 'system'));
  log.addEvent(ev('e2', 20, 'B', 'system'));
  log.addEvent(ev('e3', 20, 'C', 'system'));
  log.addEvent(ev('e4', 30, 'D', 'system'));

  assert.deepEqual(log.recent(2).map((e) => e.id), ['e3', 'e4']);
  assert.deepEqual(log.recent(3, 30).map((e) => e.id), ['e1', 'e2', 'e3']);
  assert.deepEqual(log.recent(0), []);
});

test('payload.kind 查询仅返回目标实验事件', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  log.addEvent(ev('c1', 10, '选择1', 'system', { kind: 'experiment_pair_choice', fromId: 'a', toId: 'b' }));
  log.addEvent(ev('g1', 11, '馈礼', 'interact', { kind: 'gift' }));
  log.addEvent(ev('c2', 20, '选择2', 'system', { kind: 'experiment_pair_choice', fromId: 'b', toId: 'a' }));

  assert.deepEqual(log.eventsOfKind('experiment_pair_choice').map((e) => e.id), ['c1', 'c2']);
  assert.deepEqual(log.eventsOfKind('experiment_pair_choice', 11, 20).map((e) => e.id), []);
});

test('文件模式自动创建目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-'));
  try {
    const db = openDb(join(dir, 'nested', 't.sqlite'));
    db.setMeta('k', 'v');
    assert.equal(db.getMeta('k'), 'v');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
