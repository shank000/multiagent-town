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
  /** messages 表消息总数（对话引擎逐句写入） */
  messages: number;
  /** 按 day 过滤时的当日消息数（未过滤为 null） */
  filteredMessages: number | null;
  perDay: { day: number; count: number }[];
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

interface RawEventRow {
  type: string;
  actor_id: string | null;
  description?: string;
  location: string | null;
  game_time: number;
  payload_json: string | null;
}
interface RawAgentRow { id: string; name: string }
interface RawMemRow { agent_id: string; kind: string; importance: number; created_game_time: number; last_access_game_time: number }
interface RawRefRow { agent_id: string; insights_json: string; trigger_score: number }
interface RawPlanRow { agent_id: string; day: number; hourly_json: string }
interface RawMsgRow { from_agent: string; to_agent: string; content: string; game_time: number }
interface RawRelRow {
  agent_a: string; agent_b: string; knowledge_json: string;
  affection: number; respect: number; updated_game_time: number;
}
interface RawRumorRow { origin_agent: string; content: string; hops: number }

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

function hourBucketLabel(gameTime: number): string {
  const bucketStart = Math.floor((gameTime % MINUTES_PER_DAY) / 120) * 2;
  return `${String(bucketStart).padStart(2, '0')}:00`;
}

function timeText(gameTime: number): string {
  const hh = String(Math.floor((gameTime % MINUTES_PER_DAY) / 60)).padStart(2, '0');
  const mm = String(gameTime % 60).padStart(2, '0');
  return `第${Math.floor(gameTime / MINUTES_PER_DAY) + 1}天 ${hh}:${mm}`;
}

function analyzeEvents(db: DbHandle, day: number | undefined, map: Map<string, string>, top: number): EventSection {
  const rows = (day !== undefined
    ? db.raw.prepare('SELECT * FROM events WHERE game_time >= ? AND game_time < ?').all((day - 1) * MINUTES_PER_DAY, day * MINUTES_PER_DAY)
    : db.raw.prepare('SELECT * FROM events').all()) as unknown as RawEventRow[];

  const byType = new Map<string, number>();
  const byPayloadKind = new Map<string, number>();
  const perDay = new Map<number, number>();
  const perHour = new Map<string, number>();
  const actors = new Map<string, number>();
  const locations = new Map<string, number>();

  for (const r of rows) {
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    let kind = 'none';
    if (r.payload_json) {
      const p = JSON.parse(r.payload_json) as { kind?: string } | null;
      if (p?.kind) kind = p.kind;
    }
    byPayloadKind.set(kind, (byPayloadKind.get(kind) ?? 0) + 1);
    perDay.set(Math.floor(r.game_time / MINUTES_PER_DAY) + 1, (perDay.get(Math.floor(r.game_time / MINUTES_PER_DAY) + 1) ?? 0) + 1);
    const h = hourBucketLabel(r.game_time);
    perHour.set(h, (perHour.get(h) ?? 0) + 1);
    if (r.actor_id) actors.set(r.actor_id, (actors.get(r.actor_id) ?? 0) + 1);
    if (r.location) locations.set(r.location, (locations.get(r.location) ?? 0) + 1);
  }

  const topList = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh')).slice(0, top);

  return {
    total: rows.length,
    filtered: day !== undefined,
    byType: Object.fromEntries([...byType.entries()].sort((a, b) => b[1] - a[1])),
    byPayloadKind: Object.fromEntries([...byPayloadKind.entries()].sort((a, b) => b[1] - a[1])),
    perDay: [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => ({ day: d, count: c })),
    perHour: [...perHour.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([h, c]) => ({ hour: h, count: c })),
    topActors: topList(actors).map(([id, c]) => ({ id, name: namesOf(map, id), count: c })),
    topLocations: topList(locations).map(([loc, c]) => ({ location: loc, count: c })),
  };
}

