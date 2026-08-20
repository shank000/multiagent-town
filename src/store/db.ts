// SQLite（node:sqlite）打开与 M0 表结构（design §4.1 的子集）

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  persona_json  TEXT NOT NULL,
  home_object   TEXT,
  state_json    TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS objects (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  x REAL, y REAL, w REAL, h REAL,
  state_json TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,
  actor_id        TEXT,
  target_ids_json TEXT,
  description     TEXT NOT NULL,
  location        TEXT,
  game_time       INTEGER NOT NULL,
  payload_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(game_time);
`;

export interface DbHandle {
  raw: DatabaseSync;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
}

export function openDb(path: string): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA);
  return {
    raw,
    setMeta(key, value) {
      raw.prepare(
        'INSERT INTO world_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(key, value);
    },
    getMeta(key) {
      const row = raw.prepare('SELECT value FROM world_meta WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
  };
}
