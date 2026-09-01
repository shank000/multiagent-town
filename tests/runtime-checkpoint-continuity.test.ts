import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { worldDbPath } from '../src/cli/town-web-config';
import { Economy } from '../src/engine/economy';
import { profileDefinitionOf } from '../src/engine/agent-profile';
import { MindEngine } from '../src/engine/mind';
import { ExperimentRunner } from '../src/engine/experiment-runner';
import { buildTown } from '../src/engine/seed';
import { SocialTicker } from '../src/engine/social';
import { TownLifeEngine } from '../src/engine/town-life';
import { TownModel } from '../src/engine/town-model';
import { ExperimentWorkspaceRuntime, workspaceManifestPath } from '../src/engine/workspace';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { RelationshipStore } from '../src/store/relationships';

function workspaceConfig(worldKinds: Array<'mem-on' | 'mem-off' | 'rumor'> = ['mem-on']) {
  return {
    name: '运行连续性', seed: 902, worldSpeed: 1, defaultExperimentDays: 30,
    worldKinds, startPaused: true,
  };
}

test('manifest 档案配置恢复自定义背景、初态和头像，并整体拒绝显式冲突档案', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-profile-resume-'));
  const basePath = join(directory, 'profiles.sqlite');
  const gateway = new LLMGateway({ provider: 'mock' });
  let resumed: ExperimentWorkspaceRuntime | null = null;
  try {
    const template = buildTown();
    const first = template.allAgents()[0];
    const profile = profileDefinitionOf(first, 0);
    profile.background = '持久化测试专用背景：曾在北方灯塔工作。';
    profile.initialState = { ...profile.initialState, startingLocationId: 'obj:bookstore_counter', energy: 0.33 };
    profile.avatar = { ...profile.avatar, hair: '#112233', accessory: 'glasses' };
    const profiles = { [first.id]: profile };
    const workspace = await ExperimentWorkspaceRuntime.create(
      workspaceConfig(), { gateway, profileOverrides: () => profiles, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
    );
    await workspace.dispose();

    resumed = await ExperimentWorkspaceRuntime.resume(
      basePath, { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') },
    );
    const restored = resumed.current.worlds[0].world.getAgent(first.id);
    assert.equal(restored.persona.background, profile.background);
    assert.equal(restored.persona.initialState?.energy, 0.33);
    assert.equal(restored.persona.initialState?.startingLocationId, 'obj:bookstore_counter');
    assert.equal(restored.persona.avatar?.hair, '#112233');
    assert.equal(restored.persona.avatar?.accessory, 'glasses');
    await resumed.dispose();
    resumed = null;

    const conflicting = { ...profile, background: '冲突档案' };
    await assert.rejects(
      ExperimentWorkspaceRuntime.resume(basePath, {
        gateway,
        profileOverrides: () => ({ [first.id]: conflicting }),
        nextDatabasePath: () => join(directory, 'unused.sqlite'),
      }),
      /档案.*错配/,
    );
  } finally {
    if (resumed) await resumed.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('Economy 严格检查点保持余额和收礼库存连续', () => {
  const economy = new Economy();
  economy.earnDaily('agent:a');
  assert.equal(economy.buy('agent:a', 'flower'), true);
  assert.equal(economy.give('agent:a', 'agent:b', 'flower'), 0.1);
  const checkpoint = economy.checkpoint();

  const restored = new Economy();
  restored.restore(checkpoint, new Set(['agent:a', 'agent:b']));
  assert.equal(restored.getMoney('agent:a'), 5);
  assert.deepEqual(restored.inventoryOf('agent:b'), { flower: 1 });
  restored.earnDaily('agent:a');
  assert.equal(restored.buy('agent:a', 'flower'), true);
  assert.equal(restored.give('agent:a', 'agent:b', 'flower'), 0.1);
  assert.equal(restored.getMoney('agent:a'), 10);
  assert.deepEqual(restored.inventoryOf('agent:b'), { flower: 2 });
  assert.throws(() => restored.restore({ schemaVersion: 1, money: [['unknown', 1]], items: [] }, new Set(['agent:a'])), /经济检查点/);
});

test('伙伴实验检查点跨运行累计馈礼余额与收礼库存', async () => {
  const firstDb = openDb(':memory:');
  const firstLog = new EventLog(firstDb);
  const firstWorld = buildTown();
  const firstGateway = new LLMGateway({ provider: 'mock' });
  const firstMind = new MindEngine({ db: firstDb, llm: firstGateway, log: firstLog });
  const firstRunner = new ExperimentRunner(firstLog, firstWorld, firstMind, {
    historyAccess: 'off', giftExchange: 'on',
  }, { seed: 77 });
  firstRunner.start(2, 0);
  firstRunner.tick(1170);
  const firstCheckpoint = firstRunner.checkpoint();
  assert.equal(sumMoney(firstCheckpoint.partner.economy), 30);
  assert.equal(sumInventory(firstCheckpoint.partner.economy, 'flower'), 6);
  await firstMind.dispose({ gameTime: 1170 });
  await firstGateway.drain();
  firstDb.raw.close();

  const secondDb = openDb(':memory:');
  const secondLog = new EventLog(secondDb);
  const secondWorld = buildTown();
  const secondGateway = new LLMGateway({ provider: 'mock' });
  const secondMind = new MindEngine({ db: secondDb, llm: secondGateway, log: secondLog });
  const secondRunner = new ExperimentRunner(secondLog, secondWorld, secondMind, {
    historyAccess: 'on', giftExchange: 'off',
  }, { seed: 77 });
  try {
    secondRunner.restore(firstCheckpoint, 1170);
    secondRunner.tick(2610);
    const secondCheckpoint = secondRunner.checkpoint();
    assert.equal(sumMoney(secondCheckpoint.partner.economy), 60);
    assert.equal(sumInventory(secondCheckpoint.partner.economy, 'flower'), 12);
    assert.equal(secondRunner.state().remainingDays, 0);
  } finally {
    await secondMind.dispose({ gameTime: 2610 });
    await secondGateway.drain();
    secondDb.raw.close();
  }
});

test('TownModel 恢复计划目录身份与水位线，不重放预告且继续尚未开始的计划', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const model = new TownModel(log, new RelationshipStore(db), { seed: 7 });
  try {
    model.tick(world, 300, 300);
    model.tick(world, 820, 1120);
    const checkpoint = model.checkpoint();
    assert.ok(checkpoint.plans[0].stagedTiles.length > 0);
    const before = log.eventsBetween(0, 2_000).length;
    const restored = new TownModel(log, new RelationshipStore(db), { seed: 7 });
    restored.restore(checkpoint, world, 1120);
    restored.tick(world, 1, 1121);
    assert.equal(log.eventsBetween(0, 2_000).length, before, '首 tick 不得重放预告/取消/开始');
    restored.tick(world, 49, 1170);
    assert.equal(log.eventsOfKind('town_event_announcement').length, 1);
    assert.equal(log.eventsBetween(0, 2_000).filter((event) => (
      event.payload?.kind === 'town_event' || event.payload?.kind === 'town_event_cancelled'
    )).length, 1, '恢复的未开始计划仍会在原边界结算');
  } finally {
    db.raw.close();
  }
});

test('Mind 与 TownLife 水位线恢复后不重复边界，下一个边界仍触发', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const gateway = new LLMGateway({ provider: 'mock' });
  const first = new MindEngine({ db, llm: gateway, log });
  const submitted: string[] = [];
  first.planner.scheduleDailyAndHour = async () => { submitted.push('daily'); };
  first.planner.scheduleHour = async () => { submitted.push('hour'); };
  first.reflection.tick = () => undefined;
  first.reflection.summarizeDay = async () => undefined;
  first.dialogue.tick = () => undefined;
  first.townModel.tick = () => undefined;
  first.townLife.tick = () => undefined;
  try {
    first.tick(world, 300, 300);
    assert.equal(submitted.length, 6);
    const checkpoint = first.checkpoint();
    const restored = new MindEngine({ db, llm: gateway, log });
    restored.planner.scheduleDailyAndHour = async () => { submitted.push('daily'); };
    restored.planner.scheduleHour = async () => { submitted.push('hour'); };
    restored.reflection.tick = () => undefined;
    restored.reflection.summarizeDay = async () => undefined;
    restored.dialogue.tick = () => undefined;
    restored.townModel.tick = () => undefined;
    restored.townLife.tick = () => undefined;
    restored.restore(checkpoint, world, 300);
    restored.tick(world, 0, 300);
    assert.equal(submitted.length, 6, '恢复后不得重复 05:00 规划');
    restored.tick(world, 60, 360);
    assert.equal(submitted.length, 12, '下一个整点仍应触发');

    const life = new TownLifeEngine(log);
    life.tick(world, 420, 420);
    const lifeCheckpoint = life.checkpoint();
    const ambientBefore = log.eventsOfKind('ambient_life').length;
    const restoredLife = new TownLifeEngine(log);
    restoredLife.restore(lifeCheckpoint, world, 420);
    restoredLife.tick(world, 0, 420);
    assert.equal(log.eventsOfKind('ambient_life').length, ambientBefore);
    restoredLife.tick(world, 315, 735);
    assert.equal(log.eventsOfKind('ambient_life').length, ambientBefore + 1);

    const reflectionDb = openDb(':memory:');
    const reflectionLog = new EventLog(reflectionDb);
    const reflectionDays: number[] = [];
    const reflectionSource = new MindEngine({ db: reflectionDb, llm: gateway, log: reflectionLog });
    reflectionSource.planner.scheduleDailyAndHour = async () => undefined;
    reflectionSource.planner.scheduleHour = async () => undefined;
    reflectionSource.reflection.tick = () => undefined;
    reflectionSource.reflection.summarizeDay = async (_agent, day) => { reflectionDays.push(day); };
    reflectionSource.dialogue.tick = () => undefined;
    reflectionSource.townModel.tick = () => undefined;
    reflectionSource.townLife.tick = () => undefined;
    reflectionSource.tick(world, 1440, 1440);
    await reflectionSource.drain();
    assert.deepEqual(reflectionDays, Array(6).fill(1));
    const reflectionCheckpoint = reflectionSource.checkpoint();
    const reflectionRestored = new MindEngine({ db: reflectionDb, llm: gateway, log: reflectionLog });
    reflectionRestored.planner.scheduleDailyAndHour = async () => undefined;
    reflectionRestored.planner.scheduleHour = async () => undefined;
    reflectionRestored.reflection.tick = () => undefined;
    reflectionRestored.reflection.summarizeDay = async (_agent, day) => { reflectionDays.push(day); };
    reflectionRestored.dialogue.tick = () => undefined;
    reflectionRestored.townModel.tick = () => undefined;
    reflectionRestored.townLife.tick = () => undefined;
    reflectionRestored.restore(reflectionCheckpoint, world, 1440);
    reflectionRestored.tick(world, 0, 1440);
    await reflectionRestored.drain();
    assert.equal(reflectionDays.length, 6, '恢复后不得重复第 1 天日反思');
    reflectionRestored.tick(world, 1440, 2880);
    await reflectionRestored.drain();
    assert.deepEqual(reflectionDays, [...Array(6).fill(1), ...Array(6).fill(2)]);
    reflectionDb.raw.close();
  } finally {
    db.raw.close();
    void gateway.drain();
  }
});

test('恢复激活时原子中断 crash 遗留 active conversation，不生成伪对话内容', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-conversation-resume-'));
  const basePath = join(directory, 'conversation.sqlite');
  const dbPath = worldDbPath(basePath, 'w1');
  const gateway = new LLMGateway({ provider: 'mock' });
  let resumed: ExperimentWorkspaceRuntime | null = null;
  try {
    const workspace = await ExperimentWorkspaceRuntime.create(
      workspaceConfig(), { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
    );
    await workspace.dispose();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(`INSERT INTO conversations(
        id, agent_a, agent_b, status, started_game_time, ended_game_time,
        turn_count, summary, error_text, updated_game_time
      ) VALUES (?, ?, ?, 'active', ?, NULL, 0, '', '', ?)`)
        .run('crash-active', 'agent:lin', 'agent:chen', 100, 100);
    } finally {
      db.close();
    }
    const eventsBefore = rowCount(dbPath, 'events');
    const messagesBefore = rowCount(dbPath, 'messages');
    resumed = await ExperimentWorkspaceRuntime.resume(
      basePath, { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') },
    );
    const read = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = read.prepare("SELECT status, ended_game_time, error_text FROM conversations WHERE id = 'crash-active'").get() as {
        status: string; ended_game_time: number; error_text: string;
      };
      assert.equal(row.status, 'interrupted');
      assert.equal(row.ended_game_time, resumed.current.worlds[0].time.state.totalMinutes);
      assert.equal(row.error_text, '进程恢复');
    } finally {
      read.close();
    }
    assert.equal(rowCount(dbPath, 'events'), eventsBefore);
    assert.equal(rowCount(dbPath, 'messages'), messagesBefore);
  } finally {
    if (resumed) await resumed.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('三世界按工作空间节流保存：无变化 settle 不写，一次对齐批次至多写一次', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-checkpoint-throttle-'));
  const basePath = join(directory, 'parallel.sqlite');
  const gateway = new LLMGateway({ provider: 'mock' });
  const workspace = await ExperimentWorkspaceRuntime.create(
    workspaceConfig(['mem-on', 'mem-off', 'rumor']),
    { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
  );
  try {
    const initial = workspace.checkpointStats();
    const firstSet = manifestSetId(basePath);
    await Promise.all(workspace.current.worlds.map((world) => world.loop.realtimeCycle(false)));
    assert.equal(manifestSetId(basePath), firstSet);
    assert.deepEqual(workspace.checkpointStats(), initial);

    for (let tick = 0; tick < 10; tick++) {
      await Promise.all(workspace.current.worlds.map((world) => world.loop.realtimeCycle(true)));
    }
    assert.equal(workspace.checkpointStats().writes, initial.writes + 1);
    assert.notEqual(manifestSetId(basePath), firstSet);
  } finally {
    await workspace.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('SocialTicker 恢复相邻累计与冷却，不在重启后立即重复会话', () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const world = buildTown();
  const [first, second] = world.allAgents();
  first.x = 5;
  first.y = 5;
  first.state = 'idle';
  first.action = null;
  second.x = 6;
  second.y = 5;
  second.state = 'idle';
  second.action = null;
  const config = { minProximityMinutes: 1, cooldownMinutes: 90, residentCooldownMinutes: 45 };
  const source = new SocialTicker(log, config);
  try {
    source.tick([first, second], 1, 10, world);
    assert.equal(log.eventsOfKind('chat').length, 1);
    const checkpoint = source.checkpoint();
    source.dispose(true);

    const restored = new SocialTicker(log, config);
    try {
      restored.restore(checkpoint, new Set([first.id, second.id]), 10);
      restored.tick([first, second], 1, 11, world);
      assert.equal(log.eventsOfKind('chat').length, 1, '配对冷却必须跨进程保留');
      restored.tick([first, second], 89, 100, world);
      assert.equal(log.eventsOfKind('chat').length, 2, '冷却结束后仍可发起下一次会话');
    } finally {
      restored.dispose();
    }
  } finally {
    source.dispose();
    db.raw.close();
  }
});

test('恢复预检拒绝未来决策水位与未来物件更新时间', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-checkpoint-bounds-'));
  const basePath = join(directory, 'bounds.sqlite');
  const dbPath = worldDbPath(basePath, 'w1');
  const gateway = new LLMGateway({ provider: 'mock' });
  try {
    const workspace = await ExperimentWorkspaceRuntime.create(
      workspaceConfig(), { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
    );
    await workspace.dispose();
    const db = new DatabaseSync(dbPath);
    let original: string;
    try {
      original = (db.prepare('SELECT checkpoint_json FROM runtime_checkpoint WHERE slot = 1').get() as { checkpoint_json: string }).checkpoint_json;
      const futureDecision = JSON.parse(original) as {
        clock: { elapsedMinutes: number }; agents: Array<{ lastDecisionAt: number }>;
      };
      futureDecision.agents[0].lastDecisionAt = Math.floor(futureDecision.clock.elapsedMinutes) + 1;
      db.prepare('UPDATE runtime_checkpoint SET checkpoint_json = ? WHERE slot = 1').run(JSON.stringify(futureDecision));
    } finally {
      db.close();
    }
    await assert.rejects(
      ExperimentWorkspaceRuntime.resume(basePath, { gateway, nextDatabasePath: () => join(directory, 'unused.sqlite') }),
      /决策时间/,
    );

    const db2 = new DatabaseSync(dbPath);
    try {
      const futureObject = JSON.parse(original!) as {
        clock: { elapsedMinutes: number };
        objects: Array<{ state: null | { label: string; detail: string; updatedGameTime: number; expiresGameTime: number } }>;
      };
      futureObject.objects[0].state = {
        label: '损坏状态', detail: '来自未来',
        updatedGameTime: Math.floor(futureObject.clock.elapsedMinutes) + 1,
        expiresGameTime: Math.floor(futureObject.clock.elapsedMinutes) + 2,
      };
      db2.prepare('UPDATE runtime_checkpoint SET checkpoint_json = ? WHERE slot = 1').run(JSON.stringify(futureObject));
    } finally {
      db2.close();
    }
    await assert.rejects(
      ExperimentWorkspaceRuntime.resume(basePath, { gateway, nextDatabasePath: () => join(directory, 'unused.sqlite') }),
      /物件.*更新时间/,
    );
  } finally {
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function rowCount(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function manifestSetId(basePath: string): string {
  return (JSON.parse(readFileSync(workspaceManifestPath(basePath), 'utf8')) as { checkpointSetId: string }).checkpointSetId;
}

function sumMoney(checkpoint: { money: Array<[string, number]> }): number {
  return checkpoint.money.reduce((total, [, balance]) => total + balance, 0);
}

function sumInventory(checkpoint: { items: Array<[string, Record<string, number>]> }, itemKey: string): number {
  return checkpoint.items.reduce((total, [, inventory]) => total + (inventory[itemKey] ?? 0), 0);
}