function analyzeMemories(db: DbHandle, map: Map<string, string>, days: number, top: number): MemorySection {
  const rows = db.raw.prepare('SELECT * FROM memories').all() as unknown as RawMemRow[];
  const byKind = new Map<string, number>();
  const byAgent = new Map<string, number>();
  let sum = 0, max = -Infinity, min = Infinity;
  const hist = new Map<string, number>([['<4', 0], ['4–6.9', 0], ['7–8.9', 0], ['≥9', 0]]);
  let never = 0;

  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? 0) + 1);
    sum += r.importance;
    if (r.importance > max) max = r.importance;
    if (r.importance < min) min = r.importance;
    const key = r.importance < 4 ? '<4' : r.importance < 7 ? '4–6.9' : r.importance < 9 ? '7–8.9' : '≥9';
    hist.set(key, (hist.get(key) ?? 0) + 1);
    if (r.last_access_game_time === r.created_game_time) never++;
  }

  const byAgentTop = [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([id, c]) => ({ id, name: namesOf(map, id), count: c }));

  return {
    total: rows.length,
    byKind: Object.fromEntries([...byKind.entries()].sort((a, b) => b[1] - a[1])),
    byAgent: byAgentTop,
    importance: {
      avg: rows.length ? sum / rows.length : 0,
      max: rows.length ? max : 0,
      min: rows.length ? min : 0,
    },
    importanceHist: [...hist.entries()].map(([label, count]) => ({ label, count })),
    neverAccessed: { count: never, ratio: rows.length ? never / rows.length : 0 },
    perDayRate: days ? rows.length / days : 0,
  };
}

function analyzeReflections(db: DbHandle, map: Map<string, string>, top: number): ReflectionSection {
  const rows = db.raw.prepare('SELECT * FROM reflections').all() as unknown as RawRefRow[];
  const byAgent = new Map<string, number>();
  let triggerSum = 0, insightSum = 0;
  for (const r of rows) {
    byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? 0) + 1);
    triggerSum += r.trigger_score;
    insightSum += (JSON.parse(r.insights_json) as string[]).length;
  }
  return {
    total: rows.length,
    byAgent: [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([id, c]) => ({ id, name: namesOf(map, id), count: c })),
    avgTriggerScore: rows.length ? triggerSum / rows.length : 0,
    avgInsights: rows.length ? insightSum / rows.length : 0,
  };
}

function analyzePlans(db: DbHandle, map: Map<string, string>, top: number): PlanSection {
  const rows = db.raw.prepare('SELECT * FROM plans').all() as unknown as RawPlanRow[];
  const byAgent = new Map<string, number>();
  const days = new Set<number>();
  let hourlySum = 0;
  for (const r of rows) {
    byAgent.set(r.agent_id, (byAgent.get(r.agent_id) ?? 0) + 1);
    days.add(r.day);
    hourlySum += (JSON.parse(r.hourly_json) as unknown[]).length;
  }
  return {
    total: rows.length,
    byAgent: [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([id, c]) => ({ id, name: namesOf(map, id), count: c })),
    daysCovered: days.size,
    avgHourlyItems: rows.length ? hourlySum / rows.length : 0,
  };
}

