# M1 认知核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 multiagent-town 加上 M1 认知核心：记忆流（轻量三因子检索）+ 日计划/小时分解 + 反思树 + 多轮对话（摘要双写）+ 访谈命令 + 心智面板。验收：跑满 1 游戏日（mock 3600x）后——每 agent 记忆 ≥15 条、反思 ≥1 次、对话摘要 ≥1 条、日计划已生成、访谈回答能引用真实记忆、心智面板 API 可用。

**Architecture:** 新增 MindEngine 门面（engine/mind.ts）捆绑记忆/规划/反思/对话四个子系统，作为可选参数注入 AgentExecutor / WorldLoop / town-web（M0 调用点零破坏）。记忆写入经 MemoryWriter 订阅 EventLog（事件→观察→importance 打分→写库），检索用 recency(0.995) + importance + 中文双字 shingle 关键词重叠三因子（用户批准的轻量方案，不引向量）。LLM 全部走既有 LLMGateway（mock 确定性覆盖全部新模板；DeepSeek 真机可切）。SocialTicker 降级为对话触发器（无对话引擎时保持 M0 单句行为）。

**Tech Stack:** 既有 TS strict + node:sqlite + LLMGateway + Canvas 客户端（SSE）。零新增依赖。

**Spec:** `docs/ai-town-design.md` §5.2 感知→记忆、§5.3 检索、§5.4 规划、§5.6 反思、§5.7 对话、§6.1-6.9 提示词、§4.1 DDL（memories/reflections/plans/messages）。**已批准的偏离**：① 检索 relevance 用关键词重叠代替 bge-m3 embedding（用户选定「轻量检索」）；② SocialTicker 变为对话触发器；③ 反思触发阈值/窗口同 spec（150/每天 2 次）。

## Global Constraints

- TypeScript `strict: true`；全部新增代码注释与用户可见文案一律中文
- 零新增依赖；LLM 调用全异步不阻塞 tick；每 agent 同时最多 1 个决策在飞（反思/对话/计划各司其职，互不阻塞 tick）
- 记忆 content ≤ 200 字；kind ∈ observation|reflection|dialogue_summary|plan|insight；importance 1~10
- 检索权重：recency 0.25（0.995 衰减）+ importance 0.35（/10 归一）+ relevance 0.40（Jaccard 双字 shingle）
- 反思：importance 累计 >150 触发；每天每 agent ≤2 次；insight 用「我」开头 ≤1 句
- 对话：≤12 轮、每轮 1~3 句、2 游戏分钟一句、结束摘要 ≤100 字写回双方记忆流（kind=dialogue_summary）
- 事件 type 枚举不变；chat 事件 payload 增加 conversationId（可选）
- mock 全模板确定性、离线跑通全链路；M0 既有 54 个测试不得破坏（mind 参数全部可选）
- 实现全部在 `m1-cognitive-core` 分支

---

### Task 1: 记忆层（表结构 + MemoryStore + 关键词检索）

**Files:**
- Modify: `src/store/db.ts`（SCHEMA 追加 4 张表）
- Create: `src/store/memory.ts`、`tests/memory.test.ts`

**Interfaces:**
- Produces（后续任务依赖，签名以此为准）：
  - `Memory { id; agentId; kind; content; importance; createdGameTime; lastAccessGameTime }`
  - `ReflectionRecord { id; agentId; parentId; depth; questions: string[]; insights: string[]; evidenceIds: string[]; triggerScore; createdGameTime }`
  - `AgendaItem { time; action; location }`、`PlanRecord { id; agentId; day; broadPlan; hourly: AgendaItem[]; status; createdGameTime }`
  - `shingles(text): string[]`、`keywordSimilarity(a, b): number`（Jaccard，双字 shingle，去标点空白，含字母数字）
  - `new MemoryStore(db: DbHandle)`：
    - `addMemory(m)`（content 截断 200、累加 importance 到内存累计器）
    - `retrieve(agentId, query, now, k=20): Memory[]`（三因子排序 + 更新 last_access）
    - `recentMemories(agentId, n)`、`countFor(agentId)`
    - `accumulator(agentId): number`、`resetAccumulator(agentId)`
    - `addReflection(r)`、`reflectionsFor(agentId)`、`recentInsights(agentId, n)`
    - `savePlan(p)`（同 agent+day upsert）、`planFor(agentId, day)`
    - `addMessage(m)`、`messagesFor(agentId, limit=50)`

- [ ] **Step 1: 写失败测试 tests/memory.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { MemoryStore, shingles, keywordSimilarity } from '../src/store/memory';

function setup() {
  const db = openDb(':memory:');
  return { db, store: new MemoryStore(db) };
}

test('记忆写入/截断/计数', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'x'.repeat(300), importance: 6, createdGameTime: 10 });
  assert.equal(store.countFor('agent:1'), 1);
  assert.equal(store.recentMemories('agent:1', 1)[0].content.length, 200);
});

test('检索按三因子排序并更新 last_access', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在咖啡馆煮咖啡招待客人', importance: 5, createdGameTime: 100 });
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在公园散步看湖', importance: 5, createdGameTime: 200 });
  // 重要度同样为 5：验证关键词相关性而非重要性主导排序
  store.addMemory({ agentId: 'agent:1', kind: 'plan', content: '筹备湖畔派对邀请大家', importance: 5, createdGameTime: 300 });
  const top = store.retrieve('agent:1', '咖啡馆煮咖啡', 300, 20);
  assert.equal(top.length, 3);
  assert.equal(top[0].content, '在咖啡馆煮咖啡招待客人'); // 关键词相关 + 最近
  assert.equal(top[0].lastAccessGameTime, 300);
});

test('importance 累计器读写清零', () => {
  const { store } = setup();
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'a', importance: 6, createdGameTime: 1 });
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: 'b', importance: 9, createdGameTime: 2 });
  assert.equal(store.accumulator('agent:1'), 15);
  store.resetAccumulator('agent:1');
  assert.equal(store.accumulator('agent:1'), 0);
});

test('反思树与 insight 提取', () => {
  const { store } = setup();
  store.addReflection({ agentId: 'agent:1', parentId: null, depth: 0, questions: ['q1'], insights: ['我最近常去咖啡馆。', '我喜欢观察客人。'], evidenceIds: ['m1'], triggerScore: 160, createdGameTime: 50 });
  const refs = store.reflectionsFor('agent:1');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].depth, 0);
  assert.deepEqual(store.recentInsights('agent:1', 2), ['我最近常去咖啡馆。', '我喜欢观察客人。']);
});

test('计划 upsert 与对话消息', () => {
  const { store } = setup();
  store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营。', hourly: [{ time: '09:00', action: '开店', location: '咖啡馆吧台' }], status: 'active', createdGameTime: 300 });
  store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营。', hourly: [{ time: '10:00', action: '煮咖啡', location: '咖啡馆吧台' }], status: 'active', createdGameTime: 420 });
  const plan = store.planFor('agent:1', 1)!;
  assert.equal(plan.hourly.length, 1); // upsert 覆盖
  assert.equal(plan.hourly[0].action, '煮咖啡');
  store.addMessage({ eventId: null, fromAgent: 'agent:1', toAgent: 'agent:2', content: '你好呀！', gameTime: 30 });
  assert.equal(store.messagesFor('agent:2').length, 1);
});

