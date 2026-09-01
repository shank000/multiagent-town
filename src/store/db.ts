// SQLite（node:sqlite）打开与 M0 表结构（design §4.1 的子集）

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS world_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runtime_checkpoint (
  slot            INTEGER PRIMARY KEY CHECK (slot = 1),
  schema_version  INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  updated_at      TEXT NOT NULL
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
  reflection_kind TEXT NOT NULL DEFAULT 'triggered',
  day           INTEGER NOT NULL DEFAULT 1,
  questions_json TEXT NOT NULL,
  insights_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  diary_text    TEXT NOT NULL DEFAULT '',
  mind_state_json TEXT NOT NULL DEFAULT '{}',
  beliefs_json  TEXT NOT NULL DEFAULT '[]',
  revisions_json TEXT NOT NULL DEFAULT '[]',
  guidance_json TEXT NOT NULL DEFAULT '[]',
  version       INTEGER NOT NULL DEFAULT 1,
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
  game_time INTEGER NOT NULL,
  conversation_id TEXT,
  turn_index INTEGER
);
CREATE TABLE IF NOT EXISTS conversations (
  id                TEXT PRIMARY KEY,
  agent_a           TEXT NOT NULL,
  agent_b           TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','completed','error','interrupted')),
  started_game_time INTEGER NOT NULL,
  ended_game_time   INTEGER,
  turn_count        INTEGER NOT NULL DEFAULT 0,
  summary           TEXT NOT NULL DEFAULT '',
  error_text        TEXT NOT NULL DEFAULT '',
  updated_game_time INTEGER NOT NULL
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

-- 有向关系的不可变证据账本。旧 relationships 表继续保存实验使用的
-- affection/respect 当前值；本表只为审计、回放和只读社会投影服务。
CREATE TABLE IF NOT EXISTS relationship_evidence (
  id                TEXT PRIMARY KEY,
  agent_a           TEXT NOT NULL,
  agent_b           TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  source_event_id   TEXT,
  source_text       TEXT NOT NULL,
  game_time         INTEGER NOT NULL,
  affection_before REAL NOT NULL,
  affection_delta  REAL NOT NULL,
  affection_after  REAL NOT NULL,
  respect_before   REAL NOT NULL,
  respect_delta    REAL NOT NULL,
  respect_after    REAL NOT NULL,
  trust_delta      REAL NOT NULL DEFAULT 0,
  support_delta    REAL NOT NULL DEFAULT 0,
  tension_delta    REAL NOT NULL DEFAULT 0,
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_rel_evidence_pair_time
  ON relationship_evidence(agent_a, agent_b, game_time DESC);
CREATE INDEX IF NOT EXISTS idx_rel_evidence_event
  ON relationship_evidence(source_event_id);

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
  // 兼容既有实验库：反思结构采用幂等增量列，不要求重建或丢弃历史数据。
  ensureColumn(raw, 'reflections', 'reflection_kind', "TEXT NOT NULL DEFAULT 'triggered'");
  ensureColumn(raw, 'reflections', 'day', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(raw, 'reflections', 'diary_text', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(raw, 'reflections', 'mind_state_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(raw, 'reflections', 'beliefs_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(raw, 'reflections', 'revisions_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(raw, 'reflections', 'guidance_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(raw, 'reflections', 'version', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(raw, 'messages', 'conversation_id', 'TEXT');
  ensureColumn(raw, 'messages', 'turn_index', 'INTEGER');
  ensureInterruptedConversationStatus(raw);
  raw.exec('CREATE INDEX IF NOT EXISTS idx_reflections_agent_day ON reflections(agent_id, day, created_game_time)');
  raw.exec('CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(game_time)');
  raw.exec('CREATE INDEX IF NOT EXISTS idx_messages_conversation_turn ON messages(conversation_id, turn_index)');
  raw.exec('CREATE INDEX IF NOT EXISTS idx_conversations_agents_time ON conversations(agent_a, agent_b, updated_game_time DESC)');
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

/** 旧库的 CHECK 约束不能 ALTER；事务内重建表并原样搬运既有会话。 */
function ensureInterruptedConversationStatus(raw: DatabaseSync): void {
  const row = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'")
    .get() as { sql?: string } | undefined;
  if (row?.sql?.includes("'interrupted'")) return;
  raw.exec('BEGIN IMMEDIATE');
  try {
    raw.exec(`
      ALTER TABLE conversations RENAME TO conversations_before_interrupted;
      CREATE TABLE conversations (
        id                TEXT PRIMARY KEY,
        agent_a           TEXT NOT NULL,
        agent_b           TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('active','completed','error','interrupted')),
        started_game_time INTEGER NOT NULL,
        ended_game_time   INTEGER,
        turn_count        INTEGER NOT NULL DEFAULT 0,
        summary           TEXT NOT NULL DEFAULT '',
        error_text        TEXT NOT NULL DEFAULT '',
        updated_game_time INTEGER NOT NULL
      );
      INSERT INTO conversations(
        id, agent_a, agent_b, status, started_game_time, ended_game_time,
        turn_count, summary, error_text, updated_game_time
      ) SELECT
        id, agent_a, agent_b, status, started_game_time, ended_game_time,
        turn_count, summary, error_text, updated_game_time
      FROM conversations_before_interrupted;
      DROP TABLE conversations_before_interrupted;
      COMMIT;
    `);
  } catch (error) {
    try { raw.exec('ROLLBACK'); } catch { /* 原始迁移错误优先 */ }
    throw error;
  }
}

function ensureColumn(raw: DatabaseSync, table: 'reflections' | 'messages', column: string, definition: string): void {
  const columns = raw.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
