# M2 空间呈现 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 M2 空间呈现（保留 Canvas 像素引擎，按用户画风反馈升级）：A* 寻路绕建筑墙 + 到门排队让行、玩家扮演（自然语言指令驱动任意 agent）、小镇广播（全员记忆传播）、32×32 精细像素精灵（四方向行走动画/服装细节/待机微动）、地图细节（湖水波光/石板路/门窗招牌/树木花草/昼夜色调）、精致交互（悬停提示/建筑卡片/对话条/广播横幅/扮演 UI）。验收：寻路绕墙正确、玩家指令可执行、广播全员知晓（e2e 自动化）+ 浏览器可视运行。

**Architecture:** 引擎侧新增 src/core/pathfinding.ts（A*，曼哈顿启发；墙 = 建筑边界除门外，室内可通行，经门进出）、src/engine/player.ts（PlayerDirector，指令 60 游戏分钟有效）；WorldState 增加 walkable/neighbors/findPath（替代 manhattanPath）；AgentExecutor 换用 A*（不可达降级 idle）+ 步进让行 + 玩家指令注入决策（提示词最高优先级行 + mock 按指令中对象名匹配动作）。Web 侧新增 POST/DELETE /api/player/:id/act 与 POST /api/broadcast（广播事件 targetIds=全员 → MemoryWriter 自然写入全员记忆，importance 由内容决定）。客户端拆分为 sprites.ts（32×32 四方向精灵）/ render.ts（地图细节与昼夜着色）/ main.ts（状态机、插值、交互 UI）。

**Tech Stack:** 既有 TS strict + node:http/SSE + Canvas 2D + esbuild。零新增依赖。

**Spec:** `docs/ai-town-design.md` §9（Phaser 正式版留后续；本计划按用户批准继续 Canvas 引擎 + 画风升级）+ §5.1（碰撞与排队）+ §8.1（玩家行动 POST /api/player/:agentId/act）。用户批准的偏离：① 保留 Canvas 而非迁移 Phaser；② 广播机制为 M3 信息传播的先行版（事件 targetIds=全员 + 记忆打分入库）。

## Global Constraints

- TypeScript `strict: true`；全部新增代码注释与用户可见文案一律中文
- 零新增依赖；LLM 全异步不阻塞 tick
- 墙 = 建筑边界瓦片（除门）；门 = 建筑底边中点；室内可通行；不可达 → 降级 idle + 中文 thought
- 排队让行：下一格被 moving/acting 的他人占用则本 tick 等待（idle 者不阻塞）
- 玩家指令 60 游戏分钟内有效；注入决策提示词为最高优先级；mock 按「指令包含对象名」匹配目标
- 广播：POST /api/broadcast {text} → 事件 type=broadcast、targetIds=全员 agent → MemoryWriter 全员记忆（importance 按 mockImportance）
- 客户端：精灵 32×32、四方向（上/下/左/右）2 帧行走 + 待机微动；昼夜三档着色（清晨/黄昏/夜晚）
- M1 既有 80 测试不破坏（world.findPath 替代 manhattanPath 时同步更新相关测试）
- 实现全部在 `m2-presentation` 分支

---

### Task 1: A* 寻路与碰撞（引擎侧）

**Files:**
- Create: `src/core/pathfinding.ts`、`tests/pathfinding.test.ts`
- Modify: `src/core/world.ts`（walkable/neighbors/findPath/门墙计算，移除 manhattanPath）、`src/engine/seed.ts`（新增 obj:lake 装饰湖泊）、`tests/world.test.ts`（manhattanPath 用例改为 findPath 用例）

**Interfaces:**
- Produces：
  - `findPath(world: WorldState, from: Tile, to: Tile): Tile[] | null`（A*，4 方向，曼哈顿启发；目标不可达返回 null；路径含起点终点）
  - `world.walkable(x, y): boolean`（越界/建筑边界（除门）为 false）
  - `world.neighbors(t): Tile[]`、`world.findPath(from, to)`
  - `TOWN_OBJECTS` 新增 `{ id: 'obj:lake', name: '湖边', type: 'zone', parentId: 'obj:town', x: 8, y: 7, w: 3, h: 1 }`（装饰水体，无 routine 引用）

- [ ] **Step 1: 写失败测试 tests/pathfinding.test.ts**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldState } from '../src/core/world';
import type { WorldObject } from '../src/core/types';

// 咖啡馆 (2,1,2,2)：边界 x∈{2,3},y∈{1,2} 除门 (3,2)；室内 (2,1) 可通行
const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:cafe', name: '咖啡馆', type: 'building', parentId: 'obj:town', x: 2, y: 1, w: 2, h: 2 },
  { id: 'obj:cafe_counter', name: '吧台', type: 'room', parentId: 'obj:cafe', x: 2, y: 1, w: 1, h: 1 },
];

const world = () => new WorldState(OBJS, []);

test('walkable：房间开口可通行、门开口、其余边界被挡', () => {
  const w = world();
  assert.equal(w.walkable(2, 1), true);  // 吧台（房间瓦片开口）
  assert.equal(w.walkable(3, 2), true);  // 门（底边中点）
  assert.equal(w.walkable(3, 1), false); // 顶边（非门非房间）
  assert.equal(w.walkable(2, 2), false); // 底边（非门）
  assert.equal(w.walkable(2, 0), true);  // 咖啡馆外草地
  assert.equal(w.walkable(-1, 0), false); // 越界
});

test('findPath 从馆外进吧台：路径全可通行、逐格相邻', () => {
  const w = world();
  const path = w.findPath({ x: 4, y: 4 }, { x: 2, y: 1 })!;
  assert.ok(path, '应有路径');
  assert.deepEqual(path[0], { x: 4, y: 4 });
  assert.deepEqual(path[path.length - 1], { x: 2, y: 1 });
  // 全程无墙
  for (const t of path) assert.equal(w.walkable(t.x, t.y), true, `路径含墙 (${t.x},${t.y})`);
  // 相邻步差 1（无穿墙）
  for (let i = 1; i < path.length; i++) {
    const d = Math.abs(path[i].x - path[i - 1].x) + Math.abs(path[i].y - path[i - 1].y);
    assert.equal(d, 1, '路径必须逐格相邻');
  }
});

