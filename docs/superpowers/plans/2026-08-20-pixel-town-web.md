# 像素小镇可视化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 multiagent-town 增加像素风浏览器可视化：4 个 agent 以 16×16 像素 NPC 在 12×8 瓦片小镇地图上活动，头顶显示 💭 想法 / 💬 闲聊气泡，NPC 相邻累计 3 游戏分钟触发打招呼（配对冷却 90 游戏分钟），提供游戏时钟、暂停/1x/60x/360x 调速与 NPC 状态面板；`pnpm town-web` 一键启动。

**Architecture:** 零新增运行时依赖。引擎侧新增 SocialTicker（相邻闲聊，事件 type=chat 走既有 EventLog）；Web 侧用 node:http 提供静态页面 + SSE（200ms 快照推送 + 事件即时推送）+ POST /api/world/control（暂停/恢复/调速）。客户端为纯 TS（esbuild 打包为 public/client.js，esbuild 是 tsx 既有传递依赖，仅升级为显式 devDependency）：Canvas 2D 像素渲染（瓦片 32px、CSS 2x + image-rendering: pixelated），NPC 精灵程序绘制（4 套配色、走路 2 帧），快照间线性插值平滑移动。

**Tech Stack:** TypeScript strict + node:http + SSE + Canvas 2D + esbuild（无 CDN、无运行时网络依赖）。测试：node:test + node:sqlite(:memory:) + 临时 fixture。

**Spec:** `docs/ai-town-design.md` §9（前端呈现设计，本计划为其轻量先行版；Phaser 正式版留 M2 原定计划）+ §5.1 tick 主循环 + §4.1 events 表（type 枚举含 chat）。

## Global Constraints

- TypeScript `strict: true`；全部新增代码注释与用户可见文案一律中文
- 零新增运行时依赖；esbuild 仅 devDependency（构建期使用）
- 事件 type ∈ move|chat|interact|broadcast|system|player；闲聊事件 type=chat、描述中文第三人称
- LLM 调用全异步不阻塞 tick；每 agent 最多 1 个决策在飞
- 时间模型不变：gameMinutesPerTick = speed(游戏分钟/现实秒) × 0.5，tick 0.5s；默认 60x
- 客户端所有绘制逻辑在 public/ 与 src/web/client/，不得依赖 CDN
- 生成物 public/client.js 不提交（gitignore），`pnpm town-web` 先构建再启动
- 验收：`pnpm town-web` 启动后浏览器可玩；自动化验收覆盖「快照推进、NPC 闲聊事件 ≥1/游戏日、调速生效、SSE 推送」

---

### Task 1: 社交闲聊 SocialTicker + persona 台词池

**Files:**
- Create: `src/engine/social.ts`、`tests/social.test.ts`
- Modify: `src/core/types.ts`（Persona 加 `greetingPool?: string[]`）、`src/engine/seed.ts`（4 个 persona 各加台词池）

**Interfaces:**
- Produces（后续任务依赖，签名以此为准）：
  - `SocialConfig { minProximityMinutes?: number; cooldownMinutes?: number }`（默认 3 / 90）
  - `new SocialTicker(log: EventLog, cfg?: SocialConfig)`
  - `ticker.tick(agents: Agent[], dt: number, now: number): void`（每 tick 调用；相邻=切比雪夫距离 ≤1；分离或触发即清零累计；触发后同对冷却）
  - 闲聊事件：`{ type: 'chat', actorId: a.id, targetIds: [b.id], description: '「A」对「B」说：「台词」', payload: { kind: 'chat', line, fromId, toId } }`
  - Persona 新增可选字段 `greetingPool?: string[]`（缺省用通用台词池）

- [ ] **Step 1: 写失败测试 tests/social.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { SocialTicker } from '../src/engine/social';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona } from './helpers';

function setup() {
  const log = new EventLog(openDb(':memory:'));
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0, locationId: 'obj:plaza' });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1, locationId: 'obj:plaza' });
  const ticker = new SocialTicker(log);
  return { log, a, b, ticker };
}

test('相邻累计 3 分钟触发 chat 事件', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 2, 10); // 累计 2 分钟
  assert.equal(log.count(), 0);
  ticker.tick([a, b], 1, 11); // 累计 3 分钟 → 触发
  const chat = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chat.length, 1);
  assert.equal(chat[0].actorId, 'agent:a');
  assert.deepEqual(chat[0].targetIds, ['agent:b']);
  assert.equal(chat[0].payload?.line, '你好呀！'); // 无台词池 → 通用池第 0 条
  assert.match(chat[0].description, /^「甲」对「乙」说：「你好呀！」$/);
});

test('触发后冷却 90 分钟内不再触发，之后台词轮换', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 3, 10); // 第 1 次
  for (let t = 15; t <= 99; t += 5) ticker.tick([a, b], 5, t); // 冷却期内不断相邻
  assert.equal(log.eventsForDay(1).filter((e) => e.type === 'chat').length, 1);
  ticker.tick([a, b], 1, 100); // 10 + 90 = 100 → 冷却结束
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chats.length, 2);
  assert.equal(chats[1].payload?.line, '今天天气真不错。'); // 通用池第 1 条
});

test('分离后累计清零', () => {
  const { log, a, b, ticker } = setup();
  ticker.tick([a, b], 2, 10); // 相邻 2 分钟
  a.x = 5; a.y = 5;           // 走远
  ticker.tick([a, b], 1, 11);
  a.x = 0; a.y = 0;           // 回来，重新累计
  ticker.tick([a, b], 2, 12);
  assert.equal(log.eventsForDay(1).filter((e) => e.type === 'chat').length, 0);
});