test('shingles 与关键词相似度', () => {
  assert.ok(keywordSimilarity('咖啡馆煮咖啡', '在咖啡馆煮咖啡招待客人') > 0.3);
  assert.equal(keywordSimilarity('咖啡馆', '书店看书'), 0);
  assert.deepEqual(shingles('ab'), ['ab']);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/memory.test.ts`
Expected: FAIL，报 `Cannot find module '../src/store/memory'`。

- [ ] **Step 3: 修改 src/store/db.ts（SCHEMA 追加）**

在 `SCHEMA` 常量末尾（`CREATE INDEX ... idx_events_time` 之后、反引号之前）追加：

```sql

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
```

- [ ] **Step 4: 写 src/store/memory.ts**

```ts
// 记忆层：记忆流 + 三因子检索（recency/importance/关键词）+ 反思树 + 计划 + 对话消息
// M1-lite 检索：relevance 用中文双字 shingle 的 Jaccard 相似度（用户批准，不引向量）

import { randomUUID } from 'node:crypto';
import type { DbHandle } from './db';

export interface Memory {
  id: string; agentId: string; kind: string; content: string;
  importance: number; createdGameTime: number; lastAccessGameTime: number;
}
export interface ReflectionRecord {
  id: string; agentId: string; parentId: string | null; depth: number;
  questions: string[]; insights: string[]; evidenceIds: string[]; triggerScore: number; createdGameTime: number;
}
export interface AgendaItem { time: string; action: string; location: string }
export interface PlanRecord {
  id: string; agentId: string; day: number; broadPlan: string;
  hourly: AgendaItem[]; status: string; createdGameTime: number;
}

export const RECENCY_ALPHA = 0.25;
export const IMPORTANCE_ALPHA = 0.35;
export const RELEVANCE_ALPHA = 0.40;

/** 双字 shingle：去标点空白后滑窗取二元组（中文为主，含字母数字） */
export function shingles(text: string): string[] {
  const normalized = text.replace(/[^\p{Script=Han}a-z0-9]/giu, '');
  const set = new Set<string>();
  for (let i = 0; i + 1 < normalized.length; i++) set.add(normalized.slice(i, i + 2));
  if (normalized.length === 1) set.add(normalized);
  return [...set];
}

/** Jaccard 相似度（0~1） */
export function keywordSimilarity(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  let inter = 0;
  for (const s of A) if (setB.has(s)) inter++;
  return inter / (A.length + B.length - inter);
}

interface RawMem { id: string; agent_id: string; kind: string; content: string; importance: number; created_game_time: number; last_access_game_time: number }
interface RawRef { id: string; agent_id: string; parent_id: string | null; depth: number; questions_json: string; insights_json: string; evidence_ids_json: string; trigger_score: number; created_game_time: number }
interface RawPlan { id: string; agent_id: string; day: number; broad_plan: string; hourly_json: string; status: string; created_game_time: number }
interface RawMsg { from_agent: string; to_agent: string; content: string; game_time: number }

function toMem(r: RawMem): Memory {
  return { id: r.id, agentId: r.agent_id, kind: r.kind, content: r.content, importance: r.importance, createdGameTime: r.created_game_time, lastAccessGameTime: r.last_access_game_time };
}

export class MemoryStore {
  private accumulators = new Map<string, number>();

  constructor(private db: DbHandle) {}

  addMemory(m: Omit<Memory, 'id' | 'lastAccessGameTime'> & { id?: string; sourceEventId?: string }): void {
    this.db.raw.prepare(
      `INSERT INTO memories(id, agent_id, kind, content, importance, created_game_time, last_access_game_time, source_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(m.id ?? randomUUID(), m.agentId, m.kind, m.content.slice(0, 200), m.importance, m.createdGameTime, m.createdGameTime, m.sourceEventId ?? null);
    this.accumulators.set(m.agentId, (this.accumulators.get(m.agentId) ?? 0) + m.importance);
  }

  /** 三因子检索：0.25·recency(0.995^Δt) + 0.35·importance/10 + 0.40·关键词Jaccard */
  retrieve(agentId: string, query: string, now: number, k = 20): Memory[] {
    const rows = this.db.raw.prepare('SELECT * FROM memories WHERE agent_id = ?').all(agentId) as unknown as RawMem[];
    const scored = rows
      .map((r) => {
        const mem = toMem(r);
        const recency = 0.995 ** (now - mem.lastAccessGameTime);
        const relevance = keywordSimilarity(query, mem.content);
        const score = RECENCY_ALPHA * recency + IMPORTANCE_ALPHA * (mem.importance / 10) + RELEVANCE_ALPHA * relevance;
        return { mem, score };
      })
      .sort((x, y) => y.score - x.score || y.mem.createdGameTime - x.mem.createdGameTime);
    const top = scored.slice(0, k).map((s) => s.mem);
    const upd = this.db.raw.prepare('UPDATE memories SET last_access_game_time = ? WHERE id = ?');
    for (const m of top) {
      upd.run(now, m.id);
      m.lastAccessGameTime = now; // 返回值同步最新访问时间
    }
    return top;
  }

  recentMemories(agentId: string, n: number): Memory[] {
    const rows = this.db.raw.prepare('SELECT * FROM memories WHERE agent_id = ? ORDER BY created_game_time DESC LIMIT ?').all(agentId, n) as unknown as RawMem[];
    return rows.map(toMem);
  }

  countFor(agentId: string): number {
    const row = this.db.raw.prepare('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?').get(agentId) as { n: number };
    return row.n;
  }

  /** importance 累计（自上次反思起，内存态） */
  accumulator(agentId: string): number { return this.accumulators.get(agentId) ?? 0; }
  resetAccumulator(agentId: string): void { this.accumulators.set(agentId, 0); }

  addReflection(r: Omit<ReflectionRecord, 'id'> & { id?: string }): void {
    this.db.raw.prepare(
      `INSERT INTO reflections(id, agent_id, parent_id, depth, questions_json, insights_json, evidence_ids_json, trigger_score, created_game_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(r.id ?? randomUUID(), r.agentId, r.parentId, r.depth, JSON.stringify(r.questions), JSON.stringify(r.insights), JSON.stringify(r.evidenceIds), r.triggerScore, r.createdGameTime);
  }

  reflectionsFor(agentId: string): ReflectionRecord[] {
    const rows = this.db.raw.prepare('SELECT * FROM reflections WHERE agent_id = ? ORDER BY created_game_time DESC').all(agentId) as unknown as RawRef[];
    return rows.map((r) => ({
      id: r.id, agentId: r.agent_id, parentId: r.parent_id, depth: r.depth,
      questions: JSON.parse(r.questions_json) as string[], insights: JSON.parse(r.insights_json) as string[],
      evidenceIds: JSON.parse(r.evidence_ids_json) as string[], triggerScore: r.trigger_score, createdGameTime: r.created_game_time,
    }));
  }

  recentInsights(agentId: string, n: number): string[] {
    const out: string[] = [];
    for (const r of this.reflectionsFor(agentId)) {
      out.push(...r.insights);
      if (out.length >= n) break;
    }
    return out.slice(0, n);
  }

  /** 同 agent+day upsert */
  savePlan(p: Omit<PlanRecord, 'id'> & { id?: string }): void {
    const existing = this.db.raw.prepare('SELECT id FROM plans WHERE agent_id = ? AND day = ?').get(p.agentId, p.day) as { id: string } | undefined;
    if (existing) {
      this.db.raw.prepare('UPDATE plans SET broad_plan = ?, hourly_json = ?, status = ?, created_game_time = ? WHERE id = ?').run(p.broadPlan, JSON.stringify(p.hourly), p.status, p.createdGameTime, existing.id);
    } else {
      this.db.raw.prepare('INSERT INTO plans(id, agent_id, day, broad_plan, hourly_json, status, created_game_time) VALUES (?, ?, ?, ?, ?, ?, ?)').run(p.id ?? randomUUID(), p.agentId, p.day, p.broadPlan, JSON.stringify(p.hourly), p.status, p.createdGameTime);
    }
  }

  planFor(agentId: string, day: number): PlanRecord | null {
    const r = this.db.raw.prepare('SELECT * FROM plans WHERE agent_id = ? AND day = ? ORDER BY created_game_time DESC LIMIT 1').get(agentId, day) as unknown as RawPlan | undefined;
    if (!r) return null;
    return { id: r.id, agentId: r.agent_id, day: r.day, broadPlan: r.broad_plan, hourly: JSON.parse(r.hourly_json) as AgendaItem[], status: r.status, createdGameTime: r.created_game_time };
  }

  addMessage(m: { id?: string; eventId?: string | null; fromAgent: string; toAgent: string; content: string; gameTime: number }): void {
    this.db.raw.prepare('INSERT INTO messages(id, event_id, from_agent, to_agent, content, game_time) VALUES (?, ?, ?, ?, ?, ?)').run(m.id ?? randomUUID(), m.eventId ?? null, m.fromAgent, m.toAgent, m.content, m.gameTime);
  }

  messagesFor(agentId: string, limit = 50): { fromAgent: string; toAgent: string; content: string; gameTime: number }[] {
    const rows = this.db.raw.prepare('SELECT * FROM messages WHERE from_agent = ? OR to_agent = ? ORDER BY game_time DESC LIMIT ?').all(agentId, agentId, limit) as unknown as RawMsg[];
    return rows.map((r) => ({ fromAgent: r.from_agent, toAgent: r.to_agent, content: r.content, gameTime: r.game_time }));
  }
}
```

- [ ] **Step 5: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/memory.test.ts
pnpm test
pnpm typecheck
```

Expected: memory.test 6 通过；全量 60 通过；typecheck 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/store/db.ts src/store/memory.ts tests/memory.test.ts
git commit -m "feat(store): 记忆层（记忆流/三因子检索/反思树/计划/消息）"
```

---

### Task 2: 提示词库扩展 + mock 全模板确定性

**Files:**
- Modify: `src/llm/prompts.ts`（重写为 M1 版：模板常量 + MemoryBrief/MockContextPayload 扩展 + 9 个模板构造器）、`src/llm/mock.ts`（重写：switch 全模板）、`tests/prompts.test.ts`（mockContext 增字段）、`tests/gateway.test.ts`（mock 决策断言不变）
- Create: `tests/mock-templates.test.ts`

**Interfaces:**
- Produces：
  - 模板常量：`ACTION_DECISION_TEMPLATE / IMPORTANCE_TEMPLATE / DAILY_PLAN_TEMPLATE / HOUR_PLAN_TEMPLATE / REFLECTION_QUESTIONS_TEMPLATE / REFLECTION_INSIGHTS_TEMPLATE / DIALOGUE_TEMPLATE / DIALOGUE_SUMMARY_TEMPLATE / INTERVIEW_TEMPLATE`
  - `MemoryBrief { content; importance }`；`MockContextPayload` 增加 `memories: MemoryBrief[]; insights: string[]; agenda: string | null`
  - `ActionDecisionInput` 不变（agent/day/minuteOfDay/locationName/objects/mockContext）
  - `simpleMessages(system, ctx): ChatMessage[]`；`importanceMessages(text)`；`dailyPlanMessages(agent, day, memories, insights)`；`hourPlanMessages(agent, hour, broadPlan)`；`dialogueMessages(ctx)`；`dialogueSummaryMessages(lines)`；`reflectionQuestionsMessages(memories)`；`reflectionInsightsMessages(question, evidence)`；`interviewMessages(agent, question, memories, insights)`；`personaText(p)`；`routineToText(p)`（保留）
  - `mockImportance(text): number`（导出供测试）

- [ ] **Step 1: 写失败测试 tests/mock-templates.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { LLMGateway } from '../src/llm/gateway';
import {
  IMPORTANCE_TEMPLATE, DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE,
  DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, INTERVIEW_TEMPLATE,
  importanceMessages, dailyPlanMessages, hourPlanMessages, reflectionQuestionsMessages,
  reflectionInsightsMessages, dialogueMessages, dialogueSummaryMessages, interviewMessages,
} from '../src/llm/prompts';
import { mockImportance } from '../src/llm/mock';
import { makeAgent, persona } from './helpers';
import type { LLMRequest } from '../src/llm/types';

const g = new LLMGateway({ provider: 'mock' });

function req(template: string, messages: ReturnType<typeof simpleX>): LLMRequest {
  return { tier: 'small', template, messages, jsonMode: true, maxTokens: 512 };
}
function simpleX(..._a: unknown[]): never { throw new Error('占位'); }

test('importance：mock 规则打分', async () => {
  assert.equal(mockImportance('今晚湖边派对，邀请所有人'), 9);
  assert.equal(mockImportance('开始煮咖啡'), 6);
  assert.equal(mockImportance('在公园散步'), 4);
  const res = await g.complete({ tier: 'small', template: IMPORTANCE_TEMPLATE, jsonMode: true, maxTokens: 64, messages: importanceMessages('筹备秘密画展') });
  assert.equal((res.parsed as { importance: number }).importance, 9);
});

test('daily_plan 与 hour_plan：确定性输出', async () => {
  const agent = makeAgent({ name: '林晚晴', persona: persona({ name: '林晚晴', routine: [{ from: 540, to: 600, type: 'interact', target: 'obj:cafe_counter', verb: '煮咖啡' }] }) });
  const r1 = await g.complete({ tier: 'large', template: DAILY_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: dailyPlanMessages(agent, 1, [], []) });
  assert.ok((r1.parsed as { broad_plan: string }).broad_plan.includes('咖啡馆'));
  const r2 = await g.complete({ tier: 'large', template: HOUR_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: hourPlanMessages(agent, 9, '照常经营') });
  const agenda = (r2.parsed as { agenda: { time: string; action: string }[] }).agenda;
  assert.equal(agenda[0].action, '煮咖啡');
  assert.equal(agenda[0].time, '09:00');
});

test('reflection 模板：3 问 + 证据洞察', async () => {
  const r1 = await g.complete({ tier: 'large', template: REFLECTION_QUESTIONS_TEMPLATE, jsonMode: true, maxTokens: 512, messages: reflectionQuestionsMessages(['在咖啡馆煮咖啡', '在公园散步']) });
  assert.equal((r1.parsed as { questions: string[] }).questions.length, 3);
  const r2 = await g.complete({ tier: 'large', template: REFLECTION_INSIGHTS_TEMPLATE, jsonMode: true, maxTokens: 512, messages: reflectionInsightsMessages('我常去哪？', ['在咖啡馆煮咖啡', '在公园散步']) });
  const insights = (r2.parsed as { insights: string[] }).insights;
  assert.equal(insights.length, 2);
  assert.ok(insights[0].startsWith('我'));
});

test('dialogue 与 summary：轮换台词、4 句后结束', async () => {
  const ctx = { speakerName: '林晚晴', speakerPool: ['你好呀！', '咖啡很香。', '常来坐坐。', '再见啦。'], otherName: '陈默', goal: '经营咖啡馆', turns: 0 };
  const r1 = await g.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages(ctx) });
  const d1 = r1.parsed as { utterance: string; end_dialogue: boolean };
  assert.equal(d1.utterance, '你好呀！');
  assert.equal(d1.end_dialogue, false);
  const r2 = await g.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages({ ...ctx, turns: 3 }) });
  assert.equal((r2.parsed as { end_dialogue: boolean }).end_dialogue, true);
  const r3 = await g.complete({ tier: 'large', template: DIALOGUE_SUMMARY_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueSummaryMessages(['你好呀！', '咖啡很香。']) });
  assert.match((r3.parsed as { summary: string }).summary, /你好呀/);
});

test('interview：拼装记忆作答', async () => {
  const agent = makeAgent({ name: '林晚晴', persona: persona({ name: '林晚晴' }) });
  const res = await g.complete({ tier: 'large', template: INTERVIEW_TEMPLATE, jsonMode: true, maxTokens: 512, messages: interviewMessages(agent, '今天做了什么', ['在咖啡馆煮咖啡', '去书店看书'], []) });
  const ans = (res.parsed as { answer: string }).answer;
  assert.ok(ans.includes('我记得'));
  assert.ok(ans.includes('在咖啡馆煮咖啡'));
});
```

（`req`/`simpleX` 占位函数若未被使用请删除，避免冗余。）

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/mock-templates.test.ts`
Expected: FAIL（模板常量/构造器未导出，mock 不支持新模板）。

- [ ] **Step 3: 重写 src/llm/prompts.ts**

```ts
// M1 提示词库：动作决策（含记忆/洞察/计划）+ 记忆打分 + 日/小时计划 + 反思 + 对话 + 访谈

import type { Agent, Persona, RoutineSlot } from '../core/types';
import type { ChatMessage } from './types';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';

export const ACTION_DECISION_TEMPLATE = 'action_decision';
export const IMPORTANCE_TEMPLATE = 'importance';
export const DAILY_PLAN_TEMPLATE = 'daily_plan';
export const HOUR_PLAN_TEMPLATE = 'hour_plan';
export const REFLECTION_QUESTIONS_TEMPLATE = 'reflection_questions';
export const REFLECTION_INSIGHTS_TEMPLATE = 'reflection_insights';
export const DIALOGUE_TEMPLATE = 'dialogue';
export const DIALOGUE_SUMMARY_TEMPLATE = 'dialogue_summary';
export const INTERVIEW_TEMPLATE = 'interview';

export interface MemoryBrief { content: string; importance: number }

export interface MockContextPayload {
  persona: Persona;
  minuteOfDay: number;
  routine: RoutineSlot[];
  memories: MemoryBrief[];
  insights: string[];
  agenda: string | null;
}

export interface ActionDecisionInput {
  agent: Agent;
  day: number;
  minuteOfDay: number;
  locationName: string;
  objects: { id: string; name: string }[];
  mockContext: MockContextPayload;
}

export function routineToText(p: Persona): string {
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  return p.routine.length
    ? p.routine.map((s) => `${hhmm(s.from)}-${hhmm(s.to)} 在${s.target ?? '原地'}${s.verb}`).join('；')
    : '自由安排';
}

export function personaText(p: Persona): string {
  return `${p.name}，${p.age} 岁，${p.occupation}。${p.background} 性格：${p.traits.join('、')}。目标：${p.goals.join('；')}。`;
}

export function buildActionDecisionMessages(input: ActionDecisionInput): { messages: ChatMessage[] } {
  const p = input.agent.persona;
  const clock = { day: input.day, minutesOfDay: input.minuteOfDay, totalMinutes: (input.day - 1) * MINUTES_PER_DAY + input.minuteOfDay };
  const memLines = input.mockContext.memories.slice(0, 10).map((m) => `- [重要度${m.importance}] ${m.content}`).join('\n') || '（暂无）';
  const insightText = input.mockContext.insights.join('；') || '（暂无）';
  const agendaText = input.mockContext.agenda ?? '（暂无，自由安排）';
  const system = [
    `你是 ${personaText(p)}`,
    `当前时间：${TimeEngine.format(clock)}。你现在在「${input.locationName}」。`,
    `你的一天安排（兜底作息）：${routineToText(p)}`,
    `今日计划（当前时段）：${agendaText}`,
    `近期记忆：\n${memLines}`,
    `自我认知（反思）：${insightText}`,
    `决定接下来 5~15 分钟做什么。地点必须从给定对象里选。`,
    `只输出 JSON：{"thought": "...", "action": {"type": "move_to|interact|idle", "target": "<object_id 或 null>", "verb": "..."}, "duration_minutes": <int>}`,
  ].join('\n');
  const user = `可用对象：${JSON.stringify(input.objects)}\n\n<M0_CONTEXT>\n${JSON.stringify(input.mockContext)}\n</M0_CONTEXT>`;
  return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

/** 简单模板统一封装：system 提示词 + <M0_CONTEXT> JSON */
export function simpleMessages(system: string, ctx: unknown): ChatMessage[] {
  return [
    { role: 'system', content: system },
    { role: 'user', content: `<M0_CONTEXT>\n${JSON.stringify(ctx)}\n</M0_CONTEXT>` },
  ];
}

export function importanceMessages(text: string): ChatMessage[] {
  return simpleMessages(
    '你是记忆筛选器。给智能体的一条新记忆的重要性打分 1~10。打分标准：1~3 日常琐事；4~6 有信息量的事件；7~8 与目标/人际相关；9~10 改变人生的事件。只输出 JSON：{"importance": <int>}',
    { text }
  );
}

export function dailyPlanMessages(agent: Agent, day: number, memories: MemoryBrief[], insights: string[]): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。你在一个 2D 小镇生活，需要安排第 ${day} 天。\n近期记忆：\n${memories.slice(0, 10).map((m) => `- ${m.content}`).join('\n') || '（暂无）'}\n自我认知：${insights.join('；') || '（暂无）'}\n生成你今天的大计划（3~5 句，覆盖上午/下午/晚上，自然语言）。只输出 JSON：{"broad_plan": "..."}`,
    { persona: agent.persona, day, memories, insights }
  );
}

export function hourPlanMessages(agent: Agent, hour: number, broadPlan: string): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。现在是第 ${hour} 点。当天大计划：${broadPlan || '（暂无）'}\n把接下来 1 小时拆成 5~15 分钟的具体动作清单。只输出 JSON：{"agenda": [{"time": "HH:MM", "action": "...", "location": "<对象 id 或名字>"}]}`,
    { persona: agent.persona, hour, broadPlan }
  );
}

export function dialogueMessages(ctx: { speakerName: string; speakerPool: string[]; otherName: string; goal: string; turns: number }): ChatMessage[] {
  return simpleMessages(
    `你是小镇居民「${ctx.speakerName}」。你正在和「${ctx.otherName}」聊天，这是第 ${ctx.turns + 1} 句。你当前的目标：${ctx.goal}\n规则：每次只说 1~3 句；不要替对方说话；若已聊了 3 句以上或话头已尽，把 end_dialogue 设为 true。只输出 JSON：{"utterance": "...", "end_dialogue": <true|false>}`,
    ctx
  );
}

export function dialogueSummaryMessages(lines: string[]): ChatMessage[] {
  return simpleMessages(
    '总结以上对话（≤100 字，客观，含双方达成的约定/传递的信息）。只输出 JSON：{"summary": "..."}',
    { lines }
  );
}

export function reflectionQuestionsMessages(memories: string[]): ChatMessage[] {
  return simpleMessages(
    `下面是最近发生在你身上的事（按时间）：\n${memories.map((m) => `- ${m}`).join('\n')}\n提出 3 个关于你自己的开放式问题（关于目标、人际关系、重复出现的主题）。只输出 JSON：{"questions": ["...", "...", "..."]}`,
    { memories }
  );
}

export function reflectionInsightsMessages(question: string, evidence: string[]): ChatMessage[] {
  return simpleMessages(
    `问题：${question}\n证据（只能使用以下内容，禁止编造）：\n${evidence.map((e) => `- ${e}`).join('\n')}\n基于证据给出 5 条对自己的洞察，每条 ≤ 1 句，用「我」开头。只输出 JSON：{"insights": ["...", ...]}`,
    { question, evidence }
  );
}

export function interviewMessages(agent: Agent, question: string, memories: string[], insights: string[]): ChatMessage[] {
  return simpleMessages(
    `你是 ${personaText(agent.persona)}。有人问你：「${question}」\n你的记忆：\n${memories.map((m) => `- ${m}`).join('\n') || '（暂无）'}\n你的自我认知：${insights.join('；') || '（暂无）'}\n请以第一人称诚实回答（基于记忆，不编造）。只输出 JSON：{"answer": "..."}`,
    { question, memories, insights }
  );
}
```

- [ ] **Step 4: 重写 src/llm/mock.ts**

```ts
// MockProvider：全模板确定性离线输出（M1），上下文取自提示词中的 <M0_CONTEXT> JSON

import type { ChatMessage, LLMProvider, LLMRequest, LLMResponse } from './types';
import type { Decision, RoutineSlot } from '../core/types';
import { MINUTES_PER_DAY } from '../core/time';
import {
  ACTION_DECISION_TEMPLATE, IMPORTANCE_TEMPLATE, DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE,
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE, DIALOGUE_TEMPLATE,
  DIALOGUE_SUMMARY_TEMPLATE, INTERVIEW_TEMPLATE,
} from './prompts';

const CONTEXT_RE = /<M0_CONTEXT>\n([\s\S]*?)\n<\/M0_CONTEXT>/;

const DAILY_PLANS: Record<string, string> = {
  '林晚晴': '照常经营咖啡馆，午后去书店翻翻新书，傍晚到公园散步，晚上回家写小说笔记。',
  '陈默': '整理书店的新到书目，接待常客，傍晚去广场散步透透气。',
  '沈屿': '上午在公园写生，午后到咖啡馆喝咖啡画速写，晚上整理画稿。',
  '周岚': '上午在邮局分拣信件，之后骑车给广场、咖啡馆、书店送信，傍晚回家。',
};

export function mockImportance(text: string): number {
  if (/派对|秘密|约定|邀请|结婚|事故|宝藏/.test(text)) return 9;
  if (/计划|反思|重要|决定|喜欢|讨厌/.test(text)) return 8;
  if (/说|闲聊|休息|散步|心想/.test(text)) return 4;
  return 6;
}

export class MockProvider implements LLMProvider {
  readonly name = 'mock';

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const ctx = extract(req.messages) as Record<string, unknown>;
    let out: unknown;
    switch (req.template) {
      case ACTION_DECISION_TEMPLATE: {
        const d = decideAction(ctx);
        // wire 格式与真机一致（duration_minutes），校验器同契约
        out = { thought: d.thought, action: d.action, duration_minutes: d.durationMinutes };
        break;
      }
      case IMPORTANCE_TEMPLATE: out = { importance: mockImportance(String(ctx.text ?? '')) }; break;
      case DAILY_PLAN_TEMPLATE: out = { broad_plan: DAILY_PLANS[(ctx.persona as { name?: string } | undefined)?.name ?? ''] ?? '今天照常在小镇里度过，做点喜欢的事。' }; break;
      case HOUR_PLAN_TEMPLATE: out = { agenda: hourAgenda(((ctx.persona as { routine?: RoutineSlot[] } | undefined)?.routine) ?? [], Number(ctx.hour ?? 0)) }; break;
      case REFLECTION_QUESTIONS_TEMPLATE: out = { questions: ['我最近反复在做什么？', '我和谁走得近？', '我在为什么事分心？'] }; break;
      case REFLECTION_INSIGHTS_TEMPLATE: {
        const ev = Array.isArray(ctx.evidence) ? (ctx.evidence as string[]) : [];
        out = { insights: ev.slice(0, 5).map((c) => `我最近经历了「${c.slice(0, 18)}」这件事。`) };
        break;
      }
      case DIALOGUE_TEMPLATE: out = dialogueTurn(ctx); break;
      case DIALOGUE_SUMMARY_TEMPLATE: {
        const lines = Array.isArray(ctx.lines) ? (ctx.lines as string[]) : [];
        out = { summary: `聊到了「${(lines[0] ?? '').slice(0, 16)}」等话题，气氛不错。` };
        break;
      }
      case INTERVIEW_TEMPLATE: {
        const mems = Array.isArray(ctx.memories) ? (ctx.memories as string[]) : [];
        out = { answer: `我记得：${mems.slice(0, 3).join('；')}` };
        break;
      }
      default: throw new Error(`mock 不支持模板: ${req.template}`);
    }
    return { content: JSON.stringify(out), parsed: out, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
  }
}

function extract(messages: ChatMessage[]): Record<string, unknown> {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const match = CONTEXT_RE.exec(m.content);
    if (match) return JSON.parse(match[1]) as Record<string, unknown>;
  }
  throw new Error('mock 找不到 <M0_CONTEXT>');
}

/** 确定性动作决策：命中作息槽 → 执行；否则原地小憩（M0 行为，计划/记忆已进提示词但 mock 走作息） */
function decideAction(ctx: Record<string, unknown>): Decision {
  const t = Number(ctx.minuteOfDay ?? 0);
  const routine = (ctx.routine as RoutineSlot[]) ?? [];
  const hh = String(Math.floor(t / 60)).padStart(2, '0');
  const mm = String(t % 60).padStart(2, '0');
  const slot = routine.find((s) => t >= s.from && t < s.to);
  if (slot) {
    return {
      thought: `现在${hh}:${mm}，按作息安排去「${slot.verb}」。`,
      action: { type: slot.type, target: slot.target, verb: slot.verb },
      durationMinutes: Math.min(15, Math.max(1, slot.to - t)),
    };
  }
  const next = [...routine].sort((a, b) => a.from - b.from).find((s) => s.from > t);
  const untilNext = (next ? next.from : MINUTES_PER_DAY) - t;
  return {
    thought: '现在没有安排，休息一会儿。',
    action: { type: 'idle', target: null, verb: '休息' },
    durationMinutes: Math.max(1, Math.min(30, untilNext)),
  };
}

function hourAgenda(routine: RoutineSlot[], hour: number): { time: string; action: string; location: string }[] {
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const hits = routine.filter((s) => s.from >= hour * 60 && s.from < (hour + 1) * 60);
  if (!hits.length) return [{ time: `${String(hour).padStart(2, '0')}:00`, action: '自由活动', location: '小镇' }];
  return hits.map((s) => ({ time: hhmm(s.from), action: s.verb, location: s.target ?? '小镇' }));
}

function dialogueTurn(ctx: Record<string, unknown>): { utterance: string; end_dialogue: boolean } {
  const pool = Array.isArray(ctx.speakerPool) && (ctx.speakerPool as string[]).length ? (ctx.speakerPool as string[]) : ['你好呀！', '今天天气真不错。'];
  const turns = Number(ctx.turns ?? 0);
  return { utterance: pool[turns % pool.length], end_dialogue: turns >= 3 };
}
```

- [ ] **Step 5: 更新 tests/prompts.test.ts（mockContext 增字段）与 state-machine.ts（临时空字段）**

三处 `buildActionDecisionMessages` 调用的 `mockContext` 改为：

```ts
    mockContext: { persona: agent.persona, minuteOfDay: 480, routine: agent.persona.routine, memories: [], insights: [], agenda: null },
```

（各自保持原有 minuteOfDay 数值。）另在第 2 个测试加两条断言：`assert.ok(sys.includes('近期记忆')); assert.ok(sys.includes('自我认知'));`

同时 `src/core/state-machine.ts` 的 requestDecision 中 mockContext 对象临时补 `memories: [], insights: [], agenda: null`（满足新的必填类型；Task 5 会替换为真实记忆/洞察/议程）。

- [ ] **Step 6: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/mock-templates.test.ts tests/prompts.test.ts tests/gateway.test.ts
pnpm test
pnpm typecheck
```

Expected: mock-templates 5 通过；全量通过；typecheck 0 错。

- [ ] **Step 7: 提交**

```bash
git add src/llm/prompts.ts src/llm/mock.ts tests/prompts.test.ts tests/mock-templates.test.ts tests/gateway.test.ts
git commit -m "feat(llm): M1 提示词库与 mock 全模板"
```

---

### Task 3: MemoryWriter（事件 → 观察 → 打分 → 记忆）

**Files:**
- Create: `src/engine/memory-writer.ts`、`tests/memory-writer.test.ts`

**Interfaces:**
- Consumes: EventLog.subscribe、MemoryStore、LLMGateway、IMPORTANCE_TEMPLATE
- Produces：
  - `new MemoryWriter(store: MemoryStore, llm: LLMGateway)`
  - `writer.attach(log: EventLog): void`（订阅；day_start 与 thought 事件跳过；chat 事件双方都记；actor/target 以 agent: 前缀过滤）
  - 记忆内容 = `第N天 HH:MM，<事件描述>`（≤200 字）、kind=observation、importance 由 importance 模板打分

- [ ] **Step 1: 写失败测试 tests/memory-writer.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { MemoryWriter } from '../src/engine/memory-writer';
import { flush } from './helpers';
import type { GameEvent } from '../src/core/types';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const writer = new MemoryWriter(store, new LLMGateway({ provider: 'mock' }));
  writer.attach(log);
  return { log, store };
}

test('动作事件 → 主角观察记忆', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 600, '林晚晴 开始「煮咖啡」，约 15 分钟', 'interact', 'agent:林晚晴'));
  await flush();
  const mems = store.recentMemories('agent:林晚晴', 10);
  assert.equal(mems.length, 1);
  assert.ok(mems[0].content.startsWith('第1天 10:00，'));
  assert.equal(mems[0].kind, 'observation');
});

