# 小镇 2.0 阶段 C 实施计划（素材替换 + 晴雨天气 + UI 美化）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **模型策略（控制器）**：指令明确/纯转写用 `provider: deepseek-official, model: deepseek-v4-flash`；集成与评审用 deepseek-v4-pro；终审用 deepseek-v4-pro。

**Goal:** 把小镇画风换成 ansimuz/LimeZu/Kenney 像素素材（保留程序化回退）、加晴雨天气、全面美化 UI。

**Architecture:** 新增 `tiles.ts` 统一图集加载与绘制（每图独立 ready 标志，未就绪回退程序化）；render.ts 的 terrain/water/tree/building/furniture 分支改走 tiles；`core/weather.ts` 纯函数 + 快照 weather 字段 + 客户端雨粒子（屏幕层）；UI 层做 Kenney 风像素皮肤 + CSS 动画 + main.ts 拆分（panel.ts/hud.ts）+ 阶段 B 遗留 5 项。

**Tech Stack:** TypeScript strict、Node 22 + node:test + tsx、esbuild、零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-20-town2-phase-c-design.md`（任务据此展开，实现者需先读）

## Global Constraints

- 零运行时依赖：不得引入 npm 包；`pnpm test` 用 `node --no-warnings --import tsx --test "tests/*.test.ts"`。
- TS strict：`pnpm typecheck`（`tsc --noEmit`）必须 0 错误；`pnpm build:web` 成功。
- 许可：下载任何素材前打开页面复核许可；`ATTRIBUTION.md` 记录 URL + 许可 + 署名；CC0 礼貌署名、CC-BY 强制署名。
- 素材落位 `public/assets/`；16×16 素材运行时 `drawImage` 放大，`imageSmoothingEnabled=false`；每张图独立 ready，未就绪回退程序化（功能永不退化）。
- 客户端纯逻辑抽纯函数可 node 测试；DOM/Image 只发生在模块顶层与事件回调。
- 天气纯视觉：不改 agent 决策/路径/事件；weatherForDay 纯函数可测。
- 中文注释风格沿用；提交信息 `feat:`/`fix:` 前缀。

---

### Task 1: 素材下载 + 许可复核 + tiles.ts 图集加载器

**Files:**
- Create: `src/web/client/tiles.ts`
- Create: `tests/tiles.test.ts`
- Modify: `ATTRIBUTION.md`
- Create（下载产物）: `public/assets/ansimuz-town.png`、`public/assets/ansimuz-forest.png`、`public/assets/limezu-interiors.png`、`public/assets/kenney-ui.png`（文件名以实际下载为准，tiles.ts 引用同名）

**Interfaces:**
- Consumes: 现有 `/assets/` 静态路由（server.ts）
- Produces（C2/C3 消费，签名必须精确）:
  ```ts
  // tiles.ts
  export type SheetId = 'town' | 'forest' | 'interiors' | 'ui';
  export function sheetReady(id: SheetId): boolean;
  export function drawTile(ctx: CanvasRenderingContext2D, id: SheetId, sx: number, sy: number, dx: number, dy: number, size: number): void; // sx/sy 为图集内像素，size 为目标像素；内部 drawImage 放大
  export function drawTileW(ctx: CanvasRenderingContext2D, id: SheetId, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void; // 任意尺寸版本（家具/建筑用）
  export const TILE_MAP: TileMap; // 命名常量映射（见下）
  export interface TileMap {
    terrain: { grass: number[]; grassAlt: number[]; dirt: number[]; path: number[]; plaza: number[]; flowers: number[]; crops: number[] };
    water: { frames: number[][]; sheet: SheetId };
    tree: { frames: number[][]; sheet: SheetId };
    buildings: Record<string, { wall: number[]; roof: number[]; door: number[]; window: number[] }>;
    furniture: Record<string, { frames: number[][]; sw: number; sh: number }>; // 键: bed/sofa/table/counter
    interior: { floor: number[]; wallTile: number[]; sheet: SheetId };
  }
  ```
  （`number[]` 为 `[sx, sy]` 像素坐标，16px 网格上的整数倍；`frames` 为多帧动画坐标列表。）

- [ ] **Step 1: 下载与许可复核（先复核再下载）**

  逐一打开（`curl -sL <page>` 抓页面文本，用 `grep -i "license\|cc0\|cc-by\|attribution"` 复核）：
  - ansimuz Tiny RPG Town Pack：`https://opengameart.org/content/tiny-rpg-town-pack`（期望 CC0）
  - ansimuz Tiny RPG Forest：`https://opengameart.org/content/tiny-rpg-forest`（期望 CC0）
  - LimeZu Modern Interiors：`https://limezu.itch.io/moderninteriors`（期望 CC-BY 4.0，记录署名要求原文）
  - Kenney Pixel UI Pack：`https://kenney.nl/assets/pixel-ui-pack`（期望 CC0）

  下载 zip 到 /tmp，`unzip` 后选取主图集 PNG，复制到 `public/assets/`（命名：`ansimuz-town.png`/`ansimuz-forest.png`/`limezu-interiors.png`/`kenney-ui.png`；若页面提供的是多张 PNG，town 选「town/tileset 主图」、forest 选主图、interiors 选「modern interiors 主 tileset」、UI 选「panel 图」——记录最终选择到报告）。
  **任一页面许可复核不通过或下载失败 → 该素材跳过，tiles.ts 不注册该图（sheetReady 恒 false），其余继续。**
  `ATTRIBUTION.md` 追加：
  ```md
  ## 阶段 C 像素素材
  - ansimuz Tiny RPG Town / Forest — CC0 — https://opengameart.org/content/tiny-rpg-town-pack （礼貌署名）
  - LimeZu Modern Interiors — CC-BY 4.0 — https://limezu.itch.io/moderninteriors （署名：LimeZu；如有改动请注明）
  - Kenney Pixel UI Pack — CC0 — https://kenney.nl/assets/pixel-ui-pack （礼貌署名）
  ```
  （按实际复核结果修正措辞。）

- [ ] **Step 2: 写失败测试** `tests/tiles.test.ts`

  ```ts
  // tiles.ts 冒烟：未加载时全部 ready=false 且 draw 不崩（node 无 DOM/Image 路径）
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { sheetReady, drawTile, drawTileW, TILE_MAP } from '../src/web/client/tiles';

  function mockCtx() {
    const noop = () => {};
    return { drawImage: noop, imageSmoothingEnabled: true, save: noop, restore: noop } as unknown as CanvasRenderingContext2D;
  }

  test('未加载时所有 sheet ready=false，drawTile/drawTileW 不抛', () => {
    assert.equal(sheetReady('town'), false);
    assert.equal(sheetReady('forest'), false);
    assert.equal(sheetReady('interiors'), false);
    assert.equal(sheetReady('ui'), false);
    const ctx = mockCtx();
    drawTile(ctx, 'town', 0, 0, 0, 0, 32);
    drawTileW(ctx, 'interiors', 0, 0, 16, 32, 0, 0, 32, 64);
  });

  test('TILE_MAP 结构完整：C2/C3 依赖的全部键存在且坐标非负整数', () => {
    for (const k of ['grass', 'dirt', 'path', 'plaza'] as const) {
      assert.ok(Array.isArray(TILE_MAP.terrain[k]) && TILE_MAP.terrain[k].length === 2, k);
    }
    assert.ok(TILE_MAP.water.frames.length >= 2);
    assert.ok(TILE_MAP.tree.frames.length >= 1);
    for (const b of ['cafe', 'bookstore', 'post_office', 'bakery', 'clinic', 'home']) {
      const s = TILE_MAP.buildings[b];
      assert.ok(s && s.wall.length === 2 && s.roof.length === 2 && s.door.length === 2 && s.window.length === 2, b);
    }
    for (const f of ['bed', 'sofa', 'table', 'counter']) {
      assert.ok(TILE_MAP.furniture[f] && TILE_MAP.furniture[f].frames.length >= 1, f);
    }
    assert.ok(TILE_MAP.interior.floor.length === 2 && TILE_MAP.interior.wallTile.length === 2);
  });
  ```

- [ ] **Step 3: 运行确认失败**

  Run: `node --no-warnings --import tsx --test tests/tiles.test.ts`
  Expected: FAIL——模块不存在。

- [ ] **Step 4: 实现 tiles.ts**

  ```ts
  // 图集加载与绘制：ansimuz/LimeZu/Kenney 素材统一入口；每图独立 ready，未就绪由调用方回退程序化
  export type SheetId = 'town' | 'forest' | 'interiors' | 'ui';

  const SHEETS: Record<SheetId, { img: HTMLImageElement; src: string } | null> = {
    town: null, forest: null, interiors: null, ui: null,
  };

  // node 测试环境无 window：顶层初始化跳过，浏览器才注册
  if (typeof window !== 'undefined' && typeof Image !== 'undefined') {
    for (const [id, src] of Object.entries({
      town: '/assets/ansimuz-town.png',
      forest: '/assets/ansimuz-forest.png',
      interiors: '/assets/limezu-interiors.png',
      ui: '/assets/kenney-ui.png',
    }) as [SheetId, string][]) {
      const img = new Image();
      img.onload = () => { SHEETS[id] = { img, src }; };
      img.src = src;
    }
  }

  export function sheetReady(id: SheetId): boolean {
    const s = SHEETS[id];
    return !!s && s.img.complete && s.img.naturalWidth > 0;
  }

  export function drawTile(ctx: CanvasRenderingContext2D, id: SheetId, sx: number, sy: number, dx: number, dy: number, size: number): void {
    drawTileW(ctx, id, sx, sy, 16, 16, dx, dy, size, size);
  }

  export function drawTileW(
    ctx: CanvasRenderingContext2D, id: SheetId,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number
  ): void {
    const s = SHEETS[id];
    if (!s || !sheetReady(id)) return; // 未就绪：静默跳过，调用方负责回退
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(s.img, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = prev;
  }

  // —— 命名坐标映射（C1 实现者按实际图集布局填写；数值为 16px 网格像素坐标）——
  export interface TileMap {
    terrain: { grass: number[]; dirt: number[]; path: number[]; plaza: number[] };
    water: { frames: number[][]; sheet: SheetId };
    tree: { frames: number[][]; sheet: SheetId };
    buildings: Record<string, { wall: number[]; roof: number[]; door: number[]; window: number[] }>;
    furniture: Record<string, { frames: number[][]; sw: number; sh: number }>;
    interior: { floor: number[]; wallTile: number[]; sheet: SheetId };
  }

  export const TILE_MAP: TileMap = {
    terrain: { grass: [0, 0], dirt: [16, 0], path: [32, 0], plaza: [48, 0], flowers: [64, 0], crops: [80, 0] },
    water: { frames: [[0, 32], [16, 32]], sheet: 'forest' },
    tree: { frames: [[32, 32]], sheet: 'forest' },
    buildings: {
      cafe: { wall: [0, 0], roof: [16, 0], door: [32, 0], window: [48, 0] },
      bookstore: { wall: [0, 16], roof: [16, 16], door: [32, 16], window: [48, 16] },
      post_office: { wall: [0, 32], roof: [16, 32], door: [32, 32], window: [48, 32] },
      bakery: { wall: [0, 48], roof: [16, 48], door: [32, 48], window: [48, 48] },
      clinic: { wall: [0, 64], roof: [16, 64], door: [32, 64], window: [48, 64] },
      home: { wall: [0, 80], roof: [16, 80], door: [32, 80], window: [48, 80] },
    },
    furniture: {
      bed: { frames: [[0, 0]], sw: 16, sh: 32 },
      sofa: { frames: [[16, 0]], sw: 32, sh: 16 },
      table: { frames: [[48, 0]], sw: 16, sh: 16 },
      counter: { frames: [[64, 0]], sw: 32, sh: 16 },
    },
    interior: { floor: [0, 0], wallTile: [16, 0], sheet: 'interiors' },
  };
  ```

  > **C1 实现者必读**：上面 TILE_MAP 坐标是占位骨架。下载完成后**逐个打开 PNG 确认布局**，把坐标改成真实值（图集通常是 16px 网格；城镇图含建筑墙/顶/门/窗序列，森林图含水/树/草，interiors 含地板/墙/家具）。报告里写明每张图的实际尺寸（如 256×256）与你选取的坐标依据；未下载成功的素材保持占位但对应 sheet 不注册加载，C2/C3 的 ready 检查自然回退。

- [ ] **Step 5: 运行确认通过**

  Run: `node --no-warnings --import tsx --test tests/tiles.test.ts`
  Expected: PASS（node 无 window → SHEETS 全 null，ready 全 false，测试语义成立）。

- [ ] **Step 6: 全量验证 + 提交**

  Run: `pnpm test && pnpm typecheck && pnpm build:web && git status --short`
  Expected: 全绿；`public/assets/*.png` 为新增未跟踪文件——**加入 git**（`git add public/assets/`，素材入仓）。提交：
  ```bash
  git add -A
  git commit -m "feat(town2-c): 素材下载+许可复核+ATTRIBUTION+tiles图集加载器"
  ```

---

### Task 2: 外景素材替换（地形/水/树/农田/建筑）

**Files:**
- Modify: `src/web/client/render.ts`（drawTerrain/drawLake/drawObjectDetail 各分支）
- Modify: `tests/render-smoke.test.ts`（不崩断言已有，无需改；如 mockCtx 缺新方法则补）

**Interfaces:**
- Consumes: `tiles.ts` 的 `sheetReady/drawTile/drawTileW/TILE_MAP`（Task C1）
- Produces: 无新导出；`drawTerrain` 签名不变；`drawObjectDetail(ctx, o, nowMs, minuteOfDay = -1)` 签名不变

- [ ] **Step 1: 实现（每分支「素材就绪用素材，否则保留现有程序化代码」）**

  `src/web/client/render.ts`：

  (a) 文件头部 import：`import { sheetReady, drawTile, drawTileW, TILE_MAP } from './tiles';`

  (b) `drawTerrain` 改为素材优先：

  ```ts
  export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (sheetReady('town') || sheetReady('forest')) {
      const sheet: 'town' | 'forest' = sheetReady('town') ? 'town' : 'forest';
      const [gx, gy] = TILE_MAP.terrain.grass;
      for (let y = 0; y < h; y += TILE) {
        for (let x = 0; x < w; x += TILE) drawTile(ctx, sheet, gx, gy, x, y, TILE);
      }
      const [px, py] = TILE_MAP.terrain.path;
      for (let x = 0; x < w; x += TILE) {
        drawTile(ctx, sheet, px, py, x, 16 * TILE, TILE);   // 主街（y=16-17）
        drawTile(ctx, sheet, px, py, x, 17 * TILE, TILE);
      }
      const [qx, qy] = TILE_MAP.terrain.plaza;
      for (let y = 18 * TILE; y < 24 * TILE; y += TILE) {
        for (let x = 18 * TILE; x < 24 * TILE; x += TILE) drawTile(ctx, sheet, qx, qy, x, y, TILE);
      }
      const [fx, fy] = TILE_MAP.terrain.dirt;
      for (let x = 0; x < w; x += TILE) {
        drawTile(ctx, sheet, fx, fy, x, 3 * TILE, TILE);
        drawTile(ctx, sheet, fx, fy, x, 4 * TILE, TILE);
      }
      return;
    }
    // —— 现有程序化 fallback 原样保留 ——
    ctx.fillStyle = '#7fb069';
    ctx.fillRect(0, 0, w, h);
    /* ……现有代码不动…… */
  }
  ```

  (c) `drawLake` 改素材优先（水动画 2 帧）：

  ```ts
  export function drawLake(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
    const s = TILE_MAP.water.sheet;
    if (sheetReady(s)) {
      const frame = Math.floor(nowMs / 600) % TILE_MAP.water.frames.length;
      const [sx, sy] = TILE_MAP.water.frames[frame];
      for (let y = py; y < py + ph; y += TILE) {
        for (let x = px; x < px + pw; x += TILE) drawTile(ctx, s, sx, sy, x, y, TILE);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(px + 4, py + 4, 6, 2);
      return;
    }
    /* 现有程序化湖面不动 */
  }
  ```

  (d) `drawObjectDetail` zone 分支：
  - `obj:river`（water 分支）→ 调 `drawRiver`；`drawRiver` 内部同样素材优先（用 TILE_MAP.water 平铺 + 2 帧动画），fallback 现有条纹实现。
  - `obj:orchard`/`obj:forest_ne`/`obj:park` 的树：素材就绪时 `for` 各树位用 `drawTile(ctx, TILE_MAP.tree.sheet, tx, ty, x + sway, y, TILE)`（摇摆 x 偏移 ±1 保留），fallback 现有 `drawTree`。
  - `obj:farm_east` 作物行：素材就绪用 `TILE_MAP.terrain.crops` 砖，fallback 现有色块。
  - `obj:meadow_s` 花点：素材就绪用 `TILE_MAP.terrain.flowers` 砖，fallback 现有色点。

  (e) 建筑外景分支（building，非剖切时）：

  ```ts
  } else if (o.type === 'building') {
    const key = o.id.replace('obj:', '');
    const b = TILE_MAP.buildings[key] ?? TILE_MAP.buildings.home;
    if (sheetReady('town') && b) {
      // 墙：内部 2×2 区域
      for (let y = o.y + 1; y < o.y + o.h - 1; y++) {
        for (let x = o.x + 1; x < o.x + o.w - 1; x++) {
          drawTile(ctx, 'town', b.wall[0], b.wall[1], x * TILE, y * TILE, TILE);
        }
      }
      // 屋顶：顶行
      for (let x = o.x; x < o.x + o.w; x++) drawTile(ctx, 'town', b.roof[0], b.roof[1], x * TILE, y0 * TILE, TILE);
      // 门：底边中点（与可达性 door 一致）
      drawTile(ctx, 'town', b.door[0], b.door[1], (o.x + Math.floor(o.w / 2)) * TILE, (o.y + o.h - 1) * TILE, TILE);
      // 窗：内部两角
      drawTile(ctx, 'town', b.window[0], b.window[1], (o.x + 1) * TILE, (o.y + 1) * TILE, TILE);
      drawTile(ctx, 'town', b.window[0], b.window[1], (o.x + o.w - 2) * TILE, (o.y + 1) * TILE, TILE);
      // 夜间窗户点亮：素材窗夜间色替代（若无夜间窗帧，用半透明暖色覆盖）
      const night = minuteOfDay >= 1200 || (minuteOfDay >= 0 && minuteOfDay < 300);
      if (night) { ctx.fillStyle = 'rgba(255,217,138,0.35)'; /* 覆盖两窗位置 */ ctx.fillRect((o.x+1)*TILE+2, (o.y+1)*TILE+2, TILE-4, TILE-4); ctx.fillRect((o.x+o.w-2)*TILE+2, (o.y+1)*TILE+2, TILE-4, TILE-4); }
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.font = '11px monospace';
      ctx.fillText(o.name, o.x * TILE + 3, o.y * TILE + 24);
      return;
    }
    /* 现有程序化建筑分支原样保留为 fallback */
  }
  ```

  注意：屋顶行 `y0 = o.y`；剖切内饰路径（`drawObjects` 判定含 NPC 时走 `drawInterior`）不受影响。

- [ ] **Step 2: 全量验证**

  Run: `pnpm test && pnpm typecheck && pnpm build:web`
  Expected: 全绿（render-smoke 的 mockCtx 若报缺方法——如 fillRect 已有——按需在 mockCtx 补 `imageSmoothingEnabled` 属性即可；drawTile 未就绪时静默返回，mock 下不崩）。

- [ ] **Step 3: Commit**

  ```bash
  git add -A && git commit -m "feat(town2-c): 外景素材替换（地形/水/树/农田/建筑外景，逐类回退）"
  ```

---

### Task 3: 内饰素材替换（LimeZu）

**Files:**
- Modify: `src/web/client/render.ts`（drawFurniture/drawInterior）

**Interfaces:**
- Consumes: `tiles.ts`（Task C1）；`drawFurniture(ctx, o)`、`drawInterior(ctx, building, children, nowMs)` 现有签名不变

- [ ] **Step 1: 实现**

  `src/web/client/render.ts`：

  (a) `drawFurniture` 顶部加素材优先：

  ```ts
  export function drawFurniture(ctx: CanvasRenderingContext2D, o: ObjectView): void {
    const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
    const key = o.name === '床' ? 'bed' : o.name === '沙发' ? 'sofa' : o.name === '咖啡桌' ? 'table' : 'counter';
    const f = TILE_MAP.furniture[key];
    if (f && sheetReady('interiors')) {
      const [sx, sy] = f.frames[0];
      drawTileW(ctx, 'interiors', sx, sy, f.sw, f.sh, px, py, pw, ph);
      return;
    }
    /* 现有程序化家具分支原样保留为 fallback */
  }
  ```

  (b) `drawInterior` 顶部加素材优先：

  ```ts
  export function drawInterior(ctx, building, children, nowMs): void {
    const px = building.x * TILE, py = building.y * TILE, pw = building.w * TILE, ph = building.h * TILE;
    if (sheetReady('interiors')) {
      const [fx, fy] = TILE_MAP.interior.floor;
      for (let y = py; y < py + ph; y += TILE) {
        for (let x = px; x < px + pw; x += TILE) drawTile(ctx, 'interiors', fx, fy, x, y, TILE);
      }
      const [wx, wy] = TILE_MAP.interior.wallTile;
      for (let x = px; x < px + pw; x += TILE) drawTile(ctx, 'interiors', wx, wy, x, py, TILE);
      for (const c of children) {
        if (c.type === 'furniture' || c.type === 'room') drawFurniture(ctx, c);
      }
      ctx.strokeStyle = '#7a5a3a';
      ctx.lineWidth = 4;
      ctx.strokeRect(px + 2, py + 2, pw - 4, ph - 4);
      void nowMs;
      return;
    }
    /* 现有程序化内饰原样保留为 fallback */
  }
  ```

- [ ] **Step 2: 全量验证 + 提交**

  Run: `pnpm test && pnpm typecheck && pnpm build:web`
  Expected: 全绿。
  ```bash
  git add -A && git commit -m "feat(town2-c): 内饰素材替换（LimeZu 地板/墙/家具，回退保留）"
  ```

---

### Task 4: 天气系统（晴/雨）

**Files:**
- Create: `src/core/weather.ts`
- Create: `tests/weather.test.ts`
- Modify: `src/web/snapshot.ts`（WorldSnapshot.weather）
- Modify: `src/web/client/effects.ts`（rainDrop/rainSplash）
- Modify: `src/web/client/main.ts`（雨粒子生成 + rainTint 层）
- Modify: `tests/effects.test.ts`（雨发射器冒烟追加）

**Interfaces:**
- Consumes: `TimeEngine.state.day`；`ParticleSystem`（Task B4）
- Produces: `weatherForDay(day: number): 'clear' | 'rain'`；`rainDrop(x, y): Particle[]`、`rainSplash(x, y): Particle[]`；`WorldSnapshot.weather`

- [ ] **Step 1: 写失败测试**

  `tests/weather.test.ts`：

  ```ts
  // 天气纯函数 + 快照字段
  import test from 'node:test';
  import assert from 'node:assert/strict';
  import { weatherForDay } from '../src/core/weather';
  import { TimeEngine } from '../src/core/time';
  import { buildTown } from '../src/engine/seed';
  import { buildSnapshot } from '../src/web/snapshot';

  test('weatherForDay：每 3 天第 3 天为雨，其余晴（确定性）', () => {
    assert.equal(weatherForDay(1), 'clear');
    assert.equal(weatherForDay(2), 'rain');
    assert.equal(weatherForDay(3), 'clear');
    assert.equal(weatherForDay(4), 'clear');
    assert.equal(weatherForDay(5), 'rain');
    assert.equal(weatherForDay(6), 'clear');
    assert.equal(weatherForDay(8), 'rain'); // day 8 = 8%3===2
  });

  test('快照携带 weather（与 day 对应）', () => {
    const world = buildTown();
    const time = new TimeEngine(60);
    time.state.day = 5; // 5%3===2 → rain
    const snap = buildSnapshot(world, time, false, 1);
    assert.equal(snap.weather, 'rain');
    time.state.day = 4;
    assert.equal(buildSnapshot(world, time, false, 2).weather, 'clear');
  });
  ```

  `tests/effects.test.ts` 追加：

  ```ts
  test('rainDrop/rainSplash 返回合法雨粒子', () => {
    for (const ps of [rainDrop(10, 20), rainSplash(10, 20)]) {
      assert.ok(ps.length >= 1);
      for (const p of ps) {
        assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
        assert.ok(p.life > 0 && p.maxLife >= p.life);
      }
    }
  });
  ```
  （import 补 `rainDrop, rainSplash`）

- [ ] **Step 2: 运行确认失败**

  Run: `node --no-warnings --import tsx --test tests/weather.test.ts`
  Expected: FAIL——`weatherForDay` 不存在；effects 测试 import 失败。

- [ ] **Step 3: 实现**

  `src/core/weather.ts`：

  ```ts
  // 天气：逐日确定性（每 3 天 1 雨），纯视觉不影响行为
  export type Weather = 'clear' | 'rain';

  export function weatherForDay(day: number): Weather {
    return day % 3 === 2 ? 'rain' : 'clear';
  }
  ```

  `src/web/snapshot.ts`：`WorldSnapshot` 加 `weather: 'clear' | 'rain';`；`buildSnapshot` return 对象加 `weather: weatherForDay(time.state.day),`（import 自 `../core/weather`）。

  `src/web/client/effects.ts` 追加：

  ```ts
  export type ParticleKind = /* 现有 */ | 'rain' | 'splash';

  /** 雨丝：斜向下落 */
  export function rainDrop(x: number, y: number): Particle[] {
    return [{
      kind: 'rain', x, y,
      vx: -2, vy: 90,          // 单位 px/s（屏幕层）
      life: 900, maxLife: 900, size: 1, color: 'rgba(160,190,230,0.8)', phase: Math.random() * 6,
    }];
  }

  /** 落地水花 */
  export function rainSplash(x: number, y: number): Particle[] {
    return [{
      kind: 'splash', x, y,
      vx: 0, vy: -6,
      life: 350, maxLife: 350, size: 2, color: 'rgba(160,190,230,0.6)', phase: Math.random() * 6,
    }];
  }
  ```

  `ParticleSystem.draw` 里 rain/splash 分支（现 `else` 圆点路径之前）：

  ```ts
      } else if (p.kind === 'rain') {
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 3, p.y + 10);
        ctx.stroke();
      } else if (p.kind === 'splash') {
        ctx.fillRect(p.x - p.size / 2, p.y, p.size, 1);
      } else {
  ```

  `src/web/client/main.ts`：
  - import 追加 `rainDrop`；顶部状态追加 `const RAIN_CAP = 200; let lastRainSpawn = 0;`
  - `loop()` 内 `fx.update(dt)` 后追加：

  ```ts
  if (snap!.weather === 'rain' && now - lastRainSpawn > 40) {
    lastRainSpawn = now;
    const dpr = window.devicePixelRatio || 1;
    const n = fx.particles.filter((p) => p.kind === 'rain').length;
    if (n < RAIN_CAP) {
      for (let i = 0; i < Math.min(8, RAIN_CAP - n); i++) {
        fx.spawn(rainDrop(Math.random() * canvas.width / dpr, Math.random() * canvas.height / dpr * 0.9));
      }
    }
  }
  ```

  - `draw()` 中 `applyDayNight(...)` 之后、`resetCamera()` 之前追加雨天色调；雨丝独立屏幕层绘制函数：

  ```ts
  /** 雨丝/水花：屏幕层绘制（resetCamera 后坐标即 CSS px，与相机无关） */
  function drawRainScreen(ctx: CanvasRenderingContext2D): void {
    for (const p of fx.particles) {
      if (p.kind !== 'rain' && p.kind !== 'splash') continue;
      if (p.kind === 'rain') {
        ctx.strokeStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + 3, p.y + 10);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y, p.size, 1);
      }
    }
  }
  ```

  `draw()` 世界层 `applyDayNight(ctx, worldW, worldH, snap.clock.minutesOfDay);` 之后改为：

  ```ts
  applyDayNight(ctx, worldW, worldH, snap.clock.minutesOfDay);
  if (snap.weather === 'rain') {
    ctx.fillStyle = 'rgba(70,90,130,0.12)';
    ctx.fillRect(0, 0, worldW, worldH);
  }
  // HUD 层：重置变换，按屏幕坐标绘制（tooltip/banner + 雨丝）
  resetCamera();
  if (snap.weather === 'rain') drawRainScreen(ctx);
  drawTooltip();
  drawBanner();
  ```

  `fx.draw(ctx, nowMs)`（世界层粒子调用点）改为跳过雨粒子：

  ```ts
  /** 世界层粒子绘制：跳过 rain/splash（屏幕层单独画） */
  function drawWorldFx(ctx: CanvasRenderingContext2D, nowMs: number): void {
    const saved = fx.particles;
    fx.particles = saved.filter((p) => p.kind !== 'rain' && p.kind !== 'splash');
    fx.draw(ctx, nowMs);
    fx.particles = saved;
  }
  ```
  （`draw()` 里原 `fx.draw(ctx, nowMs)` 调用点改为 `drawWorldFx(ctx, nowMs)`。）雨粒子 update 的 vy=90 是屏幕 px/s，与相机无关。

- [ ] **Step 4: 全量验证**

  Run: `pnpm test && pnpm typecheck && pnpm build:web`
  Expected: 全绿（118 + weather 2 + effects 1 = 121）。

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "feat(town2-c): 晴雨天气（weatherForDay/快照字段/雨丝粒子/雨天色调）"
  ```

---

### Task 5: UI 全面美化（Kenney 皮肤 + 主题 + 动画 + 布局 + B 遗留 5 项）

**Files:**
- Create: `src/web/client/panel.ts`、`src/web/client/hud.ts`
- Modify: `src/web/client/main.ts`（拆分 + HiDPI 字号 + CHIMNEYS 查询 + onWheel 死声明）
- Modify: `public/index.html`（面板折叠按钮、ticker 隐藏按钮、顶栏合并）
- Modify: `public/style.css`（主题变量 + 像素皮肤 + 动画 + 折叠态）
- Modify: `src/web/client/render.ts`（dayNightState 边界连续化）
- Modify: `tests/render-smoke.test.ts`（端点断言更新）

**Interfaces:**
- Consumes: `AgentView/ObjectView`（main.ts 内定义 → 移到 panel.ts 并从 main.ts re-export 或改为 panel.ts 导出、main.ts import）；`escapeHtml`、`wrap`
- Produces: `panel.ts` 导出 `renderDetail/renderProfile/renderObjectCard/renderMind/updatePanelDeps`；`hud.ts` 导出 `drawTooltip/drawBanner/drawBubbles`（含 wrap）；`main.ts` 只留相机/循环/世界绘制/特效编排

- [ ] **Step 1: dayNightState 边界连续化（render.ts + 测试）**

  `src/web/client/render.ts`：

  ```ts
  export function dayNightState(minuteOfDay: number): { color: string; alpha: number } {
    const m = minuteOfDay;
    if (m >= 300 && m < 480) {
      const t = (m - 300) / 180;
      return { color: '#1a2a4a', alpha: 0.32 * (1 - t) };   // 夜→昼连续降
    }
    if (m >= 1020 && m < 1200) {
      const t = (m - 1020) / 180;
      return { color: '#1a2a4a', alpha: 0.32 * t };         // 昼→夜连续升
    }
    if (m >= 1200 || m < 300) return { color: '#1a2a4a', alpha: 0.32 };
    return { color: '#000000', alpha: 0 };
  }
  ```

  `tests/render-smoke.test.ts` dayNightState 测试更新（替换原断言）：

  ```ts
  test('dayNightState：无跳变连续过渡', () => {
    assert.equal(dayNightState(600).alpha, 0);
    assert.equal(dayNightState(300).alpha, 0.32);       // 黎明起点=夜值
    assert.equal(dayNightState(480).alpha, 0);           // 黎明终点=昼值
    assert.equal(dayNightState(1020).alpha, 0);          // 黄昏起点=昼值
    assert.ok(Math.abs(dayNightState(1200).alpha - 0.32) < 1e-9); // 黄昏终点=夜值
    assert.equal(dayNightState(1350).alpha, 0.32);
    for (const m of [0, 100, 300, 390, 480, 600, 1020, 1100, 1199, 1200, 1300, 1400]) {
      const s = dayNightState(m);
      assert.ok(s.alpha >= 0 && s.alpha <= 1, `alpha 越界 at ${m}`);
    }
  });
  ```

- [ ] **Step 2: main.ts 拆分**

  (a) `panel.ts`（新建）：把 `interface AgentView`、`TYPE_NAME`、`STATE_NAME`（如存在于 main.ts）、`escapeHtml`、`renderDetail`、`renderProfile`、`renderObjectCard`、`renderMind` 以及 panel 相关的 DOM 绑定逻辑（`#panel-tabs` 点击、`#panel-toggle` 折叠）整体搬入并导出 `renderDetail/renderProfile/renderObjectCard/renderMind/bindPanel(activeTab, updatePanel)`。main.ts 改为 import 使用。`AgentView` 从 panel.ts 导出（main.ts `import type { AgentView } from './panel'`）。
  
  (b) `hud.ts`（新建）：把 `drawTooltip`、`drawBanner`、`drawBubbles`、`wrap`、`Bubble` 接口搬入并导出。**跨模块集合一律以参数传入**（不访问 main.ts 模块级状态），签名如下：

  ```ts
  // hud.ts
  import { TILE } from './render';
  export interface Bubble { kind: 'chat' | 'thought' | 'chat_summary'; speaker: string; text: string; until: number }
  export interface DisplayPos { x: number; y: number } // display 的像素坐标子集
  export function drawTooltip(ctx: CanvasRenderingContext2D, tooltip: { text: string; x: number; y: number } | null, canvasW: number, canvasH: number): void;
  export function drawBanner(ctx: CanvasRenderingContext2D, banner: { text: string; until: number } | null, nowMs: number, canvasW: number): void;
  export function drawBubbles(ctx: CanvasRenderingContext2D, bubbles: Map<string, Bubble>, display: Map<string, DisplayPos>, nowMs: number): void;
  export function wrap(text: string, max: number): string[];
  ```

  main.ts 调用点相应改为 `drawTooltip(ctx, tooltip, canvas.width, canvas.height)`、`drawBanner(ctx, banner, nowMs, canvas.width)`、`drawBubbles(ctx, bubbles, display as Map<string, DisplayPos>, nowMs)`（`bubbles`/`display`/`tooltip`/`banner` 状态仍留在 main.ts；`Bubble` 类型 main.ts 改从 hud.ts import）。气泡/提示/横幅绘制全部改像素风（圆角改直角 + 深色描边 + 角钉：四角 2px 色块），字体与坐标统一乘 dpr（`const dpr = window.devicePixelRatio || 1;`，resetCamera 后画布是设备像素）。
  
  (c) main.ts 清理：
  - 删除 `const dpr = window.devicePixelRatio || 1;` 死声明（onWheel 内，C5 前残留）
  - `CHIMNEYS` 改查询：删除硬编码数组，`spawnAmbient` 内改为
    ```ts
    const chimneyIds = ['obj:cafe', 'obj:bakery', 'obj:home_lin', 'obj:home_chen', 'obj:home_shen', 'obj:home_zhou'];
    for (const id of chimneyIds) {
      const o = snap.objects.find((x) => x.id === id);
      if (o) fx.spawn(smokePuff((o.x + o.w - 1) * TILE, o.y * TILE - 6));
    }
    ```
    （烟囱锚定建筑右上角，替代硬编码坐标）
  - `FIREFLY_ZONES` 改查询：按对象 id（`obj:lake`/`obj:park`/`obj:forest_ne`）从 `snap.objects` 取 x/y/w/h。

- [ ] **Step 3: HTML + CSS 皮肤**

  `public/index.html`：
  - `#hud` 内 controls 后追加 `<button id="panel-toggle">◀</button>`（折叠面板）与 `<button id="ticker-toggle">📜</button>`（ticker 显隐）
  - 其余结构不动

  `public/style.css` 主题变量 + 像素皮肤（全量替换，保留全部既有选择器与类名并新增）：

  ```css
  :root {
    --ink: #241d12; --paper: #f5e9c8; --panel: rgba(30,26,20,0.92); --panel-edge: #6b5a3a;
    --gold: #e3b23c; --gold-dark: #a87c1f; --blue: #6ba3d9; --night: #1a2a4a;
    --px: 3px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--night); font-family: monospace; }
  #game { position: fixed; inset: 0; display: block; cursor: pointer; }
  /* 顶栏 */
  #hud { position: fixed; top: 8px; left: 8px; right: 8px; z-index: 10; display: flex; gap: 8px; align-items: center;
    background: var(--panel); border: 2px solid var(--panel-edge); border-radius: 6px; padding: 6px 10px; color: var(--paper);
    box-shadow: 4px 4px 0 rgba(0,0,0,0.45); }
  #hud button { font-family: monospace; background: #4a4030; color: var(--paper); border: 2px solid #75603a;
    padding: 4px 10px; cursor: pointer; image-rendering: pixelated; }
  #hud button:hover { background: #5c5038; }
  #hud button:active { transform: translate(1px, 1px); }
  #clock { font-weight: bold; letter-spacing: 1px; }
  /* 悬浮面板（可折叠） */
  #side { position: fixed; top: 56px; right: 8px; z-index: 10; width: 330px; max-height: calc(100vh - 120px);
    display: flex; flex-direction: column; transition: transform 0.25s ease, opacity 0.25s ease; }
  #side.collapsed { transform: translateX(calc(100% - 18px)); opacity: 0.75; }
  #panel { background: var(--panel); border: 3px solid var(--panel-edge); border-radius: 8px;
    box-shadow: 6px 6px 0 rgba(0,0,0,0.5), inset 0 0 0 2px rgba(245,233,200,0.08); overflow: hidden;
    display: flex; flex-direction: column; }
  #panel-tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 5px; background: rgba(0,0,0,0.3); }
  #panel-tabs .tab { flex: 1; font-family: monospace; background: #4a4030; color: #d8c9a5; border: 2px solid #75603a;
    padding: 5px 2px; cursor: pointer; font-size: 12px; transition: background 0.15s ease; }
  #panel-tabs .tab:hover { background: #5c5038; }
  #panel-tabs .tab.active { background: var(--gold); color: var(--ink); border-color: var(--gold-dark); }
  #panel-body { padding: 10px; overflow-y: auto; color: var(--paper); font-size: 13px; line-height: 1.6;
    transition: opacity 0.18s ease; }
  #panel-body h3 { margin-bottom: 6px; color: var(--gold); }
  #panel-body .label { color: #9fb8d8; }
  .mem-item { margin: 6px 0; padding: 6px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); }
  .bar { height: 12px; background: #2a3446; border: 1px solid #444; margin: 4px 0; position: relative; overflow: hidden; }
  .bar-fill { height: 100%; }
  .bar-fill.love { background: #e8708a; } .bar-fill.resp { background: #6ba3d9; }
  .bar-fill.skill { background: var(--gold); } .bar-fill.pers { background: #7fbf7f; }
  .bar span { position: absolute; right: 6px; top: -1px; font-size: 10px; color: #fff; text-shadow: 0 0 2px #000; }
  .tag { display: inline-block; margin: 2px 4px 2px 0; padding: 2px 8px; background: #4a4030; border: 1px solid #75603a; font-size: 12px; }
  .profile-card { background: rgba(255,255,255,0.06); border: 2px solid var(--panel-edge); padding: 10px; margin: 8px 0; }
  #ticker { position: fixed; left: 8px; bottom: 8px; z-index: 10; max-width: 42vw;
    background: var(--panel); border: 2px solid var(--panel-edge); border-radius: 6px; padding: 8px 10px;
    color: #d8c9a5; font-size: 12px; transition: opacity 0.2s ease; }
  #ticker.hidden { opacity: 0; pointer-events: none; }
  #play-bar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 10;
    display: flex; gap: 6px; background: var(--panel); border: 2px solid var(--panel-edge); border-radius: 6px;
    padding: 6px 8px; box-shadow: 4px 4px 0 rgba(0,0,0,0.45); }
  #play-bar[hidden] { display: none; }
  #play-bar input { width: 300px; padding: 6px 8px; border: 2px solid #75603a; background: #2a2418; color: var(--paper); font-family: monospace; }
  #play-bar button { font-family: monospace; background: #4a4030; color: var(--paper); border: 2px solid #75603a; padding: 6px 10px; cursor: pointer; }
  ```

  `main.ts` 的 `bindControls()` 追加：

  ```ts
  const side = document.getElementById('side')!;
  document.getElementById('panel-toggle')!.addEventListener('click', () => {
    side.classList.toggle('collapsed');
  });
  const ticker = document.getElementById('ticker')!;
  document.getElementById('ticker-toggle')!.addEventListener('click', () => {
    ticker.classList.toggle('hidden');
  });
  ```

- [ ] **Step 4: 全量验证**

  Run: `pnpm test && pnpm typecheck && pnpm build:web`
  Expected: 全绿。若 hud.ts 拆分导致 main.ts 残留死代码（TS strict 不报未用局部/未用导入？——`tsc --noEmit` 默认不报未使用），自审 `git diff` 确保 main.ts 只减不增职责。

- [ ] **Step 5: Commit**

  ```bash
  git add -A && git commit -m "feat(town2-c): UI全面美化（主题/像素皮肤/动画/折叠布局/HiDPI字号/main拆分/昼夜连续）"
  ```

---

### Task 6: 终审验收 + 合并发布

- [ ] **Step 1: 全量验证**

  Run: `pnpm test && pnpm typecheck && pnpm build:web && git status --short`
  Expected: 121+ 全绿、typecheck 0、build 成功、无未提交改动。

- [ ] **Step 2: 服务冒烟**

  ```bash
  pkill -f "[t]sx src/cli/town-web" 2>/dev/null; pnpm town-web --port 8787 &
  sleep 3; curl -s http://127.0.0.1:8787/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('weather',s.weather,'grid',s.gridW+'x'+s.gridH,'assets',s.objects.length)})"
  curl -sI http://127.0.0.1:8787/assets/ansimuz-town.png | head -1
  ```
  Expected: `weather clear`（第 1 天晴）；assets PNG 返回 200（若该素材已下载）。

- [ ] **Step 3: 归档 + 合并 + 清理**

  更新 `.superpowers/sdd/town2-phase-c/progress.md` 终态后：
  ```bash
  git checkout main && git merge --no-ff town2-phase-c -m "feat(town2-c): 像素素材/晴雨天气/UI美化（阶段C合并）"
  git branch -d town2-phase-c
  rm -rf .superpowers
  ```

- [ ] **Step 4: 重启常驻服务并确认**

  ```bash
  pkill -f "[t]sx src/cli/town-web"; (pnpm town-web --port 8787 > /tmp/town-web.log 2>&1 &); sleep 3; curl -s http://127.0.0.1:8787/api/status | head -c 80
  ```
  Expected: status OK；用户刷新浏览器可看新画风 + 天气 + UI。

---

## Self-Review 结论

- **Spec 覆盖**：C1（Task C1）、C2（Task C2）、C3（Task C3）、C4（Task C4）、C5+遗留 5 项（Task C5）、验收署名（Task C6）全覆盖；「非目标」项均未入计划。
- **占位符**：TILE_MAP 坐标骨架是唯一「待 C1 填写」处——已显式标注为 C1 的检查任务与报告义务，属顺序依赖而非 TBD；其余无占位。
- **类型一致性**：`SheetId/drawTile/drawTileW/TILE_MAP/sheetReady`、`weatherForDay/Weather`、`rainDrop/rainSplash`、panel/hud 导出与 main.ts import 命名全计划一致；`drawFurniture/drawInterior/drawLake/drawObjectDetail/applyDayNight` 签名不变。
- **任务间冲突**：C1→C2/C3 顺序依赖（tiles.ts）；C4 先于 C5（同改 main.ts，顺序执行不冲突）；C5 的 dayNightState 改版与 C4 的雨天色调叠加顺序（rainTint 在 dayNight 之后）已在 C4 代码块明确。
