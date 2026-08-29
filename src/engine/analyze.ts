// 数据统计与分析核心：只读聚合 SQLite 库（events/memories/reflections/plans/messages/
// relationships/rumors），产出结构化 TownReport。数据源供 Web 端 `GET /api/stats`
//（src/web/server.ts + public/stats.html）与测试复用；只读不写，不修改任何数据。
// 设计：所有指标可由 SQL + 少量聚合得出，声望沿用 engine/status.ts 的 Weighted PageRank。

import type { DbHandle } from '../store/db';
import type { Relationship } from '../store/relationships';
import { computeStanding } from './status';
import { MINUTES_PER_DAY } from '../core/time';

export interface AnalyzeOptions {
  /** 事件/消息/对话相关统计只取该天（1 起）；缺省分析全部 */
  day?: number;
  /** 榜单长度（活跃 agent / 地点 / 关系 / 声望等），默认 5 */
  top?: number;
  /** 报告里展示的库路径（仅展示用途；缺省为空串） */
  dbPath?: string;
  /** 居民名册（id → name）注入；缺省从 agents 表读取。
   *  Web 端由世界提供（含访客），离线/测试可省略走数据库。 */
  names?: Map<string, string>;
}

export interface AgentInfo {
  id: string;
  name: string;
}

export interface OverviewSection {
  dbPath: string;
  /** world_meta.game_time（若从未运行则为 0） */
  gameMinutes: number;
  /** 已模拟天数（按 game_time 折算，≥0） */
  days: number;
  agents: AgentInfo[];
  counts: Record<string, number>;
}

export interface EventSection {
  total: number;
  /** 是否按 day 过滤（true 表示只统计某一天） */
  filtered: boolean;
  /** 按事件 type 分组：move/chat/interact/broadcast/system/player */
  byType: Record<string, number>;
  /** 按 payload.kind 分组（无 payload 的归入 'none'） */
  byPayloadKind: Record<string, number>;
  /** 每日事件数（时间升序） */
  perDay: { day: number; count: number }[];
  /** 2 小时档时段分布，hour 为档起始如 "08:00"（对 day 过滤仍按当日分钟） */
  perHour: { hour: string; count: number }[];
  topActors: { id: string; name: string; count: number }[];
  topLocations: { location: string; count: number }[];
}

export interface MemorySection {
  total: number;
  byKind: Record<string, number>;
  byAgent: { id: string; name: string; count: number }[];
  importance: { avg: number; max: number; min: number };
  importanceHist: { label: string; count: number }[];
  /** 从未被检索过的记忆（last_access == created）——记忆活跃度 */
  neverAccessed: { count: number; ratio: number };
  /** 平均每天新增记忆条数（按已模拟天数折算） */
  perDayRate: number;
}

export interface ReflectionSection {
  total: number;
  byAgent: { id: string; name: string; count: number }[];
  avgTriggerScore: number;
  /** 每条反思平均洞察条数 */
  avgInsights: number;
}

export interface PlanSection {
  total: number;
  byAgent: { id: string; name: string; count: number }[];
  /** 有计划覆盖的天数（distinct day） */
  daysCovered: number;
  avgHourlyItems: number;
}

export interface DialogueSection {
  /** 当前报告范围内的消息数；指定 day 时仅含该日 */
  messages: number;
  /** 兼容统计页的筛选提示；指定 day 时等于 messages，未过滤为 null */
  filteredMessages: number | null;
  perDay: { day: number; count: number }[];
  /** 无向伙伴对；正反两个发言方向合并为同一个 dyad */
  topPairs: { from: string; to: string; count: number }[];
  avgCharsPerMessage: number;
  /** 通过 chat 事件的 conversationId 归并出的会话数 */
  conversations: number;
  avgTurnsPerConversation: number;
}

export interface RelationshipSection {
  /** 有向关系行数 */
  pairs: number;
  meanAffection: number;
  maxAffection: number;
  minAffection: number;
  meanRespect: number;
  maxRespect: number;
  minRespect: number;
  /** (affection+respect)/2 最高的 Top N（含名字） */
  strongest: { a: string; b: string; score: number }[];
  /** (affection+respect)/2 最低的 Top N */
  mostHostile: { a: string; b: string; score: number }[];
  /** 存在双向记录的无向对数量 */
  reciprocalPairs: number;
  /** knowledge 叙事层总条目数 */
  knowledgeEntries: number;
}

export interface StandingEntry {
  id: string;
  name: string;
  score: number;
}

