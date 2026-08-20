# 小镇 2.0 · 阶段 B 设计（spec）

> 日期：2026-08-20　状态：已获用户批准（WeChat 确认「批准，开工」）
> 上游：Town 2.0 三阶段总体规划（A 已完成并合入 main）；`docs/agentopia-analysis.md`
> 阶段 C 后续：ansimuz/LimeZu/Kenney 素材替换 + 天气 + UI 皮肤精修

## 目标

1. **全屏地图**：地图扩容至 48×44 宽幅并铺满整个浏览器窗口，取消拖拽操作。
2. **家具交互动作特效**：NPC 与家具互动的每个动作都有精细特效（星露谷级）。
3. **Agent 全属性档案**：性别/外貌/爱好/技能/价值观/动机/背景，客户端档案页展示。
4. **环境动态特效基础层**：水波、炊烟、树影、萤火虫、灯火、昼夜平滑。

## B1 地图扩容 + 全屏铺满

### 地图 40×40 → 48×44

- `src/core/world.ts`：`GRID_W = 48`、`GRID_H = 44`；`inBounds` 自动生效。
- `src/engine/seed.ts`：`obj:town` 改为 `w: 48, h: 44`；新增右/下地形带对象（纯装饰，全部可走，不影响既有 A* 与 routine 可达性）：
  - `obj:orchard` 果园（x40..47, y2..10，含 `obj:orchard_tree*` 装饰树，type: zone——装饰树不阻挡、可通行，仅在渲染层画树）
  - `obj:forest_ne` 东侧林地（x42..47, y12..22，装饰树簇）
  - `obj:river` 南侧河流（y40..43, x8..47，宽 1-2 的 water 地带；**water 瓦片不可走**，仅在无人区，不与任何 routine 目标冲突）
  - `obj:farm_east` 东侧农田延伸（x40..44, y26..33，作物行装饰）
  - `obj:meadow_s` 南侧草坡（x0..7, y40..43）
- 河流按不可走处理：`ObjectType` 联合类型新增 `'water'`，`computeWalkable` 将 water 瓦片全部加入 blocked。河流区域不包含任何现有路径端点，验收测试需确认全部 routine 目标仍可达。
- 地形带不新增建筑，仅装饰 + 1 条沿河小径（zone）。

### 全屏自适应相机（取消拖拽）

- `src/web/client/main.ts`：
  - 画布尺寸 = 浏览器窗口尺寸（`window.innerWidth/Height`，resize 监听 + devicePixelRatio 适配）。
  - 相机改为 **fit-to-screen**：`scale = min(winW / (gridW*TILE), winH / (gridH*TILE))`，地图居中（信箱留白用主题底色 + 暗角）。
  - **删除拖拽平移**（pointer 手势仅保留点击/悬停）；滚轮缩放 `scaleFit × {1, 2, 4}`，围绕光标缩放；缩放 > 1 时允许按住拖动平移细节（默认全图，无需拖拽即可看到全部地图信息）；双击或 HUD「全图」按钮一键复位。
  - 悬浮 HUD：`#panel` 改为地图上方的可折叠浮动面板（右上角，收起为小按钮）；HUD 顶栏（时钟/速度）与事件 ticker、横幅保持悬浮在地图上。
  - `style.css` 配套：body 无滚动、canvas 全屏、面板半透明 + 阴影 + 折叠动画。
- 渲染性能：48×44 全图约 2112 瓦片，一次性全画可接受（现有 drawTerrain 逐瓦片绘制）；特效层独立 canvas 或同 canvas 分层绘制。

## B2 Agent 全属性档案

### 类型扩展（`src/core/types.ts`）

```ts
export interface Appearance {
  hairStyle: string;   // 如「齐肩短发」
  hairColor: string;   // 如「深棕色」
  skinTone: string;    // 如「浅麦色」
  outfit: string;      // 如「米色围裙配深蓝衬衫」
}
export interface Persona {
  // ……既有字段
  gender: '男' | '女';
  appearance: Appearance;
  hobbies: string[];      // 2~4 项
  skills: Record<string, number>; // 0..10，如 { 手冲咖啡: 9, 倾听: 8 }
  values: string[];       // 2~4 条价值观
  motivation: string;     // 一句话动机
}
```

- `background` 扩写为 150~250 字完整背景故事。
- 4 个 persona 全量填充（林晚晴/陈默/沈屿/周岚，贴合既有 personality/routine/greetingPool 不矛盾）。

### 提示词注入