test('persona 台词池优先，冷却后轮换', () => {
  const log = new EventLog(openDb(':memory:'));
  const a = makeAgent({ id: 'agent:a', name: '甲', x: 0, y: 0, persona: persona({ greetingPool: ['你好！', '再见！'] }) });
  const b = makeAgent({ id: 'agent:b', name: '乙', x: 0, y: 1 });
  const ticker = new SocialTicker(log, { cooldownMinutes: 10 });
  ticker.tick([a, b], 3, 5);
  ticker.tick([a, b], 3, 16); // 冷却已过，再累计 3 分钟触发第二次
  const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
  assert.equal(chats[0].payload?.line, '你好！');
  assert.equal(chats[1].payload?.line, '再见！');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/social.test.ts`
Expected: FAIL，报 `Cannot find module '../src/engine/social'`。

- [ ] **Step 3: 修改 src/core/types.ts（Persona 加字段）**

在 `Persona` 接口的 `routine` 字段后追加：

```ts
  /** 相邻闲聊的台词池（M2-lite 社交气泡用；缺省用通用台词） */
  greetingPool?: string[];
```

- [ ] **Step 4: 写 src/engine/social.ts**

```ts
// 社交闲聊：相邻 NPC 累计一定游戏分钟后触发一句打招呼（M2-lite；真对话引擎在 M1）
// 事件走既有 EventLog（type=chat），供浏览器气泡与回放展示

import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';

export interface SocialConfig {
  minProximityMinutes?: number; // 相邻累计多少游戏分钟触发（默认 3）
  cooldownMinutes?: number;     // 同一对触发后冷却（默认 90）
}

const GENERIC_GREETINGS = ['你好呀！', '今天天气真不错。', '最近忙什么呢？', '有阵子没见啦。'];

export class SocialTicker {
  private proximity = new Map<string, number>();
  private nextAt = new Map<string, number>();
  private triggerCount = new Map<string, number>();

  constructor(private log: EventLog, private cfg: SocialConfig = {}) {}

  /** 每 tick 调用一次；dt = 本次推进的游戏分钟数 */
  tick(agents: Agent[], dt: number, now: number): void {
    const min = this.cfg.minProximityMinutes ?? 3;
    const cooldown = this.cfg.cooldownMinutes ?? 90;
    for (let i = 0; i < agents.length; i++) {
      for (let j = i + 1; j < agents.length; j++) {
        const a = agents[i];
        const b = agents[j];
        const key = pairKey(a.id, b.id);
        if (chebyshev(a, b) <= 1) {
          this.proximity.set(key, (this.proximity.get(key) ?? 0) + dt);
        } else {
          this.proximity.set(key, 0);
          continue;
        }
        if (this.proximity.get(key)! >= min && now >= (this.nextAt.get(key) ?? 0)) {
          const count = this.triggerCount.get(key) ?? 0;
          const line = pickLine(a, count);
          this.log.addEvent(makeChatEvent(a, b, line, now));
          this.proximity.set(key, 0);
          this.nextAt.set(key, now + cooldown);
          this.triggerCount.set(key, count + 1);
        }
      }
    }
  }
}

function pairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

function chebyshev(a: Agent, b: Agent): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function pickLine(a: Agent, count: number): string {
  const pool = a.persona.greetingPool?.length ? a.persona.greetingPool : GENERIC_GREETINGS;
  return pool[count % pool.length];
}

function makeChatEvent(a: Agent, b: Agent, line: string, now: number): GameEvent {
  return {
    id: randomUUID(),
    type: 'chat',
    actorId: a.id,
    targetIds: [b.id],
    description: `「${a.name}」对「${b.name}」说：「${line}」`,
    location: a.locationId,
    gameTime: now,
    payload: { kind: 'chat', line, fromId: a.id, toId: b.id },
  };
}
```

- [ ] **Step 5: 修改 src/engine/seed.ts（4 个 persona 加台词池）**

在每个 persona 的 `routine` 数组之后、右括号之前各插入 `greetingPool`：

林晚晴：

```ts
  greetingPool: ['今天的咖啡特别香，要来一杯吗？', '你看起来气色不错。', '常来坐坐呀，小镇最近可热闹了。'],
```

陈默：

```ts
  greetingPool: ['最近在读什么书？', '……嗯，好久不见。', '书店到了批新书，有空来看看。'],
```

沈屿：

```ts
  greetingPool: ['今天的阳光是柠檬黄色的。', '我在画一张很特别的速写。', '要不要来公园看我的画？'],
```

周岚：

```ts
  greetingPool: ['有你的信吗？我帮你留意！', '早啊！今天也要加油。', '听说湖边傍晚特别好看。'],
```

- [ ] **Step 6: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/social.test.ts
pnpm test
pnpm typecheck
```

Expected: social.test 4 通过；全量通过（40 + 4 = 44）；typecheck 0 错。

- [ ] **Step 7: 提交**

```bash
git add src/engine/social.ts src/core/types.ts src/engine/seed.ts tests/social.test.ts
git commit -m "feat(engine): 相邻 NPC 打招呼闲聊 SocialTicker"
```

---

### Task 2: 世界快照序列化 snapshot.ts

**Files:**
- Create: `src/web/snapshot.ts`、`tests/snapshot.test.ts`

**Interfaces:**
- Produces：
  - `AgentView { id; name; occupation; state; x; y; locationId; locationName; verb; thought; targetName; spriteIndex; background }`
  - `ObjectView { id; name; type; x; y; w; h }`
  - `WorldSnapshot { clock: ClockState; speedPerRealSecond; paused; gridW; gridH; objects: ObjectView[]; agents: AgentView[]; seq }`
  - `buildSnapshot(world: WorldState, time: TimeEngine, paused: boolean, seq: number): WorldSnapshot`

- [ ] **Step 1: 写失败测试 tests/snapshot.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { buildSnapshot } from '../src/web/snapshot';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
];

function setup() {
  const agent = makeAgent({
    id: 'agent:1', name: '甲', x: 1, y: 2, locationId: 'obj:plaza',
    persona: persona({ occupation: '测试员', background: '喜欢测试。', name: '甲' }),
  });
  const world = new WorldState(OBJS, [agent]);
  const time = new TimeEngine(30); // speed = 60 游戏分钟/现实秒
  return { world, time, agent };
}

test('快照包含时钟/速度/网格/对象/agent 全字段', () => {
  const { world, time, agent } = setup();
  const snap = buildSnapshot(world, time, false, 7);
  assert.equal(snap.seq, 7);
  assert.equal(snap.paused, false);
  assert.equal(snap.speedPerRealSecond, 60);
  assert.equal(snap.gridW, 12);
  assert.equal(snap.gridH, 8);
  assert.equal(snap.clock.totalMinutes, 0);
  assert.equal(snap.objects.length, 2);
  assert.equal(snap.objects[0].type, 'town');
  assert.equal(snap.agents.length, 1);
  const v = snap.agents[0];
  assert.equal(v.id, agent.id);
  assert.equal(v.occupation, '测试员');
  assert.equal(v.background, '喜欢测试。');
  assert.equal(v.locationName, '中央广场');
  assert.equal(v.spriteIndex, 0);
  assert.equal(v.state, 'idle');
  assert.equal(v.verb, ''); // 无当前动作 → 空
  assert.equal(v.thought, null);
  assert.equal(v.targetName, null);
});

test('行动中快照携带 verb 与目标名；paused 透传', () => {
  const { world, time, agent } = setup();
  agent.action = { thought: '干活', action: { type: 'interact', target: 'obj:plaza', verb: '扫地' }, durationMinutes: 10 };
  agent.state = 'acting';
  agent.thought = '干活';
  const snap = buildSnapshot(world, time, true, 1);
  assert.equal(snap.paused, true);
  assert.equal(snap.agents[0].verb, '扫地');
  assert.equal(snap.agents[0].targetName, '中央广场');
  assert.equal(snap.agents[0].thought, '干活');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/snapshot.test.ts`
Expected: FAIL，报 `Cannot find module '../src/web/snapshot'`。

- [ ] **Step 3: 写 src/web/snapshot.ts**

```ts
// 世界快照序列化：把引擎状态转成浏览器可消费的纯 JSON

import { TimeEngine, type ClockState } from '../core/time';
import { GRID_W, GRID_H, type WorldState } from '../core/world';
import type { Agent, WorldObject } from '../core/types';

export interface AgentView {
  id: string;
  name: string;
  occupation: string;
  state: Agent['state'];
  x: number;
  y: number;
  locationId: string;
  locationName: string;
  verb: string;             // 当前动作动词；无动作时为空串
  thought: string | null;
  targetName: string | null; // 当前动作目标对象名
  spriteIndex: number;       // 客户端配色索引（0..3，按 allAgents 顺序）
  background: string;
}

export interface ObjectView {
  id: string;
  name: string;
  type: WorldObject['type'];
  x: number; y: number; w: number; h: number;
}

export interface WorldSnapshot {
  clock: ClockState;
  speedPerRealSecond: number; // 游戏分钟/现实秒 = gameMinutesPerTick × 2
  paused: boolean;
  gridW: number;
  gridH: number;
  objects: ObjectView[];
  agents: AgentView[];
  seq: number;
}

export function buildSnapshot(
  world: WorldState,
  time: TimeEngine,
  paused: boolean,
  seq: number
): WorldSnapshot {
  const agents: AgentView[] = world.allAgents().map((a, i) => {
    const action = a.action;
    const busy = a.state === 'acting' || a.state === 'moving';
    return {
      id: a.id,
      name: a.name,
      occupation: a.persona.occupation,
      state: a.state,
      x: a.x,
      y: a.y,
      locationId: a.locationId,
      locationName: world.getObject(a.locationId)?.name ?? a.locationId,
      verb: action && busy ? action.action.verb : '',
      thought: a.thought,
      targetName: action ? world.getObject(action.action.target)?.name ?? null : null,
      spriteIndex: i,
      background: a.persona.background,
    };
  });
  return {
    clock: time.state,
    speedPerRealSecond: time.gameMinutesPerTick * 2,
    paused,
    gridW: GRID_W,
    gridH: GRID_H,
    objects: world.allObjects().map((o) => ({
      id: o.id, name: o.name, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h,
    })),
    agents,
    seq,
  };
}
```

- [ ] **Step 4: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/snapshot.test.ts
pnpm test
pnpm typecheck
```

Expected: snapshot.test 2 通过；全量通过；typecheck 0 错。

- [ ] **Step 5: 提交**

```bash
git add src/web/snapshot.ts tests/snapshot.test.ts
git commit -m "feat(web): 世界快照序列化"
```

---

### Task 3: Web 服务器 server.ts（静态 + SSE + 控制 API）

**Files:**
- Create: `src/web/server.ts`、`tests/server.test.ts`

**Interfaces:**
- Produces：
  - `TownWebOptions { world; time; loop; log; publicDir?; snapshotMs?; port? }`（publicDir 默认 `<cwd>/public`；snapshotMs 默认 200；port 默认 0=随机端口）
  - `createTownServer(opts): Promise<TownWebServer>`，`TownWebServer { port: number; close(): Promise<void> }`（监听 127.0.0.1 随机端口）
  - 路由：`GET /`（index.html）、`GET /client.js|/style.css`（静态）、`GET /api/state`（快照 JSON）、`POST /api/world/control`（`{action:'pause'|'resume'|'speed', value?}`，speed.value = 游戏分钟/现实秒）、`GET /events`（SSE：连接即发一帧 `event: snapshot`，此后 200ms 一帧；新事件即时 `event: event`；15s 心跳注释）

- [ ] **Step 1: 写失败测试 tests/server.test.ts**

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
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { GameEvent, WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>fixture</body></html>');
  writeFileSync(join(dir, 'style.css'), 'body{}');
  writeFileSync(join(dir, 'client.js'), 'console.log(1)');
  return dir;
}

async function setup() {
  const dir = fixtureDir();
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agents = [
    makeAgent({ id: 'agent:1', name: '甲', x: 4, y: 3, locationId: 'obj:plaza', persona: persona({ name: '甲' }) }),
    makeAgent({ id: 'agent:2', name: '乙', x: 5, y: 3, locationId: 'obj:plaza', persona: persona({ name: '乙' }) }),
  ];
  const world = new WorldState(OBJS, agents);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 30 });
  return { dir, db, log, world, time, loop, server, base: `http://127.0.0.1:${server.port}` };
}

test('静态页与快照接口', async () => {
  const { server, base, world } = await setup();
  try {
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('fixture'));
    const js = await fetch(`${base}/client.js`);
    assert.equal(js.status, 200);
    const snap = (await (await fetch(`${base}/api/state`)).json()) as { agents: unknown[]; clock: { day: number }; seq: number };
    assert.equal(snap.agents.length, 2);
    assert.equal(snap.clock.day, 1);
    assert.equal(typeof snap.seq, 'number');
    assert.equal(world.allAgents().length, 2);
  } finally {
    await server.close();
  }
});

