# 小镇完善 · 阶段 D 实施计划（素材升级 + 内容扩充 + 视觉精修）

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **模型策略（控制器）**：指令明确/纯转写用 `provider: deepseek-official, model: deepseek-v4-flash`；集成与评审用 deepseek-v4-pro；终审 pro。

**Goal:** 用许可合规的高清素材升级画风、把小镇扩到 6 NPC + 新建筑装饰、修掉视觉粗糙点。

**Architecture:** tiles.ts 增加 3 个新 sheet（tinytown/tiny16/dungeon）与包选择常量；seed.ts 加 2 NPC 全套 + 3 建筑 + 码头装饰；render/main 修建筑外景、接雨花/涟漪、动作图标。

**Tech Stack:** TypeScript strict、Node 22 + node:test + tsx、esbuild、零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-08-21-town2-phase-d-design.md`

## Global Constraints

- 零运行时依赖；`pnpm test` 全绿；`pnpm typecheck` 0 错误；`pnpm build:web` 成功。
- 许可：下载前逐页复核；ATTRIBUTION 记录 URL+许可+署名（CC-BY 3.0 Sharm 强制署名）；禁用 RPG Maker RTP/星露谷/LPC/来源不明仓库（控制器已裁定）。
- 素材未就绪回退程序化；客户端纯逻辑可 node 测试；中文注释沿用；提交 `feat:`/`fix:` 前缀。
- 坐标：新建筑/装饰放置已由控制器预检（唯一调整：fence_lake 定为 (14,26,2,1)，避免与码头重叠；flowerbed 在广场内、boat 在码头内、lamp_lake 在码头上为有意嵌套）。

### Task 1: 素材升级（Kenney Tiny Town + Sharm Tiny 16 + 0x72）

**Files:** Modify `src/web/client/tiles.ts`、`ATTRIBUTION.md`、`tests/tiles.test.ts`；Create `public/assets/kenney-tinytown.png`、`public/assets/sharm-tiny16.png`、`public/assets/dungeon-0x72.png`（按实际下载命名，tiles.ts 一致引用）

**Interfaces:**
- Produces（Task 2/3 消费）:
  ```ts
  // tiles.ts
  export type SheetId = 'town' | 'forest' | 'interiors' | 'ui' | 'tinytown' | 'tiny16' | 'dungeon';
  export const TILE_MAP: TileMap; // terrain 增加 altGrass/tree2/flowerBed 键；buildings 增加 pier 键；furniture 键值改为 dungeon 图集坐标（bed/sofa/table/counter 各 sw/sh 按 0x72 实际砖定）
  export const TOWN_SHEET: 'town' | 'tiny16' | 'tinytown';   // 外景首选包
  export const INTERIOR_SHEET: 'interiors' | 'dungeon';       // 内饰首选包
  ```

- [ ] **Step 1: 下载 + 许可复核（先复核再下载）**
  - Kenney Tiny Town：`https://kenney.nl/assets/tiny-town`（期望 CC0；下载 zip 取主 tileset PNG）
  - Sharm Tiny 16 Basic：`https://opengameart.org/content/tiny-16-basic`（期望 CC-BY 3.0，记录署名要求）+ Tiny 16 Buildings：`https://opengameart.org/content/tiny-16-buildings`（期望 CC-BY 3.0/OGA-BY 3.0）
  - 0x72 DungeonTileset II：先试 `https://opengameart.org/content/dungeon-tileset-2`；若无则 `https://0x72.itch.io/dungeontileset-ii`（本环境 itch 不可达——届时改用 OGA 同源页或标注失败）
  - 落位 `public/assets/`；失败/不符 → 该素材跳过、sheet 不注册
  - ATTRIBUTION 追加三包条目（含 Sharm 署名原文与许可链接）
