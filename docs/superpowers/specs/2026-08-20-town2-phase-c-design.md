# 小镇 2.0 · 阶段 C 设计（spec）

> 日期：2026-08-20　状态：已获用户批准（「批准，开工」）
> 上游：Town 2.0 三阶段规划（A/B 已完成并合入 main，B=bb015ae）；素材候选调研报告（后台子代理 6b231a77）
> 本阶段目标：星露谷级画风素材替换 + 晴雨天气 + UI 全面美化

## 目标

1. **素材替换**：ansimuz CC0 外景 + LimeZu CC-BY 内饰 + Kenney CC0 UI，逐素材保留程序化回退。
2. **天气系统**：晴/雨，逐日确定性，雨粒子 + 暗色调，快照携带，纯视觉（不影响 agent 行为）。
3. **UI 全面美化**：像素风皮肤、主题配色、动画过渡、布局重构，并消化阶段 B 遗留 4 项。

## C1 素材下载与许可复核

- 下载目标（**下载前打开页面复核许可条款**，逐项记录 URL + 许可到 `ATTRIBUTION.md`）：
  - ansimuz「Tiny RPG Town Pack」+「Tiny RPG Forest」：opengameart.org，CC0（高置信，下载前页面确认）
  - LimeZu「Modern Interiors」：itch.io limezu.itch.io/moderninteriors，CC-BY 4.0（下载前页面确认署名要求）
  - Kenney「Pixel UI Pack」：kenney.nl，CC0
- 文件落位 `public/assets/`（现有 `/assets/` 路由已服务该目录）；16×16 素材**不预处理**，运行时 `drawImage` 放大（`imageSmoothingEnabled=false` 保持像素锐利）。
- 任一素材下载失败/许可不符 → 该类别保持现有程序化绘制，只影响观感不影响功能；`tiles.ts` 每张图有独立 `ready` 标志。
- `ATTRIBUTION.md`：CC0 礼貌署名 + CC-BY 强制署名（LimeZu、George Bailey folk.png 保留）含链接与改动说明。

## C2 外景替换

- 新增 `src/web/client/tiles.ts`：图集加载 + 就绪标志 + `drawTile(ctx, sheet, sx, sy, dx, dy, size, flipH?)` 与 `drawSprite` 统一入口；`sheetReady` 语义沿用 sprites.ts 现有模式。
- `render.ts`：
  - 地形：草地基底（forest/town 草地砖）+ 石板主街（town path 砖）+ 广场砖
  - 水域：湖/河用 forest 水砖，2 帧交替动画（nowMs 驱动，保留高光 overlay）
  - 树：orchard/forest_ne/park 装饰树改 forest 树精灵（摇摆 = 绘制 x 偏移 ±1px 保留）
  - 农田作物行 / 草坡花点：forest 作物/花草砖
  - 建筑外景：cafe/bookstore/post_office/bakery/clinic/homes 由 town 建筑砖组合（墙/屋顶/门/窗映射表集中在 tiles.ts 命名常量）；屋顶剖切内饰机制保留（含 NPC 的建筑画内饰）
  - 路灯辉光保留（程序化光晕叠在素材上）
- 每类素材加载失败 → 该类回退现有程序化绘制（现有分支保留为 fallback）。

## C3 内饰替换

- LimeZu Modern Interiors：地板砖（drawInterior 木纹点 → 地板砖平铺）、墙体、床/沙发/咖啡桌/吧台 家具精灵（drawFurniture 各分支改 drawSprite，床 16×32 竖图、沙发 32×16 横图等按实际图集定映射）。
- 映射表集中在 tiles.ts；未加载回退现有程序化家具。

## C4 天气系统（晴/雨）

