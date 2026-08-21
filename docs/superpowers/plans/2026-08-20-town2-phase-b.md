# 小镇 2.0 阶段 B 实施计划（全屏地图 + 全属性档案 + 家具交互特效 + 环境动态）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **模型策略（控制器）**：指令明确的任务（Task 1~5 实现）可派 `provider: deepseek-official, model: deepseek-v4-flash` 子代理省 token；评审子代理与疑难修复用默认 deepseek-v4-pro。已实测 flash 透传可用。

**Goal:** 把小镇扩到 48×44 并全屏铺满（无拖拽）、给 4 位 NPC 全属性档案、为家具交互加星露谷级动作特效、加环境动态特效基础层。

**Architecture:** 引擎层扩图 + water 阻挡；客户端相机改为 fit-to-screen（新增纯函数 `camera.ts`）；新增独立粒子系统 `effects.ts`（轻量、上限 512）；渲染层加水面/地形带/昼夜连续过渡/灯火；Persona 扩展属性经 `personaText` 注入提示词、经快照 AgentView 供客户端档案页渲染。

**Tech Stack:** TypeScript strict、Node 22 + node:test + tsx、esbuild、零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-20-town2-phase-b-design.md`（任务据此展开，实现者需先读）

## Global Constraints

- 零运行时依赖：不得引入 npm 包；`pnpm test` 用 `node --no-warnings --import tsx --test "tests/*.test.ts"`。
- TS strict：`pnpm typecheck`（`tsc --noEmit`）必须 0 错误。
- 禁止 sandbox 升级请求（approval prompts 已禁用）；所有写操作直接执行。
- 坐标/常量：瓦片 32px（`TILE`）；一天 1440 分钟；网格常量 `GRID_W/GRID_H` 从 `src/core/world.ts` 导入，不得在别处硬编码 40。
- 中文注释与命名风格沿用现有代码；提交信息 `feat:`/`fix:`/`test:` 前缀。
- 客户端纯逻辑必须抽成可 node 测试的纯函数（DOM 访问只发生在 `main.ts` 顶层与事件回调内）。
- 特效与布局全部客户端渲染层实现，**不改引擎状态机**（interact 已支持任意家具目标）。

---

### Task 1: 地图扩容 48×44 + 河流不可走

**Files:**
- Modify: `src/core/types.ts`（ObjectType 加 `'water'`，约第 70 行）
- Modify: `src/core/world.ts:6-7, 21-70`（GRID_W/H + computeWalkable water 阻挡）
- Modify: `src/engine/seed.ts:6-39`（obj:town 尺寸 + 新地形带对象）
- Modify: `tests/acceptance-town2.test.ts:30-31`（网格断言 48/44）
- Test: `tests/world.test.ts`（如需；跑全量后按失败处补）

**Interfaces:**
- Consumes: `WorldObject`、`computeWalkable` 现状（building 边界 blocked；room/furniture 开口）
- Produces: `GRID_W = 48`、`GRID_H = 44`；`ObjectType` 含 `'water'`；种子对象：`obj:orchard`、`obj:forest_ne`、`obj:river`(water)、`obj:farm_east`、`obj:meadow_s`、`obj:lamp_plaza`、`obj:lamp_street1`、`obj:lamp_street2`、`obj:lamp_lake`（Task 5 消费 lamp）

- [ ] **Step 1: 写失败测试**

`tests/acceptance-town2.test.ts` 第 30-31 行改为：

```ts
  assert.equal(GRID_W, 48);
  assert.equal(GRID_H, 44);
```

同文件在 ① 断言块（第 32 行后）追加：

```ts
  assert.equal(world.allObjects().some((o) => o.id === 'obj:river'), true);
  assert.equal(world.allObjects().some((o) => o.id === 'obj:lamp_plaza'), true);
```

在 ④ 门模型断言后追加河流阻挡断言：

```ts
  const river = world.getObject('obj:river')!;
  assert.equal(river.type, 'water');
  assert.equal(world.walkable(river.x, river.y), false);
  assert.equal(world.walkable(river.x + river.w - 1, river.y + river.h - 1), false);
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test`
Expected: FAIL——`assert.equal(GRID_W, 48)` 失败（当前 40），river 对象不存在报错。

- [ ] **Step 3: 实现**

`src/core/types.ts` 第 70 行：

```ts
export type ObjectType = 'town' | 'building' | 'room' | 'furniture' | 'zone' | 'water';
```

`src/core/world.ts` 第 6-7 行：

```ts
export const GRID_W = 48;
export const GRID_H = 44;
```

`computeWalkable`（第 21 行）在建筑边界处理之后、第 33 行之前插入：

```ts
    // 1.5) 水域瓦片全部阻挡（河流不可走，无 routine 端点依赖）
    for (const o of this.objects.values()) {
      if (o.type !== 'water') continue;
      for (let x = o.x; x < o.x + o.w; x++) {
        for (let y = o.y; y < o.y + o.h; y++) this.blocked.add(key({ x, y }));
      }
    }
```

`src/engine/seed.ts` 第 7 行 `obj:town` 改为 `w: 48, h: 44`；在数组末尾（第 38 行沙发对象后）追加：

```ts
  // 阶段 B 扩容地形带（x≥40 或 y≥40，纯装饰/水域；果园树为 zone 不阻挡）
  { id: 'obj:orchard', name: '西坡果园', type: 'zone', parentId: 'obj:town', x: 40, y: 2, w: 8, h: 10 },
  { id: 'obj:forest_ne', name: '东山树林', type: 'zone', parentId: 'obj:town', x: 42, y: 14, w: 6, h: 8 },
  { id: 'obj:river', name: '小镇河', type: 'water', parentId: 'obj:town', x: 8, y: 40, w: 40, h: 4 },
  { id: 'obj:farm_east', name: '东侧农田', type: 'zone', parentId: 'obj:town', x: 40, y: 24, w: 8, h: 10 },
  { id: 'obj:meadow_s', name: '南坡草地', type: 'zone', parentId: 'obj:town', x: 0, y: 40, w: 8, h: 4 },
  // 路灯（Task 5 灯火辉光用；zone 1×1 不阻挡）
  { id: 'obj:lamp_plaza', name: '广场路灯', type: 'zone', parentId: 'obj:town', x: 17, y: 18, w: 1, h: 1 },
  { id: 'obj:lamp_street1', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 10, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_street2', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 29, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_lake', name: '湖边路灯', type: 'zone', parentId: 'obj:town', x: 16, y: 27, w: 1, h: 1 },
```

- [ ] **Step 4: 跑全量测试**

Run: `pnpm test && pnpm typecheck`
Expected: PASS。若有其他测试硬编码 40 或枚举 ObjectType 缺 `'water'`（如 world/snapshot/seed 相关），按语义更新断言后重跑直至全绿。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(town2-b): 地图扩容 48×44 + 河流不可走 + 路灯/地形带种子对象"
```

---

### Task 2: 全屏铺满相机 + 悬浮 UI 布局（取消拖拽）

**Files:**
- Create: `src/web/client/camera.ts`
- Create: `tests/camera-fit.test.ts`
- Modify: `src/web/client/main.ts`（第 46-57、90-104、175-219、254-264、437-448、450-465 行区域）
- Modify: `public/index.html`（画布属性、#side 结构、全图按钮）
- Modify: `public/style.css`（全屏布局重写）

**Interfaces:**
- Consumes: `snap.gridW/gridH`（Task 1 后为 48/44）；`TILE`（`render.ts` 导出 32）
- Produces: `camera.ts` 导出 `computeFit`、`zoomScale`、`zoomOffsets`（签名见下）；`main.ts` 中 `camera` 状态改为 `{ scale: number; offX: number; offY: number }`

- [ ] **Step 1: 写失败测试** `tests/camera-fit.test.ts`

