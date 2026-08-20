# 小镇 2.0 · 阶段 A（40×40 大地图 + 摄像机 + 内饰导航）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 阶段 A：把小镇从 12×8 扩到 **40×40**（约 11 倍面积，商业街/广场/公园湖/农田/住宅区 + 家具对象），客户端加**摄像机系统**（拖拽/缩放/跟随选中 NPC），建筑**屋顶剖切**（NPC 在室内时隐藏屋顶显示内饰家具）。

**Architecture:** 世界数据仍走单一 40×40 网格（内饰=建筑内部的 room/furniture 对象，无需子地图）；GRID_W/H 改为 40 常量；墙模型不变（4×4 建筑有 2×2 室内）。客户端：视口 15×10 瓦片（画布 480×320、CSS 2x=960×640）；camera {x, y, zoom} 用 ctx.setTransform 渲染，拖拽平移 + 滚轮缩放（1x/2x）+ 跟随选中 NPC（clamp 世界边界）；命中换算做逆变换。屋顶剖切：每帧计算每个 building 是否含 NPC → 含则画室内（地板+家具+边框）而非屋顶。家具绘制在 render.ts 增加 sofa/bed/table/counter 像素样式。

**Tech Stack:** 既有 TS strict + Canvas 2D + esbuild。零新增依赖。

**Spec:** 用户批准的小镇 2.0 设计（40×40、摄像机、内饰导航；UI 美化/素材替换/天气属阶段 B/C）。

## Global Constraints

- TypeScript `strict: true`；全部新增代码注释与用户可见文案一律中文；零新增依赖
- GRID 40×40；所有 routine 目标可达（墙模型 + 门 + 房间/家具开口）；家具瓦片 walkable（阶段 B 才加坐/睡交互）
- 摄像机：视口 15×10；zoom ∈ {1, 2}；拖拽平移；跟随选中 NPC；clamp 到世界边界
- 屋顶剖切：building 内含 NPC 时渲染室内（不画屋顶/招牌）；家具样式 sofa/bed/table/counter 程序绘制
- 既有 104 测试不破坏（受影响者同步更新：snapshot gridW、acceptance-m2 墙坐标改为对象派生）
- 实现全部在 `town2-phase-a` 分支

---

### Task 1: 40×40 地图数据（seed 重布局 + GRID 常量 + 家具对象 + 测试同步）

**Files:**
- Modify: `src/core/world.ts`（GRID_W=40、GRID_H=40）、`src/engine/seed.ts`（TOWN_OBJECTS 全量替换为新布局 + 家具）、`tests/snapshot.test.ts`（gridW 12→40）、`tests/acceptance-m2.test.ts`（墙/门断言改为对象派生）

**Interfaces:**
- Produces：40×40 布局（建筑 4×4：咖啡馆 (8,8)/书店 (18,8)/邮局 (28,8)/面包店 (32,18)/诊所 (4,18)/四住宅角落；广场 (18,18,6,6)/公园 (6,26,10,6)/湖 (16,28,4,2)/农田 (24,24,8,6)/主街 (8,16,24,2)；家具：吧台/柜台/画架 + 四户床+沙发 + 咖啡馆两桌）

- [ ] **Step 1: 修改 src/core/world.ts**

```ts
export const GRID_W = 40;
export const GRID_H = 40;
```

- [ ] **Step 2: 替换 src/engine/seed.ts 的 TOWN_OBJECTS**