test('控制接口：调速与暂停', async () => {
  const { server, base, time } = await setup();
  try {
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 120 }),
    });
    assert.equal(time.gameMinutesPerTick, 60);
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    const snap = (await (await fetch(`${base}/api/state`)).json()) as { paused: boolean };
    assert.equal(snap.paused, true);
  } finally {
    await server.close();
  }
});

test('SSE：首帧快照 + 事件即时推送', async () => {
  const { server, base, log, world } = await setup();
  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const waitFor = async (marker: string): Promise<void> => {
      while (!buf.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE 流提前结束');
        buf += decoder.decode(value, { stream: true });
      }
    };
    await waitFor('event: snapshot');
    const e: GameEvent = {
      id: 'e1', type: 'system', actorId: null, targetIds: [], description: '测试事件',
      location: null, gameTime: 1, payload: { kind: 'day_start' },
    };
    log.addEvent(e);
    await waitFor('event: event');
    assert.ok(buf.includes('测试事件'));
    clearTimeout(timeout);
    reader.releaseLock();
    void res.body?.cancel();
    assert.equal(world.allAgents().length, 2);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/server.test.ts`
Expected: FAIL，报 `Cannot find module '../src/web/server'`。

- [ ] **Step 3: 写 src/web/server.ts**

```ts
// 像素小镇本地 Web 服务：静态页面 + 快照/事件 SSE + 世界控制（零新增依赖，node:http）

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TimeEngine } from '../core/time';
import type { WorldState } from '../core/world';
import type { WorldLoop } from '../engine/loop';
import type { EventLog } from '../store/events';
import type { GameEvent } from '../core/types';
import { buildSnapshot, type WorldSnapshot } from './snapshot';

export interface TownWebOptions {
  world: WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  publicDir?: string;   // 默认 <cwd>/public
  snapshotMs?: number;  // 默认 200
  port?: number;        // 默认 0 = 系统随机端口
}

export interface TownWebServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function createTownServer(opts: TownWebOptions): Promise<TownWebServer> {
  const publicDir = opts.publicDir ?? resolve(process.cwd(), 'public');
  const snapshotMs = opts.snapshotMs ?? 200;
  const { world, time, loop, log } = opts;
  const clients = new Set<ServerResponse>();
  let seq = 0;
  let paused = false;

  function currentSnapshot(): WorldSnapshot {
    return buildSnapshot(world, time, paused, ++seq);
  }
  function send(res: ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event: string, data: unknown): void {
    for (const c of clients) send(c, event, data);
  }
  log.subscribe((e: GameEvent) => broadcast('event', e));

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        send(res, 'snapshot', currentSnapshot());
        req.on('close', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(currentSnapshot()));
        return;
      }
      if (url.pathname === '/api/world/control' && req.method === 'POST') {
        const body = (await readBody(req)) as { action?: string; value?: number };
        if (body.action === 'pause') {
          paused = true;
          loop.stop();
        } else if (body.action === 'resume') {
          paused = false;
          loop.start();
        } else if (body.action === 'speed' && typeof body.value === 'number' && body.value > 0) {
          time.gameMinutesPerTick = body.value * 0.5;
          if (!paused) {
            loop.stop();
            loop.start();
          }
        } else {
          res.writeHead(400);
          res.end('bad control');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/') return await file(res, resolve(publicDir, 'index.html'));
      if (url.pathname === '/client.js' || url.pathname === '/style.css') {
        return await file(res, resolve(publicDir, url.pathname.slice(1)));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  async function file(res: ServerResponse, path: string): Promise<void> {
    const content = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  }
  async function readBody(req: IncomingMessage): Promise<unknown> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const interval = setInterval(() => broadcast('snapshot', currentSnapshot()), snapshotMs);
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 15_000);

  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        loop.stop(); // 服务停止时一并停掉世界循环（调速/恢复可能由本服务启动过 loop）
        clearInterval(interval);
        clearInterval(heartbeat);
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
```

- [ ] **Step 4: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/server.test.ts
pnpm test
pnpm typecheck
```

Expected: server.test 3 通过；全量通过；typecheck 0 错。

- [ ] **Step 5: 提交**

```bash
git add src/web/server.ts tests/server.test.ts
git commit -m "feat(web): 本地 Web 服务（静态 + SSE + 控制 API）"
```

---

### Task 4: 引擎集成 + town-web CLI + 构建脚本

**Files:**
- Modify: `src/engine/loop.ts`（构造器可选第 7 参 social，step 内 tick）、`src/core/state-machine.ts`（thoughtEvent payload 加 thought 字段）、`package.json`（scripts + esbuild devDependency）、`.gitignore`（public/client.js）
- Create: `src/cli/town-web.ts`、`tests/cli-web.test.ts`、`tests/loop-social.test.ts`

**Interfaces:**
- Consumes: Task 1~3 全部产物
- Produces：
  - `new WorldLoop(time, world, executor, log, db, hooks?, social?)`
  - `parseArgs(argv)`（town-web.ts 导出；--speed 默认 1、--port 默认 8787、--db 默认 data/town.sqlite）
  - `pnpm town-web`：构建客户端 → 起世界循环（mock 默认，`LLM_PROVIDER=deepseek` 切真机）→ 打印 `http://127.0.0.1:<port>` → 实时运行，Ctrl+C 退出
  - `pnpm build:web`：esbuild 打包 `src/web/client/main.ts` → `public/client.js`（iife、target chrome100）

- [ ] **Step 1: 写失败测试 tests/loop-social.test.ts 与 tests/cli-web.test.ts**

`tests/loop-social.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { SocialTicker } from '../src/engine/social';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('WorldLoop 集成 SocialTicker：相邻 agent 跑出 chat 事件', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:2', name: '乙', x: 0, y: 1, persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [a, b]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const social = new SocialTicker(log);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social);
  await loop.runUntil(20);
  assert.ok(log.eventsForDay(1).some((e) => e.type === 'chat'), '应产生 chat 事件');
});

test('thought 事件 payload 携带 thought 文本', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const world = new WorldState(OBJS, [a]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const loop = new WorldLoop(time, world, executor, log, db);
  await loop.runUntil(15);
  const thought = log.eventsForDay(1).find((e) => e.payload?.kind === 'thought');
  assert.ok(thought);
  assert.equal(typeof thought.payload?.thought, 'string');
});
```

`tests/cli-web.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const NODE = process.execPath;

async function waitForState(port: number, timeoutMs: number): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      if (res.ok) return await res.json();
    } catch {
      /* 未就绪，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('town-web 启动超时');
}

test('town-web 启动后可访问快照接口', async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(
    NODE,
    ['--no-warnings', '--import', 'tsx', 'src/cli/town-web.ts', '--port', String(port), '--db', ':memory:'],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let out = '';
  child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    const snap = (await waitForState(port, 15_000)) as { agents: unknown[] };
    assert.equal(snap.agents.length, 4);
    assert.ok(out.includes('浏览器打开'));
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
  }
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/loop-social.test.ts tests/cli-web.test.ts`
Expected: 两个文件 FAIL（loop.ts 无 social 参数报类型错 / `Cannot find module '../src/cli/town-web'`）。

- [ ] **Step 3: 修改 src/engine/loop.ts（集成 social）**

构造器签名改为：

```ts
  constructor(
    public time: TimeEngine,
    public world: WorldState,
    private executor: AgentExecutor,
    private log: EventLog,
    private db: DbHandle,
    private hooks: LoopHooks = {},
    private social?: SocialTicker
  ) {
```

文件顶部 import 增加：`import type { SocialTicker } from './social';`

`step()` 中 agent 循环之后、跨天判断之前插入：

```ts
    this.social?.tick(this.world.allAgents(), dt, clock.totalMinutes);
```

- [ ] **Step 4: 修改 src/core/state-machine.ts（thought payload 携带文本）**

`thoughtEvent` 的 payload 行改为：

```ts
      payload: { kind: 'thought', thought: d.thought },
```

- [ ] **Step 5: 修改 package.json（scripts + esbuild）与 .gitignore**

`package.json` 的 scripts 中新增：

```json
    "build:web": "esbuild src/web/client/main.ts --bundle --format=iife --target=chrome100 --outfile=public/client.js",
    "town-web": "pnpm build:web && node --no-warnings --import tsx src/cli/town-web.ts"
```

devDependencies 增加：`"esbuild": "^0.28.0"`。

`.gitignore` 增加一行：`public/client.js`。

然后执行 `pnpm install` 使锁文件同步。

- [ ] **Step 6: 写 src/cli/town-web.ts**

```ts
// 像素小镇 Web 版：世界循环 + 本地网页服务（浏览器可视化，mock 默认离线）

import { resolve } from 'node:path';
import { TimeEngine } from '../core/time';
import { buildTown } from '../engine/seed';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { LLMGateway } from '../llm/gateway';
import { AgentExecutor } from '../core/state-machine';
import { WorldLoop } from '../engine/loop';
import { SocialTicker } from '../engine/social';
import { createTownServer } from '../web/server';

export interface TownWebArgs {
  speed: number; // 游戏分钟/现实秒（默认 1 = 60x）
  port: number;
  dbPath: string;
}

export function parseArgs(argv: string[]): TownWebArgs {
  const args: TownWebArgs = { speed: 1, port: 8787, dbPath: resolve(process.cwd(), 'data/town.sqlite') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--speed') args.speed = Number(argv[++i]);
    else if (argv[i] === '--port') args.port = Number(argv[++i]);
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const gateway = new LLMGateway({
    provider,
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY ?? '' },
    retries: 2,
  });
  const db = openDb(args.dbPath);
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(args.speed * 0.5);
  const executor = new AgentExecutor(gateway, world, log);
  const social = new SocialTicker(log);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social);
  const server = await createTownServer({ world, time, loop, log, port: args.port });
  console.log(`[multiagent-town 像素小镇] provider=${provider} speed=${args.speed}游戏分钟/现实秒 db=${args.dbPath}`);
  console.log(`浏览器打开：http://127.0.0.1:${server.port} （按 Ctrl+C 停止）`);
  loop.start();
  process.on('SIGINT', () => {
    loop.stop();
    void server.close().then(() => process.exit(0));
  });
}

void main();
```

- [ ] **Step 7: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/loop-social.test.ts tests/cli-web.test.ts
pnpm test
pnpm typecheck
```

Expected: loop-social 2 通过、cli-web 1 通过；全量通过；typecheck 0 错。

- [ ] **Step 8: 提交**

```bash
git add src/engine/loop.ts src/core/state-machine.ts src/cli/town-web.ts package.json pnpm-lock.yaml .gitignore tests/loop-social.test.ts tests/cli-web.test.ts
git commit -m "feat(web): town-web CLI、社交集成与客户端构建脚本"
```

---

### Task 5: 浏览器像素客户端（页面/地图/精灵/气泡/面板）

**Files:**
- Create: `public/index.html`、`public/style.css`、`src/web/client/main.ts`

**Interfaces:**
- Consumes: `/api/state` 快照、`/events` SSE（snapshot/event）、`POST /api/world/control`
- Produces: 浏览器像素小镇页面（canvas 12×8 瓦片 × 32px、CSS 2x 像素化；4 套 NPC 配色与走路 2 帧；快照插值平滑移动；💭/💬 气泡 7 秒；时钟 + 暂停/1x/60x/360x + 事件滚动条 + 点击 NPC 状态面板）
- 客户端为浏览器 TS，无单元测试（由 tsc 类型检查 + esbuild 构建 + Task 6 e2e 覆盖）；本任务验证 = 构建成功 + 服务器可服务 + 页面含 canvas
- 前置：`tsconfig.json` 的 `lib` 为 `["ES2023", "DOM"]`（客户端需要 DOM 全局类型；skipLibCheck 已开，与 node 类型共存无冲突）

- [ ] **Step 1: 写 public/index.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>multiagent-town 像素小镇</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div id="hud">
    <div id="clock">第1天 00:00</div>
    <div id="controls">
      <button data-action="pause">⏸ 暂停</button>
      <button data-action="speed" data-value="1">▶ 1x</button>
      <button data-action="speed" data-value="60">▶ 60x</button>
      <button data-action="speed" data-value="360">▶ 360x</button>
    </div>
  </div>
  <main>
    <canvas id="game" width="384" height="256"></canvas>
    <aside id="side">
      <div id="panel"><p id="panel-empty">点击小镇里的角色查看详情</p></div>
    </aside>
  </main>
  <div id="ticker"><p id="ticker-empty">事件流：等待小镇苏醒……</p></div>
  <script src="/client.js"></script>
</body>
</html>
```

- [ ] **Step 2: 写 public/style.css**

```css
* { box-sizing: border-box; }
body {
  margin: 0; background: #1c2430; color: #e8e2d4;
  font-family: "Microsoft YaHei", "PingFang SC", monospace;
  display: flex; flex-direction: column; height: 100vh;
}
#hud { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; background: #141a22; }
#clock { font-size: 18px; font-weight: bold; letter-spacing: 1px; }
#controls button {
  margin-left: 6px; padding: 4px 12px; border: 1px solid #3a4657; border-radius: 4px;
  background: #2a3547; color: #e8e2d4; cursor: pointer; font-size: 14px;
}
#controls button:hover { background: #3b4a63; }
main { flex: 1; display: flex; gap: 12px; padding: 12px; min-height: 0; }
canvas {
  image-rendering: pixelated;
  width: 768px; height: 512px; max-width: 72vw; max-height: 100%;
  border: 2px solid #3a4657; border-radius: 6px; background: #7fb069;
}
#side { width: 240px; background: #141a22; border: 2px solid #3a4657; border-radius: 6px; padding: 12px; overflow-y: auto; }
#panel p { margin: 6px 0; line-height: 1.5; }
#panel h3 { margin: 2px 0 10px; }
#panel .label { color: #9fb0c6; font-size: 12px; }
#ticker {
  padding: 8px 14px; background: #141a22; border-top: 2px solid #3a4657;
  font-size: 13px; max-height: 92px; overflow-y: auto;
}
#ticker p { margin: 3px 0; }
```

- [ ] **Step 3: 写 src/web/client/main.ts（完整客户端）**

```ts
// 像素小镇浏览器客户端：Canvas 2D 像素渲染，零依赖，SSE 实时刷新

