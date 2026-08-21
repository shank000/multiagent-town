# 小镇完善 · 阶段 D 设计（spec）

> 日期：2026-08-21　状态：已获用户批准（「批准，开工」）
> 上游：小镇 2.0 三阶段（A/B/C 已完成，main=46f4236，已推送 GitHub shank000/multiagent-town）
> 目标：内容扩充 + 视觉精修 + 高清合规素材升级

## 目标

1. **素材升级**（许可合规，用户确认方向）：Kenney Tiny Town（CC0）、Sharm Tiny 16 Basic/Buildings（CC-BY 3.0 署名 Sharm）、0x72 DungeonTileset II（CC0，含家具砖）；禁用 RPG Maker RTP/星露谷/LPC/来源不明仓库（用户提议的两仓库经裁定弃用——StardewValley-Assets 为侵权扒取、PixelSRPG-Forge 作者自认版权来源不明）。
2. **小镇内容丰富**：新建筑 花店/杂货店/钓鱼码头（含小船）、装饰（广场花坛、湖边栅栏）；NPC 4→6（白露·花店老板、老周·渔夫）。
3. **视觉精修**：建筑外景修复、雨滴落地水花接线、水面涟漪、分段雨丝、NPC 交互动作图标展示、走动动画更顺滑。

## D1 素材升级

- 下载前逐页复核许可（curl 页面 grep license）：
  - Kenney Tiny Town：https://kenney.nl/assets/tiny-town（CC0）
  - Sharm Tiny 16 Basic：https://opengameart.org/content/tiny-16-basic（CC-BY 3.0）+ Tiny 16 Buildings：https://opengameart.org/content/tiny-16-buildings（CC-BY 3.0/OGA-BY 3.0，署名 Sharm）
  - 0x72 DungeonTileset II：https://0x72.itch.io/dungeontileset-ii（itch 不可达）→ 改用 opengameart 镜像/同名页（下载前复核 CC0）
- `tiles.ts`：SheetId 扩展 `'tinytown' | 'tiny16' | 'dungeon'`；TILE_MAP 增加 `townSet`（外景素材包选择）与 `furnitureSet`（家具图集来源）；程序化像素分析定坐标（沿用 C 阶段平均色方法），不确定者标注。
- ATTRIBUTION.md 追加三个包条目（CC-BY 强制署名 Sharm；CC0 礼貌署名 Kenney/0x72）。

## D2 小镇内容丰富

- 新对象（seed.ts TOWN_OBJECTS）：
  - `obj:flower_shop` 花店 (12,18,4,4)；`obj:grocer` 杂货店 (24,12,4,4)；`obj:pier` 钓鱼码头 zone (16,26,4,2)；`obj:boat` 小船 furniture (17,27,2,1)
  - `obj:home_bailu` (12,34,4,4)、`obj:home_zhoulao` (18,34,4,4)；床/沙发：`obj:bed_bailu`(13,34,1,2)、`obj:sofa_bailu`(12,36,2,1)、`obj:bed_zhoulao`(19,34,1,2)、`obj:sofa_zhoulao`(18,36,2,1)
  - 装饰：`obj:flowerbed` 广场花坛 zone (20,20,2,2)、`obj:fence_lake` 湖边栅栏 zone (14,26,8,1)（zone 不阻挡）
- 新 persona（BAILU_PERSONA 白露/女/26/花店老板/园艺、ZHOU_LAO_PERSONA 老周/男/60/渔夫/爱讲故事），全属性档案（性别/外貌/爱好/技能/价值观/动机/背景≥80字）+ routine（开店/钓鱼/散步/沙发/床双槽，白天相邻窗口不与 M3 冲突）+ greetingPool + personality（extraversion 0.6+/0.7 参与公开活动）
- HOME_BY_NAME 加两映射；DEFAULT_SEED.personas 6 人
- 测试更新（4→6 语义迁移）：acceptance-m3 `/api/status` 4→6、relations/rumor/social 相关断言；acceptance-town2 睡床断言自然覆盖新床；profile.test 6 人循环；新对象 A* 可达由 acceptance-town2 ② 覆盖
- spriteIndex 0..5：folk.png 为 4 列×2 行（8 角色容量）✓ 无需改；PALETTES 程序化回退 index%4 已有

## D3 视觉精修

- 建筑外景修复：素材路径改为「墙全铺满 3×3 + 屋顶行 + 门 + 窗」补全底部两角（tiny16/tinytown 建筑砖），回退保留；夜间窗点亮保留
- 雨：`rainSplash` 接线（rain 粒子落地或进入水面区域时 spawn splash）；水面涟漪（雨天 water 瓦片叠加波纹粒子或高光增强）；`rainDrop` 改 2 段分段斜线
- NPC 交互动作展示：acting 时头顶动作图标（☕/🎨/✉️/💤/📖 按 verb 关键词映射，2s 循环弹跳，canvas 绘制）；坐/躺姿态保留
- 走动动画：帧切换与 bob 相位微调（walk 帧间隔按速度归一、阴影随 bob 缩放）

## D4 验收 + 合并 + 推送

1. `pnpm test` 全绿（人数 6 语义）；`pnpm typecheck` 0；`pnpm build:web` 成功
2. 服务冒烟：`/api/state` agents=6、新对象存在；素材 PNG 200
3. 素材署名合规（ATTRIBUTION 完整）
4. 合并 main、推送 origin/main（GitHub 仓库已在 remote）

## 风险与对策

- 新 NPC 影响 M3 社交动态：白天相邻窗口机制不变，人数增加只会提高谣言/活动命中；若个别断言浮动则按语义微调（ledger 记录）
- 0x72 itch.io 不可达：用 opengameart 同源页或 CC0 替代内饰（若均不可达则保留现有 medieval 内饰 + 程序化家具）
- 图集坐标无视觉确认：程序化平均色 + 报告证据表，终审人工目检

## 非目标

- 不做战斗/任务系统；不做多楼层；不做季节/下雪；不做音频；不改天气机制（雨视觉增强除外）