test('findPath 目标为墙 → null；邻居四方向', () => {
  const w = world();
  assert.equal(w.findPath({ x: 4, y: 4 }, { x: 2, y: 2 }), null); // (2,2) 是墙
  assert.deepEqual(w.neighbors({ x: 0, y: 0 }), [{ x: 0, y: -1 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 1, y: 0 }]);
});

test('地图边角建筑也有出口（防死角）', () => {
  const OBJS2: WorldObject[] = [
    { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
    { id: 'obj:home', name: '家', type: 'building', parentId: 'obj:town', x: 10, y: 6, w: 2, h: 2 },
  ];
  const w = new WorldState(OBJS2, []);
  assert.ok(w.findPath({ x: 11, y: 7 }, { x: 11, y: 5 }), '边角建筑必须能出门');
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/pathfinding.test.ts`
Expected: FAIL（`Cannot find module '../src/core/pathfinding'` 或 walkable 不存在）。

- [ ] **Step 3: 写 src/core/pathfinding.ts**

```ts
// A* 寻路：4 方向网格、曼哈顿启发（spec §9 寻路；墙 = 建筑边界除门，由 WorldState 提供 walkable）

import type { Tile } from './types';
import type { WorldState } from './world';

const key = (t: Tile) => `${t.x},${t.y}`;
const unkey = (k: string): Tile => {
  const [x, y] = k.split(',').map(Number);
  return { x, y };
};
const h = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** 返回含起点终点的路径；起点或终点不可通行 → null */
export function findPath(world: WorldState, from: Tile, to: Tile): Tile[] | null {
  if (!world.inBounds(from) || !world.inBounds(to)) return null;
  if (!world.walkable(to.x, to.y)) return null;
  const startKey = key(from);
  const goalKey = key(to);
  if (startKey === goalKey) return [from];
  const open = new Map<string, { tile: Tile; g: number; f: number }>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  gScore.set(startKey, 0);
  open.set(startKey, { tile: from, g: 0, f: h(from, to) });
  while (open.size) {
    let curKey = '';
    let cur: { tile: Tile; g: number; f: number } | undefined;
    for (const [k, v] of open) {
      if (!cur || v.f < cur.f || (v.f === cur.f && k < curKey)) {
        curKey = k;
        cur = v;
      }
    }
    cur = cur!;
    if (curKey === goalKey) {
      const path: Tile[] = [to];
      let k = goalKey;
      while (k !== startKey) {
        k = cameFrom.get(k)!;
        path.unshift(unkey(k));
      }
      return path;
    }
    open.delete(curKey);
    for (const nb of world.neighbors(cur.tile)) {
      if (!world.walkable(nb.x, nb.y)) continue;
      const nk = key(nb);
      const tentative = cur.g + 1;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        cameFrom.set(nk, curKey);
        gScore.set(nk, tentative);
        open.set(nk, { tile: nb, g: tentative, f: tentative + h(nb, to) });
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: 修改 src/core/world.ts**

删除 `manhattanPath` 方法；构造函数末尾加 `this.computeWalkable();`；类体加：

```ts
  private blocked = new Set<string>();

  /** 建筑边界为墙；房间/家具瓦片永远开口；每建筑至少保证一个开口瓦片有出口（防死角） */
  private computeWalkable(): void {
    const key = (t: Tile) => `${t.x},${t.y}`;
    const buildings = [...this.objects.values()].filter((o) => o.type === 'building');
    // 1) 全部边界标记为墙
    for (const o of buildings) {
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) {
          const border = x === o.x || x === o.x + o.w - 1 || y === o.y || y === o.y + o.h - 1;
          if (border) this.blocked.add(key({ x, y }));
        }
      }
    }
    // 2) 房间/家具瓦片开口（活动目标点必须可达）
    for (const r of this.objects.values()) {
      if (r.type !== 'room' && r.type !== 'furniture') continue;
      for (let x = r.x; x < r.x + r.w; x++) {
        for (let y = r.y; y < r.y + r.h; y++) this.blocked.delete(key({ x, y }));
      }
    }
    // 3) 门：底边中点优先；开口后若无出口，依次开放其余边界瓦片直至有出口
    const inside = (o: WorldObject, t: Tile) => t.x >= o.x && t.x < o.x + o.w && t.y >= o.y && t.y < o.y + o.h;
    const hasExit = (o: WorldObject, t: Tile) =>
      this.neighbors(t).some((nb) => !inside(o, nb) && this.inBounds(nb) && !this.blocked.has(key(nb)));
    for (const o of buildings) {
      const door: Tile = { x: o.x + Math.floor(o.w / 2), y: o.y + o.h - 1 };
      const borders: Tile[] = [];
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) {
          const border = x === o.x || x === o.x + o.w - 1 || y === o.y || y === o.y + o.h - 1;
          if (border) borders.push({ x, y });
        }
      }
      const ordered = [door, ...borders.filter((t) => !(t.x === door.x && t.y === door.y))];
      for (const t of ordered) {
        this.blocked.delete(key(t));
        if (hasExit(o, t)) break;
      }
    }
  }

  walkable(x: number, y: number): boolean {
    return this.inBounds({ x, y }) && !this.blocked.has(`${x},${y}`);
  }

  neighbors(t: Tile): Tile[] {
    return [
      { x: t.x, y: t.y - 1 },
      { x: t.x, y: t.y + 1 },
      { x: t.x - 1, y: t.y },
      { x: t.x + 1, y: t.y },
    ];
  }

  findPath(from: Tile, to: Tile): Tile[] | null {
    return findPath(this, from, to);
  }
```

import 加：`import { findPath } from './pathfinding';`

- [ ] **Step 5: 修改 src/engine/seed.ts（湖泊）**

TOWN_OBJECTS 中 park 行之后插入：

```ts
  { id: 'obj:lake', name: '湖边', type: 'zone', parentId: 'obj:town', x: 8, y: 7, w: 3, h: 1 },
```

- [ ] **Step 6: 更新 tests/world.test.ts**

删除 `manhattanPath` 测试；新增：

```ts
test('findPath 与 walkable 经 world 暴露', () => {
  const w = world();
  assert.ok(w.findPath({ x: 0, y: 0 }, { x: 11, y: 7 }) !== null);
  assert.equal(w.walkable(0, 0), true);
});
```

- [ ] **Step 7: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/pathfinding.test.ts tests/world.test.ts
pnpm test
pnpm typecheck
```

Expected: pathfinding 3 通过；world.test 通过（替换后）；**注意**：state-machine 仍用 manhattanPath → 全量测试会失败（Task 2 修复）——若如此，本任务结束时全量允许 state-machine 相关失败，但必须记录输出并在 Task 2 立即修复；或提前在本任务把 state-machine 的 manhattanPath 调用替换为 findPath（带 null 降级）。**裁定：本任务内同步替换 state-machine 的调用**（最小改动：`const path = this.world.findPath(here, tile!); if (!path) { ... 降级 idle ... } else { agent.path = path; ... }`，降级文案 `找不到通往「X」的路，先休息一下。`），使全量立即恢复绿。

- [ ] **Step 8: 提交**

```bash
git add src/core/pathfinding.ts src/core/world.ts src/engine/seed.ts src/core/state-machine.ts tests/pathfinding.test.ts tests/world.test.ts
git commit -m "feat(core): A* 寻路与建筑碰撞（门墙模型 + 湖泊）"
```

---

### Task 2: 执行器接入寻路 + 让行 + 玩家指令

**Files:**
- Create: `src/engine/player.ts`、`tests/player.test.ts`、`tests/player-exec.test.ts`
- Modify: `src/core/state-machine.ts`（构造器第 5 参 player；请求决策注入玩家指令）、`src/llm/prompts.ts`（ActionDecisionInput/MockContextPayload 加 playerInstruction/objects）、`src/llm/mock.ts`（玩家指令匹配对象）

**Interfaces:**
- Produces：
  - `new PlayerDirector()`：`act(agentId, instruction, now)`、`clear(agentId)`、`current(agentId, now): string | null`（60 游戏分钟过期）
  - `new AgentExecutor(llm, world, log, mind?, player?)`
  - 提示词/M0_CONTEXT 增加 `playerInstruction: string | null` 与 `objects: {id,name}[]`；mock：指令包含对象名 → interact 该对象（verb=指令，15 分钟），否则 idle 10 分钟（thought 表明尝试执行）
  - 步进让行：stepMove 中下一格被 moving/acting 他人占用则本 tick 等待

- [ ] **Step 1: 写失败测试 tests/player.test.ts 与 tests/player-exec.test.ts**

`tests/player.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerDirector } from '../src/engine/player';

test('指令 60 游戏分钟内有效，之后过期', () => {
  const p = new PlayerDirector();
  p.act('agent:1', '去公园写生', 100);
  assert.equal(p.current('agent:1', 100), '去公园写生');
  assert.equal(p.current('agent:1', 159), '去公园写生');
  assert.equal(p.current('agent:1', 161), null); // 超 60 分钟
});

test('clear 移除指令；未设置返回 null', () => {
  const p = new PlayerDirector();
  assert.equal(p.current('agent:9', 0), null);
  p.act('agent:1', '去书店', 10);
  p.clear('agent:1');
  assert.equal(p.current('agent:1', 10), null);
});
```

`tests/player-exec.test.ts`：

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { PlayerDirector } from '../src/engine/player';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 8, y: 5, w: 3, h: 2 },
];

test('玩家指令驱动 agent 前往指定对象', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, locationId: 'obj:town' });
  const world = new WorldState(OBJS, [agent]);
  const gateway = new LLMGateway({ provider: 'mock' });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, undefined, player);
  player.act('agent:1', '去湖边公园写生', 0);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'moving');
  for (let i = 0; i < 40 && agent.state !== 'idle'; i++) {
    executor.progress(agent, 5, 15 + i * 5);
    await flush();
  }
  // 到达公园（目标中心 (9,5)）
  assert.ok(agent.x >= 8 && agent.x <= 10 && agent.y >= 5 && agent.y <= 6, `位置 ${agent.x},${agent.y}`);
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/player.test.ts tests/player-exec.test.ts`
Expected: FAIL（player.ts/新参数不存在）。

- [ ] **Step 3: 写 src/engine/player.ts**

```ts
// 玩家扮演：自然语言指令覆盖 agent 决策（60 游戏分钟内最高优先级）

export class PlayerDirector {
  private overrides = new Map<string, { instruction: string; since: number }>();

  act(agentId: string, instruction: string, now: number): void {
    this.overrides.set(agentId, { instruction: instruction.slice(0, 120), since: now });
  }

  clear(agentId: string): void {
    this.overrides.delete(agentId);
  }

  current(agentId: string, now: number): string | null {
    const o = this.overrides.get(agentId);
    if (!o) return null;
    if (now - o.since > 60) {
      this.overrides.delete(agentId);
      return null;
    }
    return o.instruction;
  }
}
```

- [ ] **Step 4: 修改 src/core/state-machine.ts（player 注入 + 让行）**

构造器加第 5 参：

```ts
    private mind?: MindEngine,
    private player?: PlayerDirector
```

import 加：`import type { PlayerDirector } from '../engine/player';`

requestDecision 中 mind 分支之后加：

```ts
    const playerInstruction = this.player?.current(agent.id, now) ?? null;
```

mockContext 与 ActionDecisionInput 增加 `playerInstruction` 与 `objects`（objects 已在 input 中，mockContext 同样带上）：

```ts
      mockContext: { persona: agent.persona, minuteOfDay, routine: agent.persona.routine, memories, insights, agenda, playerInstruction, objects: this.world.allObjects().map((o) => ({ id: o.id, name: o.name })) },
```

stepMove 开头加让行：

```ts
    const nextProgress = agent.pathProgress + dt * MOVE_SPEED_TILES_PER_MIN;
    const nextIdx = Math.min(Math.floor(nextProgress), agent.path.length - 1);
    const nextTile = agent.path[nextIdx];
    const occupied = this.world.allAgents().some(
      (other) => other.id !== agent.id && other.x === nextTile.x && other.y === nextTile.y && (other.state === 'moving' || other.state === 'acting')
    );
    if (occupied) return; // 排队让行
    agent.pathProgress = nextProgress;
```

（原 `agent.pathProgress += ...` 行删除，其余 stepMove 逻辑保持。）

- [ ] **Step 5: 修改 src/llm/prompts.ts 与 src/llm/mock.ts（玩家指令）**

prompts.ts：`MockContextPayload` 加 `playerInstruction: string | null; objects: { id: string; name: string }[];`；`ActionDecisionInput` 加 `playerInstruction: string | null;`；system 提示词「自我认知」行后加：

```ts
    `玩家指令（最高优先级，尽力执行）：${input.playerInstruction ?? '（无）'}`,
```

mock.ts：`decideAction` 开头加：

```ts
  const instruction = ctx.playerInstruction as string | null | undefined;
  if (instruction) {
    const objects = (ctx.objects ?? []) as { id: string; name: string }[];
    const hit = objects.find((o) => instruction.includes(o.name));
    if (hit) {
      return { thought: `按玩家的指令：${instruction}`, action: { type: 'interact', target: hit.id, verb: instruction.slice(0, 20) }, durationMinutes: 15 };
    }
    return { thought: `尝试执行玩家指令：${instruction}`, action: { type: 'idle', target: null, verb: instruction.slice(0, 20) }, durationMinutes: 10 };
  }
```

- [ ] **Step 6: 更新 tests/prompts.test.ts 与 tests/state-machine.test.ts（新必填字段）**

prompts.test 三处 `buildActionDecisionMessages` 调用的 input 加 `playerInstruction: null,`；mockContext 加 `playerInstruction: null, objects: [],`。

- [ ] **Step 7: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/player.test.ts tests/player-exec.test.ts tests/prompts.test.ts tests/state-machine.test.ts
pnpm test
pnpm typecheck
```

Expected: 全量通过（约 84）；typecheck 0 错。

- [ ] **Step 8: 提交**

```bash
git add src/engine/player.ts src/core/state-machine.ts src/llm/prompts.ts src/llm/mock.ts tests/player.test.ts tests/player-exec.test.ts tests/prompts.test.ts
git commit -m "feat(engine): 玩家指令驱动与步进让行"
```

---

### Task 3: 服务器玩家/广播 API

**Files:**
- Modify: `src/web/server.ts`（TownWebOptions 加 player?；POST/DELETE /api/player/:id/act、POST /api/broadcast）、`src/cli/town-web.ts`（构造 player 注入 executor/server）、`src/cli/run.ts`（同）
- Create: `tests/server-player.test.ts`

**Interfaces:**
- Produces：
  - `POST /api/player/:agentId/act` body `{instruction}` → `{ok:true}`（校验非空 ≤120 字）
  - `DELETE /api/player/:agentId/act` → `{ok:true}`
  - `POST /api/broadcast` body `{text}` → broadcast 事件（type=broadcast、actorId=null、targetIds=全员 agent id、description=`小镇广播：${text}`、payload {kind:'broadcast', text}）→ MemoryWriter 全员记忆（importance 按内容）；返回 {ok:true}

- [ ] **Step 1: 写失败测试 tests/server-player.test.ts**

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
import { PlayerDirector } from '../src/engine/player';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'web-player-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const a = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const b = makeAgent({ id: 'agent:2', name: '乙', x: 1, y: 0, persona: persona({ name: '乙' }) });
  const world = new WorldState(OBJS, [a, b]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, player, publicDir: dir });
  return { dir, db, log, world, mind, player, server, base: `http://127.0.0.1:${server.port}` };
}

test('玩家指令 API：act 设置、delete 清除', async () => {
  const { player, server, base, world } = await setup();
  try {
    const r = await fetch(`${base}/api/player/${encodeURIComponent('agent:1')}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '去公园写生' }),
    });
    assert.equal(r.status, 200);
    assert.equal(player.current('agent:1', world.allAgents()[0].actionEndsAt + 0), '去公园写生');
    await fetch(`${base}/api/player/${encodeURIComponent('agent:1')}/act`, { method: 'DELETE' });
    assert.equal(player.current('agent:1', 0), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test('广播：全员 agent 获得记忆（派对 → importance 9）', async () => {
  const { mind, server, base, dir } = await setup();
  try {
    const r = await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '今晚湖边派对，欢迎所有人！' }),
    });
    assert.equal(r.status, 200);
    await flush();
    for (const id of ['agent:1', 'agent:2']) {
      const mems = mind.store.recentMemories(id, 20);
      assert.ok(mems.some((m) => m.content.includes('湖边派对')), `${id} 应记住广播`);
      assert.equal(mems.find((m) => m.content.includes('湖边派对'))!.importance, 9);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
```

- [ ] **Step 2: 运行并确认失败**

Run: `node --no-warnings --import tsx --test tests/server-player.test.ts`
Expected: FAIL（404）。

- [ ] **Step 3: 修改 src/web/server.ts**

TownWebOptions 加：`player?: PlayerDirector;    // 玩家扮演`
import：`import type { PlayerDirector } from '../engine/player';`

在 mind API 路由后插入：

```ts
      if (url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/act')) {
        const id = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/act'.length));
        if (req.method === 'POST') {
          const body = (await readBody(req)) as { instruction?: unknown };
          const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 120) : '';
          if (!instruction) {
            res.writeHead(400);
            res.end('指令不能为空');
            return;
          }
          if (!opts.player) {
            res.writeHead(404);
            res.end('扮演未启用');
            return;
          }
          opts.player.act(id, instruction, time.state.totalMinutes);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'DELETE') {
          opts.player?.clear(id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
      if (url.pathname === '/api/broadcast' && req.method === 'POST') {
        const body = (await readBody(req)) as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        if (!text) {
          res.writeHead(400);
          res.end('广播内容不能为空');
          return;
        }
        log.addEvent({
          id: randomUUID(),
          type: 'broadcast',
          actorId: null,
          targetIds: world.allAgents().map((a) => a.id),
          description: `小镇广播：${text}`,
          location: null,
          gameTime: time.state.totalMinutes,
          payload: { kind: 'broadcast', text },
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
```

import 加：`import { randomUUID } from 'node:crypto';`

- [ ] **Step 4: 修改 src/cli/town-web.ts 与 src/cli/run.ts（player 接线）**

两处都：

```ts
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
```

town-web 的 createTownServer 调用加 `player,`；import 加：`import { PlayerDirector } from '../engine/player';`

- [ ] **Step 5: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/server-player.test.ts
pnpm test
pnpm typecheck
```

Expected: server-player 2 通过；全量通过；typecheck 0 错。

- [ ] **Step 6: 提交**

```bash
git add src/web/server.ts src/cli/town-web.ts src/cli/run.ts tests/server-player.test.ts
git commit -m "feat(web): 玩家扮演与小镇广播 API"
```

---

### Task 4: 客户端渲染升级（32×32 精灵 / 地图细节 / 昼夜）

**Files:**
- Create: `src/web/client/sprites.ts`、`src/web/client/render.ts`
- Modify: `src/web/client/main.ts`（拆分渲染与精灵逻辑到新模块）、`public/style.css`（画布加大到 32px 瓦片 + 更精致 HUD）

**Interfaces:**
- Produces（浏览器 TS，构建+typecheck 验证）：
  - `PALETTES: SpriteStyle[]`（4 套：围裙/眼镜/贝雷帽/邮差帽，含 hair/skin/top/bottom/accent/kind）
  - `drawNpc(ctx, cx, cy, dir: 'up'|'down'|'left'|'right', frame: 0|1, index: number, moving: boolean, selected: boolean, name: string, thoughtBubble?: boolean): void`（32×32 像素小人：影子/腿/躯干/头/发/配件；四方向；行走帧摆动）
  - `drawTerrain(ctx, w, h)`（草地基底 + 石板小径）
  - `drawLake(ctx, px, py, pw, ph, nowMs)`（波光动画）
  - `drawObjectDetail(ctx, o, nowMs)`（建筑门窗/屋顶高光/招牌、公园树与花、广场喷泉）
  - `applyDayNight(ctx, w, h, minuteOfDay)`（清晨 300-480 橙 0.12、黄昏 1020-1200 橙 0.18、夜晚 1200-300 深蓝 0.32）
  - 画布瓦片 32px；CSS 宽 768→（12×32=384 逻辑 ×2 = 768）保持

- [ ] **Step 1: 写 src/web/client/sprites.ts**

```ts
// 32×32 像素小人：四方向行走 2 帧 + 待机微动；程序绘制（无美术资源）

export interface SpriteStyle {
  hair: string; skin: string; top: string; bottom: string; accent: string;
  kind: 'apron' | 'glasses' | 'beret' | 'cap';
}

export const PALETTES: SpriteStyle[] = [
  { hair: '#5b3a29', skin: '#f2c99c', top: '#d97757', bottom: '#6b4f6b', accent: '#f7e8d0', kind: 'apron' },   // 林晚晴
  { hair: '#2f2f2f', skin: '#e8c39a', top: '#4a6fa5', bottom: '#3a3a3a', accent: '#9fb8d8', kind: 'glasses' }, // 陈默
  { hair: '#7a4a2b', skin: '#f5d0a8', top: '#8a2f2f', bottom: '#5a4a3a', accent: '#c9a66b', kind: 'beret' },   // 沈屿
  { hair: '#1f1f1f', skin: '#f2c99c', top: '#b33b3b', bottom: '#4a4a4a', accent: '#2f6b2f', kind: 'cap' },     // 周岚
];

export type Dir = 'up' | 'down' | 'left' | 'right';

export function drawNpc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Dir,
  frame: 0 | 1,
  index: number,
  moving: boolean,
  selected: boolean,
  name: string,
  thinking: boolean
): void {
  const p = PALETTES[index % PALETTES.length];
  const x = Math.round(cx);
  const y = Math.round(cy) + (moving ? Math.round(Math.sin(performance.now() / 150)) : 0);
  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, cy + 10, 7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  const step = frame === 0 ? 0 : 1;
  // 腿
  ctx.fillStyle = p.bottom;
  if (dir === 'left' || dir === 'right') {
    ctx.fillRect(x - 5 + step, y - 8, 4, 9);
    ctx.fillRect(x + 1 - step, y - 8, 4, 9);
  } else {
    ctx.fillRect(x - 5, y - 8 + step, 4, 9);
    ctx.fillRect(x + 1, y - 8 - step, 4, 9);
  }
  // 躯干
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 6, y - 19, 12, 12);
  if (p.kind === 'apron') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 3, y - 19, 6, 12);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, y - 19, 12, 3);
  }
  // 手臂（行走摆动）
  ctx.fillStyle = p.skin;
  if (moving && dir !== 'up') {
    ctx.fillRect(x - 8 + step * 3, y - 18, 3, 9);
    ctx.fillRect(x + 5 - step * 3, y - 18, 3, 9);
  } else {
    ctx.fillRect(x - 8, y - 18, 3, 9);
    ctx.fillRect(x + 5, y - 18, 3, 9);
  }
  // 头
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 5, y - 31, 10, 10);
  // 头发
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 6, y - 33, 12, 4);
  if (dir !== 'up') ctx.fillRect(x - 6, y - 29, 3, 6); // 侧发
  // 配件
  if (p.kind === 'beret') {
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 7, y - 35, 14, 3);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, y - 34, 12, 3);
    ctx.fillRect(x - 8, y - 31, 3, 2); // 帽檐
  }
  if (p.kind === 'glasses') {
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 4, y - 27, 3, 3);
    ctx.fillRect(x + 1, y - 27, 3, 3);
    ctx.fillRect(x - 1, y - 26, 2, 1);
  }
  // 眼睛（背向无）
  if (dir !== 'up') {
    ctx.fillStyle = '#1a1a1a';
    const ex = dir === 'left' ? x - 3 : dir === 'right' ? x + 1 : x - 1;
    ctx.fillRect(ex, y - 27, 2, 2);
  }
  if (thinking) {
    ctx.fillStyle = '#ffe9a8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('…', x - 8, y - 38);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '10px monospace';
  ctx.fillText(name, x - ctx.measureText(name).width / 2, y + 19);
  if (selected) {
    ctx.strokeStyle = '#ffd700';
    ctx.strokeRect(x - 9, y - 37, 18, 32);
  }
}
```

- [ ] **Step 2: 写 src/web/client/render.ts**

```ts
// 地图渲染：地形/建筑细节/湖水波光/昼夜着色

