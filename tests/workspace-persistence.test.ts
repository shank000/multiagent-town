import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { parseArgs, worldDbPath } from '../src/cli/town-web-config';
import { TimeEngine } from '../src/core/time';
import { ExperimentWorkspaceRuntime, nextWorkspaceDatabasePath, workspaceManifestPath } from '../src/engine/workspace';
import { LLMGateway } from '../src/llm/gateway';

function config(worldKinds: Array<'mem-on' | 'mem-off' | 'rumor'> = ['mem-on']) {
  return {
    name: '持久化复现实验', seed: 20260902, worldSpeed: 1,
    defaultExperimentDays: 30, worldKinds, startPaused: true,
  };
}

function countRows(path: string, table: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return Number(row.n);
  } finally {
    db.close();
  }
}

test('精确时钟只接受有限、非负且版本匹配的恢复点', () => {
  const time = new TimeEngine(0.25);
  time.tick();
  time.tick();
  const saved = time.checkpoint();
  time.tick();
  time.restore(saved);
  assert.deepEqual(time.checkpoint(), { schemaVersion: 1, elapsedMinutes: 0.5 });
  assert.throws(() => time.restore({ schemaVersion: 1, elapsedMinutes: Number.NaN }), /时钟检查点/);
  assert.throws(() => time.restore({ schemaVersion: 2, elapsedMinutes: 0 }), /时钟检查点/);
});