- [ ] **Step 2: tiles.ts 扩展**
  - `SheetId` 加 `'tinytown' | 'tiny16' | 'dungeon'`；SHEETS 注册循环加对应 URL（仅对下载成功的）
  - `TileMap` 增加：`terrain.altGrass: number[]; terrain.tree2: number[]; terrain.flowerBed: number[];`、`buildings.pier`、`furniture` 键加 `sw/sh` 与坐标改 dungeon 真值（若 0x72 不可达保持现状）
  - 导出 `TOWN_SHEET`、`INTERIOR_SHEET` 常量（默认 `'tiny16'`/`'dungeon'`；对应 sheet 未下载时调用方按 sheetReady 回退链选择）
- [ ] **Step 3: 程序化像素分析定坐标**（沿用平均色方法，写 /tmp 一次性脚本；报告给证据表；不确定标注占位）
- [ ] **Step 4: tests/tiles.test.ts** 更新：SheetId 全量 ready=false 断言扩展新 sheet；TILE_MAP 新键结构断言
- [ ] **Step 5: 全量验证 + 提交**
  ```bash
  pnpm test && pnpm typecheck && pnpm build:web && git add -A && git commit -m "feat(town2-d): 素材升级（Kenney Tiny Town/Sharm Tiny16/0x72 许可复核+tiles扩展）"
  ```

### Task 2: 小镇内容丰富（3 建筑 + 装饰 + NPC 4→6）

**Files:** Modify `src/engine/seed.ts`、`tests/acceptance-m3.test.ts`、`tests/acceptance-web.test.ts`、`tests/acceptance.test.ts`、`tests/cli-web.test.ts`、`tests/loop.test.ts`、`tests/profile.test.ts`（如需）；跑全量后按失败处语义更新其余

**Interfaces:**
- Consumes: `Persona` 全字段（性别/外貌/爱好/技能/价值观/动机/背景≥80字）；`HOME_BY_NAME`
- Produces: `BAILU_PERSONA`、`ZHOU_LAO_PERSONA`；对象 `obj:flower_shop/obj:grocer/obj:pier/obj:boat/obj:home_bailu/obj:home_zhoulao/obj:bed_bailu/obj:sofa_bailu/obj:bed_zhoulao/obj:sofa_zhoulao/obj:flowerbed/obj:fence_lake`

- [ ] **Step 1: 写失败测试（人数 6 断言先行）**
  把以下 5 处 4→6（语义迁移，控制器裁定）：
  - `tests/acceptance-m3.test.ts:64` `st.length, 4` → `6`（注释 ④ 声望榜同步改「6 项」）
  - `tests/acceptance-web.test.ts:63` `snap.agents.length, 4` → `6`
  - `tests/acceptance.test.ts:29` `agents.length, 4` → `6`
  - `tests/cli-web.test.ts:34` `snap.agents.length, 4` → `6`
  - `tests/loop.test.ts:13` `world.allAgents().length, 4` → `6`
  Run: `pnpm test` → 上述 5 处 RED（当前 4 人）。
