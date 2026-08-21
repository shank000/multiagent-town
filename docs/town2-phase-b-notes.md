# 小镇 2.0 · 阶段 B 设计备忘（家具交互 + Agent 全属性档案）

> 阶段 C 素材候选（后台调研子代理完整报告）：
> - 外景首选：ansimuz Tiny RPG Forest（CC0 已核实）+ Tiny RPG Town（CC0 高置信，下载前页面确认）
> - 内饰首选：LimeZu Modern Interiors（CC-BY 4.0 高置信，下载前页面确认）；备选 ansimuz Tiny RPG Interior
> - UI：Kenney Pixel UI Pack + RPG Expansion（CC0 已核实）
> - 角色：保留 folk.png（CC-BY 4.0 George Bailey）
> - 禁用：LPC 全系（SA+GPL）、Sonetto Commons Town tileset（CC-BY-SA）、RPG Maker RTP、仿星露谷衍生
> - 工程建议：16×16 素材 2× nearest-neighbor 放大至 32px，匹配现有网格与角色
> - 署名：CC0 礼貌署名；CC-BY 必须署名（LimeZu/George Bailey）+ 链接 + 改动说明 → credits 统一列出

## 阶段 B 设计

**B1 家具交互（坐/睡/休息）**
- 家具目标走既有 interact 动作（无需新动作类型）；routine 增加家具时段（22:00-次日 7:00 睡床；午后沙发小憩；吧台/咖啡桌小坐）
- 客户端视觉：目标为床 → NPC 头顶「Zzz」+ 平躺姿（精灵横向压缩）；沙发/椅 → 「小憩」气泡；家具点击卡已有（复用建筑卡片逻辑）
- 引擎无需改状态机（interact 已支持任意对象）

**B2 Agent 全属性档案**
- Persona 扩展：gender（男/女）、appearance（发型/发色/肤色/服装）、hobbies[]、skills{}（如 咖啡 8/10）、values[]、motivation、backstory
- 提示词注入：personaText 增加 爱好/技能/动机/背景 压缩行；decision 提示词增加价值观一行
- 快照 AgentView 扩展上述字段；客户端「档案」标签页：性别/年龄/职业/爱好标签/技能条/价值观/动机/背景故事/性格五维
- 4 个 persona 补全档案（林晚晴/陈默/沈屿/周岚各写 200 字级背景与技能）

**B3 验收**
- e2e：1 游戏日每 agent 至少一次 interact 目标为其床；/api/state 快照 AgentView 含新档案字段且非空；4 persona 档案完整性单测
