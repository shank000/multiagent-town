import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ExperimentWorkspaceRuntime, nextWorkspaceDatabasePath, normalizeWorkspaceConfig } from '../src/engine/workspace';
import { LLMGateway } from '../src/llm/gateway';
import { BackendRuntimeLog, runtimeLogPathForDatabase } from '../src/runtime/backend-log';
import { createTownServer } from '../src/web/server';

test('工作空间配置支持任意一个、两个或三个不重复的世界模板', () => {
  const base = { name: '选择性加载实验', seed: 7, worldSpeed: 1, defaultExperimentDays: 60, startPaused: true };
  for (const worldKinds of [
    ['mem-on'],
    ['mem-on', 'mem-off'],
    ['mem-on', 'mem-off', 'rumor'],
  ] as const) {
    assert.deepEqual(normalizeWorkspaceConfig({ ...base, worldKinds }).worldKinds, worldKinds);
  }
  assert.throws(() => normalizeWorkspaceConfig({ ...base, worldKinds: [] }), /1\.\.3/);
  assert.throws(() => normalizeWorkspaceConfig({ ...base, worldKinds: ['mem-on', 'mem-on'] }), /不重复/);
  assert.throws(() => normalizeWorkspaceConfig({ ...base, worldKinds: ['unknown'] }), /世界模板/);
});