- [ ] **Step 2: seed.ts 实现**
  对象追加（坐标已预检；type 按既有分类）：
  ```ts
  { id: 'obj:flower_shop', name: '白露花店', type: 'building', parentId: 'obj:town', x: 12, y: 18, w: 4, h: 4 },
  { id: 'obj:grocer', name: '小镇杂货店', type: 'building', parentId: 'obj:town', x: 24, y: 12, w: 4, h: 4 },
  { id: 'obj:pier', name: '湖边码头', type: 'zone', parentId: 'obj:town', x: 16, y: 26, w: 4, h: 2 },
  { id: 'obj:boat', name: '小船', type: 'furniture', parentId: 'obj:pier', x: 17, y: 27, w: 2, h: 1 },
  { id: 'obj:flowerbed', name: '广场花坛', type: 'zone', parentId: 'obj:town', x: 20, y: 20, w: 2, h: 2 },
  { id: 'obj:fence_lake', name: '湖边栅栏', type: 'zone', parentId: 'obj:town', x: 14, y: 26, w: 2, h: 1 },
  { id: 'obj:home_bailu', name: '白露的家', type: 'building', parentId: 'obj:town', x: 12, y: 34, w: 4, h: 4 },
  { id: 'obj:home_zhoulao', name: '老周的家', type: 'building', parentId: 'obj:town', x: 18, y: 34, w: 4, h: 4 },
  { id: 'obj:bed_bailu', name: '床', type: 'furniture', parentId: 'obj:home_bailu', x: 13, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_bailu', name: '沙发', type: 'furniture', parentId: 'obj:home_bailu', x: 12, y: 36, w: 2, h: 1 },
  { id: 'obj:bed_zhoulao', name: '床', type: 'furniture', parentId: 'obj:home_zhoulao', x: 19, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_zhoulao', name: '沙发', type: 'furniture', parentId: 'obj:home_zhoulao', x: 18, y: 36, w: 2, h: 1 },
  ```
  persona 追加（全属性档案，routine 与 M3 白天相邻窗口不冲突；沙发 17-19 时、床 1320-1440 + 0-420 双槽、晚间 19:30 后自由）：
  ```ts
  export const BAILU_PERSONA: Persona = {
    name: '白露', age: 26, occupation: '花店老板', gender: '女',
    appearance: { hairStyle: '丸子头', hairColor: '浅棕色', skinTone: '白皙', outfit: '浅绿围裙配白衬衫' },
    hobbies: ['园艺', '插花', '收集种子'],
    skills: { 插花: 9, 园艺: 8, 记账: 5, 聊天: 7 },
    values: ['每一束花都有收花人', '小镇值得被装点', '勤恳经营'],
    motivation: '把花店开成小镇最香的地方，让每一个路过的人都带一束花回家。',
    background: '从小在祖母的花圃里长大，三年前在小镇开了「白露花店」。她能记住每位客人的喜好，周岚送信路过时总爱顺一束花。最近她在湖边码头旁种了一片野花，说是要送给小镇的夏天。',
    traits: ['温柔', '勤快', '有点害羞'],
    goals: ['把花店经营成小镇的风景', '在湖边种满野花'],
    speechStyle: '轻声细语，爱聊花草',
    routine: [
      { from: 480, to: 720, type: 'interact', target: 'obj:flower_shop', verb: '在花店理花插花' },
      { from: 780, to: 840, type: 'interact', target: 'obj:park', verb: '到公园赏花' },
      { from: 1080, to: 1140, type: 'interact', target: 'obj:sofa_bailu', verb: '坐在沙发上看园艺书' },
      { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_bailu', verb: '睡觉' },
      { from: 0, to: 420, type: 'interact', target: 'obj:bed_bailu', verb: '睡觉' },
    ],
    greetingPool: ['今天的玫瑰开得正好。', '要带一束花回家吗？', '湖边那片野花快开了。'],
    personality: { extraversion: 0.6, empathy: 0.9, honesty: 0.9, curiosity: 0.6, patience: 0.8 },
  };
  export const ZHOU_LAO_PERSONA: Persona = {
    name: '老周', age: 60, occupation: '渔夫', gender: '男',
    appearance: { hairStyle: '花白短发', hairColor: '灰白色', skinTone: '古铜色', outfit: '旧渔夫背心配草帽' },
    hobbies: ['钓鱼', '讲古', '修船'],
    skills: { 钓鱼: 9, 讲古: 8, 修船: 7, 看天气: 8 },
    values: ['湖里永远有鱼', '年轻人多出去走走', '慢工出细活'],
    motivation: '每天在码头钓鱼，把小镇的老故事讲给愿意听的人。',
    background: '在湖边钓了一辈子鱼的老渔夫，认识小镇上每一个人，连每片水面的脾气都摸得清。他白天在码头钓鱼修船，傍晚爱到广场给年轻人讲小镇的老故事。他总说白露花店的那片野花，是他见过最像春天的东西。',
    traits: ['豁达', '爱讲故事', '慢性子'],
    goals: ['钓上湖里最大的鱼', '把小镇的老故事传下去'],
    speechStyle: '慢悠悠，爱用俗语',
    routine: [
      { from: 480, to: 660, type: 'interact', target: 'obj:pier', verb: '在码头钓鱼' },
      { from: 660, to: 780, type: 'interact', target: 'obj:boat', verb: '划船巡湖' },
      { from: 1140, to: 1200, type: 'interact', target: 'obj:plaza', verb: '在广场讲古' },
      { from: 1230, to: 1290, type: 'interact', target: 'obj:sofa_zhoulao', verb: '坐在沙发上打盹' },
      { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_zhoulao', verb: '睡觉' },
      { from: 0, to: 420, type: 'interact', target: 'obj:bed_zhoulao', verb: '睡觉' },
    ],
    greetingPool: ['今天湖面风平浪静。', '年轻人，坐会儿听个故事？', '这天气，鱼都懒得上钩咯。'],
    personality: { extraversion: 0.7, empathy: 0.7, honesty: 0.9, curiosity: 0.5, patience: 0.9 },
  };
  ```
  `HOME_BY_NAME` 加 `'白露': 'obj:home_bailu', '老周': 'obj:home_zhoulao'`；`DEFAULT_SEED.personas` 追加两人。