export interface RumorSection {
  total: number;
  uniqueContents: number;
  maxHops: number;
  hopsHist: { hops: number; count: number }[];
  topOrigins: { id: string; name: string; count: number }[];
}

export interface TownEventEntry {
  name: string;
  timeText: string;
  participants: number;
}

export interface TownReport {
  overview: OverviewSection;
  events: EventSection;
  memories: MemorySection;
  reflections: ReflectionSection;
  plans: PlanSection;
  dialogues: DialogueSection;
  relationships: RelationshipSection;
  /** 声望榜（Weighted PageRank，降序） */
  standing: StandingEntry[];
  rumors: RumorSection;
  townEvents: TownEventEntry[];
}

interface RawAgentRow { id: string; name: string }
interface RawRelRow {
  agent_a: string; agent_b: string; knowledge_json: string;
  affection: number; respect: number; updated_game_time: number;
}

interface CountRow { key: string; n: number }

function daySql(day: number | undefined): { where: string; params: number[] } {
  return day === undefined
    ? { where: '', params: [] }
    : { where: 'WHERE game_time >= ? AND game_time < ?', params: [(day - 1) * MINUTES_PER_DAY, day * MINUTES_PER_DAY] };
}

function withCondition(where: string, condition: string): string {
  return where ? `${where} AND ${condition}` : `WHERE ${condition}`;
}

function countRecord(rows: readonly CountRow[]): Record<string, number> {
  return Object.fromEntries(rows.map((row) => [row.key, row.n]));
}

const countOf = (db: DbHandle, table: string): number => {
  const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
};