```ts
export const TOWN_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 40, h: 40 },
  // 商业街
  { id: 'obj:cafe', name: '林间咖啡馆', type: 'building', parentId: 'obj:town', x: 8, y: 8, w: 4, h: 4 },
  { id: 'obj:cafe_counter', name: '咖啡馆吧台', type: 'room', parentId: 'obj:cafe', x: 9, y: 8, w: 2, h: 1 },
  { id: 'obj:cafe_table1', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 8, y: 9, w: 1, h: 1 },
  { id: 'obj:cafe_table2', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 11, y: 9, w: 1, h: 1 },
  { id: 'obj:bookstore', name: '默语书店', type: 'building', parentId: 'obj:town', x: 18, y: 8, w: 4, h: 4 },
  { id: 'obj:bookstore_counter', name: '书店柜台', type: 'room', parentId: 'obj:bookstore', x: 19, y: 8, w: 2, h: 1 },
  { id: 'obj:post_office', name: '小镇邮局', type: 'building', parentId: 'obj:town', x: 28, y: 8, w: 4, h: 4 },
  { id: 'obj:bakery', name: '晨光面包店', type: 'building', parentId: 'obj:town', x: 32, y: 18, w: 4, h: 4 },
  { id: 'obj:clinic', name: '小镇诊所', type: 'building', parentId: 'obj:town', x: 4, y: 18, w: 4, h: 4 },
  // 公共区域
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 18, y: 18, w: 6, h: 6 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 6, y: 26, w: 10, h: 6 },
  { id: 'obj:lake', name: '湖边', type: 'zone', parentId: 'obj:town', x: 16, y: 28, w: 4, h: 2 },
  { id: 'obj:park_easel', name: '公园画架', type: 'furniture', parentId: 'obj:park', x: 7, y: 27, w: 1, h: 1 },
  { id: 'obj:farm', name: '晨光农田', type: 'zone', parentId: 'obj:town', x: 24, y: 24, w: 8, h: 6 },
  { id: 'obj:path_main', name: '主街', type: 'zone', parentId: 'obj:town', x: 8, y: 16, w: 24, h: 2 },
  // 住宅（四角）
  { id: 'obj:home_lin', name: '林晚晴的家', type: 'building', parentId: 'obj:town', x: 2, y: 2, w: 4, h: 4 },
  { id: 'obj:home_chen', name: '陈默的家', type: 'building', parentId: 'obj:town', x: 34, y: 2, w: 4, h: 4 },
  { id: 'obj:home_shen', name: '沈屿的家', type: 'building', parentId: 'obj:town', x: 2, y: 34, w: 4, h: 4 },
  { id: 'obj:home_zhou', name: '周岚的家', type: 'building', parentId: 'obj:town', x: 34, y: 34, w: 4, h: 4 },
  // 家具（床 + 沙发，各户一件）
  { id: 'obj:bed_lin', name: '床', type: 'furniture', parentId: 'obj:home_lin', x: 3, y: 2, w: 1, h: 2 },
  { id: 'obj:bed_chen', name: '床', type: 'furniture', parentId: 'obj:home_chen', x: 35, y: 2, w: 1, h: 2 },
  { id: 'obj:bed_shen', name: '床', type: 'furniture', parentId: 'obj:home_shen', x: 3, y: 34, w: 1, h: 2 },
  { id: 'obj:bed_zhou', name: '床', type: 'furniture', parentId: 'obj:home_zhou', x: 35, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_lin', name: '沙发', type: 'furniture', parentId: 'obj:home_lin', x: 2, y: 4, w: 2, h: 1 },
  { id: 'obj:sofa_chen', name: '沙发', type: 'furniture', parentId: 'obj:home_chen', x: 34, y: 4, w: 2, h: 1 },
  { id: 'obj:sofa_shen', name: '沙发', type: 'furniture', parentId: 'obj:home_shen', x: 2, y: 36, w: 2, h: 1 },
  { id: 'obj:sofa_zhou', name: '沙发', type: 'furniture', parentId: 'obj:home_zhou', x: 34, y: 36, w: 2, h: 1 },
];
```

（persona 的 routine 目标 id 不变；林/陈/沈/周出生点由 buildTown 按新住宅自动计算。）

- [ ] **Step 3: 更新 tests/snapshot.test.ts**

```ts
  assert.equal(snap.gridW, 40);
  assert.equal(snap.gridH, 40);
```

（原为 12/8。）

- [ ] **Step 4: 更新 tests/acceptance-m2.test.ts（墙/门断言对象派生）**

原断言块：

```ts
    assert.equal(world.walkable(3, 1), false); // 顶边是墙
    assert.equal(world.walkable(3, 2), true);  // 门开口
```

替换为：

```ts
    const cafe = world.getObject('obj:cafe')!;
    const door = { x: cafe.x + Math.floor(cafe.w / 2), y: cafe.y + cafe.h - 1 };
    assert.equal(world.walkable(door.x, door.y), true); // 门开口（底边中点）
    assert.equal(world.walkable(cafe.x, cafe.y), false); // 左上角顶边是墙（无房间覆盖）
```

- [ ] **Step 5: 运行确认通过 + 全量 + 类型检查**

```bash
node --no-warnings --import tsx --test tests/acceptance-m2.test.ts tests/snapshot.test.ts tests/pathfinding.test.ts
pnpm test
pnpm typecheck
```

Expected: 全量 104 通过（若 acceptance-m0/m1 有位置硬编码失败，按断言信息只改被测代码/对象派生断言，不放宽语义）。

- [ ] **Step 6: 提交**

```bash
git add src/core/world.ts src/engine/seed.ts tests/snapshot.test.ts tests/acceptance-m2.test.ts
git commit -m "feat(world): 40×40 大地图与家具对象"
```