interface AgentView {
  id: string; name: string; occupation: string; state: string;
  x: number; y: number; locationId: string; locationName: string;
  verb: string; thought: string | null; targetName: string | null;
  spriteIndex: number; background: string;
}
interface ObjectView { id: string; name: string; type: string; x: number; y: number; w: number; h: number }
interface ClockState { day: number; minutesOfDay: number; totalMinutes: number }
interface WorldSnapshot {
  clock: ClockState; speedPerRealSecond: number; paused: boolean;
  gridW: number; gridH: number; objects: ObjectView[]; agents: AgentView[]; seq: number;
}
interface TownEvent {
  type: string; actorId: string | null; description: string;
  payload: { kind?: string; line?: string; thought?: string; fromId?: string } | null;
}

const TILE = 32;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
let snap: WorldSnapshot | null = null;
let selectedId: string | null = null;

interface Display { x: number; y: number; tx: number; ty: number; lastTileX: number; lastTileY: number; moving: boolean }
const display = new Map<string, Display>();
const bubbles = new Map<string, { text: string; kind: string; until: number }>();
const ticker: string[] = [];

const PALETTES = [
  { hair: '#5b3a29', skin: '#f2c99c', top: '#d97757', bottom: '#6b4f6b', accent: '#f7e8d0' }, // 林晚晴·围裙
  { hair: '#2f2f2f', skin: '#e8c39a', top: '#4a6fa5', bottom: '#3a3a3a', accent: '#9fb8d8' }, // 陈默·眼镜
  { hair: '#7a4a2b', skin: '#f5d0a8', top: '#8a2f2f', bottom: '#5a4a3a', accent: '#c9a66b' }, // 沈屿·贝雷帽
  { hair: '#1f1f1f', skin: '#f2c99c', top: '#b33b3b', bottom: '#4a4a4a', accent: '#2f6b2f' }, // 周岚·邮差帽
];
const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