```ts
// 全屏相机纯函数：fit 缩放 / 缩放钳制 / 光标锚定偏移
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeFit, zoomScale, zoomOffsets } from '../src/web/client/camera';

test('computeFit：48×44 网格在 1920×1080 窗口按高度铺满并居中', () => {
  const c = computeFit(1920, 1080, 48, 44, 32);
  assert.equal(c.scale, 1080 / (44 * 32)); // min(1920/1536, 1080/1408)
  assert.equal(c.offX, (1920 - 48 * 32 * c.scale) / 2);
  assert.equal(c.offY, 0);
});

test('computeFit：窄窗口按宽度铺满', () => {
  const c = computeFit(800, 600, 48, 44, 32);
  assert.equal(c.scale, 800 / (48 * 32));
});

test('zoomScale：钳制在 [fit, fit×4]', () => {
  assert.equal(zoomScale(1, 2, 1), 2);
  assert.equal(zoomScale(1, 0.5, 1), 1);
  assert.equal(zoomScale(3.9, 2, 1), 4);
  assert.equal(zoomScale(0.5, 0.5, 0.5), 0.5);
});

test('zoomOffsets：缩放后光标下的世界点不动', () => {
  const fit = computeFit(1920, 1080, 48, 44, 32);
  const z = zoomOffsets(400, 300, fit.scale, 2 * fit.scale, fit.offX, fit.offY, 32);
  const wBefore = (400 - fit.offX) / (fit.scale * 32);
  const wAfter = (400 - z.offX) / (2 * fit.scale * 32);
  assert.ok(Math.abs(wBefore - wAfter) < 1e-9);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --no-warnings --import tsx --test tests/camera-fit.test.ts`
Expected: FAIL——模块不存在。

- [ ] **Step 3: 实现** `src/web/client/camera.ts`

```ts
// 全屏相机纯函数：fit-to-screen 缩放与光标锚定缩放（无 DOM 依赖，可 node 测试）

export interface FitCamera { scale: number; offX: number; offY: number }

/** 整图适配窗口：scale = min(w/gridW, h/gridH)，居中（信箱留白在两侧或上下） */
export function computeFit(viewW: number, viewH: number, gridW: number, gridH: number, tile: number): FitCamera {
  const scale = Math.min(viewW / (gridW * tile), viewH / (gridH * tile));
  return {
    scale,
    offX: (viewW - gridW * tile * scale) / 2,
    offY: (viewH - gridH * tile * scale) / 2,
  };
}

/** 缩放系数钳制到 [fit, fit×4] */
export function zoomScale(current: number, factor: number, fitScale: number): number {
  return Math.max(fitScale, Math.min(fitScale * 4, current * factor));
}

/** 以屏幕锚点 (anchorX,anchorY) 为中心缩放后的新偏移：锚点下的世界坐标保持不变 */
export function zoomOffsets(
  anchorX: number, anchorY: number,
  prevScale: number, newScale: number,
  prevOffX: number, prevOffY: number,
  tile: number
): { offX: number; offY: number } {
  // 锚点世界坐标守恒：wx = (ax - offX)/(scale*tile)
  const wx = (anchorX - prevOffX) / (prevScale * tile);
  const wy = (anchorY - prevOffY) / (prevScale * tile);
  return {
    offX: anchorX - wx * newScale * tile,
    offY: anchorY - wy * newScale * tile,
  };
}
```

测试相应改为：

```ts
test('zoomOffsets：缩放后光标下的世界点不动', () => {
  const fit = computeFit(1920, 1080, 48, 44, 32);
  const z = zoomOffsets(400, 300, fit.scale, 2 * fit.scale, fit.offX, fit.offY, 32);
  const wBefore = (400 - fit.offX) / (fit.scale * 32);
  const wAfter = (400 - z.offX) / (2 * fit.scale * 32);
  assert.ok(Math.abs(wBefore - wAfter) < 1e-9);
});
```

- [ ] **Step 4: 运行确认通过**

Run: `node --no-warnings --import tsx --test tests/camera-fit.test.ts`
Expected: PASS。

- [ ] **Step 5: main.ts 相机重写**

`src/web/client/main.ts` 改动清单（逐段替换）：

(a) 顶部 import 增加：

```ts
import { computeFit, zoomScale, zoomOffsets, type FitCamera } from './camera';
```

(b) 删除第 46-57 行 `VIEW_W/VIEW_H/camera/pointer/drag` 状态，替换为：

```ts
// —— 全屏相机（fit-to-screen，无拖拽）——
const camera: FitCamera = { scale: 1, offX: 0, offY: 0 };
let fitScale = 1;
```

(c) 删除 `initCanvas`（90-93）与 `clampCam`（95-100）与 `applyCamera/resetCamera`（102-108），替换为：

```ts
function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  fitCamera();
}

function fitCamera(): void {
  if (!snap) return;
  const dpr = window.devicePixelRatio || 1;
  const f = computeFit(canvas.width / dpr, canvas.height / dpr, snap.gridW, snap.gridH, TILE);
  fitScale = f.scale;
  camera.scale = fitScale;
  camera.offX = f.offX * dpr;
  camera.offY = f.offY * dpr;
}

function applyCamera(): void {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(camera.scale * dpr, 0, 0, camera.scale * dpr, camera.offX, camera.offY);
}

function resetCamera(): void { ctx.setTransform(1, 0, 0, 1, 0, 0); }
```

(d) `main()` 中 `initCanvas();` 改为 `resizeCanvas(); window.addEventListener('resize', resizeCanvas);`；删除 `canvas.addEventListener('pointerdown'...)` 等 5 行拖拽监听（第 63-67 行），保留 `mousemove/mouseleave` 与 wheel；wheel 监听改为 `canvas.addEventListener('wheel', onWheel, { passive: false });`；增加 `canvas.addEventListener('dblclick', () => fitCamera());`。

(e) 删除 `onPointerDown/onPointerMove/onPointerUp/onPointerCancel`（175-212），删除旧 `onWheel`（214-219），替换为：

```ts
function onWheel(e: WheelEvent): void {
  if (!snap) return;
  e.preventDefault();
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const ax = (e.clientX - rect.left) * dpr;
  const ay = (e.clientY - rect.top) * dpr;
  const factor = e.deltaY < 0 ? 1.25 : 0.8;
  const next = zoomScale(camera.scale, factor, fitScale * dpr);
  const off = zoomOffsets(ax, ay, camera.scale, next, camera.offX, camera.offY, TILE);
  camera.scale = next;
  camera.offX = off.offX;
  camera.offY = off.offY;
}
```

(f) 删除 `onClick` 前的 `dragged` 语义依赖：`onClick` 保持现状（仅点击选择）；`tileAt`（254-264）重写：

```ts
function tileAt(ev: MouseEvent): { px: number; py: number; tx: number; ty: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const px = (ev.clientX - rect.left) * dpr;
  const py = (ev.clientY - rect.top) * dpr;
  return {
    px, py,
    tx: Math.floor((px - camera.offX) / (TILE * camera.scale)),
    ty: Math.floor((py - camera.offY) / (TILE * camera.scale)),
  };
}
```

(g) `loop()`（423-448）删除「跟随选中 NPC」块（437-445），保留 display 插值/bubble 清理/banner 清理/`draw()`；`draw()` 内 `applyCamera()` 后全图绘制（世界坐标不变，无需修改 drawTerrain/drawObjects/drawAgents 逻辑）。

(h) 快照到达时若无相机初始化（`snap` 首次加载），在 `main()` 首个 fetch 后调用 `resizeCanvas()`（已覆盖）；`applySnapshot` 后若 `gridW/H` 变化调用 `fitCamera()`（在 `applySnapshot` 末尾加一行）。

- [ ] **Step 6: index.html + style.css 悬浮布局**

`public/index.html`：`<canvas id="game" width="384" height="256"></canvas>` 改为 `<canvas id="game"></canvas>`；`#hud` 内 controls 末尾追加 `<button id="fit-view">🗺 全图</button>`；`<aside id="side">` 结构不变但 CSS 定位为悬浮；`#ticker` 保持。

`main.ts` 的 `bindControls()` 追加：

```ts
  document.getElementById('fit-view')!.addEventListener('click', () => fitCamera());
```

`public/style.css` 全量重写：