---

### Task 2: 摄像机系统（拖拽/缩放/跟随）

**Files:**
- Modify: `src/web/client/main.ts`（camera 状态 + setTransform 渲染 + 拖拽/滚轮/跟随 + tileAt 逆变换 + 画布 480×320）、`public/style.css`（画布 CSS 960×640）

**Interfaces:**
- Produces（浏览器 TS，构建+typecheck 验证）：
  - `camera { x: number; y: number; zoom: 1 | 2 }`（瓦片坐标；视口 15×10）
  - 渲染：`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * TILE * zoom, -cam.y * TILE * zoom)` 后正常画世界；HUD 气泡等用重置 transform
  - 拖拽平移（pointerdown/move/up + **setPointerCapture 与 pointercancel/leave 复位**；位移按 CSS 缩放系数换算 `(e.clientX-lastX)/zoom * (canvas.width/rect.width) / TILE`；位移 <4px 视为点击）；滚轮 zoom 切换；跟随：选中 NPC 时 camera 平滑 lerp 至其瓦片中心（clamp 边界**随 zoom**：`[0, gridW - VIEW_W/zoom]`）
  - `tileAt(mouseX, mouseY)` 逆变换：`(mx - rect.left) / rect.width * canvas.width / (TILE*zoom) + cam.x`

- [ ] **Step 1: 修改 public/style.css（画布尺寸）**

```css
canvas {
  image-rendering: pixelated;
  width: 960px; height: 640px; max-width: 88vw; max-height: 80vh;
  border: 2px solid #3a4657; border-radius: 6px; background: #7fb069;
}
```

- [ ] **Step 2: 修改 src/web/client/main.ts（摄像机）**

按以下语义替换/新增（保持既有逻辑不动：SSE/气泡/面板/扮演/谣言横幅）：

```ts
// —— 摄像机 ——
const VIEW_W = 15; // 视口瓦片数
const VIEW_H = 10;
const camera = { x: 0, y: 0, zoom: 1 as 1 | 2 };
const MAX_CAM_X = 40 - VIEW_W;
const MAX_CAM_Y = 40 - VIEW_H;

function clampCam(): void {
  camera.x = Math.max(0, Math.min(MAX_CAM_X, camera.x));
  camera.y = Math.max(0, Math.min(MAX_CAM_Y, camera.y));
}

function applyCamera(): void {
  ctx.setTransform(camera.zoom, 0, 0, camera.zoom, -camera.x * TILE * camera.zoom, -camera.y * TILE * camera.zoom);
}

function resetCamera(): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
```

- initCanvas：`canvas.width = VIEW_W * TILE; canvas.height = VIEW_H * TILE;`（480×320）
- 每帧 loop：若有 selectedId → `camera.x += ((target.x - VIEW_W/2) - camera.x) * 0.08`（target = 该 NPC 插值瓦片坐标），y 同理，clampCam()
- draw()：`applyCamera()` → 画世界（地形/对象/agent/气泡）→ `resetCamera()` → 画 HUD 层（tooltip/banner 已用 reset 坐标）
- 指针事件：pointerdown 记录 lastX/lastY 与 moved=false；pointermove 若按下：dx=(e.clientX-lastX)/zoom → `camera.x -= dx/TILE; camera.y -= dy/TILE; clampCam();`，moved 位移>4 置 true，更新 last；pointerup 若 !moved → 视为 click（走原 onClick 命中，用 tileAt）
- wheel：deltaY<0 → zoom=1，>0 → zoom=2（clampCam）
- tileAt(ev)：`const rect = canvas.getBoundingClientRect(); const mx = (ev.clientX - rect.left) * (canvas.width / rect.width); const my = (ev.clientY - rect.top) * (canvas.height / rect.height); return { tx: Math.floor(mx / (TILE * camera.zoom) + camera.x), ty: Math.floor(my / (TILE * camera.zoom) + camera.y) };`
- onClick 与 mousemove 命中改用 tileAt（原换算替换）

（实现者按上述语义落地，保持类型与既有行为；hover tooltip/点击面板/扮演等逻辑不变。）

- [ ] **Step 3: 构建 + 类型检查 + 冒烟**

```bash
pnpm build:web
pnpm typecheck
node --no-warnings --import tsx src/cli/town-web.ts --port 8795 --db :memory: &
sleep 3
curl -s http://127.0.0.1:8795/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('grid:',s.gridW+'x'+s.gridH,'agents:',s.agents.length)})"
kill %1
```

Expected：构建/typecheck 0 错；快照 grid 40×40。

- [ ] **Step 4: 提交**

