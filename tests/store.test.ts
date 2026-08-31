import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
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
  const db = openDb(join(dir, 'nested', 't.sqlite'));
  try {
    db.setMeta('k', 'v');
    assert.equal(db.getMeta('k'), 'v');
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});

test('旧会话表迁移保留既有记录、索引并幂等支持 interrupted 终态', () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-conversation-migration-'));
  const path = join(dir, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      agent_a TEXT NOT NULL,
      agent_b TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','completed','error')),
      started_game_time INTEGER NOT NULL,
      ended_game_time INTEGER,
      turn_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      updated_game_time INTEGER NOT NULL
    );
    CREATE INDEX idx_conversations_agents_time
      ON conversations(agent_a, agent_b, updated_game_time DESC);
    INSERT INTO conversations VALUES
      ('completed:legacy', 'agent:a', 'agent:b', 'completed', 2, 8, 3, '既有摘要', '', 8),
      ('active:legacy', 'agent:a', 'agent:c', 'active', 12, NULL, 0, '', '', 12);
  `);
  legacy.close();

  let db = openDb(path);
  try {
    const table = db.raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'")
      .get() as { sql: string };
    assert.match(table.sql, /'interrupted'/);
    const completed = db.raw.prepare("SELECT * FROM conversations WHERE id='completed:legacy'")
      .get() as { status: string; ended_game_time: number; summary: string };
    assert.deepEqual(
      { status: completed.status, ended: completed.ended_game_time, summary: completed.summary },
      { status: 'completed', ended: 8, summary: '既有摘要' },
    );
    const index = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_conversations_agents_time'").get();
    assert.ok(index);
    const store = new MemoryStore(db);
    assert.equal(store.interruptConversation('active:legacy', 5, '测试世界结束'), true);
    const interrupted = db.raw.prepare("SELECT status, ended_game_time, error_text FROM conversations WHERE id='active:legacy'")
      .get() as { status: string; ended_game_time: number; error_text: string };
    assert.equal(interrupted.status, 'interrupted');
    assert.equal(interrupted.ended_game_time, 12);
    assert.equal(interrupted.error_text, '测试世界结束');
    assert.equal(store.interruptConversation('active:legacy', 99, '重复终止'), false);
  } finally {
    db.raw.close();
  }

  db = openDb(path);
  try {
    const rows = db.raw.prepare('SELECT id, status FROM conversations ORDER BY id').all()
      .map((row) => ({ ...(row as { id: string; status: string }) }));
    assert.deepEqual(rows, [
      { id: 'active:legacy', status: 'interrupted' },
      { id: 'completed:legacy', status: 'completed' },
    ]);
  } finally {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
});