async function main(): Promise<void> {
  snap = (await (await fetch('/api/state')).json()) as WorldSnapshot;
  initCanvas();
  for (const a of snap.agents) initDisplay(a);
  canvas.addEventListener('click', onClick);
  bindControls();
  const es = new EventSource('/events');
  es.addEventListener('snapshot', (ev) => {
    snap = JSON.parse((ev as MessageEvent<string>).data) as WorldSnapshot;
    applySnapshot();
  });
  es.addEventListener('event', (ev) => onEvent(JSON.parse((ev as MessageEvent<string>).data) as TownEvent));
  updateHud();
  requestAnimationFrame(loop);
}

function initCanvas(): void {
  if (!snap) return;
  canvas.width = snap.gridW * TILE;
  canvas.height = snap.gridH * TILE;
}
function initDisplay(a: AgentView): void {
  display.set(a.id, { x: a.x * TILE, y: a.y * TILE, tx: a.x * TILE, ty: a.y * TILE, lastTileX: a.x, lastTileY: a.y, moving: false });
}
function applySnapshot(): void {
  if (!snap) return;
  for (const a of snap.agents) {
    let d = display.get(a.id);
    if (!d) {
      initDisplay(a);
      d = display.get(a.id)!;
    }
    if (a.x !== d.lastTileX || a.y !== d.lastTileY) {
      d.tx = a.x * TILE;
      d.ty = a.y * TILE;
      d.moving = true;
      d.lastTileX = a.x;
      d.lastTileY = a.y;
    } else {
      d.moving = false;
    }
  }
  updateHud();
}