```bash
git add src/web/client/main.ts public/style.css
git commit -m "feat(web): 摄像机（拖拽/缩放/跟随）与视口渲染"
```

---

### Task 3: 屋顶剖切与内饰/家具绘制

**Files:**
- Modify: `src/web/client/render.ts`（drawObjectDetail 支持 4×4 建筑细节 + 家具样式 sofa/bed/table/counter；新增 drawInterior）、`src/web/client/main.ts`（每帧计算含 NPC 的建筑集合；对含 NPC 的建筑改画内饰）

**Interfaces:**
- Produces（浏览器 TS，构建+typecheck 验证）：
  - `drawInterior(ctx, building: ObjectView, objects: ObjectView[], nowMs)`：画室内地板（浅木色）+ 边框（墙）+ 内部 room/furniture 对象（家具样式）
  - 家具像素样式：bed（床头板+床单）、sofa（靠背+坐垫）、table（桌面+腿）、counter（台面+柜体）
  - main.ts：`buildingsWithAgents: Set<string>` 每帧从 snap.agents 瓦片命中建筑计算；drawObjectDetail 前判断：building 在集合中 → drawInterior 而非屋顶

- [ ] **Step 1: 修改 src/web/client/render.ts**

在 drawObjectDetail 的 building 分支前加判断参数，并新增家具样式与内饰函数（实现者按语义落地；签名兼容 main.ts 调用，新增导出）：

```ts
export function drawFurniture(ctx: CanvasRenderingContext2D, o: ObjectView): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.name === '床') {
    // 床头板 + 床单 + 枕头
    ctx.fillStyle = '#8a5a3a';
    ctx.fillRect(px, py, pw, 6);
    ctx.fillStyle = '#e8e0f0';
    ctx.fillRect(px, py + 6, pw, ph - 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px, py + 6, 10, 8);
  } else if (o.name === '沙发') {
    ctx.fillStyle = '#b35d45';
    ctx.fillRect(px, py, pw, 6); // 靠背
    ctx.fillStyle = '#d98a6a';
    ctx.fillRect(px, py + 6, pw, ph - 6);
    ctx.fillStyle = '#b35d45';
    ctx.fillRect(px, py + ph - 6, pw, 6);
  } else if (o.name === '咖啡桌') {
    ctx.fillStyle = '#6b4a2f';
    ctx.fillRect(px + 8, py + 8, pw - 16, ph - 16); // 桌面
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(px + 10, py + 20, 4, 8);
    ctx.fillRect(px + pw - 14, py + 20, 4, 8);
  } else {
    // 柜台/吧台类
    ctx.fillStyle = '#a97c50';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = '#e3b23c';
    ctx.fillRect(px + 4, py + 4, pw - 8, 4); // 台面高光
  }
}

export function drawInterior(
  ctx: CanvasRenderingContext2D,
  building: ObjectView,
  children: ObjectView[],
  nowMs: number
): void {
  const px = building.x * TILE, py = building.y * TILE, pw = building.w * TILE, ph = building.h * TILE;
  ctx.fillStyle = '#d9b48f';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = '#c9a06a';
  for (let x = px + 4; x < px + pw; x += 8) {
    for (let y = py + 4; y < py + ph; y += 8) ctx.fillRect(x, y, 3, 3); // 木纹点
  }
  for (const c of children) {
    if (c.type === 'furniture' || c.type === 'room') drawFurniture(ctx, c);
  }
  // 墙边框（门口留缝）
  ctx.strokeStyle = '#7a5a3a';
  ctx.lineWidth = 4;
  ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
  void nowMs;
}
```

- [ ] **Step 2: 修改 src/web/client/main.ts（剖切判断）**

- 每帧 draw() 前：`const inside = new Set<string>(); for (const a of snap.agents) { const o = findObjectAtTile(a.x, a.y); if (o && o.type === 'building') inside.add(o.id); }`
- drawObjects：building 分支 `if (inside.has(o.id)) drawInterior(ctx, o, childrenOf(o), nowMs); else 原屋顶绘制`

（childrenOf = snap.objects 中 parentId === o.id 的项；findObjectAtTile 用瓦片边界判定，优先面积最小者——与旧 objectAt 逻辑一致的客户端版本。）

- [ ] **Step 3: 构建 + 类型检查 + 冒烟**

```bash
pnpm build:web
pnpm typecheck
```

Expected：0 错。

- [ ] **Step 4: 提交**

```bash
git add src/web/client/render.ts src/web/client/main.ts
git commit -m "feat(web): 屋顶剖切与内饰家具绘制"
```

---