function agentMap(db: DbHandle): Map<string, string> {
  const rows = db.raw.prepare('SELECT id, name FROM agents').all() as unknown as RawAgentRow[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

function namesOf(map: Map<string, string>, id: string | null): string {
  return (id ? map.get(id) : undefined) ?? id ?? '（全局）';
}

function timeText(gameTime: number): string {
  const hh = String(Math.floor((gameTime % MINUTES_PER_DAY) / 60)).padStart(2, '0');
  const mm = String(gameTime % 60).padStart(2, '0');
  return `第${Math.floor(gameTime / MINUTES_PER_DAY) + 1}天 ${hh}:${mm}`;
}

function analyzeEvents(db: DbHandle, day: number | undefined, map: Map<string, string>, top: number): EventSection {
  const { where, params } = daySql(day);
  const total = (db.raw.prepare(`SELECT COUNT(*) AS n FROM events ${where}`).get(...params) as { n: number }).n;
  const byType = db.raw.prepare(
    `SELECT type AS key, COUNT(*) AS n FROM events ${where} GROUP BY type ORDER BY n DESC, key ASC`
  ).all(...params) as unknown as CountRow[];
  const byPayloadKind = db.raw.prepare(
    `SELECT COALESCE(json_extract(payload_json, '$.kind'), 'none') AS key, COUNT(*) AS n
     FROM events ${where} GROUP BY key ORDER BY n DESC, key ASC`
  ).all(...params) as unknown as CountRow[];
  const perDay = db.raw.prepare(
    `SELECT CAST(game_time / ${MINUTES_PER_DAY} AS INTEGER) + 1 AS day, COUNT(*) AS n
     FROM events ${where} GROUP BY day ORDER BY day ASC`
  ).all(...params) as unknown as { day: number; n: number }[];
  const perHour = db.raw.prepare(
    `SELECT CAST((game_time % ${MINUTES_PER_DAY}) / 120 AS INTEGER) * 2 AS hour, COUNT(*) AS n
     FROM events ${where} GROUP BY hour ORDER BY hour ASC`
  ).all(...params) as unknown as { hour: number; n: number }[];
  const actorWhere = withCondition(where, 'actor_id IS NOT NULL');
  const actors = db.raw.prepare(
    `SELECT actor_id AS id, COUNT(*) AS n FROM events ${actorWhere}
     GROUP BY actor_id ORDER BY n DESC, id ASC LIMIT ?`
  ).all(...params, top) as unknown as { id: string; n: number }[];
  const locationWhere = withCondition(where, 'location IS NOT NULL');
  const locations = db.raw.prepare(
    `SELECT location, COUNT(*) AS n FROM events ${locationWhere}
     GROUP BY location ORDER BY n DESC, location ASC LIMIT ?`
  ).all(...params, top) as unknown as { location: string; n: number }[];

  return {
    total,
    filtered: day !== undefined,
    byType: countRecord(byType),
    byPayloadKind: countRecord(byPayloadKind),
    perDay: perDay.map((row) => ({ day: row.day, count: row.n })),
    perHour: perHour.map((row) => ({ hour: `${String(row.hour).padStart(2, '0')}:00`, count: row.n })),
    topActors: actors.map((row) => ({ id: row.id, name: namesOf(map, row.id), count: row.n })),
    topLocations: locations.map((row) => ({ location: row.location, count: row.n })),
  };
}

function analyzeMemories(db: DbHandle, map: Map<string, string>, days: number, top: number): MemorySection {
  const summary = db.raw.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(importance), 0) AS avg,
      COALESCE(MAX(importance), 0) AS max, COALESCE(MIN(importance), 0) AS min,
      COALESCE(SUM(CASE WHEN last_access_game_time = created_game_time THEN 1 ELSE 0 END), 0) AS never
     FROM memories`
  ).get() as { n: number; avg: number; max: number; min: number; never: number };
  const byKind = db.raw.prepare(
    'SELECT kind AS key, COUNT(*) AS n FROM memories GROUP BY kind ORDER BY n DESC, key ASC'
  ).all() as unknown as CountRow[];
  const byAgent = db.raw.prepare(
    'SELECT agent_id AS id, COUNT(*) AS n FROM memories GROUP BY agent_id ORDER BY n DESC, id ASC LIMIT ?'
  ).all(top) as unknown as { id: string; n: number }[];
  const histogram = db.raw.prepare(
    `SELECT
      COALESCE(SUM(CASE WHEN importance < 4 THEN 1 ELSE 0 END), 0) AS low,
      COALESCE(SUM(CASE WHEN importance >= 4 AND importance < 7 THEN 1 ELSE 0 END), 0) AS medium,
      COALESCE(SUM(CASE WHEN importance >= 7 AND importance < 9 THEN 1 ELSE 0 END), 0) AS high,
      COALESCE(SUM(CASE WHEN importance >= 9 THEN 1 ELSE 0 END), 0) AS critical
     FROM memories`
  ).get() as { low: number; medium: number; high: number; critical: number };

  return {
    total: summary.n,
    byKind: countRecord(byKind),
    byAgent: byAgent.map((row) => ({ id: row.id, name: namesOf(map, row.id), count: row.n })),
    importance: {
      avg: summary.avg,
      max: summary.max,
      min: summary.min,
    },
    importanceHist: [
      { label: '<4', count: histogram.low },
      { label: '4–6.9', count: histogram.medium },
      { label: '7–8.9', count: histogram.high },
      { label: '≥9', count: histogram.critical },
    ],
    neverAccessed: { count: summary.never, ratio: summary.n ? summary.never / summary.n : 0 },
    perDayRate: days ? summary.n / days : 0,
  };
}

function analyzeReflections(db: DbHandle, map: Map<string, string>, top: number): ReflectionSection {
  const summary = db.raw.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(trigger_score), 0) AS avgTrigger,
      COALESCE(AVG(json_array_length(insights_json)), 0) AS avgInsights FROM reflections`
  ).get() as { n: number; avgTrigger: number; avgInsights: number };
  const byAgent = db.raw.prepare(
    'SELECT agent_id AS id, COUNT(*) AS n FROM reflections GROUP BY agent_id ORDER BY n DESC, id ASC LIMIT ?'
  ).all(top) as unknown as { id: string; n: number }[];
  return {
    total: summary.n,
    byAgent: byAgent.map((row) => ({ id: row.id, name: namesOf(map, row.id), count: row.n })),
    avgTriggerScore: summary.avgTrigger,
    avgInsights: summary.avgInsights,
  };
}