function onEvent(e: TownEvent): void {
  ticker.unshift(e.description);
  if (ticker.length > 5) ticker.pop();
  updateTicker();
  const kind = e.payload?.kind;
  const fromId = e.payload?.fromId ?? e.actorId;
  if ((kind === 'thought' || kind === 'chat') && fromId) {
    const text = kind === 'chat' ? (e.payload?.line ?? '') : (e.payload?.thought ?? '');
    bubbles.set(fromId, { text, kind, until: performance.now() + 7000 });
  }
}

function updateTicker(): void {
  const box = document.getElementById('ticker')!;
  box.innerHTML = ticker.map((t) => `<p>${escapeHtml(t)}</p>`).join('') || '<p>事件流：等待小镇苏醒……</p>';
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bindControls(): void {
  document.querySelectorAll('#controls button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.getAttribute('data-action')!;
      const value = btn.getAttribute('data-value');
      void fetch('/api/world/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value ? { action, value: Number(value) } : { action }),
      });
    });
  });
}

function onClick(ev: MouseEvent): void {
  if (!snap) return;
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
  const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
  const tx = Math.floor(px / TILE);
  const ty = Math.floor(py / TILE);
  selectedId = snap.agents.find((a) => Math.abs(a.x - tx) <= 0.5 && Math.abs(a.y - ty) <= 0.5)?.id ?? null;
  updatePanel();
}