import type { ObjectView } from './types';

export const TILE = 32;

const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, w, h);
  // 石板小径：中央十字
  ctx.fillStyle = '#c9b79c';
  for (let x = 0; x < w; x += TILE) {
    ctx.fillRect(x, 4 * TILE + 8, TILE, 8);
    ctx.fillRect(x + 4, 4 * TILE, 8, TILE);
  }
  // 花点
  ctx.fillStyle = '#e8d5a0';
  for (let i = 0; i < 12; i++) {
    const fx = (i * 37) % w;
    const fy = ((i * 53) % h);
    ctx.fillRect(fx, fy, 2, 2);
  }
}

export function drawLake(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
  ctx.fillStyle = '#5b9bd1';
  ctx.fillRect(px, py, pw, ph);
  const wave = Math.floor(nowMs / 400) % 2;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = px + 4 + wave * 6; x < px + pw; x += 12) {
    ctx.fillRect(x, py + 6, 5, 2);
    ctx.fillRect(x + 5, py + ph - 12, 5, 2);
  }
}

export function drawObjectDetail(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.type === 'zone') {
    if (o.id === 'obj:park') {
      ctx.fillStyle = '#6aa84f';
      ctx.fillRect(px, py, pw, ph);
      for (const [tx, ty] of [[px + 10, py + 10], [px + pw - 22, py + ph - 24]]) {
        ctx.fillStyle = '#4a3520';
        ctx.fillRect(tx, ty, 6, 16);
        ctx.fillStyle = '#2f7a3a';
        ctx.fillRect(tx - 7, ty - 10, 20, 14);
      }
    } else if (o.id === 'obj:lake') {
      drawLake(ctx, px, py, pw, ph, nowMs);
    } else {
      ctx.fillStyle = '#c9b79c';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#a3937a';
      for (let x = px + 8; x < px + pw; x += 16) {
        for (let y = py + 8; y < py + ph; y += 16) ctx.strokeRect(x, y, 16, 16);
      }
      ctx.fillStyle = '#6b9bd1';
      ctx.fillRect(px + pw / 2 - 10, py + ph / 2 - 10, 20, 20);
    }
  } else if (o.type === 'building') {
    ctx.fillStyle = '#e8d5b7';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = ROOFS[hash(o.id) % ROOFS.length];
    ctx.fillRect(px, py, pw, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(px + 4, py + 3, pw - 8, 3);
    // 窗
    ctx.fillStyle = '#7a5a3a';
    for (let wx = px + 8; wx < px + pw - 8; wx += 16) {
      ctx.fillRect(wx, py + 16, 8, 8);
      ctx.strokeStyle = '#4a3520';
      ctx.strokeRect(wx, py + 16, 8, 8);
    }
    // 门
    ctx.fillStyle = '#6b4a2f';
    const doorX = px + pw / 2 - 6;
    ctx.fillRect(doorX, py + ph - 14, 12, 14);
    // 招牌
    if (o.id === 'obj:cafe' || o.id === 'obj:bookstore' || o.id === 'obj:post_office') {
      ctx.fillStyle = '#e3b23c';
      ctx.fillRect(px + pw - 16, py + 2, 12, 8);
    }
  } else if (o.type === 'room') {
    ctx.fillStyle = '#d9b48f';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#a97c50';
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
  } else {
    ctx.fillStyle = '#8a6f4d';
    ctx.fillRect(px + 6, py + 6, pw - 12, ph - 12);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '11px monospace';
  ctx.fillText(o.name, px + 3, py + 24);
}

export function applyDayNight(ctx: CanvasRenderingContext2D, w: number, h: number, minuteOfDay: number): void {
  let color = '';
  let alpha = 0;
  if (minuteOfDay >= 300 && minuteOfDay < 480) { color = '#ff9a3c'; alpha = 0.1; }
  else if (minuteOfDay >= 1020 && minuteOfDay < 1200) { color = '#ff7a3c'; alpha = 0.16; }
  else if (minuteOfDay >= 1200 || minuteOfDay < 300) { color = '#1a2a4a'; alpha = 0.3; }
  if (alpha > 0) {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
```

- [ ] **Step 3: 修改 src/web/client/main.ts（接线新模块）**

- 删除内置的 `drawPark/drawPlaza/drawBuilding/drawSprite/PALETTES/ROOFS/hash` 与旧 16px 绘制逻辑
- 引入：`import { drawNpc, type Dir } from './sprites'; import { drawTerrain, drawObjectDetail, applyDayNight, TILE } from './render';`
- `draw()` 改为：`drawTerrain(ctx, canvas.width, canvas.height)` → 分层 drawObjectDetail（zone→building→room/furniture）→ agents（用 drawNpc；dir 由 display 的最近位移决定：`d.tx > d.x ? 'right' : d.tx < d.x ? 'left' : d.ty > d.y ? 'down' : d.ty < d.y ? 'up' : 'down'`）→ bubbles → `applyDayNight(ctx, canvas.width, canvas.height, snap.clock.minutesOfDay)`
- 画布尺寸不变（12×32=384 × 8×32=256，CSS 2x=768×512）
- 气泡/面板/ticker/控制逻辑保持

（main.ts 中旧渲染函数的具体行由实现者按上述语义替换，保持类型与既有行为：点击命中、插值、SSE 接线全部不动。）

- [ ] **Step 4: 修改 public/style.css**

canvas 规则保持 768×512（逻辑不变）；HUD 加渐变背景与圆角按钮（视觉精致）：

```css
#hud { background: linear-gradient(180deg, #1a2230, #141a22); box-shadow: 0 2px 6px rgba(0,0,0,0.4); }
#controls button { transition: background 0.15s; }
#controls button.active { background: #4a5f83; }
```

- [ ] **Step 5: 构建 + 类型检查 + 冒烟**

```bash
pnpm build:web
pnpm typecheck
node --no-warnings --import tsx src/cli/town-web.ts --port 8792 --db :memory: &
sleep 3
curl -s http://127.0.0.1:8792/client.js | head -c 60
curl -s http://127.0.0.1:8792/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('lake:',s.objects.some(o=>o.id==='obj:lake'),'agents:',s.agents.length)})"
kill %1
```

Expected：构建成功、typecheck 0、client.js 返回、快照含 obj:lake。

- [ ] **Step 6: 提交**

```bash
git add src/web/client/sprites.ts src/web/client/render.ts src/web/client/main.ts public/style.css
git commit -m "feat(web): 32×32 四方向精灵与地图细节/湖水/昼夜"
```

---

### Task 5: 客户端精致交互（悬停/建筑卡片/对话条/广播横幅/扮演 UI）

**Files:**
- Modify: `src/web/client/main.ts`（悬停 tooltip、建筑卡片、对话条升级、广播横幅、扮演按钮+输入框）、`public/index.html`（扮演输入区）、`public/style.css`（tooltip/横幅/扮演区样式）

**Interfaces:**
- Produces（浏览器 TS，构建+typecheck 验证）：
  - 悬停：mousemove → 命中 NPC 或建筑 → canvas 右上 tooltip（名字/状态/类型）
  - 点击建筑 → 面板显示建筑信息卡（名称/类型/尺寸）
  - chat 气泡升级：对话条（更宽、说话人姓名行 + 文本行、时长 9s）；chat_summary 用 📜 前缀
  - broadcast 事件 → 顶部横幅条（事件描述，6 秒淡出）
  - 扮演：面板详情 tab 加「🎮 扮演」按钮与「退出扮演」；扮演后显示输入框 → POST /api/player/:id/act；该 NPC 头顶 🎮 徽标（snapshot 无此信息——客户端本地记录 playingId 集合）

- [ ] **Step 1: 修改 public/index.html（扮演输入区）**

在 `#panel-body` 内 detail 渲染时动态生成即可；index.html 仅在 `#side` 后加一个全局输入容器：

```html
    <div id="play-bar" hidden>
      <input id="play-input" placeholder="输入指令，如：去告诉陈默今晚派对" maxlength="120" />
      <button id="play-send">执行</button>
      <button id="play-exit">退出扮演</button>
    </div>
```

- [ ] **Step 2: 修改 public/style.css（tooltip/横幅/扮演区）**

追加：

```css
#tooltip {
  position: absolute; display: none; background: rgba(20,26,34,0.92);
  border: 1px solid #3a4657; border-radius: 4px; padding: 4px 8px;
  font-size: 12px; pointer-events: none; white-space: pre-line;
}
#banner {
  position: absolute; top: 52px; left: 50%; transform: translateX(-50%);
  background: rgba(227,178,60,0.95); color: #1a1a1a; padding: 6px 18px;
  border-radius: 6px; font-size: 14px; font-weight: bold; display: none;
  box-shadow: 0 2px 8px rgba(0,0,0,0.5);
}
#play-bar { display: flex; gap: 6px; margin-top: 10px; }
#play-bar[hidden] { display: none; }
#play-input { flex: 1; background: #1a2230; color: #e8e2d4; border: 1px solid #3a4657; border-radius: 4px; padding: 4px 8px; }
#play-bar button { background: #2a3547; color: #e8e2d4; border: 1px solid #3a4657; border-radius: 4px; cursor: pointer; }
```

- [ ] **Step 3: 修改 src/web/client/main.ts（交互逻辑）**

新增状态与函数：

```ts
const playing = new Set<string>();
let tooltip: { text: string; x: number; y: number } | null = null;
let banner: { text: string; until: number } | null = null;
```

- mousemove 监听：换算瓦片 → 命中 NPC（快照瓦片）→ tooltip = `${name}（${stateName}）`；否则命中对象（非 town）→ tooltip = `${obj.name}（${typeName}）`；否则 null；canvas 上重绘时画 tooltip（`drawTooltip()` 简单矩形+文字）。
- 点击：先 NPC（选中+面板）后对象（面板显示建筑卡片：名称/类型/尺寸）。
- onEvent 扩展：`kind === 'broadcast'` → banner = {text: description, until: now+6000}；绘制层画 banner（顶部条），过期清除。
- chat 气泡升级：bubbles 存 `{kind:'chat'|'thought'|'chat_summary', speaker, text, until}`；onEvent 中 chat 取 payload.line + payload.fromId → speaker 名（从 snap.agents 找）；drawBubbles 中 chat/chat_summary 用两行（speaker 行 + text 行）、宽 180、时长 9s。
- 扮演：detail 面板加按钮 `🎮 扮演`（点击 → playing.add(id)；显示 #play-bar；send → POST act；exit → DELETE + playing.delete + 隐藏）；drawNpc 调用处若 playing.has(id) → 在名字旁画 🎮（或在 drawNpc 后手动补 8px 徽标）。
- 面板/时钟/调速/ticker 逻辑不动。

- [ ] **Step 4: 构建 + 类型检查 + 冒烟**

```bash
pnpm build:web
pnpm typecheck
node --no-warnings --import tsx src/cli/town-web.ts --port 8793 --db :memory: &
sleep 3
curl -s -X POST http://127.0.0.1:8793/api/broadcast -H 'content-type: application/json' -d '{"text":"今晚湖边派对！"}'
curl -s http://127.0.0.1:8793/api/state >/dev/null && echo "server ok"
kill %1
```

Expected：构建成功、typecheck 0、broadcast 返回 {ok:true}。

- [ ] **Step 5: 提交**

```bash
git add src/web/client/main.ts public/index.html public/style.css
git commit -m "feat(web): 精致交互（悬停/建筑卡片/对话条/广播横幅/扮演 UI）"
```

---

### Task 6: M2 验收 e2e + README + 终审

**Files:**
- Create: `tests/acceptance-m2.test.ts`
- Modify: `README.md`（M2 说明 + 扮演/广播用法）

- [ ] **Step 1: 写 tests/acceptance-m2.test.ts**

```ts
// M2 验收：寻路绕墙 + 玩家指令执行 + 广播全员知晓

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
import { PlayerDirector } from '../src/engine/player';
import { createTownServer } from '../src/web/server';
import { flush } from './helpers';

test('M2 验收：寻路经门进吧台、玩家指令执行、广播全员记忆', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-m2-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, player, publicDir: dir });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // ① 寻路：咖啡馆吧台在房间瓦片（开口），从家出发存在合法路径且全程无墙
    const lin = world.allAgents()[0]; // 林晚晴，家 (2,7)
    const path = world.findPath({ x: lin.x, y: lin.y }, world.targetTile('obj:cafe_counter')!)!;
    assert.ok(path, '应找到通往吧台的路');
    for (const t of path) assert.equal(world.walkable(t.x, t.y), true, `路径含墙 (${t.x},${t.y})`);
    assert.equal(world.walkable(3, 1), false); // 顶边是墙
    assert.equal(world.walkable(3, 2), true);  // 门开口

    // ② 玩家指令：让沈屿去书店（含「默语书店」对象名）
    const shen = world.allAgents().find((a) => a.name === '沈屿')!;
    const r = await fetch(`${base}/api/player/${encodeURIComponent(shen.id)}/act`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '去默语书店看书' }),
    });
    assert.equal(r.status, 200);
    await loop.runUntil(120);
    assert.ok(
      world.targetTile('obj:bookstore') !== null &&
      (Math.abs(shen.x - world.targetTile('obj:bookstore')!.x) <= 1 && Math.abs(shen.y - world.targetTile('obj:bookstore')!.y) <= 1),
      `沈屿应前往书店，实际 (${shen.x},${shen.y})`
    );

    // ③ 广播：全员获得派对记忆（importance 9）
    await fetch(`${base}/api/broadcast`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '今晚湖边派对，欢迎所有人！' }),
    });
    await flush();
    for (const a of world.allAgents()) {
      const mem = mind.store.recentMemories(a.id, 50).find((m) => m.content.includes('湖边派对'));
      assert.ok(mem, `${a.name} 应记住广播`);
      assert.equal(mem.importance, 9);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
```

- [ ] **Step 2: 运行验收**

```bash
node --no-warnings --import tsx --test tests/acceptance-m2.test.ts
```

Expected: 1 通过。若失败按断言修被测代码，不放宽断言。

- [ ] **Step 3: 更新 README.md**

M2 行打勾 + 使用说明：

```markdown
pnpm town-web   # 浏览器像素小镇：点击「🎮 扮演」输入指令指挥 NPC；「📢 广播」发布小镇消息
```

- [ ] **Step 4: 全量验证**

```bash
pnpm build:web
pnpm test
pnpm typecheck
git status
```

Expected: 全量通过（约 87）；typecheck 0 错；工作区干净。

- [ ] **Step 5: 提交**

```bash
git add tests/acceptance-m2.test.ts README.md
git commit -m "test: M2 验收（寻路/玩家扮演/广播）与文档"
```

---

## 自检记录（写完后已核对）

- **Spec 覆盖**：§9 空间呈现（寻路/碰撞/气泡/面板/时间条已由先行版覆盖，本计划补 A* 绕墙 + 画风升级）；§5.1 碰撞与排队（门墙模型 + 让行）；§8.1 玩家行动接口（POST /api/player/:agentId/act 语义化）；广播为 M3 信息传播先行版（用户批准）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`findPath(world, from, to)` 与 world.findPath 委托一致；`PlayerDirector.current(agentId, now)` 与 executor/server 调用一致；`ActionDecisionInput/MockContextPayload` 新字段在 prompts/mock/executor/tests 一致；`drawNpc` 参数与 main.ts 调用一致；TILE=32 与画布 384×256/CSS 768 一致；broadcast 事件 targetIds=全员 与 MemoryWriter 的 targetIds 循环一致。
- **边界推演**：咖啡馆吧台 (2,1) 室内可通行、门 (3,2) 开口，e2e 路径必经门 ✓；玩家指令「去默语书店看书」含对象名「默语书店」→ mock 匹配 obj:bookstore ✓，120 游戏分钟内有效（runUntil(120) 内）✓；广播「派对」→ mockImportance 9 ✓；湖泊为装饰 zone，无 routine 引用，不影响 agent 行为 ✓；门墙模型下所有 routine 目标（吧台/柜台/画架/广场/公园/咖啡馆/书店/邮局）中心均为室内或 zone 可通行 ✓。
- **已知简化（有意为之）**：排队只挡 moving/acting（idle 者不阻塞，避免死锁）；玩家指令由 mock 按对象名匹配（真机走提示词最高优先级行）；昼夜为三档着色（无光照计算）；Phaser 正式版留 M2 后续（用户批准保留 Canvas）。
