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
CREATE INDEX IF NOT EXISTS idx_events_payload_kind_time
  ON events(json_extract(payload_json, '$.kind'), game_time);

-- M1 记忆层：记忆流 / 反思树 / 计划 / 对话消息
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  agent_id          TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN
                     ('observation','reflection','dialogue_summary','plan','insight')),
  content           TEXT NOT NULL,
  importance        REAL NOT NULL DEFAULT 5,
  created_game_time INTEGER NOT NULL,
  last_access_game_time INTEGER NOT NULL,
  source_event_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_agent_time ON memories(agent_id, created_game_time);
CREATE INDEX IF NOT EXISTS idx_mem_agent_imp ON memories(agent_id, importance);
CREATE TABLE IF NOT EXISTS reflections (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  parent_id     TEXT,
  depth         INTEGER NOT NULL DEFAULT 0,
  questions_json TEXT NOT NULL,
  insights_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  trigger_score REAL NOT NULL,
  created_game_time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL,
  day           INTEGER NOT NULL,
  broad_plan    TEXT NOT NULL,
  hourly_json   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  created_game_time INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id        TEXT PRIMARY KEY,
  event_id  TEXT,
  from_agent TEXT,
  to_agent  TEXT,
  content   TEXT,
  game_time INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  id         TEXT PRIMARY KEY,
  agent_a    TEXT NOT NULL,
  agent_b    TEXT NOT NULL,
  knowledge_json TEXT NOT NULL DEFAULT '[]',
  affection  REAL NOT NULL DEFAULT 0,
  respect    REAL NOT NULL DEFAULT 0,
  updated_game_time INTEGER NOT NULL,
  UNIQUE(agent_a, agent_b)
);

CREATE TABLE IF NOT EXISTS rumors (
  id         TEXT PRIMARY KEY,
  origin_agent TEXT NOT NULL,
  carrier_agent TEXT NOT NULL,
  content    TEXT NOT NULL,
  hops       INTEGER NOT NULL DEFAULT 0,
  created_game_time INTEGER NOT NULL,
  prev_rumor_id TEXT
);
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