- 引擎：新增 `src/core/weather.ts` 纯函数 `weatherForDay(day: number): 'clear' | 'rain'`——确定性：`day % 3 === 2 → 'rain'`，否则 `'clear'`（每 3 天 1 场雨）。
- 快照：`WorldSnapshot.weather: 'clear' | 'rain'`（buildSnapshot 从 time.state.day 计算）。
- 客户端：
  - `effects.ts` 新增 `rainDrop(x, y, speed)` 发射器（斜线雨丝粒子，长度 8-12px 分段绘制）+ `rainSplash(x, y)`（落地水花）
  - loop 中 `snap.weather === 'rain'` 时每帧按 200 上限补雨粒子（覆盖全屏随机 x，速度与相机无关，绘制在屏幕层——雨在相机变换外画，落在 HUD 层下方、dayNight 之上）
  - 雨天色调：`applyDayNight` 后追加 `rainTint` 层（蓝灰 0.12 alpha）+ 水面涟漪高光增强
- 纯视觉：不改变 agent 决策/路径/事件。
- 测试：weatherForDay 周期单测；快照 weather 字段；rainDrop 粒子合法性冒烟。
> 简化实现说明（终审记录）：雨丝实现为固定 10px 单段斜线（无 speed 参数/分段），雨天水面涟漪增强未实现——纯视觉抛光项，随 UI 迭代再补。

## C5 UI 全面美化

- 主题：暖羊皮纸 + 深蓝夜色统一配色表（CSS 变量 + 画布常量 `UI_THEME`）；中文字体沿用 monospace。
- Kenney Pixel UI 皮肤：面板边框像素化（CSS border + 阶梯阴影模拟像素角）、tab/按钮像素风（方形、描边、按压位移 1px）、气泡/横幅/提示框（canvas 绘制层改像素边框 + 角钉装饰）。
- 动画过渡：面板滑入/切 tab 淡入（CSS transition）、横幅弹入、气泡 pop-in、暂停按钮状态切换。
- 布局重构：面板折叠按钮（收起为竖条）、ticker 可隐藏、HUD 合并为一条顶栏。
- 消化阶段 B 遗留（终审裁定项）：
  1. HiDPI HUD 字号：drawTooltip/drawBanner/drawBubbles 字体尺寸 × dpr（resetCamera 后按设备像素绘制）
  2. onWheel 死声明 `const dpr` 删除
  3. `main.ts` 拆分：面板渲染（renderDetail/renderProfile/renderObjectCard/renderMind）→ `panel.ts`；HUD 绘制（drawTooltip/drawBanner/drawBubbles/wrap）→ `hud.ts`；main.ts 只留相机/循环/世界绘制/特效编排
  4. CHIMNEYS/FIREFLY_ZONES 坐标改从 `snap.objects` 按 id 查找（不再硬编码瓦片坐标）
  5. 昼夜边界连续化：dayNightState 端点对齐——黎明 300→480 从 0.32 连续降到 0；黄昏 1020→1200 从 0 连续升到 0.32；消除 300/1020/1200 三处跳变（同步更新 render-smoke 断言）

## C6 验收 + 合并

1. `ATTRIBUTION.md` 含全部新素材许可 + 链接 + 署名要求满足。
2. `/api/state` 含 `weather` 字段；weatherForDay 单测；雨渲染冒烟测试。
3. `pnpm test` 全绿（118+ 新增）；`pnpm typecheck` 0 错误；`pnpm build:web` 成功。
4. 服务冒烟：48×44 全图渲染（curl /api/state + 浏览器人工复核）；程序化回退路径冒烟（tiles 未加载时测试不崩——现有 render-smoke 扩展 mock）。
5. 按 SDD 惯例合并 main（本地合并，用户既有偏好）。

## 风险与对策

- **下载失败/许可不符**：逐类别降级程序化绘制（C2/C3 fallback 设计保证功能不退化）。
- **16×16 放大**：drawImage + imageSmoothingEnabled=false；fit 全图缩放下 25px/瓦 观感接受，滚轮放大看细节。
- **图集坐标不确定**：C1 下载后由实现者检查图集实际布局，映射表集中在 tiles.ts 命名常量，评审只审映射合理性。
- **雨粒子性能**：上限 200，屏幕层绘制，每帧 O(上限)。
- **subagent 工具不稳定**：沿用 SDD 惯例（2 连败控制器自实现，ledger 记录）。

## 非目标（明确不做）

- 不做下雪/雷暴/季节；不做音频；不做 agent 天气响应（打伞/避雨行为）；不做多楼层；角色仍用 folk.png（CC-BY George Bailey，已在 ATTRIBUTION）。