```css
/* 全屏地图布局：画布铺满窗口，面板/HUD 悬浮其上 */
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; background: #1a2a4a; font-family: monospace; }
#game { position: fixed; inset: 0; display: block; cursor: pointer; }
#hud { position: fixed; top: 10px; left: 10px; z-index: 10; display: flex; gap: 8px; align-items: center;
  background: rgba(20,26,34,0.85); padding: 6px 10px; border-radius: 8px; color: #e8e2d4; }
#hud button { background: #3a4657; color: #e8e2d4; border: 1px solid #56637a; border-radius: 5px; padding: 4px 8px; cursor: pointer; }
#hud button:hover { background: #4a5870; }
#side { position: fixed; top: 10px; right: 10px; z-index: 10; width: 320px; max-height: calc(100vh - 120px);
  display: flex; flex-direction: column; }
#panel { background: rgba(20,26,34,0.88); border: 1px solid #3a4657; border-radius: 10px;
  box-shadow: 0 4px 18px rgba(0,0,0,0.45); overflow: hidden; display: flex; flex-direction: column; }
#panel-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 6px; background: rgba(0,0,0,0.25); }
#panel-tabs .tab { flex: 1; background: #2a3446; color: #c9d3e8; border: 1px solid #3a4657; border-radius: 5px;
  padding: 5px 4px; cursor: pointer; font-size: 12px; }
#panel-tabs .tab.active { background: #e3b23c; color: #1a1a1a; border-color: #e3b23c; }
#panel-body { padding: 10px; overflow-y: auto; color: #e8e2d4; font-size: 13px; line-height: 1.6; }
#panel-body h3 { margin-bottom: 6px; color: #f5e9c8; }
#panel-body .label { color: #9fb8d8; }
.mem-item { margin: 6px 0; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 6px; }
.bar { height: 12px; background: #2a3446; border-radius: 6px; margin: 4px 0; position: relative; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 6px; }
.bar-fill.love { background: #e8708a; } .bar-fill.resp { background: #6ba3d9; }
.bar-fill.skill { background: #e3b23c; } .bar-fill.pers { background: #7fbf7f; }
.bar span { position: absolute; right: 6px; top: -1px; font-size: 10px; color: #fff; text-shadow: 0 0 2px #000; }
.tag { display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px; background: #3a4657; border-radius: 10px; font-size: 12px; }
.profile-card { background: rgba(255,255,255,0.06); border: 1px solid #3a4657; border-radius: 8px; padding: 10px; margin: 8px 0; }
#ticker { position: fixed; left: 10px; bottom: 10px; z-index: 10; max-width: 40vw;
  background: rgba(20,26,34,0.82); border-radius: 8px; padding: 8px 10px; color: #c9d3e8; font-size: 12px; }
#play-bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 10;
  display: flex; gap: 6px; background: rgba(20,26,34,0.88); padding: 6px 8px; border-radius: 8px; }
#play-bar input { width: 300px; padding: 6px 8px; border-radius: 5px; border: 1px solid #56637a; background: #2a3446; color: #e8e2d4; }
#play-bar button { background: #3a4657; color: #e8e2d4; border: 1px solid #56637a; border-radius: 5px; padding: 6px 10px; cursor: pointer; }
```

- [ ] **Step 7: 构建 + 全量验证**

Run: `pnpm typecheck && pnpm test && pnpm build:web`
Expected: 全绿、构建产出 `public/client.js`。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(town2-b): 全屏铺满相机（fit-to-screen/滚轮缩放/取消拖拽）+ 悬浮HUD布局"
```

---

### Task 3: Agent 全属性档案（类型 + 4 份档案 + 提示词注入 + 快照 + 档案页）

**Files:**
- Modify: `src/core/types.ts:35-49`（Appearance + Persona 扩展）
- Modify: `src/engine/seed.ts:41-100`（4 份 persona 档案填充 + background 扩写）
- Modify: `src/llm/prompts.ts:47-49`（personaText 注入）
- Modify: `src/web/snapshot.ts:7-21, 47-64`（AgentView 扩展）
- Modify: `src/web/client/main.ts:6-12, 278-312`（AgentView 接口 + renderProfile）
- Modify: `public/index.html:24-27`（档案 tab）
- Test: `tests/profile.test.ts`（新建）；`tests/prompts.test.ts`、`tests/snapshot.test.ts` 跑后按失败更新
- Modify: `public/style.css`（追加 `.bar-fill.skill/.bar-fill.pers/.tag/.profile-card`——若 Task 2 未含则此处加）

**Interfaces:**
- Consumes: `Persona`（Task 1 后含 routine）；`personaText` 现有签名
- Produces: `Persona.gender/appearance/hobbies/skills/values/motivation`；`AgentView` 新字段 `age/gender/appearance/hobbies/skills/values/motivation/personality`；`renderProfile(body, a)`（Task 4/5 不依赖）

- [ ] **Step 1: 写失败测试** `tests/profile.test.ts`

```ts
// 阶段 B：4 份 persona 全属性档案完整性 + 快照 AgentView 档案字段
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED } from '../src/engine/seed';
import { buildTown } from '../src/engine/seed';
import { TimeEngine } from '../src/core/time';
import { buildSnapshot } from '../src/web/snapshot';

test('每份 persona 档案字段完整且合法', () => {
  for (const p of DEFAULT_SEED.personas) {
    assert.ok(p.gender === '男' || p.gender === '女', `${p.name} gender 非法`);
    assert.ok(p.appearance.hairStyle.length > 0, `${p.name} 缺发型`);
    assert.ok(p.appearance.hairColor.length > 0, `${p.name} 缺发色`);
    assert.ok(p.appearance.skinTone.length > 0, `${p.name} 缺肤色`);
    assert.ok(p.appearance.outfit.length > 0, `${p.name} 缺服装`);
    assert.ok(p.hobbies.length >= 2, `${p.name} 爱好不足`);
    assert.ok(Object.keys(p.skills).length >= 3, `${p.name} 技能不足`);
    for (const v of Object.values(p.skills)) {
      assert.ok(v >= 0 && v <= 10, `${p.name} 技能数值越界`);
    }
    assert.ok(p.values.length >= 2, `${p.name} 价值观不足`);
    assert.ok(p.motivation.length >= 10, `${p.name} 动机过短`);
    assert.ok(p.background.length >= 80, `${p.name} 背景故事过短`);
  }
});

