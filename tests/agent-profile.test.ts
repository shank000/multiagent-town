import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyAgentProfile,
  normalizeAgentProfile,
  profileDefinitionOf,
  profileSetHash,
} from '../src/engine/agent-profile';
import { buildTown } from '../src/engine/seed';
import { createManagedWorld } from '../src/engine/world-factory';
import { createTownServer } from '../src/web/server';
import { loadAgentProfileConfig, saveAgentProfileConfig } from '../src/store/agent-profile-config';

test('居民档案校验、头像与初始状态形成可复现指纹', () => {
  const world = buildTown();
  const agent = world.allAgents()[0];
  const before = profileSetHash(world);
  const input = profileDefinitionOf(agent, 0);
  input.background = `${input.background} 她开始记录新的田野观察。`;
  input.avatar.accent = '#44ccaa';
  input.initialState.stress = 0.35;
  const profile = normalizeAgentProfile(input, agent, world, 0);
  applyAgentProfile(world, agent.id, profile);
  assert.equal(world.getAgent(agent.id).persona.avatar?.accent, '#44ccaa');
  assert.equal(world.getAgent(agent.id).persona.initialState?.stress, 0.35);
  assert.notEqual(profileSetHash(world), before);
  assert.throws(() => normalizeAgentProfile({ ...input, name: world.allAgents()[1].name }, agent, world, 0), /已被其他居民使用/);
  assert.throws(() => normalizeAgentProfile({ ...input, avatar: { ...input.avatar, hair: 'red' } }, agent, world, 0), /#RRGGBB/);
});

test('档案配置按稳定居民 ID 保存并载入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-profile-'));
  const path = join(dir, 'agent-profiles.json');
  try {
    const world = buildTown();
    const profiles = Object.fromEntries(world.allAgents().map((agent, index) => [agent.id, profileDefinitionOf(agent, index)]));
    saveAgentProfileConfig(path, profiles);
    assert.ok(existsSync(path));
    assert.deepEqual(Object.keys(loadAgentProfileConfig(path)).sort(), Object.keys(profiles).sort());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('档案 API 同步当前工作空间已加载的世界并记录持久化配置', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-profile-api-'));
  const profileStorePath = join(dir, 'agent-profiles.json');
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: ':memory:' }),
    createManagedWorld('w2', 'mem-off', { dbPath: ':memory:' }),
    createManagedWorld('w3', 'rumor', { dbPath: ':memory:' }),
  ];
  const primary = worlds[0];
  const server = await createTownServer({
    world: primary.world, time: primary.time, loop: primary.loop, log: primary.log, mind: primary.mind,
    player: primary.player, experiment: primary.experiment ?? undefined, worlds, port: 0, profileStorePath,
  });
  try {
    const agent = primary.world.allAgents()[0];
    const profile = profileDefinitionOf(agent, 0);
    profile.name = '林晚晴·研究版';
    profile.speechStyle = '语气温和，先回应对方信息，再联系自己的经历';
    const response = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent(agent.id)}/profile?worldId=w2`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profile }),
    });
    assert.equal(response.status, 200);
    const result = await response.json() as { scope: string; worldIds: string[]; profileHash: string };
    assert.equal(result.scope, 'loaded_worlds');
    assert.deepEqual(result.worldIds, ['w1', 'w2', 'w3']);
    assert.ok(result.profileHash.length === 64);
    assert.ok(worlds.every((world) => world.world.getAgent(agent.id).name === '林晚晴·研究版'));
    assert.equal(new Set(worlds.map((world) => profileSetHash(world.world))).size, 1);
    assert.ok(worlds.every((world) => world.log.eventsOfKind('agent_profile_updated', 0, 1).length === 1));
    assert.ok(loadAgentProfileConfig(profileStorePath)[agent.id]);
  } finally {
    await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