function updatePanel(): void {
  const panel = document.getElementById('panel')!;
  const a = snap?.agents.find((x) => x.id === selectedId);
  if (!a) {
    panel.innerHTML = '<p id="panel-empty">点击小镇里的角色查看详情</p>';
    return;
  }
  const stateName: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
  panel.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${stateName[a.state] ?? a.state}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>`;
}

function updateHud(): void {
  if (!snap) return;
  const c = snap.clock;
  const hh = String(Math.floor(c.minutesOfDay / 60)).padStart(2, '0');
  const mm = String(c.minutesOfDay % 60).padStart(2, '0');
  const paused = snap.paused ? ' ⏸ 已暂停' : '';
  document.getElementById('clock')!.textContent = `第${c.day}天 ${hh}:${mm}${paused}`;
}

function loop(): void {
  const now = performance.now();
  for (const d of display.values()) {
    d.x += (d.tx - d.x) * 0.25;
    d.y += (d.ty - d.y) * 0.25;
    if (Math.abs(d.tx - d.x) < 0.4 && Math.abs(d.ty - d.y) < 0.4) {
      d.x = d.tx;
      d.y = d.ty;
    }
  }
  for (const [id, b] of bubbles) {
    if (now > b.until) bubbles.delete(id);
  }
  draw();
  requestAnimationFrame(loop);
}

function draw(): void {
  if (!snap) return;
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawObjects();
  drawAgents();
  drawBubbles();
}

function drawObjects(): void {
  const order: Record<string, number> = { zone: 0, building: 1, room: 2, furniture: 2 };
  const objs = snap!.objects
    .filter((o) => o.type !== 'town')
    .sort((a, b) => (order[a.type] ?? 0) - (order[b.type] ?? 0));
  for (const o of objs) {
    const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
    if (o.type === 'zone') {
      if (o.id === 'obj:park') drawPark(px, py, pw, ph);
      else drawPlaza(px, py, pw, ph);
    } else if (o.type === 'building') {
      drawBuilding(o, px, py, pw, ph);
    } else if (o.type === 'room') {
      ctx.fillStyle = '#d9b48f';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#a97c50';
      ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    } else {
      ctx.fillStyle = '#8a6f4d';
      ctx.fillRect(px + 4, py + 4, pw - 8, ph - 8);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '11px monospace';
    ctx.fillText(o.name, px + 3, py + 13);
  }
}

function drawPark(px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#6aa84f';
  ctx.fillRect(px, py, pw, ph);
  for (const [tx, ty] of [[px + 8, py + 8], [px + pw - 14, py + ph - 14]]) {
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(tx, ty, 6, 14);
    ctx.fillStyle = '#2f7a3a';
    ctx.fillRect(tx - 6, ty - 8, 18, 12);
  }
}

function drawPlaza(px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#c9b79c';
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeStyle = '#a3937a';
  for (let x = px + 8; x < px + pw; x += 16) {
    for (let y = py + 8; y < py + ph; y += 16) {
      ctx.strokeRect(x, y, 16, 16);
    }
  }
  ctx.fillStyle = '#6b9bd1';
  ctx.fillRect(px + pw / 2 - 8, py + ph / 2 - 8, 16, 16);
}

function drawBuilding(o: ObjectView, px: number, py: number, pw: number, ph: number): void {
  ctx.fillStyle = '#e8d5b7';
  ctx.fillRect(px, py, pw, ph);
  const roof = ROOFS[hash(o.id) % ROOFS.length];
  ctx.fillStyle = roof;
  ctx.fillRect(px, py, pw, 8);
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(px + pw / 2 - 5, py + ph - 12, 10, 12);
  if (o.id === 'obj:post_office') {
    ctx.fillStyle = '#e3b23c';
    ctx.fillRect(px + pw - 14, py + 4, 10, 10);
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function drawAgents(): void {
  const sorted = [...snap!.agents].sort((a, b) => a.y - b.y);
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const frame = d.moving ? Math.floor(performance.now() / 300) % 2 : 0;
    drawSprite(d.x + TILE / 2, d.y + TILE / 2, a.spriteIndex, frame, d.moving, a.state === 'thinking', a.id === selectedId, a.name);
  }
}

function drawSprite(cx: number, cy: number, index: number, frame: number, moving: boolean, thinking: boolean, selected: boolean, name: string): void {
  const p = PALETTES[index % PALETTES.length];
  const x = Math.round(cx);
  const y = Math.round(cy) + (moving ? Math.round(Math.sin(performance.now() / 120)) : 0);
  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, cy + 6, 5, 2, 0, 0, Math.PI * 2);
  ctx.fill();
  // 腿
  ctx.fillStyle = p.bottom;
  if (frame === 0) {
    ctx.fillRect(x - 4, y - 4, 3, 5);
    ctx.fillRect(x + 1, y - 4, 3, 5);
  } else {
    ctx.fillRect(x - 5, y - 4, 3, 4);
    ctx.fillRect(x + 2, y - 4, 3, 5);
  }
  // 身体
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 4, y - 9, 8, 6);
  if (index === 0) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 2, y - 9, 4, 6);
  }
  if (index === 3) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 4, y - 9, 8, 2);
  }
  // 头
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 3, y - 16, 6, 6);
  // 头发
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 3, y - 18, 6, 3);
  if (index === 2) {
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 4, y - 19, 8, 2);
  }
  if (index === 3) {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 4, y - 18, 8, 2);
  }
  // 眼镜（陈默）
  if (index === 1) {
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 3, y - 14, 2, 2);
    ctx.fillRect(x + 1, y - 14, 2, 2);
  }
  if (thinking) {
    ctx.fillStyle = '#ffe9a8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('…', x - 7, y - 22);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = '10px monospace';
  ctx.fillText(name, x - ctx.measureText(name).width / 2, y + 13);
  if (selected) {
    ctx.strokeStyle = '#ffd700';
    ctx.strokeRect(x - 6, y - 21, 12, 29);
  }
}

function drawBubbles(): void {
  const now = performance.now();
  for (const [id, b] of bubbles) {
    if (now > b.until) {
      bubbles.delete(id);
      continue;
    }
    const d = display.get(id);
    if (!d) continue;
    const lines = wrap(b.text, 14);
    const w = Math.max(...lines.map((l) => l.length)) * 12 + 14;
    const h = lines.length * 14 + 12;
    const bx = d.x + TILE / 2 - w / 2;
    const by = d.y - 40 - h;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#333333';
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#222222';
    ctx.font = '12px monospace';
    lines.forEach((l, i) => {
      ctx.fillText((b.kind === 'chat' ? '💬' : '💭') + l, bx + 7, by + 16 + i * 14);
    });
  }
}

function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [''];
}

void main();
```

- [ ] **Step 4: 构建 + 类型检查 + 服务冒烟**

```bash
pnpm install
pnpm build:web
pnpm typecheck
ls -la public/client.js
node --no-warnings --import tsx src/cli/town-web.ts --port 8791 --db :memory: &
sleep 3
curl -s http://127.0.0.1:8791/ | grep -o 'id="game"'
curl -s http://127.0.0.1:8791/client.js | head -c 80
kill %1
```

Expected：构建产物 public/client.js 存在；typecheck 0 错；`/` 含 `id="game"`；`/client.js` 返回打包后代码。

- [ ] **Step 5: 提交**

```bash
git add public/index.html public/style.css src/web/client/main.ts
git commit -m "feat(web): 像素小镇浏览器客户端（地图/精灵/气泡/面板）"
```

---

### Task 6: e2e 验收 + README + 终审

**Files:**
- Create: `tests/acceptance-web.test.ts`
- Modify: `README.md`（运行说明加 town-web）

**Interfaces:**
- Consumes: Task 1~5 全部产物

- [ ] **Step 1: 写 tests/acceptance-web.test.ts**

```ts
// 像素小镇 e2e 验收：快照推进、NPC 闲聊、调速生效、SSE 推送

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { buildTown } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { SocialTicker } from '../src/engine/social';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { createTownServer } from '../src/web/server';

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-e2e-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html lang="zh-CN"><body>e2e</body></html>');
  return dir;
}

test('像素小镇 e2e：一天内快照推进 + NPC 闲聊 + 调速 + SSE', async () => {
  const dir = fixtureDir();
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x 虚拟时钟
  const gateway = new LLMGateway({ provider: 'mock' });
  const executor = new AgentExecutor(gateway, world, log);
  const social = new SocialTicker(log);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social);
  const server = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 40 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    assert.ok((await (await fetch(`${base}/`)).text()).includes('e2e'));

    // SSE 首帧
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 8000);
    const sse = await fetch(`${base}/events`, { signal: ac.signal });
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    while (!sseBuf.includes('event: snapshot')) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });
    }
    clearTimeout(timeout);
    assert.ok(sseBuf.includes('event: snapshot'));
    await reader.cancel(); // 流已被 getReader 锁定，用 reader.cancel 释放

    // 跑满 1 游戏日（服务端快照推送并行运行）
    await loop.runUntil(1440);

    const snap = (await (await fetch(`${base}/api/state`)).json()) as {
      clock: { day: number };
      agents: { id: string; name: string }[];
    };
    assert.equal(snap.clock.day, 2);
    assert.equal(snap.agents.length, 4);

    // 4 个 agent 一整天里至少发生一次 NPC 闲聊
    const chats = log.eventsForDay(1).filter((e) => e.type === 'chat');
    assert.ok(chats.length >= 1, `闲聊事件应为 ≥1，实际 ${chats.length}`);
    assert.match(chats[0].description, /对「.+」说：「.+」/);

    // 调速生效
    await fetch(`${base}/api/world/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 360 }),
    });
    assert.equal(time.gameMinutesPerTick, 180);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
