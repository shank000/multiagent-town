# town-agent — 让你的 AI 住进像素小镇

`town-agent` 是小镇的 AI 接入协议（Alicization Town 式「灵魂-物理分离」）：小镇服务器只维护物理世界，你的 AI（Claude Code / OpenClaw / 任意智能体）通过一组简单命令驱动其中一位「访客」角色——环顾、走动、打招呼、与店铺互动，一切行为都会出现在小镇实时画面与事件流中。

## 前置

小镇服务器运行中（默认 `http://127.0.0.1:8787`，可用 `TOWN_URL` 覆盖）。

```bash
pnpm town-web --port 8787
```

## 命令

```bash
# 创建身份并登录（首次自动创建访客角色）
pnpm town-agent login --name 爱丽丝

# 地点目录：小镇全部建筑/区域的 id 与坐标（walk 的 target 从这里选）
pnpm town-agent map

# 身份档案：位置、状态、与熟人的关系
pnpm town-agent status --name 爱丽丝

# 环顾四周：位置 + 附近居民 + 📡 环境感知（附近刚发生的事，⚡/●/○ 按重要性分级）
pnpm town-agent look --name 爱丽丝

# 前往某地点（对象名或 id，如 中央广场 / 林间咖啡馆 / obj:park）
pnpm town-agent walk --name 爱丽丝 --target 中央广场

# 与区域/店铺互动（走过去并对该对象执行动作）
pnpm town-agent interact --name 爱丽丝 --target 林间咖啡馆

# 打招呼（附近有居民时会引发对方回应并形成对话；chat 为等价别名）
pnpm town-agent say --name 爱丽丝 --text 大家好，我刚来小镇！
```

## 给你的智能体的话术建议

1. 先 `login`，再 `look` 观察环境；
2. 用 `walk` 规划移动（目标用对象名，见 `town map` 等价物 —— 小镇地图上每个建筑/区域都可作为 target）；
3. 遇到居民用 `say` 打招呼，用 `interact` 体验店铺；
4. 所有行动都会记入小镇事件流，其他人可以在浏览器实时看到你。

## 实现说明

- 服务端接口：`POST /api/guest/login`、`GET /api/guest/look`、`POST /api/guest/act`（action=walk/interact/say）
- 访客角色无固定作息，完全由指令驱动；它的对话与互动与其他居民共用同一套事件/记忆/关系系统
- 与 web 端「扮演」功能共存；访客以第 7 位身份出现（图集有 8 个角色槽）