test('chat 事件双方都记；day_start 与 thought 跳过', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 700, '「林晚晴」对「陈默」说：「你好呀！」', 'chat', 'agent:林晚晴', { kind: 'chat', line: '你好呀！', fromId: 'agent:林晚晴', toId: 'agent:陈默' }));
  log.addEvent(ev('e2', 701, '第1天开始。', 'system', null, { kind: 'day_start' }));
  log.addEvent(ev('e3', 702, '林晚晴 心想：「休息」', 'system', 'agent:林晚晴', { kind: 'thought', thought: '休息' }));
  await flush();
  assert.ok(store.countFor('agent:林晚晴') >= 1);
  assert.ok(store.countFor('agent:陈默') >= 1);
  assert.ok(!store.recentMemories('agent:林晚晴', 20).some((m) => m.content.includes('心想')));
  assert.ok(!store.recentMemories('agent:林晚晴', 20).some((m) => m.content.includes('第1天开始')));
});

test('importance 经 mock 打分（派对→9）', async () => {
  const { log, store } = setup();
  log.addEvent(ev('e1', 800, '林晚晴 广播「今晚湖边派对！」', 'broadcast', 'agent:林晚晴'));
  await flush();
  assert.equal(store.recentMemories('agent:林晚晴', 1)[0].importance, 9);
});