function analyzePlans(db: DbHandle, map: Map<string, string>, top: number): PlanSection {
  const summary = db.raw.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT day) AS daysCovered,
      COALESCE(AVG(json_array_length(hourly_json)), 0) AS avgHourly FROM plans`
  ).get() as { n: number; daysCovered: number; avgHourly: number };
  const byAgent = db.raw.prepare(
    'SELECT agent_id AS id, COUNT(*) AS n FROM plans GROUP BY agent_id ORDER BY n DESC, id ASC LIMIT ?'
  ).all(top) as unknown as { id: string; n: number }[];
  return {
    total: summary.n,
    byAgent: byAgent.map((row) => ({ id: row.id, name: namesOf(map, row.id), count: row.n })),
    daysCovered: summary.daysCovered,
    avgHourlyItems: summary.avgHourly,
  };
}

function analyzeDialogues(db: DbHandle, day: number | undefined, map: Map<string, string>, top: number): DialogueSection {
  const { where, params } = daySql(day);
  const summary = db.raw.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(length(content)), 0) AS avgChars FROM messages ${where}`
  ).get(...params) as { n: number; avgChars: number };
  const perDay = db.raw.prepare(
    `SELECT CAST(game_time / ${MINUTES_PER_DAY} AS INTEGER) + 1 AS day, COUNT(*) AS n
     FROM messages ${where} GROUP BY day ORDER BY day ASC`
  ).all(...params) as unknown as { day: number; n: number }[];
  const pairs = db.raw.prepare(
    `SELECT
       CASE WHEN from_agent <= to_agent THEN from_agent ELSE to_agent END AS fromId,
       CASE WHEN from_agent <= to_agent THEN to_agent ELSE from_agent END AS toId,
       COUNT(*) AS n
     FROM messages ${where}
     GROUP BY fromId, toId ORDER BY n DESC, fromId ASC, toId ASC LIMIT ?`
  ).all(...params, top) as unknown as { fromId: string; toId: string; n: number }[];

  // 会话与轮数使用同一日边界，并只计逐句 chat，不把 chat_summary 当作额外一轮。
  const chatWhere = withCondition(
    where,
    `type = 'chat' AND json_extract(payload_json, '$.kind') = 'chat'
     AND json_extract(payload_json, '$.conversationId') IS NOT NULL`
  );
  const conversations = db.raw.prepare(
    `SELECT COUNT(*) AS n, COALESCE(AVG(turns), 0) AS avgTurns FROM (
       SELECT json_extract(payload_json, '$.conversationId') AS conversationId, COUNT(*) AS turns
       FROM events ${chatWhere} GROUP BY conversationId
     )`
  ).get(...params) as { n: number; avgTurns: number };

  return {
    messages: summary.n,
    filteredMessages: day === undefined ? null : summary.n,
    perDay: perDay.map((row) => ({ day: row.day, count: row.n })),
    topPairs: pairs.map((row) => ({
      from: namesOf(map, row.fromId), to: namesOf(map, row.toId), count: row.n,
    })),
    avgCharsPerMessage: summary.avgChars,
    conversations: conversations.n,
    avgTurnsPerConversation: conversations.avgTurns,
  };
}

function loadRelationships(db: DbHandle): RawRelRow[] {
  // 关系规模受居民数平方约束；显式列与上限防止损坏数据库导致无界同步读取。
  return db.raw.prepare(
    `SELECT agent_a, agent_b, knowledge_json, affection, respect, updated_game_time
     FROM relationships LIMIT 10000`
  ).all() as unknown as RawRelRow[];
}

function analyzeRelationships(rows: RawRelRow[], map: Map<string, string>, top: number): RelationshipSection {
  const rels: Relationship[] = rows.map((r) => ({
    agentA: r.agent_a, agentB: r.agent_b,
    knowledge: JSON.parse(r.knowledge_json) as string[],
    affection: r.affection, respect: r.respect, updatedGameTime: r.updated_game_time,
  }));

  const dir = new Set(rows.map((r) => `${r.agent_a}::${r.agent_b}`));
  let reciprocal = 0;
  for (const r of rows) if (dir.has(`${r.agent_b}::${r.agent_a}`)) reciprocal++;

  let aSum = 0, rSum = 0, kSum = 0;
  let aMax = -Infinity, aMin = Infinity, rMax = -Infinity, rMin = Infinity;
  for (const rel of rels) {
    aSum += rel.affection; rSum += rel.respect; kSum += rel.knowledge.length;
    if (rel.affection > aMax) aMax = rel.affection;
    if (rel.affection < aMin) aMin = rel.affection;
    if (rel.respect > rMax) rMax = rel.respect;
    if (rel.respect < rMin) rMin = rel.respect;
  }
  const n = rels.length;
  const combined = rels.map((rel) => ({ rel, score: (rel.affection + rel.respect) / 2 }));
  const pick = (arr: { rel: Relationship; score: number }[]) => arr.slice(0, top)
    .map(({ rel, score }) => ({ a: namesOf(map, rel.agentA), b: namesOf(map, rel.agentB), score }));

  return {
    pairs: n,
    meanAffection: n ? aSum / n : 0,
    maxAffection: n ? aMax : 0,
    minAffection: n ? aMin : 0,
    meanRespect: n ? rSum / n : 0,
    maxRespect: n ? rMax : 0,
    minRespect: n ? rMin : 0,
    strongest: pick([...combined].sort((x, y) => y.score - x.score || x.rel.agentA.localeCompare(y.rel.agentA, 'zh'))),
    mostHostile: pick([...combined].sort((x, y) => x.score - y.score || x.rel.agentA.localeCompare(y.rel.agentA, 'zh'))),
    reciprocalPairs: reciprocal / 2,
    knowledgeEntries: kSum,
  };
}