test('快照 AgentView 携带档案全字段', () => {
  const world = buildTown();
  const time = new TimeEngine(60);
  const snap = buildSnapshot(world, time, false, 1);
  const a = snap.agents[0];
  assert.ok(['男', '女'].includes(a.gender));
  assert.ok(a.hobbies.length >= 2);
  assert.ok(Object.keys(a.skills).length >= 3);
  assert.ok(a.values.length >= 2);
  assert.ok(a.motivation.length > 0);
  assert.ok(a.personality && typeof a.personality.extraversion === 'number');
  assert.ok(a.appearance && a.appearance.outfit.length > 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --no-warnings --import tsx --test tests/profile.test.ts`
Expected: FAIL——gender 等字段不存在（TS 编译亦失败）。

- [ ] **Step 3: 实现类型 + 档案**

`src/core/types.ts` 在 `Personality` 后新增，并扩展 `Persona`（第 35-49 行）：

```ts
export interface Appearance {
  hairStyle: string;
  hairColor: string;
  skinTone: string;
  outfit: string;
}

export interface Persona {
  name: string;
  age: number;
  occupation: string;
  gender: '男' | '女';
  appearance: Appearance;
  hobbies: string[];              // 2~4 项
  skills: Record<string, number>; // 0..10
  values: string[];               // 2~4 条
  motivation: string;             // 一句话动机
  background: string;
  traits: string[];
  goals: string[];
  speechStyle: string;
  routine: RoutineSlot[];
  greetingPool?: string[];
  personality?: Personality;
}
```

`src/engine/seed.ts` 4 份 persona 全量替换（保留既有 routine/greetingPool/personality 不动，仅插入新字段 + 扩写 background）：

```ts
export const LIN_PERSONA: Persona = {
  name: '林晚晴', age: 32, occupation: '咖啡馆老板', gender: '女',
  appearance: { hairStyle: '齐肩短发', hairColor: '深棕色', skinTone: '浅麦色', outfit: '米色围裙配深蓝衬衫' },
  hobbies: ['手冲咖啡', '观察路人', '写小说'],
  skills: { 手冲咖啡: 9, 倾听: 8, 写作: 7, 烘焙: 6 },
  values: ['咖啡馆是小镇的客厅', '真诚待人', '慢生活'],
  motivation: '把咖啡馆经营成小镇最温暖的公共空间，并写下小镇人物的故事。',
  background: '五年前从大城市回到小镇，在中央大街开了「林间咖啡馆」。她记得每一位常客的口味，也悄悄在笔记本里记下小镇人物的故事。陈默是她学生时代的老同学，这些年两人因为书店与咖啡馆的生意往来重新走近，却又总隔着一层没说出口的话。她想把咖啡馆经营成小镇的公共客厅，也盼着自己写的那本小说有一天能出版。',
  traits: ['温和', '健谈', '有点理想主义'],
  goals: ['把咖啡馆经营成小镇的公共客厅', '写一本关于小镇人物的小说'],
  speechStyle: '语气轻柔，爱用比喻',
  routine: [/* 保持原样（Task 4 会加床/沙发槽） */],
  greetingPool: [/* 保持原样 */],
  personality: { extraversion: 0.7, empathy: 0.9, honesty: 0.8, curiosity: 0.6, patience: 0.7 },
};

export const CHEN_PERSONA: Persona = {
  name: '陈默', age: 33, occupation: '书店老板', gender: '男',
  appearance: { hairStyle: '利落短发', hairColor: '黑色', skinTone: '偏白', outfit: '深灰开衫配白衬衫' },
  hobbies: ['读书', '整理书单', '下棋'],
  skills: { 选书推荐: 9, 记忆力: 8, 下棋: 6, 聊天: 4 },
  values: ['书是安静的陪伴', '少说多做', '诚信经营'],
  motivation: '让书店成为小镇的精神角落，修复与林晚晴逐渐疏远的旧谊。',
  background: '林晚晴的老同学，沉默寡言，却熟悉小镇每一个人的阅读口味。他把「默语书店」经营成小镇的沙龙，新书到货时总会在门口的小黑板上写一句推荐语。对林晚晴，他嘴上不说，却总在她来翻书时悄悄留一壶热水。最近他反复想着学生时代没送出去的那封信，犹豫要不要把当年的心意补上。',
  traits: ['内敛', '细心', '爱书成癖'],
  goals: ['把书店办成小镇的沙龙', '修复与林晚晴逐渐疏远的关系'],
  speechStyle: '话不多，但句句实在',
  routine: [/* 保持原样 */],
  greetingPool: [/* 保持原样 */],
  personality: { extraversion: 0.3, empathy: 0.7, honesty: 0.9, curiosity: 0.7, patience: 0.9 },
};

export const SHEN_PERSONA: Persona = {
  name: '沈屿', age: 35, occupation: '画家', gender: '男',
  appearance: { hairStyle: '微卷长发', hairColor: '栗色', skinTone: '浅麦色', outfit: '白色衬衫配旧围巾' },
  hobbies: ['油画写生', '收集明信片', '弹吉他'],
  skills: { 油画: 9, 观察力: 8, 吉他: 6, 社交: 7 },
  values: ['自由比稳定重要', '记录小镇的美', '真诚的表达'],
  motivation: '完成小镇系列画展，画出林晚晴开咖啡馆的样子。',
  background: '旅居小镇的画家，每天清晨在公园支起画架写生，午后到咖啡馆喝咖啡画速写。他喜欢把小镇的光线画成柠檬黄色，也悄悄给咖啡馆老板娘林晚晴画过许多张侧影。他计划在入冬前办一场小镇系列画展，最想展出的一幅，是林晚晴站在吧台后擦杯子的样子。',
  traits: ['浪漫', '随性', '观察力强'],
  goals: ['完成小镇系列画展', '画出林晚晴开咖啡馆的样子'],
  speechStyle: '热情洋溢，喜欢描述颜色',
  routine: [/* 保持原样 */],
  greetingPool: [/* 保持原样 */],
  personality: { extraversion: 0.8, empathy: 0.6, honesty: 0.5, curiosity: 0.9, patience: 0.5 },
};

export const ZHOU_PERSONA: Persona = {
  name: '周岚', age: 28, occupation: '邮差', gender: '女',
  appearance: { hairStyle: '高马尾', hairColor: '黑色', skinTone: '小麦色', outfit: '邮差绿制服配红围巾' },
  hobbies: ['骑自行车', '打听消息', '集邮'],
  skills: { 骑行: 9, 认路: 9, 集邮: 8, 保密: 3 },
  values: ['每一封信都要送到', '消息灵通是责任', '朋友的事就是我的事'],
  motivation: '把每一封信准时送到，并撮合沈屿与林晚晴。',
  background: '小镇唯一的邮差，骑着一辆绿色自行车穿行每一条街巷，是小镇消息最灵通的人。她收藏邮票也收藏故事，谁家的事都瞒不过她。最近她最大的心事是沈屿和林晚晴——一个天天画人家，一个天天煮咖啡给人家喝，就是没人先开口。她决定利用送信之便，给这对木头人制造点机会。',
  traits: ['爽朗', '热心', '藏不住话'],
  goals: ['把每一封信准时送到', '撮合沈屿与林晚晴'],
  speechStyle: '语速快，爱开玩笑',
  routine: [/* 保持原样 */],
  greetingPool: [/* 保持原样 */],
  personality: { extraversion: 0.9, empathy: 0.8, honesty: 0.4, curiosity: 0.7, patience: 0.6 },
};
```

> 注意：`routine`/`greetingPool` 用原文件内容原样保留（复制现有数组，不要删改——Task 4 才加床/沙发槽）。

- [ ] **Step 4: 提示词注入**

`src/llm/prompts.ts:47-49` 替换：

```ts
export function personaText(p: Persona): string {
  const skills = Object.entries(p.skills).map(([k, v]) => `${k}(${v}/10)`).join('、');
  return `${p.name}，${p.age} 岁，${p.gender}，${p.occupation}。${p.background} 性格：${p.traits.join('、')}。爱好：${p.hobbies.join('、')}。技能：${skills}。价值观：${p.values.join('、')}。动机：${p.motivation}。目标：${p.goals.join('；')}。`;
}
```

`buildActionDecisionMessages`（第 57-67 行 system 数组）在 `你的一天安排…` 行后追加：

```ts
    `你的价值观（决策时保持一致）：${p.values.join('、')}`,
```

- [ ] **Step 5: 快照扩展**

`src/web/snapshot.ts` AgentView（第 7-21 行）追加字段：

```ts
export interface AgentView {
  id: string;
  name: string;
  occupation: string;
  age: number;
  gender: string;
  appearance: { hairStyle: string; hairColor: string; skinTone: string; outfit: string };
  hobbies: string[];
  skills: Record<string, number>;
  values: string[];
  motivation: string;
  personality: { extraversion: number; empathy: number; honesty: number; curiosity: number; patience: number };
  state: Agent['state'];
  x: number;
  y: number;
  locationId: string;
  locationName: string;
  verb: string;
  thought: string | null;
  targetName: string | null;
  spriteIndex: number;
  background: string;
}
```

`buildSnapshot`（第 47-65 行）映射追加：

```ts
      age: a.persona.age,
      gender: a.persona.gender,
      appearance: a.persona.appearance,
      hobbies: a.persona.hobbies,
      skills: a.persona.skills,
      values: a.persona.values,
      motivation: a.persona.motivation,
      personality: a.persona.personality ?? { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 },
```

- [ ] **Step 6: 客户端档案页**

`src/web/client/main.ts` 顶部 `interface AgentView`（第 6-12 行）追加与 snapshot 同名同型字段（`age/gender/appearance/hobbies/skills/values/motivation/personality`）。

`public/index.html` 面板 tabs（第 22-28 行）在「详情」后追加：

```html
          <button data-tab="profile" class="tab">档案</button>
```

`updatePanel`（第 296-297 行）改为：

```ts
  if (activeTab === 'detail') renderDetail(body, a);
  else if (activeTab === 'profile') renderProfile(body, a);
  else void renderMind(body, a.id, activeTab);
```

新增 `renderProfile`（放在 `renderDetail` 后）：

```ts
function renderProfile(body: HTMLElement, a: AgentView): void {
  const skillBars = Object.entries(a.skills).map(([k, v]) =>
    `<div class="mem-item">${escapeHtml(k)}<div class="bar"><div class="bar-fill skill" style="width:${v * 10}%"></div><span>${v}/10</span></div></div>`).join('');
  const dims: [string, number][] = [
    ['外向', a.personality.extraversion], ['共情', a.personality.empathy], ['诚实', a.personality.honesty],
    ['好奇', a.personality.curiosity], ['耐心', a.personality.patience],
  ];
  const persBars = dims.map(([k, v]) =>
    `<div class="mem-item">${k}<div class="bar"><div class="bar-fill pers" style="width:${Math.round(v * 100)}%"></div></div></div>`).join('');
  const tags = a.hobbies.map((h) => `<span class="tag">${escapeHtml(h)}</span>`).join('');
  body.innerHTML = `
    <h3>${escapeHtml(a.name)} 的档案</h3>
    <p><span class="label">性别</span> ${escapeHtml(a.gender)} · <span class="label">年龄</span> ${a.age} · <span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">外貌</span> ${escapeHtml(a.appearance.hairStyle)}，${escapeHtml(a.appearance.hairColor)}，${escapeHtml(a.appearance.skinTone)}肤色，常穿${escapeHtml(a.appearance.outfit)}</p>
    <p class="label">爱好</p><p>${tags}</p>
    <p class="label">技能</p>${skillBars}
    <p class="label">性格五维</p>${persBars}
    <div class="profile-card"><p class="label">价值观</p><p>${a.values.map((v) => `· ${escapeHtml(v)}`).join('<br>')}</p></div>
    <div class="profile-card"><p class="label">动机</p><p>${escapeHtml(a.motivation)}</p></div>
    <div class="profile-card"><p class="label">背景故事</p><p>${escapeHtml(a.background)}</p></div>`;
}
```

`public/style.css` 追加（若 Task 2 已含 `.bar-fill.skill/.bar-fill.pers/.tag/.profile-card` 则跳过）：

```css
.bar-fill.skill { background: #e3b23c; }
.bar-fill.pers { background: #7fbf7f; }
.tag { display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px; background: #3a4657; border-radius: 10px; font-size: 12px; }
.profile-card { background: rgba(255,255,255,0.06); border: 1px solid #3a4657; border-radius: 8px; padding: 10px; margin: 8px 0; }
```

- [ ] **Step 7: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build:web`
Expected: 全绿。若 `tests/prompts.test.ts`/`tests/snapshot.test.ts` 断言了旧 personaText/AgentView 形状，按其语义更新断言（例如 personaText 包含「爱好：」）。mock.ts 无需改（decideAction 只用 routine）。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(town2-b): Agent 全属性档案（类型/4份档案/提示词注入/快照/档案页）"
```

---

### Task 4: 家具作息槽 + 交互动作特效（坐/睡/尘土/Zzz/蒸汽/星光/信封）

**Files:**
- Modify: `src/engine/seed.ts`（4 份 routine 加 沙发/床/咖啡桌 槽）
- Create: `src/web/client/effects.ts`
- Create: `tests/effects.test.ts`
- Modify: `src/web/client/main.ts`（姿态/粒子集成）
- Modify: `tests/acceptance-town2.test.ts`（睡床断言）

**Interfaces:**
- Consumes: `TILE`（`render.ts`）；`snap.agents` 的 `state/targetName/verb/x/y`；`drawNpc` 现有签名（不动）
- Produces: `effects.ts` 导出 `Particle/ParticleSystem/ParticleKind/sitDust/steamPuff/sparkleBurst/zzzPuff/smokePuff/fireflySpawn/paperFlutter`（Task 5 消费 smokePuff/fireflySpawn/ParticleSystem）

- [ ] **Step 1: 写失败测试**

`tests/effects.test.ts`：

```ts
// 粒子系统：上限/衰减/清理 + 各发射器产出合法粒子（node 可测，draw 需 mock ctx 仅冒烟）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, smokePuff, fireflySpawn, paperFlutter,
} from '../src/web/client/effects';

function mockCtx() {
  const noop = () => {};
  return {
    fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop, fill: noop, ellipse: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }), drawImage: noop,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

test('ParticleSystem 上限 512：超出时丢最旧粒子', () => {
  const sys = new ParticleSystem();
  for (let i = 0; i < 600; i++) sys.spawn(steamPuff(i, 0));
  assert.equal(sys.particles.length, 512);
  // shift 丢弃前 88 个 → 存活最老的是 i=88 的粒子（x≈88±4）
  assert.ok(sys.particles[0].x >= 84 && sys.particles[0].x <= 92);
});

test('update 衰减并清理死亡粒子', () => {
  const sys = new ParticleSystem();
  sys.spawn(zzzPuff(0, 0));
  const p = sys.particles[0];
  sys.update(p.maxLife + 1);
  assert.equal(sys.particles.length, 0);
});

test('各发射器返回坐标/寿命合法的粒子', () => {
  for (const ps of [sitDust(10, 20), steamPuff(10, 20), sparkleBurst(10, 20, '#fff'), zzzPuff(10, 20), smokePuff(10, 20), fireflySpawn(10, 20), paperFlutter(10, 20)]) {
    assert.ok(ps.length >= 1);
    for (const p of ps) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(p.life > 0 && p.maxLife >= p.life);
      assert.ok(Number.isFinite(p.vx) && Number.isFinite(p.vy));
    }
  }
});

test('draw 冒烟：mock ctx 不抛异常', () => {
  const sys = new ParticleSystem();
  sys.spawn([...sitDust(5, 5), ...zzzPuff(5, 5), ...fireflySpawn(5, 5)]);
  sys.draw(mockCtx(), 1000);
});
```

`tests/acceptance-town2.test.ts` ③ 跑满 1 天断言后追加：

```ts
  // ⑤ 家具作息：每个 agent 至少一次睡自己的床
  for (const a of world.allAgents()) {
    const bed = events.filter((e) =>
      e.actorId === a.id && e.type === 'interact' && e.targetIds.some((t) => t.startsWith('obj:bed_')));
    assert.ok(bed.length > 0, `${a.name} 从未睡床`);
  }
```

- [ ] **Step 2: 运行确认失败**

Run: `node --no-warnings --import tsx --test tests/effects.test.ts`
Expected: FAIL——模块不存在；`pnpm test` 中 acceptance-town2 ⑤ 失败（无床槽）。

- [ ] **Step 3: 实现 routine 槽**（`src/engine/seed.ts`，在各 persona 的 routine 数组**末尾**追加；`from` 分钟值：780=13:00、1170=19:30、1200=20:00、1230=20:30、1290=21:30、1320=22:00、1440=24:00）

```ts
  // 林晚晴 routine 追加：
  { from: 780, to: 840, type: 'interact', target: 'obj:cafe_table1', verb: '坐会儿歇歇脚' },
  { from: 1200, to: 1290, type: 'interact', target: 'obj:sofa_lin', verb: '坐在沙发上看小说笔记' },
  { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_lin', verb: '睡觉' },
  { from: 0, to: 420, type: 'interact', target: 'obj:bed_lin', verb: '睡觉' },
  // 陈默 routine 追加：
  { from: 1230, to: 1290, type: 'interact', target: 'obj:sofa_chen', verb: '在沙发上看书' },
  { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_chen', verb: '睡觉' },
  { from: 0, to: 420, type: 'interact', target: 'obj:bed_chen', verb: '睡觉' },
  // 沈屿 routine 追加：
  { from: 1170, to: 1230, type: 'interact', target: 'obj:sofa_shen', verb: '在沙发上小憩' },
  { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_shen', verb: '睡觉' },
  { from: 0, to: 420, type: 'interact', target: 'obj:bed_shen', verb: '睡觉' },
  // 周岚 routine 追加：
  { from: 1230, to: 1320, type: 'interact', target: 'obj:sofa_zhou', verb: '在沙发上整理信件' },
  { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_zhou', verb: '睡觉' },
  { from: 0, to: 420, type: 'interact', target: 'obj:bed_zhou', verb: '睡觉' },
```

> 说明：跨午夜睡觉拆成 `1320-1440` 与 `0-420` 两槽（mock `decideAction` 按 `minuteOfDay` 匹配，不支持跨日区间）；mock 每次决策时长 `min(15, slot.to - t)`，睡床会产生多次 interact 事件。

- [ ] **Step 4: 实现 `src/web/client/effects.ts`**

```ts
// 轻量粒子系统：尘土/蒸汽/星光/Zzz/炊烟/萤火虫/纸屑（星露谷风动作与环境特效，上限 512）
export type ParticleKind = 'dust' | 'steam' | 'sparkle' | 'zzz' | 'smoke' | 'firefly' | 'paper';

export interface Particle {
  kind: ParticleKind;
  x: number; y: number;
  vx: number; vy: number;
  life: number;      // 剩余毫秒
  maxLife: number;
  size: number;
  color: string;
  phase: number;     // sin 相位
}

export class ParticleSystem {
  static readonly CAP = 512;
  particles: Particle[] = [];

  spawn(ps: Particle[]): void {
    for (const p of ps) {
      if (this.particles.length >= ParticleSystem.CAP) this.particles.shift();
      this.particles.push(p);
    }
  }

  update(dtMs: number): void {
    for (const p of this.particles) {
      p.life -= dtMs;
      p.x += p.vx * (dtMs / 1000);
      p.y += p.vy * (dtMs / 1000);
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  draw(ctx: CanvasRenderingContext2D, nowMs: number): void {
    for (const p of this.particles) {
      const t = 1 - p.life / p.maxLife; // 0→1
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = p.color;
      if (p.kind === 'firefly' || p.kind === 'sparkle') {
        const pulse = 0.5 + 0.5 * Math.sin(nowMs / 200 + p.phase);
        ctx.globalAlpha = Math.max(0, 1 - t) * pulse;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      } else if (p.kind === 'zzz') {
        ctx.font = `${Math.round(10 + t * 6)}px monospace`;
        ctx.fillText('z', p.x, p.y);
      } else if (p.kind === 'paper') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.phase + t * 2);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.6 + t * 0.8), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}

/** 落座尘土：环形扩散 */
export function sitDust(x: number, y: number): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI * 2 * i) / 6;
    out.push({
      kind: 'dust', x, y: y + 4,
      vx: Math.cos(ang) * 12, vy: -Math.abs(Math.sin(ang)) * 10 - 2,
      life: 500 + Math.random() * 300, maxLife: 800, size: 3, color: '#c9b79c', phase: i,
    });
  }
  return out;
}

/** 咖啡蒸汽 */
export function steamPuff(x: number, y: number): Particle[] {
  return [{
    kind: 'steam', x: x + (Math.random() * 8 - 4), y,
    vx: Math.random() * 4 - 2, vy: -14,
    life: 1600, maxLife: 1600, size: 4, color: 'rgba(255,255,255,0.9)', phase: Math.random() * 6,
  }];
}

/** 星光（写生/画画） */
export function sparkleBurst(x: number, y: number, color: string): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < 4; i++) {
    out.push({
      kind: 'sparkle', x: x + (Math.random() * 10 - 5), y: y + (Math.random() * 6 - 3),
      vx: 0, vy: -6, life: 700, maxLife: 700, size: 3, color, phase: i * 1.7,
    });
  }
  return out;
}

/** Zzz 气泡 */
export function zzzPuff(x: number, y: number): Particle[] {
  return [{ kind: 'zzz', x, y, vx: 4, vy: -10, life: 1400, maxLife: 1400, size: 8, color: '#ffffff', phase: 0 }];
}

/** 烟囱炊烟（Task 5 复用） */
export function smokePuff(x: number, y: number): Particle[] {
  return [{
    kind: 'smoke', x: x + (Math.random() * 4 - 2), y,
    vx: Math.random() * 6 - 3, vy: -18,
    life: 2600, maxLife: 2600, size: 5, color: 'rgba(120,120,120,0.5)', phase: Math.random() * 6,
  }];
}

/** 萤火虫（Task 5 复用） */
export function fireflySpawn(x: number, y: number): Particle[] {
  return [{
    kind: 'firefly', x, y,
    vx: Math.random() * 8 - 4, vy: Math.random() * 8 - 4,
    life: 5000, maxLife: 5000, size: 2, color: '#ffe9a8', phase: Math.random() * 6,
  }];
}

/** 信封纸屑（送信/分拣） */
export function paperFlutter(x: number, y: number): Particle[] {
  return [{
    kind: 'paper', x, y, vx: 6, vy: -12,
    life: 900, maxLife: 900, size: 3, color: '#f7ecd8', phase: Math.random() * 3,
  }];
}
```

- [ ] **Step 5: main.ts 集成姿态 + 动作粒子**

`src/web/client/main.ts`：

(a) import：

```ts
import { ParticleSystem, sitDust, steamPuff, sparkleBurst, zzzPuff, paperFlutter } from './effects';
```

(b) 状态（`display` map 附近）：

```ts
const fx = new ParticleSystem();
const poses = new Map<string, { scaleY: number }>(); // agentId -> 姿态缩放（1 站 / 0.78 坐 / 0.5 躺）
const lastActionKey = new Map<string, string>();     // agentId -> "targetName:verb"
const zzzLast = new Map<string, number>();
const steamLast = new Map<string, number>();
let lastFx = performance.now();
```

(c) 目标姿态 + 动作开始检测 + 持续特效（`loop()` 中 display 插值后插入）：

```ts
  const dt = now - lastFx;
  lastFx = now;
  for (const a of snap!.agents) {
    const p = poses.get(a.id) ?? { scaleY: 1 };
    poses.set(a.id, p);
    const target = a.state === 'acting' && a.targetName
      ? (a.targetName === '床' ? 0.5 : /沙发|咖啡桌|椅/.test(a.targetName) ? 0.78 : 1)
      : 1;
    p.scaleY += (target - p.scaleY) * 0.3; // 0.3s 级缓动
    if (Math.abs(target - p.scaleY) < 0.02) p.scaleY = target;
    const d = display.get(a.id);
    if (!d) continue;
    const key = `${a.targetName}:${a.verb}`;
    if (a.state === 'acting' && a.targetName && lastActionKey.get(a.id) !== key) {
      lastActionKey.set(a.id, key);
      const cx = d.x + TILE / 2;
      if (a.targetName === '床') fx.spawn(zzzPuff(cx, d.y - 12));
      else if (/沙发|咖啡桌|椅/.test(a.targetName)) fx.spawn(sitDust(cx, d.y + TILE));
      if (/煮|咖啡|泡/.test(a.verb)) fx.spawn(steamPuff(cx, d.y - 6));
      if (/写生|画|速写/.test(a.verb)) fx.spawn(sparkleBurst(cx, d.y - 8, '#ffd700'));
      if (/信|分拣|送/.test(a.verb)) fx.spawn(paperFlutter(cx, d.y - 12));
    }
    if (a.state === 'acting' && a.targetName === '床' && now - (zzzLast.get(a.id) ?? 0) > 900) {
      zzzLast.set(a.id, now);
      fx.spawn(zzzPuff(d.x + TILE / 2, d.y - 12));
    }
    if (a.state === 'acting' && /煮|泡/.test(a.verb) && now - (steamLast.get(a.id) ?? 0) > 1200) {
      steamLast.set(a.id, now);
      fx.spawn(steamPuff(d.x + TILE / 2, d.y - 8));
    }
  }
  fx.update(dt);
```

(d) `drawAgents()`（515-528）绘制循环体改为姿态变换版：

```ts
  for (const a of sorted) {
    const d = display.get(a.id)!;
    const dir: Dir = d.tx > d.x ? 'right' : d.tx < d.x ? 'left' : d.ty > d.y ? 'down' : d.ty < d.y ? 'up' : 'down';
    const frame = (d.moving ? Math.floor(performance.now() / 300) % 2 : 0) as 0 | 1;
    const p = poses.get(a.id) ?? { scaleY: 1 };
    const cx = d.x + TILE / 2;
    const cy = d.y + TILE / 2;
    ctx.save();
    if (p.scaleY < 0.999) {
      ctx.translate(cx, cy + 8);
      ctx.scale(1, p.scaleY);
      ctx.translate(-cx, -cy - 8);
    }
    drawNpc(ctx, cx, cy, dir, frame, a.spriteIndex, d.moving, a.id === selectedId, a.name, a.state === 'thinking');
    ctx.restore();
    // 躺床盖被
    if (p.scaleY < 0.6 && a.targetName === '床') {
      ctx.fillStyle = '#e8e0f0';
      ctx.fillRect(cx - 8, cy - 2, 16, 6);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 6, cy - 8, 7, 5);
    }
    if (playing.has(a.id)) {
      ctx.font = '10px monospace';
      ctx.fillText('🎮', cx + ctx.measureText(a.name).width / 2 + 2, cy + 19);
    }
  }
```

(e) `draw()`（450-465）世界层在 `drawAgents();` 后、`applyDayNight` 前加：

```ts
  fx.draw(ctx, nowMs);
```

其中 `nowMs` 在 `draw()` 顶部定义：`const nowMs = performance.now();`（供后续 Task 5 环境特效复用）。

- [ ] **Step 6: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build:web`
Expected: 全绿；acceptance-town2 ⑤ 睡床断言通过（mock 在 0:00-7:00/22:00-24:00 连续决策睡床）。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(town2-b): 家具作息槽（床/沙发/咖啡桌）+ 粒子动作特效（坐躺姿态/Zzz/尘土/蒸汽/星光/信封）"
```

---

### Task 5: 环境动态特效基础层（水波/炊烟/树影/萤火虫/灯火/昼夜平滑）

**Files:**
- Modify: `src/web/client/render.ts`（water/地形带/树绘制/昼夜连续/灯火）
- Modify: `src/web/client/main.ts`（环境粒子生成 + 绘制调用）
- Create: `tests/render-smoke.test.ts`

**Interfaces:**
- Consumes: `effects.ts` 的 `ParticleSystem/smokePuff/fireflySpawn`；`drawObjectDetail(ctx, o, nowMs)` 现有签名（**扩展为可选第四参 `minuteOfDay?`**，向后兼容）；`applyDayNight(ctx, w, h, minuteOfDay)` 现有签名（保留）
- Produces: `render.ts` 导出 `dayNightState(minuteOfDay): { color: string; alpha: number }`（纯函数）；`drawRiver(ctx, px, py, pw, ph, nowMs)`；`drawTree(ctx, x, y, nowMs, phase)`；`drawLampGlow(ctx, px, py, nowMs, night: boolean)`

- [ ] **Step 1: 写失败测试** `tests/render-smoke.test.ts`

```ts
// 渲染冒烟：昼夜纯函数数值合法 + 各绘制函数在 mock ctx 下不抛异常
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayNightState, applyDayNight, drawRiver, drawTree, drawLampGlow, drawObjectDetail, drawFurniture, drawTerrain, TILE } from '../src/web/client/render';
import type { ObjectView } from '../src/web/client/types';

function mockCtx() {
  const noop = () => {};
  return {
    fillRect: noop, strokeRect: noop, beginPath: noop, arc: noop, fill: noop, ellipse: noop,
    fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }), drawImage: noop,
    save: noop, restore: noop, translate: noop, scale: noop, setTransform: noop, rotate: noop,
    createRadialGradient: () => ({ addColorStop: noop }),
    globalAlpha: 1, fillStyle: '', strokeStyle: '', font: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D;
}

test('dayNightState：白天无着色，夜间蓝色覆盖，黄昏渐入', () => {
  assert.equal(dayNightState(600).alpha, 0);
  assert.equal(dayNightState(300).alpha, 0);
  assert.ok(dayNightState(1350).alpha > 0.25);
  assert.ok(dayNightState(100).alpha > 0.25);
  const dusk = dayNightState(1100);
  assert.ok(dusk.alpha > 0 && dusk.alpha < 0.2);
  for (const m of [0, 100, 300, 480, 600, 1020, 1100, 1200, 1300, 1400]) {
    const s = dayNightState(m);
    assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha 越界 at ${m}`);
  }
});

test('绘制函数冒烟：mock ctx 不抛异常', () => {
  const ctx = mockCtx();
  drawTerrain(ctx, 48 * TILE, 44 * TILE);
  drawRiver(ctx, 8 * TILE, 40 * TILE, 40 * TILE, 4 * TILE, 1000);
  drawTree(ctx, 41 * TILE, 3 * TILE, 1000, 2);
  drawLampGlow(ctx, 17 * TILE, 18 * TILE, 1000, true);
  const water: ObjectView = { id: 'obj:river', name: '小镇河', type: 'water', x: 8, y: 40, w: 40, h: 4 };
  drawObjectDetail(ctx, water, 1000, 1350);
  const lamp: ObjectView = { id: 'obj:lamp_plaza', name: '广场路灯', type: 'zone', x: 17, y: 18, w: 1, h: 1 };
  drawObjectDetail(ctx, lamp, 1000, 1350);
  const bed: ObjectView = { id: 'obj:bed_lin', name: '床', type: 'furniture', x: 3, y: 2, w: 1, h: 2 };
  drawFurniture(ctx, bed);
  applyDayNight(ctx, 100, 100, 1350);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --no-warnings --import tsx --test tests/render-smoke.test.ts`
Expected: FAIL——`dayNightState/drawRiver/drawTree/drawLampGlow` 不存在、`type 'water'` 与 `drawObjectDetail` 第四参不兼容。

- [ ] **Step 3: 实现 render.ts**

(a) 文件头部（`TILE` 后）新增纯函数与绘制函数：

```ts
/** 昼夜着色状态（纯函数）：黎明 300~480 淡橙；黄昏 1020~1200 渐深橙；夜 1200~1440/0~300 蓝 */
export function dayNightState(minuteOfDay: number): { color: string; alpha: number } {
  const m = minuteOfDay;
  if (m >= 300 && m < 480) {
    const t = (m - 300) / 180;
    return { color: '#ff9a3c', alpha: Math.sin(t * Math.PI) * 0.12 };
  }
  if (m >= 1020 && m < 1200) {
    const t = (m - 1020) / 180;
    return { color: '#ff7a3c', alpha: 0.04 + t * 0.16 };
  }
  if (m >= 1200 || m < 300) return { color: '#1a2a4a', alpha: 0.32 };
  return { color: '#000000', alpha: 0 };
}

export function applyDayNight(ctx: CanvasRenderingContext2D, w: number, h: number, minuteOfDay: number): void {
  const s = dayNightState(minuteOfDay);
  if (s.alpha > 0) {
    ctx.fillStyle = s.color;
    ctx.globalAlpha = s.alpha;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

/** 河流/湖水：底色 + 双层错相位高光条纹（正弦流动） */
export function drawRiver(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
  ctx.fillStyle = '#4e93c9';
  ctx.fillRect(px, py, pw, ph);
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  const shift = Math.floor(nowMs / 400) % 3;
  for (let y = py + 4; y < py + ph - 2; y += 10) {
    const off = (Math.floor((y - py) / 10) % 2 === 0) ? shift * 6 : -shift * 6;
    for (let x = px + off; x < px + pw; x += 26) ctx.fillRect(x, y, 8, 2);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  const shimmer = Math.sin(nowMs / 700);
  ctx.fillRect(px + 10 + shimmer * 8, py + 3, 6, 2);
  ctx.fillRect(px + pw - 20 - shimmer * 8, py + ph - 6, 6, 2);
}

/** 装饰树：树冠随 sin 摇曳（phase 由位置 hash 决定，避免整齐划一） */
export function drawTree(ctx: CanvasRenderingContext2D, x: number, y: number, nowMs: number, phase: number): void {
  const sway = Math.round(Math.sin(nowMs / 900 + phase));
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(x - 2, y + 6, 4, 10);
  ctx.fillStyle = '#2f7a3a';
  ctx.fillRect(x - 9 + sway, y - 8, 18, 14);
  ctx.fillStyle = '#3f9a4a';
  ctx.fillRect(x - 6 + sway, y - 11, 12, 8);
  ctx.fillStyle = '#4f8a5a';
  ctx.fillRect(x - 14 + sway, y - 3, 10, 7);
}

/** 路灯夜间暖光晕 */
export function drawLampGlow(ctx: CanvasRenderingContext2D, px: number, py: number, nowMs: number, night: boolean): void {
  ctx.fillStyle = '#3a3f4a';
  ctx.fillRect(px + 10, py + 6, 12, 26);
  ctx.fillStyle = '#f5e9c8';
  ctx.fillRect(px + 12, py + 8, 8, 6);
  if (!night) return;
  const pulse = 0.85 + 0.15 * Math.sin(nowMs / 800);
  const g = ctx.createRadialGradient(px + 16, py + 12, 4, px + 16, py + 12, 34);
  g.addColorStop(0, `rgba(255,214,130,${0.45 * pulse})`);
  g.addColorStop(1, 'rgba(255,214,130,0)');
  ctx.fillStyle = g as unknown as string;
  ctx.fillRect(px - 18, py - 22, 68, 68);
}
```

(b) `drawObjectDetail`（38-97 行）扩展：签名改为 `(ctx, o, nowMs, minuteOfDay = -1)`；`zone` 分支追加各新区 id：

```ts
  if (o.type === 'zone') {
    if (o.id === 'obj:park') { /* 现有逻辑不动 */ }
    else if (o.id === 'obj:lake') { drawLake(ctx, px, py, pw, ph, nowMs); }
    else if (o.id === 'obj:river') { drawRiver(ctx, px, py, pw, ph, nowMs); }
    else if (o.id === 'obj:orchard' || o.id === 'obj:forest_ne') {
      ctx.fillStyle = '#6aa84f';
      ctx.fillRect(px, py, pw, ph);
      const dense = o.id === 'obj:forest_ne';
      for (let ty = py + 8; ty < py + ph - 8; ty += dense ? 20 : 26) {
        for (let tx = px + 8; tx < px + pw - 8; tx += dense ? 20 : 26) {
          drawTree(ctx, tx + ((hash(o.id + tx + ty) % 8) - 4), ty, nowMs, (hash(o.id + tx + ty) % 6) * 1.1);
        }
      }
    }
    else if (o.id === 'obj:farm_east') {
      ctx.fillStyle = '#8a6a3a';
      ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = '#c9a06a';
      for (let ty = py + 6; ty < py + ph; ty += 12) ctx.fillRect(px + 4, ty, pw - 8, 5);
      ctx.fillStyle = '#5f8f3f';
      for (let tx = px + 8; tx < px + pw; tx += 12) for (let ty = py + 8; ty < py + ph; ty += 12) ctx.fillRect(tx, ty, 4, 4);
    }
    else if (o.id === 'obj:meadow_s') {
      ctx.fillStyle = '#7fb069';
      ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = '#e8d5a0';
      for (let i = 0; i < 10; i++) ctx.fillRect(px + ((i * 17) % pw), py + ((i * 11) % ph), 2, 2);
    }
    else if (o.id.startsWith('obj:lamp')) {
      drawLampGlow(ctx, px, py, nowMs, minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300));
    }
    else { /* 现有 zone 兜底逻辑不动 */ }
  }
```

(c) 建筑窗户夜间点亮：`building` 分支（62-84）窗循环内，把窗户填充色改为按夜判定：

```ts
    // 窗（夜间点亮）
    const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
    ctx.fillStyle = night ? '#ffd98a' : '#7a5a3a';
```

(d) 湖边 `drawLake` 内水波沿用（Task 5 不改，或复用 drawRiver 亦可——保持现状即可）。

- [ ] **Step 4: main.ts 环境粒子**

`src/web/client/main.ts`：

(a) import 增加：

```ts
import { smokePuff, fireflySpawn } from './effects';
```

(b) 状态追加：

```ts
const CHIMNEYS: [string, number, number][] = [
  ['obj:cafe', 11, 8], ['obj:bakery', 35, 18],
  ['obj:home_lin', 5, 2], ['obj:home_chen', 37, 2],
  ['obj:home_shen', 5, 34], ['obj:home_zhou', 37, 34],
];
const FIREFLY_ZONES = [
  { x: 16, y: 28, w: 4, h: 2 },  // 湖
  { x: 6, y: 26, w: 10, h: 6 },  // 公园
  { x: 42, y: 14, w: 6, h: 8 },  // 树林
];
let lastSmoke = 0;
let lastFirefly = 0;
```

(c) `loop()` 内（Task 4 的 `fx.update(dt)` 后）追加：

```ts
  spawnAmbient(now);
```

新增函数（`loop` 前）：

```ts
/** 环境粒子：白天炊烟（咖啡馆/面包店/住宅烟囱）、夜间萤火虫（湖/公园/树林，≤40 只） */
function spawnAmbient(now: number): void {
  if (!snap) return;
  const m = snap.clock.minutesOfDay;
  const night = m >= 1200 || m < 300;
  if (!night && now - lastSmoke > 900) {
    lastSmoke = now;
    for (const [id, tx, ty] of CHIMNEYS) {
      const o = snap.objects.find((x) => x.id === id);
      if (o) fx.spawn(smokePuff(tx * TILE, ty * TILE - 6));
    }
  }
  if (night && now - lastFirefly > 350) {
    lastFirefly = now;
    const count = fx.particles.filter((p) => p.kind === 'firefly').length;
    if (count < 40) {
      const z = FIREFLY_ZONES[Math.floor(Math.random() * FIREFLY_ZONES.length)];
      const fx0 = (z.x + Math.random() * z.w) * TILE;
      const fy0 = (z.y + Math.random() * z.h) * TILE;
      fx.spawn(fireflySpawn(fx0, fy0));
    }
  }
}
```

(d) `drawObjects()`（492-513）调用 `drawObjectDetail` 处传 `minuteOfDay`：

```ts
      drawObjectDetail(ctx, o, now, snap!.clock.minutesOfDay);
```

(e) `draw()` 中 `applyDayNight` 调用保持（其实现已换连续版）；水面/灯火由 drawObjectDetail 处理。

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build:web`
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(town2-b): 环境动态特效（河水波光/地形带/树影摇曳/炊烟/萤火虫/路灯辉光/昼夜平滑）"
```

---

### Task 6: 终审验收 + 合并发布

**Files:** 无新增代码（仅验收与文档）

- [ ] **Step 1: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm build:web && git status --short`
Expected: 全部通过、无未提交改动。

- [ ] **Step 2: 服务冒烟**

Run:
```bash
pkill -f "[t]sx src/cli/town-web" 2>/dev/null; pnpm town-web --port 8787 &
sleep 3; curl -s http://127.0.0.1:8787/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('grid',s.gridW+'x'+s.gridH,'agents',s.agents.length,'档案字段',!!s.agents[0].gender&&Object.keys(s.agents[0].skills).length>0)})"
```
Expected: `grid 48x44 agents 4 档案字段 true`。

- [ ] **Step 3: 归档 ledger + 合并**

按 SDD 惯例更新 `.superpowers/sdd/town2-phase-b/progress.md`（Rulings 追加：flash 模型策略、zoomOffsets 签名修正、跨午夜睡床拆双槽、lamp 用 zone 不阻挡），然后：

```bash
git checkout main && git merge --no-ff town2-phase-b -m "feat(town2-b): 全屏地图/全属性档案/家具交互特效/环境动态"
git branch -d town2-phase-b
rm -rf .superpowers
```

- [ ] **Step 4: 重启常驻服务并确认**

```bash
pkill -f "[t]sx src/cli/town-web"; (pnpm town-web --port 8787 > /tmp/town-web.log 2>&1 &); sleep 3; curl -s http://127.0.0.1:8787/api/status
```
Expected: status OK；浏览器打开 http://127.0.0.1:8787 可见全屏地图。

---

## Self-Review 结论

- **Spec 覆盖**：B1（Task 1/2）、B2（Task 3）、B3（Task 4）、B4（Task 5）、验收（Task 6）全覆盖；「走路轻摆」已存在于 sprites.ts 移动 bob，spec 视为满足；「双击/按钮回全图」在 Task 2 Step 5(e)/Step 6。
- **占位符**：全文无 TBD/TODO；Task 2 的 zoomOffsets 已给出最终签名与守恒实现。
- **类型一致性**：`FitCamera/computeFit/zoomScale/zoomOffsets`、`Particle/ParticleSystem/*Puff/fireflySpawn`、`dayNightState/drawRiver/drawTree/drawLampGlow` 命名在各任务一致；`drawObjectDetail` 第四参 `minuteOfDay = -1` 可选，Task 5 测试与 main.ts 调用一致。