function ev(id: string, gameTime: number, description: string, type: GameEvent['type'], actorId: string | null, payload: Record<string, unknown> | null = null): GameEvent {
  return { id, type, actorId, targetIds: [], description, location: 'obj:cafe', gameTime, payload };
}
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/memory-writer.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/memory-writer'`。

- [ ] **Step 3: 写 src/engine/memory-writer.ts**

```ts
// 事件 → 观察记忆：订阅 EventLog，把有意义的事件转成叙述式记忆并打分入库

import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import { IMPORTANCE_TEMPLATE, importanceMessages } from '../llm/prompts';
import { TimeEngine, MINUTES_PER_DAY } from '../core/time';
import type { GameEvent } from '../core/types';

export class MemoryWriter {
  constructor(private store: MemoryStore, private llm: LLMGateway) {}

  attach(log: EventLog): void {
    log.subscribe((e) => void this.onEvent(e).catch((err) => console.error('[memory-writer]', err)));
  }

  async onEvent(e: GameEvent): Promise<void> {
    if (e.payload?.kind === 'day_start' || e.payload?.kind === 'thought') return;
    const day = Math.floor(e.gameTime / MINUTES_PER_DAY) + 1;
    const minute = e.gameTime % MINUTES_PER_DAY;
    const clock = { day, minutesOfDay: minute, totalMinutes: e.gameTime };
    const stamp = `${TimeEngine.format(clock).split(' ')[1]}，`;
    const ids = new Set<string>();
    if (e.actorId) ids.add(e.actorId);
    for (const t of e.targetIds) ids.add(t);
    const payload = e.payload as { fromId?: string; toId?: string } | null;
    if (payload?.fromId) ids.add(payload.fromId);
    if (payload?.toId) ids.add(payload.toId);
    const content = `第${day}天 ${stamp}${e.description}`.slice(0, 200);
    const score = await this.score(content); // 同一事件同一内容只打一次分（chat 双方复用）
    for (const id of ids) {
      if (!id.startsWith('agent:')) continue;
      this.store.addMemory({ agentId: id, kind: 'observation', content, importance: score, createdGameTime: e.gameTime, sourceEventId: e.id });
    }  }

  private async score(text: string): Promise<number> {
    const res = await this.llm.complete({ tier: 'small', template: IMPORTANCE_TEMPLATE, jsonMode: true, maxTokens: 64, messages: importanceMessages(text) });
    const n = (res.parsed as { importance?: number } | null)?.importance;
    return typeof n === 'number' && Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 5;
  }
}
```

- [ ] **Step 4: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/memory-writer.test.ts
pnpm test
pnpm typecheck
```

Expected: memory-writer 3 通过；全量通过；typecheck 0 错。

- [ ] **Step 5: 提交**

```bash
git add src/engine/memory-writer.ts tests/memory-writer.test.ts
git commit -m "feat(engine): 事件到记忆的 MemoryWriter"
```

---

### Task 4: Planner + MindEngine 门面 + 循环调度

**Files:**
- Create: `src/llm/planner.ts`、`src/engine/mind.ts`、`tests/mind.test.ts`
- Modify: `src/engine/loop.ts`（构造器可选第 8 参 mind；step 内调用 `this.mind?.tick(...)`）

**Interfaces:**
- Produces：
  - `new Planner(llm, store)`：`dailyPlan(agent, day, now)`、`decomposeHour(agent, day, hour, now)`、`currentAgendaLine(agent, day, minuteOfDay): string | null`
  - `new MindEngine({ db, llm, log })`：字段 `store / planner / dialogue / reflection`；`tick(world, dt, now)`（跨 5:00 触发日计划；跨整点触发小时分解；推进反思与对话——反思/对话在 Task 6/7 落地，本任务 tick 内以可选调用占位：`this.reflection?.tick(...)`、`this.dialogue?.tick(...)`）
  - `new WorldLoop(time, world, executor, log, db, hooks?, social?, mind?)`

- [ ] **Step 1: 写失败测试 tests/mind.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { Planner } from '../src/llm/planner';

test('跨 5:00 生成日计划，跨整点生成小时计划', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 每 tick 30 游戏分钟
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const mind = new MindEngine({ db, llm: gateway, log });
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  await loop.runUntil(330); // 越过 5:00（300）与 5 点整点
  for (const a of world.allAgents()) {
    const plan = mind.store.planFor(a.id, 1);
    assert.ok(plan, `${a.name} 应有日计划`);
    assert.ok(plan.broadPlan.length > 5);
    assert.ok(plan.broadPlan !== '自由安排一天。', `${a.name} 的日计划不应是兜底文本`);
    assert.ok(plan.hourly.length >= 1, `${a.name} 应有小时议程`);
    const planMem = mind.store.recentMemories(a.id, 500).find((m) => m.kind === 'plan');
    assert.ok(planMem, `${a.name} 应有 kind=plan 记忆`);
    assert.equal(planMem.importance, 8);
  }
});

test('currentAgendaLine 返回当前时段议程或大计划', async () => {
  const db = openDb(':memory:');
  const store = new MindEngine({ db, llm: new LLMGateway({ provider: 'mock' }), log: new EventLog(db) }).store;
  const planner = new Planner(new LLMGateway({ provider: 'mock' }), store);
  const agent = buildTown().allAgents()[0];
  await planner.dailyPlan(agent, 1, 300);
  await planner.decomposeHour(agent, 1, 9, 540);
  const line = planner.currentAgendaLine(agent, 1, 540);
  assert.ok(line && line.length > 3);
  assert.ok(!planner.currentAgendaLine(agent, 2, 540)); // 第 2 天无计划
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/mind.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/mind'`。

- [ ] **Step 3: 写 src/llm/planner.ts**