- `src/engine/`（persona 文本组装处）：personaText 增加一行「性别/爱好/技能/价值观/动机」压缩摘要；decision 提示词增加价值观一句（影响 mock 与真实 LLM 决策上下文）。

### 快照与客户端

- `src/web/server.ts`：`AgentView` 增加 `gender/age/occupation/hobbies/skills/values/motivation/background/appearance/personality`（档案全量）。
- 客户端：`#panel-tabs` 新增「档案」标签页 → 头像（程序化）、性别/年龄/职业、爱好标签、技能条（数值可视化）、价值观列表、动机、背景故事卡片、性格五维条。

## B3 家具交互动作特效

全部为客户端渲染层（`render.ts` + `main.ts`），不改引擎状态机。

### 姿态与过渡

- 坐：agent 到达椅/沙发/咖啡桌目标瓦片且 state=acting 时，0.3s 缓动切换为**坐姿**（下半身隐藏、整体下沉 4px）；起身 0.2s 恢复。
- 睡：目标是床 → **平躺姿**（身体横向压扁 50%，头部保留），头顶逐帧「Z…z…z」气泡循环上升。
- 判断依据：`action.target` 对象 type=furniture + name 关键词（床/沙发/椅/桌）。

### 动作粒子（verb/target 关键词映射）

| 触发 | 特效 |
|---|---|
| 煮咖啡/吧台/咖啡馆 | 白色蒸汽粒子上升 + 消散 |
| 写生/画架 | 画笔光点 + 调色板微光 |
| 送信/邮局/分拣 | 信封图标弹跳 + 纸张粒子 |
| 开店/整理/接待 | 柜台前光点闪烁 |
| 落座瞬间 | 尘土粒子环形扩散 |
| 睡觉入睡 | 星星粒子淡入 + Zzz |

- 粒子系统：轻量数组 + 每帧更新（位置/寿命/alpha），上限 512 个，性能安全。
- 阴影：全员脚下椭圆阴影（Y 越下越大），移动时同步。
- 走路：现有 3 帧步行 + 增加 ±1px 上下轻摆（sin 相位），四方向沿用 sprites 表。

## B4 环境动态特效基础层

- 水波：湖/河 water 瓦片叠加正弦高光条纹（2 层错相位）+ 偶发波光粒子。
- 炊烟：咖啡馆/面包店/住宅烟囱处灰色烟圈粒子缓慢上升扩散（白天启用）。
- 树影：装饰树冠 sin(t + 相位) 左右 ±1px 摇曳。
- 萤火虫：夜间（日落后）公园/湖边/林地 20~40 只发光粒子漂移（暖黄 alpha 脉动）。
- 灯火：日落后路灯（主街/广场 4~6 处）暖光晕 + 建筑窗户逐一点亮。
- 昼夜平滑：现有 applyDayNight 改为**连续过渡**（黄昏橙紫 tint 渐变，夜间蓝调 + 辉光层），不再跳变。
- 特效随 60x 时间（游戏时间）驱动 + 渲染帧实时插值。

## B5 验收

1. e2e：推进 1 游戏日，每 agent 至少 1 条 `interact` 目标为自身床的事件（`obj:bed_*`）。
2. 快照：`/api/state` 的 AgentView 含档案全字段且非空；4 persona 完整性单测（字段全量 + skills 数值 0..10）。
3. 地图：`gridW=48, gridH=44`；所有 routine 目标可达（既有 A* 测试迁移新尺寸）；河流不可走单测。
4. 客户端冒烟：无拖拽监听、fit-scale 计算单测（纯函数抽出）、特效渲染函数 smoke（node 下不崩，注入 mock ctx）。
5. 全量 `node:test` 绿；`tsc` 严格通过。

## 风险与对策

- **河流不可走影响可达性**：河流仅放 y40..43 无人带，若 A* 验收失败则降级为「可涉水浅滩」装饰（不阻挡）。
- **全屏铺满后瓦片变小**：fit-scale 在 1080p 约 0.77（~25px/瓦），可接受；滚轮放大可看细节。
- **粒子性能**：上限 512 + 单 canvas 合成，帧率目标 60fps（粒子按需按区域启用，画面外不更新）。
- **subagent 工具不稳定**：沿用 SDD 惯例，连续 2 次失败由控制器自实现并记入 ledger。

## 非目标（明确不做）

- 不做物品拾取/背包/家具摆放（取用=动作演出，非物品系统）。
- 不做音频；不做多楼层。
- 天气、素材替换、UI 皮肤属于阶段 C。