function analyzeDialogues(db: DbHandle, day: number | undefined, map: Map<string, string>, top: number): DialogueSection {
  const rows = db.raw.prepare('SELECT * FROM messages').all() as unknown as RawMsgRow[];
  const perDay = new Map<number, number>();
  const pairs = new Map<string, number>();
  let chars = 0;
  let filteredMessages: number | null = null;

  for (const r of rows) {
    const d = Math.floor(r.game_time / MINUTES_PER_DAY) + 1;
    perDay.set(d, (perDay.get(d) ?? 0) + 1);
    pairs.set(`${r.from_agent}→${r.to_agent}`, (pairs.get(`${r.from_agent}→${r.to_agent}`) ?? 0) + 1);
    chars += r.content.length;
    if (day !== undefined && d === day) filteredMessages = (filteredMessages ?? 0) + 1;
  }

  // 会话归并：chat 事件 payload 里的 conversationId 相同即同一场对话
  const chatRows = (day !== undefined
    ? db.raw.prepare('SELECT payload_json FROM events WHERE type = ? AND game_time >= ? AND game_time < ?').all('chat', (day - 1) * MINUTES_PER_DAY, day * MINUTES_PER_DAY)
    : db.raw.prepare('SELECT payload_json FROM events WHERE type = ?').all('chat')) as unknown as { payload_json: string | null }[];
  const conversations = new Map<string, number>();
  for (const r of chatRows) {
    if (!r.payload_json) continue;
    const p = JSON.parse(r.payload_json) as { conversationId?: string } | null;
    if (!p?.conversationId) continue;
    conversations.set(p.conversationId, (conversations.get(p.conversationId) ?? 0) + 1);
  }
  const turnsArr = [...conversations.values()];

  return {
    messages: rows.length,
    filteredMessages,
    perDay: [...perDay.entries()].sort((a, b) => a[0] - b[0]).map(([d, c]) => ({ day: d, count: c })),
    topPairs: [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([k, c]) => {
        const [from, to] = k.split('→');
        return { from: namesOf(map, from), to: namesOf(map, to), count: c };
      }),
    avgCharsPerMessage: rows.length ? chars / rows.length : 0,
    conversations: conversations.size,
    avgTurnsPerConversation: turnsArr.length ? turnsArr.reduce((a, b) => a + b, 0) / turnsArr.length : 0,
  };
}

function analyzeRelationships(db: DbHandle, map: Map<string, string>, top: number): RelationshipSection {
  const rows = db.raw.prepare('SELECT * FROM relationships').all() as unknown as RawRelRow[];
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
  const rows = db.raw.prepare('SELECT * FROM rumors').all() as unknown as RawRumorRow[];
  const contents = new Set<string>();
  const hops = new Map<number, number>();
  const origins = new Map<string, number>();
  let maxHops = 0;
  for (const r of rows) {
    contents.add(r.content);
    hops.set(r.hops, (hops.get(r.hops) ?? 0) + 1);
    if (r.hops > maxHops) maxHops = r.hops;
    origins.set(r.origin_agent, (origins.get(r.origin_agent) ?? 0) + 1);
  }
  return {
    total: rows.length,
    uniqueContents: contents.size,
    maxHops,
    hopsHist: [...hops.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => ({ hops: h, count: c })),
    topOrigins: [...origins.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
      .map(([id, c]) => ({ id, name: namesOf(map, id), count: c })),
  };
}

/** 主入口：对整库做只读聚合，返回结构化报告 */
export function analyzeTown(db: DbHandle, opts: AnalyzeOptions = {}): TownReport {
  const top = opts.top ?? 5;
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
  const relationships = analyzeRelationships(db, map, top);

  const standingRows = db.raw.prepare('SELECT * FROM relationships').all() as unknown as RawRelRow[];
  const standingRels: Relationship[] = standingRows.map((r) => ({
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

  const townEvents = eventsScoped(db, day)
    .filter((r) => r.payload_json && (JSON.parse(r.payload_json) as { kind?: string } | null)?.kind === 'town_event')
    .map((r) => {
      const p = JSON.parse(r.payload_json!) as { name?: string; participants?: string[] } | null;
      return {
        name: p?.name ?? '未知活动',
        timeText: timeText(r.game_time),
        participants: p?.participants?.length ?? 0,
      };
    });

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

function eventsScoped(db: DbHandle, day: number | undefined): RawEventRow[] {
  return (day !== undefined
    ? db.raw.prepare('SELECT * FROM events WHERE game_time >= ? AND game_time < ?').all((day - 1) * MINUTES_PER_DAY, day * MINUTES_PER_DAY)
    : db.raw.prepare('SELECT * FROM events').all()) as unknown as RawEventRow[];
}