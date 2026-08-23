// 数据统计与分析：analyzeTown 报告结构 + /api/stats 接口 + 统计页静态资源 + 客户端渲染
// 运行方式同其他测试：node --import tsx --test

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
import { SocialTicker } from '../src/engine/social';
import { analyzeTown, type TownReport } from '../src/engine/analyze';
import { createTownServer } from '../src/web/server';
import { renderAll, fmt } from '../src/web/client/stats';

/** 全引擎跑一个游戏日（mock LLM），得到一个有事件/记忆/关系/对话的库 */
async function runOneDay() {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const time = new TimeEngine(30); // 3600x
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const social = new SocialTicker(log, {}, mind.dialogue);
  const loop = new WorldLoop(time, world, executor, log, db, {}, social, mind);
  await loop.runUntil(1440);
  return db;
}

test('analyzeTown：整库报告结构完整（全引擎跑 1 个游戏日后）', async () => {
  const db = await runOneDay();
  const r = analyzeTown(db, { top: 10 });
  const c = r.overview.counts;

  // 概览
  assert.equal(r.overview.days, 1);
  assert.equal(r.overview.gameMinutes, 1440);
  assert.equal(c.agents, 6);                       // 六位常驻居民（名册已水合）
  assert.equal(r.overview.agents.length, 6);
  assert.ok(c.objects > 40, `对象过少: ${c.objects}`);
  assert.ok(c.events > 100, `事件过少: ${c.events}`);
  assert.ok(c.memories >= 6 * 15, `记忆过少: ${c.memories}`);
  // 每位一天一条日计划；runUntil(1440) 落在第 2 天 0:00，整点变化还会生成第 2 天的占位计划
  assert.ok(c.plans >= 6 && c.plans % 6 === 0, `计划数异常: ${c.plans}`);
  assert.ok(c.reflections >= 1, '一整天没有反思');
  assert.ok(c.messages > 0, '没有对话消息');

  // 事件
  assert.ok(r.events.total === c.events);
  assert.equal(r.events.filtered, false);
  for (const t of ['move', 'system']) assert.ok(r.events.byType[t] > 0, `缺事件类型 ${t}`);
  assert.ok(r.events.perDay.length >= 1);
  assert.equal(r.events.perDay[0].day, 1);
  assert.ok(r.events.perHour.length >= 1);
  assert.ok(r.events.topActors.length >= 1);
  // actor 名字应解析为居民名
  const known = new Set(r.overview.agents.map((a) => a.name));
  assert.ok(known.has(r.events.topActors[0].name), `actor 名未解析: ${r.events.topActors[0].name}`);

  // 记忆
  assert.ok(r.memories.byKind.observation > 0);
  assert.ok(r.memories.byKind.dialogue_summary > 0);
  assert.equal(r.memories.byAgent.length, 6);
  assert.ok(r.memories.importance.avg >= 1 && r.memories.importance.avg <= 10);
  assert.equal(r.memories.importanceHist.reduce((s, h) => s + h.count, 0), r.memories.total);
  assert.ok(r.memories.neverAccessed.ratio >= 0 && r.memories.neverAccessed.ratio <= 1);
  assert.ok(r.memories.perDayRate > 0);

  // 反思 / 计划
  assert.ok(r.reflections.avgTriggerScore > 0);
  assert.ok(r.reflections.avgInsights >= 0);
  assert.ok(r.plans.daysCovered >= 1); // runUntil(1440) 还会产生第 2 天占位计划
  assert.ok(r.plans.byAgent.length >= 1);

  // 对话
  assert.ok(r.dialogues.conversations >= 1, '没有完整会话');
  assert.ok(r.dialogues.avgTurnsPerConversation >= 1);
  assert.ok(r.dialogues.avgCharsPerMessage > 0);
  assert.ok(r.dialogues.topPairs.length >= 1);

  // 关系：对话摘要双写 → 至少存在一个双向对
  assert.ok(r.relationships.pairs >= 2);
  assert.ok(r.relationships.reciprocalPairs >= 1, '没有双向关系对');
  assert.ok(r.relationships.knowledgeEntries >= 1);

  // 声望榜：覆盖全镇名册、降序且成员名已解析（无关系边的居民补 0 分）
  assert.equal(r.standing.length, r.overview.agents.length);
  for (let i = 1; i < r.standing.length; i++) {
    assert.ok(r.standing[i - 1].score >= r.standing[i].score);
  }

  // 谣言：无种子时为 0（有结构即可）
  assert.equal(typeof r.rumors.total, 'number');
  assert.equal(typeof r.rumors.maxHops, 'number');

  // 公开活动：成行活动≥0，结构存在
  assert.ok(Array.isArray(r.townEvents));
});