```ts
// 规划：每日大计划 + 每小时议程分解 + 当前时段议程（spec §5.4；M0 作息为兜底）

import type { Agent } from '../core/types';
import type { LLMGateway } from './gateway';
import { DAILY_PLAN_TEMPLATE, HOUR_PLAN_TEMPLATE, dailyPlanMessages, hourPlanMessages } from './prompts';
import type { AgendaItem, MemoryStore } from '../store/memory';

function hhToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export class Planner {
  constructor(private llm: LLMGateway, private store: MemoryStore) {}

  async dailyPlan(agent: Agent, day: number, now: number): Promise<void> {
    const memories = this.store.retrieve(agent.id, agent.persona.goals.join(' '), now, 20).map((m) => ({ content: m.content, importance: m.importance }));
    const insights = this.store.recentInsights(agent.id, 5);
    const res = await this.llm.complete({ tier: 'large', template: DAILY_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: dailyPlanMessages(agent, day, memories, insights) });
    const raw = (res.parsed as { broad_plan?: unknown } | null)?.broad_plan;
    const broad = (typeof raw === 'string' ? raw : '').slice(0, 300) || '自由安排一天。';
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad, hourly: [], status: 'active', createdGameTime: now });
    this.store.addMemory({ agentId: agent.id, kind: 'plan', content: `第${day}天计划：${broad}`, importance: 8, createdGameTime: now });
  }

  async decomposeHour(agent: Agent, day: number, hour: number, now: number): Promise<void> {
    const plan = this.store.planFor(agent.id, day);
    const broad = plan?.broadPlan ?? '';
    const res = await this.llm.complete({ tier: 'large', template: HOUR_PLAN_TEMPLATE, jsonMode: true, maxTokens: 512, messages: hourPlanMessages(agent, hour, broad) });
    const rawAgenda = (res.parsed as { agenda?: unknown } | null)?.agenda;
    const agenda = (Array.isArray(rawAgenda) ? rawAgenda : [])
      .filter((h): h is { time: string; action: string; location?: unknown } =>
        !!h && typeof (h as { time?: unknown }).time === 'string' && typeof (h as { action?: unknown }).action === 'string')
      .map((h) => ({ time: h.time, action: h.action.slice(0, 60), location: String(h.location ?? '').slice(0, 40) }));
    const merged = (plan?.hourly ?? []).filter((h) => Math.floor(hhToMin(h.time) / 60) !== hour);
    merged.push(...agenda);
    merged.sort((a, b) => hhToMin(a.time) - hhToMin(b.time));
    this.store.savePlan({ agentId: agent.id, day, broadPlan: broad || '自由安排一天。', hourly: merged, status: 'active', createdGameTime: now });
  }

  currentAgendaLine(agent: Agent, day: number, minuteOfDay: number): string | null {
    const plan = this.store.planFor(agent.id, day);
    if (!plan) return null;
    const hour = Math.floor(minuteOfDay / 60);
    const items = plan.hourly.filter((h) => Math.floor(hhToMin(h.time) / 60) === hour);
    if (!items.length) return plan.broadPlan;
    return items.map((h) => `${h.time} ${h.action}（${h.location}）`).join('；');
  }
}
```

- [ ] **Step 4: 写 src/engine/mind.ts**

```ts
// MindEngine：M1 认知核心门面——记忆/规划/反思/对话，作为可选参数注入循环与执行器

import { MINUTES_PER_DAY } from '../core/time';
import type { WorldState } from '../core/world';
import type { Agent } from '../core/types';
import type { DbHandle } from '../store/db';
import type { EventLog } from '../store/events';
import type { LLMGateway } from '../llm/gateway';
import { MemoryStore } from '../store/memory';
import { Planner } from '../llm/planner';
import { MemoryWriter } from './memory-writer';

export interface MindEngineOptions {
  db: DbHandle;
  llm: LLMGateway;
  log: EventLog;
}

/** 反思/对话先以结构化接口占位（Task 6/7 装配为具体实现，避免跨任务 import） */
interface ReflectionLike { tick(agent: Agent, day: number, now: number): void }
interface DialogueLike { tick(world: WorldState, dt: number, now: number): void }

export class MindEngine {
  readonly store: MemoryStore;
  readonly planner: Planner;
  reflection?: ReflectionLike;
  dialogue?: DialogueLike;
  private writer: MemoryWriter;
  private lastMinute = 0;

  constructor(opts: MindEngineOptions) {
    this.store = new MemoryStore(opts.db);
    this.planner = new Planner(opts.llm, this.store);
    this.reflection = undefined; // Task 6 装配
    this.dialogue = undefined;   // Task 7 装配
    this.writer = new MemoryWriter(this.store, opts.llm);
    this.writer.attach(opts.log);
  }

  tick(world: WorldState, dt: number, now: number): void {
    const day = Math.floor(now / MINUTES_PER_DAY) + 1;
    const minute = now % MINUTES_PER_DAY;
    const hour = Math.floor(minute / 60);
    if (this.lastMinute < 300 && minute >= 300) {
      // 跨 5:00：先日计划、完成后再小时分解（避免同 tick 竞争覆盖 plans 行）
      for (const a of world.allAgents()) {
        void this.planner.dailyPlan(a, day, now)
          .catch((err) => console.error('[planner] dailyPlan', err))
          .then(() => this.planner.decomposeHour(a, day, hour, now))
          .catch((err) => console.error('[planner] decomposeHour', err));
      }
    } else if (hour !== Math.floor(this.lastMinute / 60)) {
      for (const a of world.allAgents()) {
        void this.planner.decomposeHour(a, day, hour, now).catch((err) => console.error('[planner] decomposeHour', err));
      }
    }
    this.lastMinute = minute;
    for (const a of world.allAgents()) this.reflection?.tick(a, day, now);
    this.dialogue?.tick(world, dt, now);
  }
}
```

（注：Task 6/7 会把结构化占位替换为具体 ReflectionEngine/DialogueEngine 并改字段为必填，见相应任务步骤。）

- [ ] **Step 5: 修改 src/engine/loop.ts（mind 注入）**

构造器签名加第 8 个可选参数：

```ts
  constructor(
    public time: TimeEngine,
    public world: WorldState,
    private executor: AgentExecutor,
    private log: EventLog,
    private db: DbHandle,
    private hooks: LoopHooks = {},
    private social?: SocialTicker,
    private mind?: MindEngine
  ) {
```

顶部 import 加：`import type { MindEngine } from './mind';`

`step()` 中 `this.social?.tick(...)` 之后插入：

```ts
    this.mind?.tick(this.world, dt, clock.totalMinutes);
```

- [ ] **Step 6: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/mind.test.ts
pnpm test
pnpm typecheck
```

Expected: mind.test 2 通过；全量通过；typecheck 0 错。

- [ ] **Step 7: 提交**

```bash
git add src/llm/planner.ts src/engine/mind.ts src/engine/loop.ts tests/mind.test.ts
git commit -m "feat(engine): 规划器与 MindEngine 调度（5:00 日计划/整点分解）"
```

---

### Task 5: 决策上下文装配（记忆/洞察/议程注入执行器）

**Files:**
- Modify: `src/core/state-machine.ts`（构造器可选第 4 参 mind；requestDecision 注入记忆/洞察/议程）、`tests/state-machine.test.ts`（构造器不变仍通过——mind 可选；新增 1 个断言用例）

**Interfaces:**
- Produces：`new AgentExecutor(llm, world, log, mind?: MindEngine)`
- 语义：有 mind 时 requestDecision 的查询 = `目标 + 当前动作动词 + 位置名`；retrieve k=20 → MemoryBrief[]；insights=recentInsights(3)；agenda=planner.currentAgendaLine；全部进 mockContext 与提示词

- [ ] **Step 1: 写失败测试（追加到 tests/state-machine.test.ts）**

```ts
import { MindEngine } from '../src/engine/mind';
import type { ChatMessage, LLMProvider } from '../src/llm/types';

test('注入 mind 后决策提示词包含记忆与议程', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, locationId: 'obj:home' });
  const world = new WorldState(TEST_OBJECTS, [agent]);
  const captured: ChatMessage[][] = [];
  const spy: LLMProvider = {
    name: 'spy',
    async complete(req) {
      captured.push(req.messages);
      const parsed = { thought: '', action: { type: 'idle', target: null, verb: '休息' }, duration_minutes: 10 };
      return { content: JSON.stringify(parsed), parsed, usage: { inputTokens: 0, outputTokens: 0, costYuan: 0 } };
    },
  };
  const gateway = new LLMGateway({ provider: spy });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '在咖啡馆煮咖啡招待客人', importance: 6, createdGameTime: 1 });
  mind.store.savePlan({ agentId: 'agent:1', day: 1, broadPlan: '照常经营咖啡馆', hourly: [{ time: '00:10', action: '测试议程动作', location: '咖啡馆' }], status: 'active', createdGameTime: 5 });
  const executor = new AgentExecutor(gateway, world, log, mind);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'acting'); // mock 无作息槽 → idle 行动
  assert.ok(captured.length >= 1);
  const text = captured[0].map((m) => m.content).join('\n');
  assert.ok(text.includes('煮咖啡'), '提示词应包含记忆内容');
  assert.ok(text.includes('测试议程动作'), '提示词应包含当前议程');
  assert.ok(text.includes('近期记忆'));
  // 检索副作用：目标记忆的 last_access 被刷新
  const mem = mind.store.recentMemories('agent:1', 20).find((m) => m.content.includes('煮咖啡'))!;
  assert.equal(mem.lastAccessGameTime, 10);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/state-machine.test.ts`
Expected: FAIL（TS 编译错：AgentExecutor 构造器无第 4 参——若 test 文件先编译失败即 RED 成立）。

- [ ] **Step 3: 修改 src/core/state-machine.ts**

构造器改为：

```ts
  constructor(
    private llm: LLMGateway,
    private world: WorldState,
    private log: EventLog,
    private mind?: MindEngine
  ) {
```

顶部 import 加：`import type { MindEngine } from '../engine/mind';`、`import { MINUTES_PER_DAY } from './time';`（已有则复用）、`import type { MemoryBrief } from '../llm/prompts';`

`requestDecision` 的 `const minuteOfDay = ...` 之后、`buildActionDecisionMessages` 之前插入：

```ts
    let memories: MemoryBrief[] = [];
    let insights: string[] = [];
    let agenda: string | null = null;
    if (this.mind) {
      const day = Math.floor(now / MINUTES_PER_DAY) + 1;
      const query = `${agent.persona.goals.join(' ')} ${agent.action?.action.verb ?? ''} ${this.world.getObject(agent.locationId)?.name ?? ''}`;
      memories = this.mind.store.retrieve(agent.id, query, now, 20).map((m) => ({ content: m.content, importance: m.importance }));
      insights = this.mind.store.recentInsights(agent.id, 3);
      agenda = this.mind.planner.currentAgendaLine(agent, day, minuteOfDay);
    }
```

并把 `buildActionDecisionMessages({ agent, day: ..., minuteOfDay, ... })` 的调用中 `day` 由 `Math.floor(now / MINUTES_PER_DAY) + 1` 计算（现有实现可能已如此，保持正确），`mockContext` 改为：

```ts
      mockContext: { persona: agent.persona, minuteOfDay, routine: agent.persona.routine, memories, insights, agenda },
```

- [ ] **Step 4: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/state-machine.test.ts
pnpm test
pnpm typecheck
```

Expected: state-machine 6 通过（原 5 + 新 1）；全量通过；typecheck 0 错。

- [ ] **Step 5: 提交**

```bash
git add src/core/state-machine.ts tests/state-machine.test.ts
git commit -m "feat(core): 决策上下文注入记忆/洞察/议程"
```

---

### Task 6: 反思引擎

**Files:**
- Create: `src/engine/reflection.ts`、`tests/reflection.test.ts`
- Modify: `src/engine/mind.ts`（构造器装配 reflection）

**Interfaces:**
- Produces：
  - `new ReflectionEngine(llm, store, log)`
  - `tick(agent, day, now)`：每天每 agent ≤2 次；accumulator >150 且无在飞 → 触发（异步 run，不阻塞 tick）
  - run：最近 100 条记忆 → 3 问题 → 每问题检索 5 证据 → 洞察（每条「我」开头 ≤1 句）→ addReflection（挂最近反思为父节点、depth+1）+ insights 写回记忆（kind=insight、importance 8）+ system 事件（payload {kind:'reflection'}）
- MindEngine 构造器：`this.reflection = new ReflectionEngine(opts.llm, this.store, opts.log);`（字段改为 `readonly reflection: ReflectionEngine`）

- [ ] **Step 1: 写失败测试 tests/reflection.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { ReflectionEngine } from '../src/engine/reflection';
import { makeAgent, persona, flush } from './helpers';

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const engine = new ReflectionEngine(new LLMGateway({ provider: 'mock' }), store, log);
  const agent = makeAgent({ id: 'agent:1', name: '甲', persona: persona({ name: '甲' }) });
  return { log, store, engine, agent };
}