- [ ] **Step 3: 全量验证**
  Run: `pnpm test && pnpm typecheck && pnpm build:web`。Expected: 除 Step 1 已改的 5 处外，其余失败按语义更新（如 rumor/social 断言人数相关、profile.test 若写死 4 份则改循环 6 份——**只迁移人数语义，不弱化断言**）；M3 社交断言（carriers≥2、participants≥2、关系密度）在新人数下必须仍通过。
- [ ] **Step 4: Commit**
  ```bash
  git add -A && git commit -m "feat(town2-d): 小镇内容丰富（花店/杂货店/码头/装饰 + 白露/老周 NPC 4→6）"
  ```

### Task 3: 视觉精修（建筑外景/雨花/涟漪/分段雨丝/动作图标/走路动画）

**Files:** Modify `src/web/client/render.ts`、`src/web/client/effects.ts`、`src/web/client/main.ts`、`tests/render-smoke.test.ts`（如需 mock 补方法）、`tests/effects.test.ts`

**Interfaces:**
- Consumes: `ParticleSystem`、`rainDrop/rainSplash`、`sheetReady/drawTile/TILE_MAP`、`TOWN_SHEET`（Task 1）
- Produces: `rainDrop` 分段绘制（kind 'rain' 绘制改 2 段）；main.ts 新增 `actionIconFor(verb: string, targetName: string | null): string | null`（纯函数可测）

- [ ] **Step 1: 写失败测试**（`tests/effects.test.ts` 追加；actionIcon 纯函数放 hud.ts 或 main.ts 抽出）
  ```ts
  test('actionIconFor：verb 关键词映射动作图标', () => {
    assert.equal(actionIconFor('煮咖啡招待客人', null), '☕');
    assert.equal(actionIconFor('在公园写生', null), '🎨');
    assert.equal(actionIconFor('到咖啡馆送信', null), '✉️');
    assert.equal(actionIconFor('睡觉', '床'), '💤');
    assert.equal(actionIconFor('坐在沙发上看书', null), '📖');
    assert.equal(actionIconFor('在码头钓鱼', null), '🎣');
    assert.equal(actionIconFor('随便走走', null), null);
  });
  ```
  （`actionIconFor` 实现为纯函数，导出自 `src/web/client/hud.ts`：按 `/煮|咖啡|泡/ → '☕'；/写生|画|速写/ → '🎨'；/信|分拣|送/ → '✉️'；targetName==='床' → '💤'；/书|读/ → '📖'；/钓鱼|鱼/ → '🎣'；否则 null`）