test('analyzeTown：day 过滤只作用于事件/消息；JSON 可序列化；dbPath 回显', async () => {
  const db = await runOneDay();
  const all = analyzeTown(db, { top: 5 });
  const day1 = analyzeTown(db, { day: 1, top: 5, dbPath: 'data/town.sqlite' });

  assert.equal(day1.events.filtered, true);
  assert.equal(day1.events.total, all.events.perDay.find((d) => d.day === 1)?.count);
  assert.equal(day1.events.perDay.length, 1);
  assert.equal(day1.events.perDay[0].day, 1);
  // 记忆/关系不受 day 过滤影响
  assert.equal(day1.memories.total, all.memories.total);
  assert.equal(day1.relationships.pairs, all.relationships.pairs);
  // dbPath 回显
  assert.equal(day1.overview.dbPath, 'data/town.sqlite');
  // JSON 往返一致（无 Map/Set，全部纯数据）
  const roundtrip = JSON.parse(JSON.stringify(day1)) as TownReport;
  assert.deepEqual(roundtrip, day1);
});

test('/api/stats 接口与统计页静态资源', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-web-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>fixture</body></html>');
    writeFileSync(join(dir, 'stats.html'), '<!doctype html><html><body>📊 小镇数据统计与分析</body></html>');
    writeFileSync(join(dir, 'style.css'), 'body{}');
    writeFileSync(join(dir, 'client.js'), 'console.log(1)');
    writeFileSync(join(dir, 'stats.js'), 'console.log(2)');

    const db = openDb(':memory:');
    db.setMeta('game_time', '720');
    // 手工写入少量数据，让报告非零
    db.raw.prepare(`INSERT INTO events(id, type, actor_id, target_ids_json, description, location, game_time, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('e1', 'move', 'agent:lin', '[]', '「林晚晴」走到咖啡店', 'obj:cafe', 300, null);

    const log = new EventLog(db);
    const world = buildTown();
    const time = new TimeEngine(5);
    const gateway = new LLMGateway({ provider: 'mock' });
    const executor = new AgentExecutor(gateway, world, log);
    const loop = new WorldLoop(time, world, executor, log, db);
    const server = await createTownServer({ world, time, loop, log, db, dbPath: 'data/town.sqlite', publicDir: dir, snapshotMs: 30 });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const page = await (await fetch(`${base}/stats.html`)).text();
      assert.ok(page.includes('小镇数据统计与分析'));
      assert.equal((await fetch(`${base}/stats.js`)).status, 200);

      const res = await fetch(`${base}/api/stats`);
      assert.equal(res.status, 200);
      const report = (await res.json()) as TownReport;
      assert.equal(report.overview.gameMinutes, 720);
      assert.equal(report.overview.days, 0); // 不足一天
      assert.equal(report.overview.dbPath, 'data/town.sqlite');
      assert.equal(report.overview.agents.length, 6); // 名册来自内存世界（WorldLoop 水合）
      assert.equal(report.events.byType.move, 1);
      assert.equal(report.events.filtered, false);

      const res1 = await fetch(`${base}/api/stats?day=1`);
      const report1 = (await res1.json()) as TownReport;
      assert.equal(report1.events.filtered, true);
      // 1 条手写 move + WorldLoop 构造时的「第1天开始」system 事件
      assert.equal(report1.events.total, 2);
      assert.equal(report1.events.byType.system, 1);

      // 缺省 db 时 404
      const serverNoDb = await createTownServer({ world, time, loop, log, publicDir: dir, snapshotMs: 30 });
      try {
        const noDb = await fetch(`http://127.0.0.1:${serverNoDb.port}/api/stats`);
        assert.equal(noDb.status, 404);
      } finally {
        await serverNoDb.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('客户端渲染：renderAll 输出全部统计区块', async () => {
  const db = await runOneDay();
  const r = analyzeTown(db, { top: 5 });
  const html = renderAll(r);
  for (const key of ['概览', '事件', '记忆', '反思', '计划', '对话', '关系', '声望榜', '谣言', '公开活动']) {
    assert.ok(html.includes(`<h2>${key}`), `缺少区块：${key}`);
  }
  assert.ok(html.includes('林晚晴'), '未渲染居民名');
  assert.ok(html.includes('sbar-fill'), '缺少条形图');
  // fmt 数字格式化
  assert.equal(fmt(12), '12');
  assert.equal(fmt(0.5), '0.5');
  assert.equal(fmt(1 / 3, 2), '0.33');
  assert.equal(fmt(12.0, 2), '12');
});