test('累计超 150 触发反思：树 + insight 写回 + 事件', async () => {
  const { log, store, engine, agent } = setup();
  for (let i = 0; i < 30; i++) store.addMemory({ agentId: 'agent:1', kind: 'observation', content: `第1天 09:${i % 60}，甲 在咖啡馆煮咖啡 ${i}`, importance: 6, createdGameTime: 540 + i });
  engine.tick(agent, 1, 600);
  await flush();
  await flush();
  const refs = store.reflectionsFor('agent:1');
  assert.ok(refs.length >= 1);
  assert.equal(refs[0].questions.length, 3);
  assert.ok(refs[0].insights.length >= 1);
  assert.ok(refs[0].insights[0].startsWith('我'));
  assert.ok(store.recentMemories('agent:1', 100).some((m) => m.kind === 'insight'));
  assert.ok(log.eventsForDay(1).some((e) => e.payload?.kind === 'reflection'));
});

test('每天最多 2 次；未超阈值不触发', async () => {
  const { store, engine, agent } = setup();
  engine.tick(agent, 1, 10);
  await flush();
  assert.equal(store.reflectionsFor('agent:1').length, 0); // 累计 0
  store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '大事件', importance: 9, createdGameTime: 20 });
  engine.tick(agent, 1, 30);
  await flush();
  await flush();
  assert.equal(store.reflectionsFor('agent:1').length, 0); // 9 < 150
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/reflection.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/reflection'`。

- [ ] **Step 3: 写 src/engine/reflection.ts**

```ts
// 反思引擎：importance 累计 >150 触发 → 3 问题 → 检索证据 → 洞察 → 反思树 + 写回记忆流
// （spec §5.6；每天每 agent 最多 2 次控成本）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import {
  REFLECTION_QUESTIONS_TEMPLATE, REFLECTION_INSIGHTS_TEMPLATE,
  reflectionQuestionsMessages, reflectionInsightsMessages,
} from '../llm/prompts';

export class ReflectionEngine {
  private inFlight = new Set<string>();
  private dayCount = new Map<string, { day: number; count: number }>();

  constructor(private llm: LLMGateway, private store: MemoryStore, private log: EventLog) {}

  tick(agent: Agent, day: number, now: number): void {
    const dc = this.dayCount.get(agent.id);
    const count = dc && dc.day === day ? dc.count : 0;
    if (count >= 2) return;
    if (this.inFlight.has(agent.id)) return;
    if (this.store.accumulator(agent.id) > 150) {
      this.store.resetAccumulator(agent.id);
      this.inFlight.add(agent.id);
      this.dayCount.set(agent.id, { day, count: count + 1 });
      void this.run(agent, day, now).catch((err) => console.error('[reflection]', err));
    }
  }

  private async run(agent: Agent, day: number, now: number): Promise<void> {
    try {
      const recent = this.store.recentMemories(agent.id, 100).map((m) => m.content);
      const q = await this.ask(REFLECTION_QUESTIONS_TEMPLATE, { memories: recent });
      const questions = (q.questions ?? []).slice(0, 3);
      const evidenceIds: string[] = [];
      const insights: string[] = [];
      for (const question of questions) {
        const ev = this.store.retrieve(agent.id, question, now, 5);
        evidenceIds.push(...ev.map((m) => m.id));
        const r = await this.ask(REFLECTION_INSIGHTS_TEMPLATE, { question, evidence: ev.map((m) => m.content) });
        insights.push(...(r.insights ?? []).slice(0, 5));
      }
      const final = insights.slice(0, 5);
      const parent = this.store.reflectionsFor(agent.id)[0] ?? null;
      this.store.addReflection({
        agentId: agent.id, parentId: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0,
        questions, insights: final, evidenceIds, triggerScore: 150, createdGameTime: now,
      });
      for (const ins of final) {
        this.store.addMemory({ agentId: agent.id, kind: 'insight', content: ins, importance: 8, createdGameTime: now });
      }
      this.log.addEvent(reflectionEvent(agent, final[0] ?? '', day, now));
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  private async ask(template: string, ctx: unknown): Promise<{ questions?: string[]; insights?: string[] }> {
    const messages = template === REFLECTION_QUESTIONS_TEMPLATE
      ? reflectionQuestionsMessages((ctx as { memories: string[] }).memories)
      : reflectionInsightsMessages((ctx as { question: string }).question, (ctx as { evidence: string[] }).evidence);
    const res = await this.llm.complete({ tier: 'large', template, jsonMode: true, maxTokens: 512, messages });
    return (res.parsed ?? {}) as { questions?: string[]; insights?: string[] };
  }
}

function reflectionEvent(agent: Agent, insight: string, day: number, now: number): GameEvent {
  return {
    id: randomUUID(), type: 'system', actorId: agent.id, targetIds: [],
    description: `「${agent.name}」反思：${insight}`, location: null, gameTime: now,
    payload: { kind: 'reflection', day },
  };
}
```

- [ ] **Step 4: 修改 src/engine/mind.ts（装配 reflection）**

`reflection?: ReflectionLike;` → `readonly reflection: ReflectionEngine;`
构造器内 `this.reflection = undefined; // Task 6 装配` → `this.reflection = new ReflectionEngine(opts.llm, this.store, opts.log);`
import 加：`import { ReflectionEngine } from './reflection';`（并删除 ReflectionLike 接口）

- [ ] **Step 5: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/reflection.test.ts
pnpm test
pnpm typecheck
```

Expected: reflection.test 2 通过；全量通过；typecheck 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/engine/reflection.ts src/engine/mind.ts tests/reflection.test.ts
git commit -m "feat(engine): 反思引擎（阈值/窗口/树/洞察写回）"
```

---

### Task 7: 对话引擎（多轮 + 摘要双写）

**Files:**
- Create: `src/engine/dialogue.ts`、`tests/dialogue.test.ts`
- Modify: `src/engine/social.ts`（构造器可选第 3 参 dialogue；触发时优先启动对话）、`src/engine/mind.ts`（装配 dialogue）

**Interfaces:**
- Produces：
  - `new DialogueEngine(llm, store, log, maxRounds = 12)`
  - `isActive(aId, bId): boolean`、`start(a: Agent, b: Agent, now)`（pairKey 去重；立即异步产出第一句）、`tick(world, dt, now)`（每 2 游戏分钟交替一句；结束 → 摘要写回双方 kind=dialogue_summary importance 7 + chat 事件 payload {kind:'chat_summary', line}）
  - chat 事件 payload：`{ kind:'chat', line, fromId, toId, conversationId }`；utterance 写入 messages 表
  - `new SocialTicker(log, cfg?, dialogue?)`：触发时若 dialogue 且无进行中会话 → `dialogue.start(a, b, now)`，否则保持原单句行为

- [ ] **Step 1: 写失败测试 tests/dialogue.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { DialogueEngine } from '../src/engine/dialogue';
import { WorldState } from '../src/core/world';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [{ id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 }];