test('工作空间 API 安全替换为选择性加载的小镇并保留独立数据文件', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-workspace-'));
  const initialBase = join(directory, 'initial.sqlite');
  const nextBase = join(directory, 'next.sqlite');
  const runtimeLog = new BackendRuntimeLog(runtimeLogPathForDatabase(initialBase), { captureConsole: false });
  const gateway = new LLMGateway({ provider: 'mock', expectedActiveAgents: 6 });
  const workspace = await ExperimentWorkspaceRuntime.create({
    name: '单世界基线', seed: 1, worldSpeed: 1, defaultExperimentDays: 30,
    worldKinds: ['mem-on'], startPaused: true,
  }, {
    gateway,
    runtimeLog,
    nextDatabasePath: () => nextBase,
  }, initialBase);
  const first = workspace.current;
  const primary = first.worlds[0];
  const server = await createTownServer({
    world: primary.world, time: primary.time, loop: primary.loop, log: primary.log, mind: primary.mind,
    player: primary.player, experiment: primary.experiment ?? undefined, worlds: first.worlds, workspace,
    llm: gateway, runtimeLog, port: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const before = await (await fetch(`${base}/api/workspace`)).json() as {
      workspace: { id: string; worldIds: string[] }; templates: unknown[]; safety: { ready: boolean };
    };
    assert.deepEqual(before.workspace.worldIds, ['w1']);
    assert.equal(before.templates.length, 3);
    assert.equal(before.safety.ready, true);
    assert.ok(existsSync(join(directory, 'initial-w1.sqlite')));
    assert.equal(existsSync(join(directory, 'initial-w2.sqlite')), false);

    const invalid = await fetch(`${base}/api/workspace`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '空选择', seed: 2, worldSpeed: 1, defaultExperimentDays: 30, worldKinds: [] }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(workspace.current.meta.worldIds, ['w1']);
    assert.equal((await fetch(`${base}/api/state?worldId=w1`)).status, 200);

    const response = await fetch(`${base}/api/workspace`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '双世界稳健性', seed: 42, worldSpeed: 5, defaultExperimentDays: 60,
        worldKinds: ['mem-off', 'rumor'], startPaused: true,
      }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as { workspace: { id: string; worldIds: string[] }; active: string; worlds: unknown[] };
    assert.notEqual(created.workspace.id, before.workspace.id);
    assert.deepEqual(created.workspace.worldIds, ['w2', 'w3']);
    assert.equal(created.worlds.length, 2);
    assert.equal(created.active, 'w2');
    assert.ok(existsSync(join(directory, 'next-w2.sqlite')));
    assert.ok(existsSync(join(directory, 'next-w3.sqlite')));
    assert.equal(existsSync(join(directory, 'next-w1.sqlite')), false);
    assert.equal((await fetch(`${base}/api/state?worldId=w1`)).status, 404);
    assert.equal((await fetch(`${base}/api/state?worldId=w2`)).status, 200);
    assert.equal(((await (await fetch(`${base}/api/state?worldId=w2`)).json()) as { paused: boolean }).paused, true);
    const registry = await (await fetch(`${base}/api/worlds`)).json() as { worlds: unknown[]; workspaceName: string };
    assert.equal(registry.worlds.length, 2);
    assert.equal(registry.workspaceName, '双世界稳健性');
    assert.equal(runtimeLog.filePath, runtimeLogPathForDatabase(nextBase));
  } finally {
    await server.close();
    await workspace.dispose();
    await gateway.drain();
    runtimeLog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('运行中的世界拒绝替换工作空间', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-workspace-guard-'));
  const initialBase = join(directory, 'guard.sqlite');
  const gateway = new LLMGateway({ provider: 'mock' });
  const workspace = await ExperimentWorkspaceRuntime.create({
    name: '运行保护', seed: 1, worldSpeed: 1, defaultExperimentDays: 30,
    worldKinds: ['mem-on'], startPaused: false,
  }, { gateway, nextDatabasePath: () => nextWorkspaceDatabasePath(initialBase) }, initialBase);
  const primary = workspace.current.worlds[0];
  const server = await createTownServer({
    world: primary.world, time: primary.time, loop: primary.loop, log: primary.log, mind: primary.mind,
    player: primary.player, experiment: primary.experiment ?? undefined, worlds: workspace.current.worlds,
    workspace, llm: gateway, port: 0,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/api/workspace`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '不应创建', seed: 2, worldSpeed: 1, defaultExperimentDays: 30,
        worldKinds: ['rumor'], startPaused: true,
      }),
    });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /暂停世界时钟/);
    assert.deepEqual(workspace.current.meta.worldIds, ['w1']);
  } finally {
    await server.close();
    await workspace.dispose();
    await gateway.drain();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('重置 API 以相同实验配置创建暂停的新运行并保留文件研究档案', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'town-workspace-reset-'));
  const initialBase = join(directory, 'reset-initial.sqlite');
  const nextBase = join(directory, 'reset-next.sqlite');
  const runtimeLog = new BackendRuntimeLog(runtimeLogPathForDatabase(initialBase), { captureConsole: false });
  const gateway = new LLMGateway({ provider: 'mock', expectedActiveAgents: 12 });
  const workspace = await ExperimentWorkspaceRuntime.create({
    name: '关系记忆稳健性', seed: 20260831, worldSpeed: 0.3, defaultExperimentDays: 60,
    worldKinds: ['mem-on', 'mem-off'], startPaused: true,
  }, { gateway, runtimeLog, nextDatabasePath: () => nextBase }, initialBase);
  const first = workspace.current;
  const primary = first.worlds[0];
  const server = await createTownServer({
    world: primary.world, time: primary.time, loop: primary.loop, log: primary.log, mind: primary.mind,
    player: primary.player, experiment: primary.experiment ?? undefined, worlds: first.worlds, workspace,
    llm: gateway, runtimeLog, port: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const before = (await (await fetch(`${base}/api/workspace`)).json()) as {
      workspace: { id: string; name: string; seed: number; worldSpeed: number; defaultExperimentDays: number; worldKinds: string[] };
    };
    const stale = await fetch(`${base}/api/workspace/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'stale-workspace-id' }),
    });
    assert.equal(stale.status, 409);
    assert.equal(workspace.current.meta.id, before.workspace.id);

    const response = await fetch(`${base}/api/workspace/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: before.workspace.id }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const reset = await response.json() as {
      workspace: typeof before.workspace & { startPaused: boolean; worldIds: string[] };
      previous: { id: string; databaseBasePath: string; runtimeLogPath: string; persisted: boolean };
    };
    assert.notEqual(reset.workspace.id, before.workspace.id);
    assert.equal(reset.workspace.name, before.workspace.name);
    assert.equal(reset.workspace.seed, before.workspace.seed);
    assert.equal(reset.workspace.worldSpeed, before.workspace.worldSpeed);
    assert.equal(reset.workspace.defaultExperimentDays, before.workspace.defaultExperimentDays);
    assert.deepEqual(reset.workspace.worldKinds, before.workspace.worldKinds);
    assert.equal(reset.workspace.startPaused, true);
    assert.deepEqual(reset.workspace.worldIds, ['w1', 'w2']);
    assert.deepEqual(reset.previous, {
      id: before.workspace.id,
      databaseBasePath: initialBase,
      runtimeLogPath: runtimeLogPathForDatabase(initialBase),
      persisted: true,
    });
    assert.ok(existsSync(join(directory, 'reset-initial-w1.sqlite')));
    assert.ok(existsSync(join(directory, 'reset-initial-w2.sqlite')));
    assert.ok(existsSync(join(directory, 'reset-next-w1.sqlite')));
    assert.ok(existsSync(join(directory, 'reset-next-w2.sqlite')));
    assert.equal(runtimeLog.filePath, runtimeLogPathForDatabase(nextBase));
    const state = await (await fetch(`${base}/api/state?worldId=w1`)).json() as {
      paused: boolean; clock: { day: number; minutesOfDay: number; totalMinutes: number };
    };
    assert.equal(state.paused, true);
    assert.deepEqual(state.clock, { day: 1, minutesOfDay: 0, totalMinutes: 0 });
  } finally {
    await server.close();
    await workspace.dispose();
    await gateway.drain();
    runtimeLog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