### Task 4: 大图运行验收 + 终审

**Files:**
- Create: `tests/acceptance-town2.test.ts`
- Modify: `README.md`（小镇 2.0 阶段 A 说明）

- [ ] **Step 1: 写 tests/acceptance-town2.test.ts**

```ts
// 小镇 2.0 阶段 A 验收：40×40 大图上全 routine 可达 + 家具可达 + 摄像机数据就绪

import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { buildTown, TOWN_OBJECTS } from '../src/engine/seed';
import { WorldLoop } from '../src/engine/loop';
import { AgentExecutor } from '../src/core/state-machine';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { PlayerDirector } from '../src/engine/player';
import { SocialTicker } from '../src/engine/social';

test('小镇2.0阶段A：大图全 routine 可达、NPC 行动、家具对象就位', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, mind, player);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);

  // ① 网格 40×40，家具对象就位
  assert.equal(world.allObjects().some((o) => o.id === 'obj:bed_lin'), true);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:sofa_zhou'), true);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:cafe_table1'), true);

  // ② 每个 agent 的每个 routine 目标都可达（A* 有解）
  for (const a of world.allAgents()) {
    const from = { x: a.x, y: a.y };
    for (const slot of a.persona.routine) {
      if (!slot.target) continue;
      const to = world.targetTile(slot.target);
      assert.ok(to, `${a.name} 目标不存在: ${slot.target}`);
      const path = world.findPath(from, to);
      assert.ok(path, `${a.name} → ${slot.target} 无路径`);
    }
  }

  // ③ 跑满 1 天：每个 agent 都有移动与互动事件（大图不卡死）
  await loop.runUntil(1440);
  const events = log.eventsForDay(1);
  for (const a of world.allAgents()) {
    const mine = events.filter((e) => e.actorId === a.id);
    assert.ok(mine.some((e) => e.type === 'move'), `${a.name} 从未移动`);
    assert.ok(mine.some((e) => e.type === 'interact'), `${a.name} 从未互动`);
    assert.notEqual(a.state, 'thinking', `${a.name} 卡在 thinking`);
  }

  // ④ 门模型在大图上成立：咖啡馆门开口、顶角是墙
  const cafe = world.getObject('obj:cafe')!;
  assert.equal(world.walkable(cafe.x + Math.floor(cafe.w / 2), cafe.y + cafe.h - 1), true);
  assert.equal(world.walkable(cafe.x, cafe.y), false);
});
```

- [ ] **Step 2: 运行验收**

```bash
node --no-warnings --import tsx --test tests/acceptance-town2.test.ts
```

Expected: 1 通过。若失败按断言修被测代码，不放宽断言。

- [ ] **Step 3: 更新 README.md**

```markdown
## 小镇 2.0（阶段 A）
- 40×40 大地图（商业街/广场/公园湖/农田/住宅区）；摄像机拖拽/缩放/跟随；屋顶剖切看内饰
```

- [ ] **Step 4: 全量验证**

```bash
pnpm build:web
pnpm test
pnpm typecheck
git status
```

Expected: 全量通过（105）；typecheck 0；工作区干净。

- [ ] **Step 5: 提交**

```bash
git add tests/acceptance-town2.test.ts README.md
git commit -m "test: 小镇2.0阶段A验收（大图可达性/行动/家具）"
```

---

## 自检记录（写完后已核对）

- **Spec 覆盖**：40×40 布局（建筑 4×4 五商业 + 四住宅角落、六公共区、八件家具）；摄像机（15×10 视口/zoom 1-2/拖拽/跟随/边界 clamp/逆变换命中）；屋顶剖切（building 内含 NPC → drawInterior）；验收（全 routine A* 可达、1 天不卡、门模型）。
- **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码或明确语义规格（A2/A3 客户端渲染按语义落地并构建验证）。
- **类型一致性**：GRID 40 与 camera MAX 常量一致；drawInterior/drawFurniture 导出与 main.ts 调用一致；acceptance 用对象派生坐标（不再硬编码墙位置）。
- **边界推演**：周岚家 (34,34) → 邮局 (28,8) 约 32 瓦片行程，60x 下 32 分钟可达；所有 routine 目标中心均为室内/房间/zone 可通行（4×4 建筑有 2×2 室内 + 门 + 房间开口）；zoom=2 时视口 7.5×5 瓦片（15/2 向下取整渲染即可，命中换算按 float 处理）。
- **已知简化（有意为之）**：内饰不分子地图（同网格 + 剖切，阶段 B 再添加坐/睡）；zoom 仅 1/2 两档；摄像机跟随只跟选中 NPC。