function setup() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const store = new MemoryStore(db);
  const gateway = new LLMGateway({ provider: 'mock' });
  const a = makeAgent({ id: 'agent:a', name: '甲', persona: persona({ name: '甲', greetingPool: ['你好呀！', '今天真不错。', '改天一起吃饭？', '那就说定啦。'] }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', persona: persona({ name: '乙', greetingPool: ['你好！', '是呀。', '好呀好呀。', '一言为定。'] }) });
  const world = new WorldState(OBJS, [a, b]);
  const dialogue = new DialogueEngine(gateway, store, log);
  return { db, log, store, world, dialogue, a, b };
}

test('多轮对话：交替 4 句后结束并摘要双写', async () => {
  const { log, world, dialogue, a, b } = setup();
  dialogue.start(a, b, 10);
  await flush();
  // 推进：每 tick 2 游戏分钟
  for (let now = 12; now <= 40; now += 2) {
    dialogue.tick(world, 2, now);
    await flush();
  }
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.ok(chats.length >= 4, `应有至少 4 句，实际 ${chats.length}`);
  assert.ok(chats.some((e) => e.payload?.kind === 'chat_summary'));
  assert.equal(dialogue.isActive('agent:a', 'agent:b'), false);
});

test('摘要写入双方记忆流', async () => {
  const { store, world, dialogue, a, b } = setup();
  dialogue.start(a, b, 10);
  await flush();
  for (let now = 12; now <= 40; now += 2) { dialogue.tick(world, 2, now); await flush(); }
  const sa = store.recentMemories('agent:a', 20).filter((m) => m.kind === 'dialogue_summary');
  const sb = store.recentMemories('agent:b', 20).filter((m) => m.kind === 'dialogue_summary');
  assert.ok(sa.length >= 1 && sb.length >= 1);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/dialogue.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/dialogue'`。

- [ ] **Step 3: 写 src/engine/dialogue.ts**

```ts
// 对话引擎：多轮对话（≤12 轮、每 2 游戏分钟一句）+ 结束摘要写回双方记忆流（spec §5.7）

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';
import type { MemoryStore } from '../store/memory';
import type { LLMGateway } from '../llm/gateway';
import { DIALOGUE_TEMPLATE, DIALOGUE_SUMMARY_TEMPLATE, dialogueMessages, dialogueSummaryMessages } from '../llm/prompts';

interface Session {
  a: string; aName: string; b: string; bName: string;
  turns: { from: string; content: string }[];
  lastUtterAt: number;
  ended: boolean;
  conversationId: string;
}

interface Pending { resolved: { utterance: string; end: boolean } | null; error: string | null }

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class DialogueEngine {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();

  constructor(private llm: LLMGateway, private store: MemoryStore, private log: EventLog, private maxRounds = 12) {}

  isActive(aId: string, bId: string): boolean {
    return this.sessions.has(pairKey(aId, bId));
  }

  start(a: Agent, b: Agent, now: number): void {
    const key = pairKey(a.id, b.id);
    if (this.sessions.has(key)) return;
    const s: Session = { a: a.id, aName: a.name, b: b.id, bName: b.name, turns: [], lastUtterAt: now, ended: false, conversationId: randomUUID() };
    this.sessions.set(key, s);
    this.speak(a, b, s, now);
  }

  tick(world: WorldState, dt: number, now: number): void {
    for (const [key, s] of this.sessions) {
      if (s.ended) {
        this.sessions.delete(key);
        this.pending.delete(key);
        continue;
      }
      const p = this.pending.get(key);
      if (p?.error) {
        this.sessions.delete(key);
        this.pending.delete(key);
        continue;
      }
      if (p?.resolved) {
        this.pending.delete(key);
        this.deliver(s, p.resolved, now);
        continue;
      }
      if (!p && now - s.lastUtterAt >= 2) {
        const speaker = world.getAgent(s.turns.length % 2 === 0 ? s.a : s.b);
        const other = world.getAgent(speaker.id === s.a ? s.b : s.a);
        this.speak(speaker, other, s, now);
      }
    }
  }

  private speak(speaker: Agent, other: Agent, s: Session, now: number): void {
    const key = pairKey(s.a, s.b);
    s.lastUtterAt = now;
    const entry: Pending = { resolved: null, error: null };
    this.pending.set(key, entry);
    void (async () => {
      try {
        const ctx = {
          speakerName: speaker.name,
          speakerPool: speaker.persona.greetingPool ?? [],
          otherName: other.name,
          goal: speaker.persona.goals[0] ?? '',
          turns: s.turns.length,
        };
        const res = await this.llm.complete({ tier: 'large', template: DIALOGUE_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueMessages(ctx) });
        const parsed = res.parsed as { utterance?: string; end_dialogue?: boolean } | null;
        entry.resolved = {
          utterance: (parsed?.utterance ?? '……').slice(0, 120),
          end: !!parsed?.end_dialogue || s.turns.length + 1 >= this.maxRounds,
        };
      } catch (err) {
        entry.error = err instanceof Error ? err.message : String(err);
      }
    })();
  }

  private deliver(s: Session, u: { utterance: string; end: boolean }, now: number): void {
    const fromId = s.turns.length % 2 === 0 ? s.a : s.b;
    const toId = fromId === s.a ? s.b : s.a;
    const fromName = fromId === s.a ? s.aName : s.bName;
    const toName = toId === s.a ? s.aName : s.bName;
    s.turns.push({ from: fromId, content: u.utterance });
    this.log.addEvent({
      id: randomUUID(), type: 'chat', actorId: fromId, targetIds: [toId],
      description: `「${fromName}」对「${toName}」说：「${u.utterance}」`,
      location: null, gameTime: now,
      payload: { kind: 'chat', line: u.utterance, fromId, toId, conversationId: s.conversationId },
    });
    this.store.addMessage({ eventId: null, fromAgent: fromId, toAgent: toId, content: u.utterance, gameTime: now });
    if (u.end) void this.finish(s, now);
  }

  private async finish(s: Session, now: number): Promise<void> {
    s.ended = true;
    const lines = s.turns.map((t) => t.content);
    let summary = '两人简单聊了几句。';
    try {
      const res = await this.llm.complete({ tier: 'large', template: DIALOGUE_SUMMARY_TEMPLATE, jsonMode: true, maxTokens: 256, messages: dialogueSummaryMessages(lines) });
      summary = (((res.parsed as { summary?: string } | null)?.summary) ?? summary).slice(0, 100);
    } catch {
      /* 保留默认摘要 */
    }
    for (const id of [s.a, s.b]) {
      this.store.addMemory({ agentId: id, kind: 'dialogue_summary', content: `第${Math.floor(now / 1440) + 1}天 对话摘要：${summary}`, importance: 7, createdGameTime: now });
    }
    this.log.addEvent({
      id: randomUUID(), type: 'chat', actorId: null, targetIds: [s.a, s.b],
      description: `「${s.aName}」和「${s.bName}」的对话结束：${summary}`,
      location: null, gameTime: now,
      payload: { kind: 'chat_summary', line: summary, fromId: s.a, toId: s.b, conversationId: s.conversationId },
    });
  }
}
```

- [ ] **Step 4: 修改 src/engine/social.ts（对话触发）**

构造器：

```ts
  constructor(private log: EventLog, private cfg: SocialConfig = {}, private dialogue?: DialogueEngine) {}
```

import 加：`import type { DialogueEngine } from './dialogue';`

`tick` 触发分支改为：

```ts
        if (this.proximity.get(key)! >= min && now >= (this.nextAt.get(key) ?? 0)) {
          if (this.dialogue && !this.dialogue.isActive(a.id, b.id)) {
            this.dialogue.start(a, b, now);
          } else {
            const count = this.triggerCount.get(key) ?? 0;
            const line = pickLine(a, count);
            this.log.addEvent(makeChatEvent(a, b, line, now));
            this.triggerCount.set(key, count + 1);
          }
          this.proximity.set(key, 0);
          this.nextAt.set(key, now + cooldown);
        }
```

（保留 `pickLine`/`makeChatEvent`/`triggerCount` 供无对话引擎的 M0 路径使用。）

- [ ] **Step 5: 修改 src/engine/mind.ts（装配 dialogue）**

`dialogue?: DialogueLike;` → `readonly dialogue: DialogueEngine;`
构造器内 `this.dialogue = undefined;   // Task 7 装配` → `this.dialogue = new DialogueEngine(opts.llm, this.store, opts.log);`
import 加：`import { DialogueEngine } from './dialogue';`（并删除 DialogueLike 接口）

- [ ] **Step 6: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/dialogue.test.ts tests/social.test.ts
pnpm test
pnpm typecheck
```

Expected: dialogue.test 2 通过；social.test 原 4 通过（无对话引擎路径不变）；全量通过；typecheck 0 错。

- [ ] **Step 7: 提交**

```bash
git add src/engine/dialogue.ts src/engine/social.ts src/engine/mind.ts tests/dialogue.test.ts
git commit -m "feat(engine): 多轮对话引擎与摘要双写"
```

---

### Task 8: 访谈（服务 + CLI）

**Files:**
- Create: `src/engine/interview.ts`、`src/cli/interview.ts`、`tests/interview.test.ts`
- Modify: `package.json`（scripts 加 interview）

**Interfaces:**
- Produces：
  - `interviewAgent(opts: { agent: Agent; question: string; llm: LLMGateway; store: MemoryStore; now: number }): Promise<string>`
  - `pnpm interview -- --agent <名> --question <问题> [--db path]`（mock 默认；真机 LLM_PROVIDER=deepseek；打印第一人称回答）

- [ ] **Step 1: 写失败测试 tests/interview.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { interviewAgent } from '../src/engine/interview';
import { buildTown } from '../src/engine/seed';

test('访谈回答引用检索到的记忆', async () => {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const agent = buildTown().allAgents()[0]; // 林晚晴
  store.addMemory({ agentId: agent.id, kind: 'observation', content: '第1天 10:00，林晚晴 开始「煮咖啡」，约 15 分钟', importance: 6, createdGameTime: 600 });
  const answer = await interviewAgent({ agent, question: '你今天做了什么？', llm: new LLMGateway({ provider: 'mock' }), store, now: 700 });
  assert.ok(answer.includes('我记得'));
  assert.ok(answer.includes('煮咖啡'));
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/interview.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/interview'`。

- [ ] **Step 3: 写 src/engine/interview.ts**

```ts
// 访谈：上帝视角向任意 agent 提问，第一人称基于记忆回答（spec §10.2 的自动化版）

import type { Agent } from '../core/types';
import type { LLMGateway } from '../llm/gateway';
import type { MemoryStore } from '../store/memory';
import { INTERVIEW_TEMPLATE, interviewMessages } from '../llm/prompts';

export interface InterviewOptions {
  agent: Agent;
  question: string;
  llm: LLMGateway;
  store: MemoryStore;
  now: number;
}

export async function interviewAgent(opts: InterviewOptions): Promise<string> {
  const memories = opts.store.retrieve(opts.agent.id, opts.question, opts.now, 20).map((m) => m.content);
  const insights = opts.store.recentInsights(opts.agent.id, 5);
  const res = await opts.llm.complete({
    tier: 'large', template: INTERVIEW_TEMPLATE, jsonMode: true, maxTokens: 512,
    messages: interviewMessages(opts.agent, opts.question, memories, insights),
  });
  return ((res.parsed as { answer?: string } | null)?.answer) ?? '（我不知道）';
}
```

- [ ] **Step 4: 写 src/cli/interview.ts**

```ts
// 访谈命令：pnpm interview -- --agent 林晚晴 --question "昨天做了什么"

import { resolve } from 'node:path';
import { buildTown } from '../engine/seed';
import { openDb } from '../store/db';
import { MemoryStore } from '../store/memory';
import { LLMGateway } from '../llm/gateway';
import { interviewAgent } from '../engine/interview';

export interface InterviewArgs {
  agentName: string;
  question: string;
  dbPath: string;
}

export function parseArgs(argv: string[]): InterviewArgs {
  const args: InterviewArgs = { agentName: '', question: '', dbPath: resolve(process.cwd(), 'data/town.sqlite') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') args.agentName = argv[++i];
    else if (argv[i] === '--question') args.question = argv[++i];
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agentName || !args.question) {
    console.error('用法：pnpm interview -- --agent <名字> --question "<问题>" [--db 路径]');
    process.exit(1);
  }
  const agent = buildTown().allAgents().find((a) => a.name === args.agentName);
  if (!agent) {
    console.error(`找不到 agent：${args.agentName}`);
    process.exit(1);
  }
  const provider = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const llm = new LLMGateway({ provider, deepseek: { apiKey: process.env.DEEPSEEK_API_KEY ?? '' }, retries: 2 });
  const db = openDb(args.dbPath);
  const store = new MemoryStore(db);
  const now = Number(db.getMeta('game_time') ?? '0');
  const answer = await interviewAgent({ agent, question: args.question, llm, store, now });
  console.log(`问：${args.question}`);
  console.log(`${agent.name}：${answer}`);
}

void main();
```

- [ ] **Step 5: 修改 package.json**

scripts 加：

```json
    "interview": "node --no-warnings --import tsx src/cli/interview.ts"
```

- [ ] **Step 6: 运行确认通过 + 全量 + 类型检查 + 手动冒烟**

```bash
node --no-warnings --import tsx --test tests/interview.test.ts
pnpm test
pnpm typecheck
pnpm town --until-minutes 1440 --speed 60   # 生成记忆（写 data/town.sqlite）
pnpm interview -- --agent 林晚晴 --question "今天做了什么"
```

Expected: interview.test 1 通过；全量通过；typecheck 0 错；手动冒烟打印「我记得：…」开头的回答。

- [ ] **Step 7: 提交**

```bash
git add src/engine/interview.ts src/cli/interview.ts package.json tests/interview.test.ts
git commit -m "feat(engine): 访谈服务与 CLI"
```

---

### Task 9: 心智面板（mind API + 客户端标签页）

**Files:**
- Modify: `src/web/server.ts`（TownWebOptions 加 `mind?: MindEngine`；GET /api/agents/:id/mind）、`src/cli/town-web.ts`（构造 mind 并注入 executor/loop/server）、`src/cli/run.ts`（同样构造 mind 并注入——Task 8 冒烟发现的接线缺口，控制器裁定并入本任务）、`public/index.html`（面板加标签容器）、`public/style.css`（标签与列表样式）、`src/web/client/main.ts`（面板标签页 + fetch mind）
- Create: `tests/server-mind.test.ts`

**Interfaces:**
- Consumes: MemoryStore
- Produces：
  - `GET /api/agents/:id/mind`（id 为 encodeURIComponent 后的 agent id，如 `agent:林晚晴` → `agent%3A%E6%9E%97%E6%99%9A%E6%99%B4`）→ `{ memories: Memory[]; reflections: ReflectionRecord[]; plans: PlanRecord[]; dialogues: {fromAgent;toAgent;content;gameTime}[] }`（memories 限 50 条）
  - 客户端：选中 NPC 后面板出现 标签行（详情/记忆/反思/对话），点击切换内容（记忆显示 ★重要度、反思树缩进、对话按行列出）

- [ ] **Step 1: 写失败测试 tests/server-mind.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('mind API 返回记忆/反思/计划/对话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-mind-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const world = new WorldState(OBJS, [agent]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '第1天 09:00，甲 开始「煮咖啡」', importance: 6, createdGameTime: 540 });
  mind.store.addReflection({ agentId: 'agent:1', parentId: null, depth: 0, questions: ['q'], insights: ['我常去咖啡馆。'], evidenceIds: [], triggerScore: 160, createdGameTime: 700 });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, publicDir: dir });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent('agent:1')}/mind`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { memories: unknown[]; reflections: unknown[] };
    assert.equal(body.memories.length, 1);
    assert.equal(body.reflections.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/server-mind.test.ts`
Expected: FAIL（/api/agents/... 404）。

- [ ] **Step 3: 修改 src/web/server.ts（mind API）**

TownWebOptions 加：

```ts
  mind?: MindEngine;    // M1 认知核心（心智面板数据源）
```

import 加：`import type { MindEngine } from '../engine/mind';`

在 `/api/state` 路由之后插入：

```ts
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/mind') && req.method === 'GET') {
        const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/mind'.length));
        if (!opts.mind) {
          res.writeHead(404);
          res.end('mind 未启用');
          return;
        }
        const body = {
          memories: opts.mind.store.recentMemories(id, 50),
          reflections: opts.mind.store.reflectionsFor(id),
          plans: [], // 计划列表：取当天与前一天
          dialogues: opts.mind.store.messagesFor(id, 50),
        };
        for (let day = Math.floor(time.state.totalMinutes / 1440) + 1; day >= 1 && body.plans.length < 4; day--) {
          const p = opts.mind.store.planFor(id, day);
          if (p) body.plans.push(p);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
        return;
      }
```

（`body.plans` 需要显式类型注解：`const body: { memories: unknown[]; reflections: unknown[]; plans: unknown[]; dialogues: unknown[] } = {...}` —— 以通过 strict 检查为准。）

- [ ] **Step 4: 修改 src/cli/town-web.ts（注入 mind）**

```ts
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  const server = await createTownServer({ world, time, loop, log, mind, port: args.port });
```

import 加：`import { MindEngine } from '../engine/mind';`

- [ ] **Step 4b: 修改 src/cli/run.ts（同样注入 mind）**

```ts
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
```

import 加：`import { MindEngine } from '../engine/mind';`、`import { SocialTicker } from '../engine/social';`（若未导入）

- [ ] **Step 5: 修改 public/index.html（面板标签容器）**

`<div id="panel">` 内容替换为：

```html
      <div id="panel">
        <div id="panel-tabs">
          <button data-tab="detail" class="tab active">详情</button>
          <button data-tab="memory" class="tab">记忆</button>
          <button data-tab="reflection" class="tab">反思</button>
          <button data-tab="dialogue" class="tab">对话</button>
        </div>
        <div id="panel-body"><p id="panel-empty">点击小镇里的角色查看详情</p></div>
      </div>
```

- [ ] **Step 6: 修改 public/style.css（标签与列表样式）**

追加：

```css
#panel-tabs { display: flex; gap: 4px; margin-bottom: 8px; }
#panel-tabs .tab {
  flex: 1; padding: 4px 0; border: 1px solid #3a4657; border-radius: 4px;
  background: #2a3547; color: #e8e2d4; cursor: pointer; font-size: 12px;
}
#panel-tabs .tab.active { background: #4a5f83; }
#panel-body .mem-item { border-bottom: 1px dashed #3a4657; padding: 4px 0; font-size: 12px; line-height: 1.5; }
#panel-body .mem-item .stars { color: #e3b23c; }
#panel-body .ref-item { padding-left: 0; margin: 6px 0; font-size: 12px; }
#panel-body .ref-item .ins { padding-left: 14px; }
#panel-body .dl-item { font-size: 12px; margin: 4px 0; }
```

- [ ] **Step 7: 修改 src/web/client/main.ts（面板标签页）**

`updatePanel` 重写（详情 tab 保留原逻辑，另三 tab fetch mind）。在文件末尾（`void main();` 之前）追加/替换如下实现：

```ts
let activeTab = 'detail';

function updatePanel(): void {
  const body = document.getElementById('panel-body')!;
  const a = snap?.agents.find((x) => x.id === selectedId);
  if (!a) {
    activeTab = 'detail';
    body.innerHTML = '<p id="panel-empty">点击小镇里的角色查看详情</p>';
    return;
  }
  if (activeTab === 'detail') renderDetail(body, a);
  else void renderMind(body, a.id, activeTab);
}

function renderDetail(body: HTMLElement, a: AgentView): void {
  const stateName: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
  body.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${escapeHtml(stateName[a.state] ?? a.state)}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>`;
}

async function renderMind(body: HTMLElement, agentId: string, tab: string): Promise<void> {
  body.innerHTML = '<p class="label">加载中…</p>';
  try {
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/mind`);
    const mind = (await res.json()) as {
      memories: { content: string; importance: number; kind: string }[];
      reflections: { insights: string[] }[];
      dialogues: { fromAgent: string; content: string }[];
    };
    if (tab === 'memory') {
      body.innerHTML = mind.memories.length
        ? mind.memories.map((m) => `<div class="mem-item"><span class="stars">${'★'.repeat(Math.round(m.importance / 2))}</span> ${escapeHtml(m.content)}</div>`).join('')
        : '<p class="label">暂无记忆</p>';
    } else if (tab === 'reflection') {
      body.innerHTML = mind.reflections.length
        ? mind.reflections.map((r) => `<div class="ref-item">${r.insights.map((i) => `<div class="ins">💡 ${escapeHtml(i)}</div>`).join('')}</div>`).join('')
        : '<p class="label">暂无反思</p>';
    } else {
      body.innerHTML = mind.dialogues.length
        ? mind.dialogues.map((d) => `<div class="dl-item">${escapeHtml(d.fromAgent)}：${escapeHtml(d.content)}</div>`).join('')
        : '<p class="label">暂无对话</p>';
    }
  } catch {
    body.innerHTML = '<p class="label">加载失败</p>';
  }
}
```

并在 `main()` 中 `bindControls();` 之后追加：

```ts
  document.querySelectorAll('#panel-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = (tab as HTMLElement).dataset.tab ?? 'detail';
      document.querySelectorAll('#panel-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
      updatePanel();
    });
  });
```

- [ ] **Step 8: 运行确认通过 + 构建 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/server-mind.test.ts
pnpm build:web
pnpm test
pnpm typecheck
```

Expected: server-mind 1 通过；构建成功；全量通过；typecheck 0 错。

- [ ] **Step 9: 提交**

```bash
git add src/web/server.ts src/cli/town-web.ts public/index.html public/style.css src/web/client/main.ts tests/server-mind.test.ts
git commit -m "feat(web): 心智面板（mind API + 客户端标签页）"
```

---

### Task 10: M1 验收 e2e + README + 收尾

**Files:**
- Create: `tests/acceptance-m1.test.ts`
- Modify: `README.md`（M1 说明 + interview 用法）

- [ ] **Step 1: 写 tests/acceptance-m1.test.ts**

```ts
// M1 验收：1 游戏日闭环（记忆/计划/反思/对话摘要）+ 访谈引用真实记忆 + 心智面板 API

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { SocialTicker } from '../src/engine/social';
import { interviewAgent } from '../src/engine/interview';
import { createTownServer } from '../src/web/server';

test('M1 验收：闭环跑通 + 访谈引用记忆 + mind API', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-m1-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  const server = await createTownServer({ world, time, loop, log, mind, publicDir: dir });
  try {
    await loop.runUntil(1440);

    // ① 每 agent 记忆 ≥15
    for (const a of world.allAgents()) {
      assert.ok(mind.store.countFor(a.id) >= 15, `${a.name} 记忆过少: ${mind.store.countFor(a.id)}`);
    }
    // ② 反思 ≥1 次
    const totalRefs = world.allAgents().reduce((s, a) => s + mind.store.reflectionsFor(a.id).length, 0);
    assert.ok(totalRefs >= 1, '一整天没有任何反思');
    // ③ 日计划已生成
    for (const a of world.allAgents()) {
      assert.ok(mind.store.planFor(a.id, 1), `${a.name} 缺少日计划`);
    }
    // ④ 对话摘要 ≥1 条（双方记忆流）
    const summaries = world.allAgents().reduce((s, a) => s + mind.store.recentMemories(a.id, 500).filter((m) => m.kind === 'dialogue_summary').length, 0);
    assert.ok(summaries >= 2, `对话摘要应 ≥2（双写），实际 ${summaries}`);
    // ⑤ 访谈引用真实记忆
    const lin = world.allAgents()[0];
    const answer = await interviewAgent({ agent: lin, question: '你今天做了什么？', llm: gateway, store: mind.store, now: 1440 });
    assert.ok(answer.includes('我记得'));
    const dayMemories = mind.store.recentMemories(lin.id, 500).filter((m) => m.createdGameTime < 1440);
    const quoted = dayMemories.some((m) => answer.includes(m.content.slice(0, 12)));
    assert.ok(quoted, '访谈回答未引用任何真实记忆');
    // ⑥ mind API
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent(lin.id)}/mind`);
    const body = (await res.json()) as { memories: unknown[]; reflections: unknown[] };
    assert.ok(body.memories.length >= 15);
    assert.ok(body.reflections.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
```

- [ ] **Step 2: 运行验收**

```bash
node --no-warnings --import tsx --test tests/acceptance-m1.test.ts
```

Expected: 1 通过。若失败按断言修被测代码，不放宽断言。

- [ ] **Step 3: 更新 README.md**

项目状态 M1 行打勾，并加运行说明：

```markdown
pnpm interview -- --agent 林晚晴 --question "今天做了什么"   # 上帝视角访谈（先跑 pnpm town --until-minutes 1440 --speed 60 生成记忆）
```

- [ ] **Step 4: 全量验证**

```bash
pnpm build:web
pnpm test
pnpm typecheck
git status
```

Expected: 全量通过（约 70 个测试）；typecheck 0 错；工作区干净。

- [ ] **Step 5: 提交**

```bash
git add tests/acceptance-m1.test.ts README.md
git commit -m "test: M1 验收（认知闭环 + 访谈 + 心智面板）"
```

---

## 自检记录（写完后已核对）

- **Spec 覆盖**：§5.2（MemoryWriter 事件→观察→打分→记忆流）、§5.3（三因子检索，relevance 以关键词代替 embedding——用户批准偏离）、§5.4（5:00 日计划 + 整点小时分解 + 兜底）、§5.6（阈值 150/每天 2 次/问题-证据-洞察/树/写回）、§5.7（≤12 轮/2 分钟一句/摘要双写/重要信息高 importance 由 mockImportance 的派对类关键词兜住）、§6.1-6.9 九个提示词全部落地、§4.1 DDL 四表落地。验收 = §11 M1 行（闭环 + 访谈能答出）。
- **占位符扫描**：无 TBD/TODO；全部代码步骤含完整代码。
- **类型一致性**：`MemoryBrief` 在 prompts/state-machine 一致；`MockContextPayload` 新字段在 executor 装配与 prompts.test 更新一致；`MindEngine.tick(world, dt, now)` 与 loop.step 调用一致；`SocialTicker(log, cfg?, dialogue?)` 与 town-web/验收装配一致；`DialogueEngine.tick(world, dt, now)` 与 mind.tick 一致；mind API 的 encodeURIComponent 往返与客户端 fetch 一致。
- **边界推演**：dt=30 时 5:00（300）恰好命中、整点恰好命中；importance 累计：每 agent 每天约 35-45 条记忆 × 均值 6 ≈ 210-270 > 150 → 反思必然触发一次（触发后 insights 再累 40，二次触发受每天 2 次上限约束）；对话：周岚与林晚晴/陈默各相邻 ≥60 分钟，4 句对话（每句 2 分钟）必然完成并产出摘要；mock 对话 turn>=3 结束（4 句）。
- **已知简化（有意为之）**：检索无向量（用户批准）；对话不检查双方距离（开始后跨图继续，M1-lite）；反思问题/洞察 mock 为模板化输出（真机走提示词）；importance 累计为内存态（重启清零，M4 持久化）。