- [ ] **Step 2: 实现**
  (a) **建筑外景修复**（render.ts building 素材分支）：墙铺满内部 3×3（o.y+1..o.y+o.h-2 行 × o.x+1..o.x+o.w-2 列），底部一行同样铺墙（补上原先镂空底角），屋顶行保留，门底中、窗两角保留；fallback 不动。
  (b) **分段雨丝**（effects.ts draw 不再处理 rain——rain 绘制在 main.ts drawRainScreen）：rain 分支改画 2 段：`moveTo(x,y)→lineTo(x+2,y+5)` 与 `moveTo(x+3,y+7)→lineTo(x+5,y+12)`（8px 总长 2 段）。
  (c) **雨花接线**（main.ts loop）：对 kind==='rain' 且 y > canvas.height/dprScale()-20 的粒子，spawn `rainSplash(x, canvas.height/dprScale()-14)` 并移除该 rain 粒子；同时雨天内每 ~500ms 在 lake/river 水面区域随机 spawn 涟漪（rainSplash 用在水面坐标）。
  (d) **水面涟漪**：雨天时 drawLake/drawRiver 调用处追加 `if (snap.weather==='rain')` 高光增强（rgba 白 0.3 波纹条第二层，用 nowMs 相位）。
  (e) **动作图标**（main.ts drawAgents）：acting 且 `actionIconFor` 非 null 时，NPC 头顶（y-44 处）画图标，2s 周期弹跳：`const bounce = Math.sin(now/250)*2; ctx.font='14px monospace'; ctx.fillText(icon, x-7, y-44+bounce);`（世界层）。
  (f) **走路动画微调**（main.ts drawAgents）：frame 间隔由固定 300ms 改 `250`，bob 与 frame 同步（sprites 内已 bob）；阴影随 bob 微缩放：`drawNpc` 不动，接受现状即可（若改动 sprites.ts 会破坏现有测试——不强制）。
- [ ] **Step 3: 全量验证 + 提交**
  ```bash
  pnpm test && pnpm typecheck && pnpm build:web && git add -A && git commit -m "feat(town2-d): 视觉精修（建筑外景补全/雨花接线/水面涟漪/分段雨丝/动作图标）"
  ```

### Task 4: 验收 + 合并 + 推送 GitHub

- [ ] **Step 1: 全量验证**
  ```bash
  pnpm test && pnpm typecheck && pnpm build:web && git status --short
  ```
  Expected: 全绿（127+）、干净。
- [ ] **Step 2: 服务冒烟**
  ```bash
  pkill -f "[t]sx src/cli/town-web" 2>/dev/null; pnpm town-web --port 8787 &
  sleep 3; curl -s http://127.0.0.1:8787/api/state | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log('agents',s.agents.length,'objects',s.objects.length,'weather',s.weather)})"
  ```
  Expected: agents 6、objects 49、weather clear。
- [ ] **Step 3: 合并 + 推送**
  ```bash
  git checkout main && git merge --no-ff town2-phase-d -m "feat(town2-d): 素材升级/内容扩充/视觉精修（阶段D合并）"
  git branch -d town2-phase-d
  rm -rf .superpowers
  git push origin main
  ```
  Expected: push 成功（remote 已配置 shank000/multiagent-town）。
- [ ] **Step 4: 重启常驻服务 + 微信汇报**

## Self-Review 结论

- **Spec 覆盖**：D1（Task 1）、D2（Task 2）、D3（Task 3）、D4（Task 4）全覆盖；非目标项未入计划。
- **占位符**：Task 1 坐标以程序化分析产出真值（报告证据表），无 TBD；0x72 不可达时降级路径已写明。
- **类型一致性**：SheetId 新成员、TOWN_SHEET/INTERIOR_SHEET、actionIconFor、rainSplash 接线命名全计划一致；drawLake/drawRiver 签名不变。
- **坐标预检**：控制器已用重叠检查脚本验证新对象坐标——唯一调整 fence_lake=(14,26,2,1)；嵌套（boat∈pier、flowerbed∈plaza、lamp_lake∈pier）为有意装饰。
- **测试迁移**：5 处 4→6 断言已列名定位；其余由全量测试暴露后按「人数语义迁移、不弱化断言」规则处理。