function analyzeRumors(db: DbHandle, map: Map<string, string>, top: number): RumorSection {
  const summary = db.raw.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT content) AS uniqueContents,
      COALESCE(MAX(hops), 0) AS maxHops FROM rumors`
  ).get() as { n: number; uniqueContents: number; maxHops: number };
  const hops = db.raw.prepare(
    'SELECT hops, COUNT(*) AS n FROM rumors GROUP BY hops ORDER BY hops ASC'
  ).all() as unknown as { hops: number; n: number }[];
  const origins = db.raw.prepare(
    'SELECT origin_agent AS id, COUNT(*) AS n FROM rumors GROUP BY origin_agent ORDER BY n DESC, id ASC LIMIT ?'
  ).all(top) as unknown as { id: string; n: number }[];
  return {
    total: summary.n,
    uniqueContents: summary.uniqueContents,
    maxHops: summary.maxHops,
    hopsHist: hops.map((row) => ({ hops: row.hops, count: row.n })),
    topOrigins: origins.map((row) => ({ id: row.id, name: namesOf(map, row.id), count: row.n })),
  };
}

function analyzeTownEvents(db: DbHandle, day: number | undefined): TownEventEntry[] {
  const { where, params } = daySql(day);
  const townWhere = withCondition(where, `json_extract(payload_json, '$.kind') = 'town_event'`);
  const rows = db.raw.prepare(
    `SELECT game_time, payload_json FROM events ${townWhere}
     ORDER BY game_time DESC LIMIT 500`
  ).all(...params) as unknown as { game_time: number; payload_json: string }[];
  return rows.reverse().map((row) => {
    const payload = JSON.parse(row.payload_json) as { name?: string; participants?: string[] } | null;
    return {
      name: payload?.name ?? '未知活动',
      timeText: timeText(row.game_time),
      participants: payload?.participants?.length ?? 0,
    };
  });
}

/** 主入口：对整库做只读聚合，返回结构化报告 */
export function analyzeTown(db: DbHandle, opts: AnalyzeOptions = {}): TownReport {
  const top = Number.isSafeInteger(opts.top) && (opts.top ?? 0) > 0 ? Math.min(100, opts.top!) : 5;
  const day = opts.day;
  const map = opts.names ?? agentMap(db);
  const gameMinutes = Number(db.getMeta('game_time') ?? '0');
  const days = Math.floor(gameMinutes / MINUTES_PER_DAY);

  const overview: OverviewSection = {
    dbPath: opts.dbPath ?? '',
    gameMinutes,
    days,
    agents: [...map.entries()].map(([id, name]) => ({ id, name })),
    counts: {
      agents: map.size,
      objects: countOf(db, 'objects'),
      events: countOf(db, 'events'),
      memories: countOf(db, 'memories'),
      reflections: countOf(db, 'reflections'),
      plans: countOf(db, 'plans'),
      messages: countOf(db, 'messages'),
      relationships: countOf(db, 'relationships'),
      rumors: countOf(db, 'rumors'),
    },
  };

  const events = analyzeEvents(db, day, map, top);
  const memories = analyzeMemories(db, map, days, top);
  const reflections = analyzeReflections(db, map, top);
  const plans = analyzePlans(db, map, top);
  const dialogues = analyzeDialogues(db, day, map, top);
  const relationshipRows = loadRelationships(db);
  const relationships = analyzeRelationships(relationshipRows, map, top);

  const standingRels: Relationship[] = relationshipRows.map((r) => ({
    agentA: r.agent_a, agentB: r.agent_b,
    knowledge: JSON.parse(r.knowledge_json) as string[],
    affection: r.affection, respect: r.respect, updatedGameTime: r.updated_game_time,
  }));
  const standingMap = computeStanding(standingRels);
  // PageRank 只覆盖有关系边的节点；补上零分居民，保证声望榜覆盖全镇名册
  for (const id of map.keys()) {
    if (!standingMap.has(id)) standingMap.set(id, 0);
  }
  const standingList = [...standingMap.entries()]
    .map(([id, s]) => ({ id, name: namesOf(map, id), score: s }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'zh'));

  const townEvents = analyzeTownEvents(db, day);

  return {
    overview,
    events,
    memories,
    reflections,
    plans,
    dialogues,
    relationships,
    standing: standingList,
    rumors: analyzeRumors(db, map, top),
    townEvents,
  };
}