test('文件工作空间原子保存并显式恢复运行态，同时保留既有研究记录', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-persistence-'));
  const basePath = join(directory, 'study.sqlite');
  const gateway = new LLMGateway({ provider: 'mock' });
  let workspace: ExperimentWorkspaceRuntime | null = null;
  let resumed: ExperimentWorkspaceRuntime | null = null;
  try {
    workspace = await ExperimentWorkspaceRuntime.create(
      config(), { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
    );
    const managed = workspace.current.worlds[0];
    const resident = managed.world.allAgents()[0];
    const pendingResident = managed.world.allAgents()[1];
    const object = managed.world.getObject('obj:notice_board')!;
    managed.time.restore({ schemaVersion: 1, elapsedMinutes: 1170.75 });
    resident.state = 'moving';
    resident.locationId = 'obj:plaza';
    resident.x = 22;
    resident.y = 22;
    resident.path = [{ x: 22, y: 22 }, { x: 21, y: 22 }];
    resident.pathProgress = 0.5;
    resident.action = {
      thought: '去公告栏确认活动安排',
      action: { type: 'move_to', target: 'obj:notice_board', verb: '前往公告栏' },
      durationMinutes: 10,
    };
    resident.actionEndsAt = 1200;
    resident.lastDecisionAt = 1160;
    resident.thought = '去公告栏确认活动安排';
    pendingResident.state = 'thinking';
    pendingResident.thought = '等待中的 LLM 请求不能跨进程恢复';
    pendingResident.action = null;
    object.state = { label: '新公告', detail: '今晚读书会', updatedGameTime: 300, expiresGameTime: 500 };
    managed.experiment!.setConfig({ historyAccess: 'off', giftExchange: 'on' });
    managed.experiment!.start(4, 0);
    managed.experiment!.tick(1170);
    managed.log.addEvent({
      id: 'persistence-record', type: 'system', actorId: null, targetIds: [],
      description: '必须保留的研究记录', location: null, gameTime: 1170, payload: { kind: 'persistence_probe' },
    });
    await workspace.saveCheckpoint();

    const manifestPath = workspaceManifestPath(basePath);
    assert.ok(existsSync(manifestPath));
    assert.equal(readdirSync(directory).some((name) => name.includes('.tmp-')), false);
    const dbPath = worldDbPath(basePath, 'w1');
    await workspace.dispose();
    workspace = null;
    const eventsBefore = countRows(dbPath, 'events');
    const memoriesBefore = countRows(dbPath, 'memories');

    resumed = await ExperimentWorkspaceRuntime.resume(
      basePath, { gateway, nextDatabasePath: () => join(directory, 'next-after-resume.sqlite') },
    );
    const restored = resumed.current.worlds[0];
    const restoredResident = restored.world.getAgent(resident.id);
    assert.deepEqual(restored.time.checkpoint(), { schemaVersion: 1, elapsedMinutes: 1170.75 });
    assert.equal(restoredResident.state, 'moving');
    assert.equal(restoredResident.locationId, 'obj:plaza');
    assert.deepEqual({ x: restoredResident.x, y: restoredResident.y }, { x: 22, y: 22 });
    assert.deepEqual(restoredResident.path, [{ x: 22, y: 22 }, { x: 21, y: 22 }]);
    assert.equal(restoredResident.pathProgress, 0.5);
    assert.deepEqual(restoredResident.action, resident.action);
    assert.equal(restoredResident.actionEndsAt, 1200);
    assert.equal(restoredResident.lastDecisionAt, 1160);
    assert.equal(restoredResident.thought, '去公告栏确认活动安排');
    const restoredPending = restored.world.getAgent(pendingResident.id);
    assert.equal(restoredPending.state, 'idle');
    assert.equal(restoredPending.action, null);
    assert.equal(restoredPending.thought, null);
    assert.deepEqual(restoredPending.path, []);
    assert.deepEqual(restored.world.getObject('obj:notice_board')!.state, object.state);
    assert.deepEqual(restored.experiment!.state(), {
      running: true, remainingDays: 3, mem: 'off', gift: 'on',
    });
    assert.equal(countRows(dbPath, 'events'), eventsBefore, '恢复不得写入伪造的第1天或工作空间创建事件');
    assert.equal(countRows(dbPath, 'memories'), memoriesBefore);
    assert.equal(restored.log.eventsBetween(0, 2_000).some((event) => event.id === 'persistence-record'), true);

    restored.experiment!.tick(1170);
    assert.equal(restored.experiment!.state().remainingDays, 3, '恢复后不能重复已经完成的当日触发边界');
  } finally {
    if (workspace) await workspace.dispose();
    if (resumed) await resumed.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('thinking 居民恢复为可重新决策状态，并拒绝平行世界任一损坏或错配', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-persistence-reject-'));
  const basePath = join(directory, 'paired.sqlite');
  const gateway = new LLMGateway({ provider: 'mock' });
  let workspace: ExperimentWorkspaceRuntime | null = null;
  try {
    workspace = await ExperimentWorkspaceRuntime.create(
      config(['mem-on', 'mem-off']), { gateway, nextDatabasePath: () => join(directory, 'next.sqlite') }, basePath,
    );
    const thinking = workspace.current.worlds[0].world.allAgents()[0];
    thinking.state = 'thinking';
    thinking.thought = '不会跨进程伪恢复的待决策';
    thinking.action = null;
    await workspace.saveCheckpoint();
    await workspace.dispose();
    workspace = null;

    const firstDbPath = worldDbPath(basePath, 'w1');
    const secondDbPath = worldDbPath(basePath, 'w2');
    const firstEventsBefore = countRows(firstDbPath, 'events');
    const secondEventsBefore = countRows(secondDbPath, 'events');
    const db = new DatabaseSync(secondDbPath);
    try {
      const row = db.prepare('SELECT checkpoint_json FROM runtime_checkpoint WHERE slot = 1').get() as { checkpoint_json: string };
      const checkpoint = JSON.parse(row.checkpoint_json) as { seed: number };
      checkpoint.seed += 1;
      db.prepare('UPDATE runtime_checkpoint SET checkpoint_json = ? WHERE slot = 1').run(JSON.stringify(checkpoint));
    } finally {
      db.close();
    }

    await assert.rejects(
      ExperimentWorkspaceRuntime.resume(
        basePath, { gateway, nextDatabasePath: () => join(directory, 'unused.sqlite') },
      ),
      /检查点|seed|种子|错配/,
    );
    assert.equal(countRows(firstDbPath, 'events'), firstEventsBefore, '整体拒绝前不得激活第一个世界');
    assert.equal(countRows(secondDbPath, 'events'), secondEventsBefore, '损坏库也不得被启动逻辑改写');
  } finally {
    if (workspace) await workspace.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test('恢复必须显式指定持久化 --db；内存启动后的新工作空间改用 data/runs 文件', () => {
  assert.throws(() => parseArgs(['--resume']), /--resume.*--db/);
  assert.throws(() => parseArgs(['--resume', '--db', ':memory:']), /--resume.*memory|--resume.*持久化/i);
  const args = parseArgs(['--resume', '--db', join('data', 'runs', 'saved.sqlite')]);
  assert.equal(args.resume, true);
  assert.equal(args.dbPathExplicit, true);

  const next = nextWorkspaceDatabasePath(':memory:');
  assert.notEqual(next, ':memory:');
  assert.equal(resolve(next).startsWith(resolve('data', 'runs') + '\\'), true);
  assert.equal(dirname(resolve(next)), resolve('data', 'runs'));
});