```

- [ ] **Step 2: 运行验收**

```bash
pnpm acceptance
```

（`package.json` 的 acceptance 脚本保持不变：`node --no-warnings --import tsx --test tests/acceptance.test.ts`。本文件用单独命令跑：`node --no-warnings --import tsx --test tests/acceptance-web.test.ts`，或先 `pnpm build:web` 后跑全量 `pnpm test`。）

Expected: acceptance-web 1 通过。若失败按断言修被测代码，不放宽断言。

- [ ] **Step 3: 更新 README.md**

在「运行（M0）」代码块中追加：

```markdown
pnpm town-web                    # 像素小镇浏览器版（默认 mock，自动打开 http://127.0.0.1:8787）
```

并加一行说明：

```markdown
> 像素小镇：浏览器里看 4 个像素 NPC 在小镇地图上活动、闲聊冒泡；可暂停/调速，点击角色看状态面板。真机：`LLM_PROVIDER=deepseek DEEPSEEK_API_KEY=sk-xxx pnpm town-web`。
```

- [ ] **Step 4: 全量验证**

```bash
pnpm build:web
pnpm test
pnpm typecheck
git status
```

Expected: 全量测试通过（含 acceptance-web）；typecheck 0 错；工作区干净（public/client.js 被 gitignore）。

- [ ] **Step 5: 提交**

```bash
git add tests/acceptance-web.test.ts README.md
git commit -m "test: 像素小镇 e2e 验收与文档"
```

---

## 自检记录（写完后已核对）

- **Spec 覆盖**：§9 前端呈现的轻量先行版（地图/气泡/面板/时间控制条全部落地；Phaser 正式版留 M2）；闲聊机制为 M3 信息传播的雏形，事件走既有 EventLog 与 chat 枚举；REST 控制接口对应 §8.1 `POST /api/world/control`。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`buildSnapshot` 字段与客户端 `WorldSnapshot` 接口一致（clock/gridW/gridH/objects/agents/speedPerRealSecond/paused/seq）；`SocialTicker.tick(agents, dt, now)` 与 loop.step 的调用一致；chat 事件 payload（kind/line/fromId/toId）与客户端 onEvent 解析一致；thought payload 的 `thought` 字段在 Task 4 补上并与客户端一致。
- **边界推演**：e2e 中周岚(11:00-12:00 咖啡馆)与林晚晴(09:00-11:30 吧台)、周岚(15:00-16:00 书店)与陈默(全天书店) 的相邻时间 ≥60 游戏分钟 >> 触发阈值 3，闲聊事件必然出现；快照 40ms 推送与 runUntil 单线程交错安全（Node 事件循环）。
- **已知简化（有意为之）**：NPC 精灵为程序绘制（无美术资源）；移动为快照间线性插值；气泡 7 秒自动消失；闲聊为单句台词非多轮对话（M1 对话引擎替换）。
