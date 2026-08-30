import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedWorld, startAllWorlds, stopAllWorlds } from '../src/engine/world-factory';
import { PerceptionEngine } from '../src/engine/perception';
import { hydrateWorld } from '../src/engine/seed';
import { createTownServer } from '../src/web/server';

test('平行世界暂停、恢复与调速保持同步', async () => {
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: ':memory:' }),
    createManagedWorld('w2', 'mem-off', { dbPath: ':memory:' }),
    createManagedWorld('w3', 'rumor', { dbPath: ':memory:' }),
  ];
  const main = worlds[0];
  const server = await createTownServer({
    world: main.world, time: main.time, loop: main.loop, log: main.log,
    mind: main.mind, player: main.player, experiment: main.experiment ?? undefined,
    worlds, port: 0, snapshotMs: 50,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    startAllWorlds(worlds);
    const speed = await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'speed', value: 60 }),
    });
    assert.equal(speed.status, 200);
    assert.deepEqual(worlds.map((world) => world.time.gameMinutesPerTick), [30, 30, 30]);

    await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pause' }),
    });
    const pausedAt = worlds.map((world) => world.time.state.totalMinutes);
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.deepEqual(worlds.map((world) => world.time.state.totalMinutes), pausedAt);
    const pausedSnapshot = await (await fetch(`${base}/api/state`)).json() as { paused: boolean };
    assert.equal(pausedSnapshot.paused, true);

    await fetch(`${base}/api/world/control`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    });
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.ok(worlds.every((world, index) => world.time.state.totalMinutes > pausedAt[index]));
  } finally {
    stopAllWorlds(worlds);
    await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
  }
});

test('世界控制拒绝非有限或超范围速度', async () => {
  const world = createManagedWorld('w1', 'mem-off', { dbPath: ':memory:' });
  const server = await createTownServer({
    world: world.world, time: world.time, loop: world.loop, log: world.log,
    mind: world.mind, player: world.player, experiment: world.experiment ?? undefined,
    port: 0,
  });
  try {
    for (const value of [61, 360, Number.POSITIVE_INFINITY]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/world/control`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'speed', value }),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    await server.close();
    await world.mind.dispose();
    world.db.raw.close();
  }
});

test('定址读写指定世界且不改变活跃世界', async () => {
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: ':memory:' }),
    createManagedWorld('w2', 'mem-off', { dbPath: ':memory:' }),
    createManagedWorld('w3', 'rumor', { dbPath: ':memory:' }),
  ];
  const main = worlds[0];
  const server = await createTownServer({
    world: main.world, time: main.time, loop: main.loop, log: main.log,
    mind: main.mind, player: main.player, experiment: main.experiment ?? undefined,
    worlds, port: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    const switched = await fetch(`${base}/api/world/switch`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'w2' }),
    });
    assert.equal(switched.status, 200);
    assert.equal(((await switched.json()) as { active: string }).active, 'w2');

    const endpoints = [
      '/api/state?worldId=w1',
      '/api/narrative?worldId=w1',
      '/api/experiment/state?worldId=w1',
      '/api/experiment/metrics?worldId=w1',
      `/api/agents/${encodeURIComponent(main.world.allAgents()[0].id)}/mind?worldId=w1`,
      `/api/relationships/${encodeURIComponent(main.world.allAgents()[0].id)}?worldId=w1`,
    ];
    for (const endpoint of endpoints) {
      const response = await fetch(`${base}${endpoint}`);
      assert.equal(response.status, 200, endpoint);
      assert.equal(((await response.json()) as { worldId: string }).worldId, 'w1', endpoint);
    }

    for (const [command, body] of [
      ['config', { mem: 'on', gift: 'off' }],
      ['start', { days: 3 }],
    ] as const) {
      const response = await fetch(`${base}/api/experiment/${command}?worldId=w1`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 200, command);
      assert.equal(((await response.json()) as { worldId: string }).worldId, 'w1', command);
    }
    assert.equal(main.experiment?.state().running, true);
    assert.equal(worlds[1].experiment?.state().running, false);

    const agentId = main.world.allAgents()[0].id;
    const playerAction = await fetch(`${base}/api/player/${encodeURIComponent(agentId)}/act?worldId=w1`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: '去广场观察' }),
    });
    assert.equal(((await playerAction.json()) as { worldId: string }).worldId, 'w1');
    assert.equal(main.player.current(agentId, main.time.state.totalMinutes), '去广场观察');
    assert.equal(worlds[1].player.current(agentId, worlds[1].time.state.totalMinutes), null);
    const playerClear = await fetch(`${base}/api/player/${encodeURIComponent(agentId)}/act?worldId=w1`, { method: 'DELETE' });
    assert.equal(((await playerClear.json()) as { worldId: string }).worldId, 'w1');
    assert.equal(main.player.current(agentId, main.time.state.totalMinutes), null);

    const stopped = await fetch(`${base}/api/experiment/stop?worldId=w1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(((await stopped.json()) as { worldId: string }).worldId, 'w1');
    assert.equal(main.experiment?.state().running, false);

    const worldsResponse = await fetch(`${base}/api/worlds`);
    assert.equal(((await worldsResponse.json()) as { active: string }).active, 'w2');
    assert.equal((await fetch(`${base}/api/state?worldId=unknown`)).status, 404);
  } finally {
    await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
  }
});

test('PerceptionEngine dispose 解除订阅并清空缓冲', async () => {
  const managed = createManagedWorld('w1', 'mem-off', { dbPath: ':memory:' });
  const perception = new PerceptionEngine(managed.world, managed.log);
  try {
    const [actor, observer] = managed.world.allAgents();
    assert.ok(actor);
    assert.ok(observer);
    observer.x = actor.x;
    observer.y = actor.y;
    const addPerception = (id: string) => managed.log.addEvent({
      id, type: 'interact', actorId: actor.id, targetIds: [observer.id], description: id, location: null,
      gameTime: managed.time.state.totalMinutes, payload: { kind: 'interact' },
    });
    addPerception('dispose-before');
    assert.ok(perception.size(observer.id) > 0);

    perception.dispose();
    assert.equal(perception.size(observer.id), 0);
    addPerception('dispose-after');
    assert.equal(perception.size(observer.id), 0);
    perception.dispose();
  } finally {
    perception.dispose();
    await managed.mind.dispose();
    managed.db.raw.close();
  }
});

test('访客感知缓冲按世界隔离', async () => {
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: ':memory:' }),
    createManagedWorld('w2', 'mem-off', { dbPath: ':memory:' }),
    createManagedWorld('w3', 'rumor', { dbPath: ':memory:' }),
  ];
  const main = worlds[0];
  const server = await createTownServer({
    world: main.world, time: main.time, loop: main.loop, log: main.log,
    mind: main.mind, player: main.player, experiment: main.experiment ?? undefined,
    worlds, port: 0,
  });
  const base = `http://127.0.0.1:${server.port}`;
  const guestName = '跨世界访客';
  const login = () => fetch(`${base}/api/guest/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: guestName }),
  });
  try {
    assert.equal((await login()).status, 200);
    const guestW1 = worlds[0].world.getAgent(`agent:${guestName}`);
    const actorW1 = worlds[0].world.allAgents().find((agent) => agent.id !== guestW1?.id);
    assert.ok(guestW1);
    assert.ok(actorW1);
    guestW1.x = actorW1.x;
    guestW1.y = actorW1.y;
    worlds[0].log.addEvent({
      id: 'w1-private-perception', type: 'interact', actorId: actorW1.id, targetIds: [guestW1.id],
      description: '仅属于 w1 的感知事件', location: null,
      gameTime: worlds[0].time.state.totalMinutes, payload: { kind: 'interact' },
    });

    const switched = await fetch(`${base}/api/world/switch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'w2' }),
    });
    assert.equal(switched.status, 200);
    assert.equal((await login()).status, 200);

    const lookW2 = await fetch(`${base}/api/guest/look?name=${encodeURIComponent(guestName)}`);
    assert.equal(lookW2.status, 200);
    const firstW2 = await lookW2.json() as { perceptions: { text: string | null }[] };
    assert.deepEqual(firstW2.perceptions, []);

    const guestW2 = worlds[1].world.getAgent(`agent:${guestName}`);
    const actorW2 = worlds[1].world.allAgents().find((agent) => agent.id !== guestW2?.id);
    assert.ok(guestW2);
    assert.ok(actorW2);
    guestW2.x = actorW2.x;
    guestW2.y = actorW2.y;
    worlds[1].log.addEvent({
      id: 'w2-private-perception', type: 'interact', actorId: actorW2.id, targetIds: [guestW2.id],
      description: '仅属于 w2 的感知事件', location: null,
      gameTime: worlds[1].time.state.totalMinutes, payload: { kind: 'interact' },
    });
    const secondW2 = await (await fetch(`${base}/api/guest/look?name=${encodeURIComponent(guestName)}`)).json() as {
      perceptions: { text: string | null }[];
    };
    assert.deepEqual(secondW2.perceptions.map((entry) => entry.text), ['仅属于 w2 的感知事件']);
  } finally {
    await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
  }
});

test('SSE 每个周期广播全部平行世界快照', async () => {
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: ':memory:' }),
    createManagedWorld('w2', 'mem-off', { dbPath: ':memory:' }),
    createManagedWorld('w3', 'rumor', { dbPath: ':memory:' }),
  ];
  const main = worlds[0];
  const server = await createTownServer({
    world: main.world, time: main.time, loop: main.loop, log: main.log,
    mind: main.mind, player: main.player, experiment: main.experiment ?? undefined,
    worlds, port: 0, snapshotMs: 25,
  });
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    if (!response.body) throw new Error('SSE 响应缺少数据流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const counts = new Map([['w1', 0], ['w2', 0], ['w3', 0]]);
    let buffer = '';
    const collectTwoRounds = async (): Promise<void> => {
      while ([...counts.values()].some((count) => count < 2)) {
        const { done, value } = await reader.read();
        if (done) throw new Error('SSE 在收齐全部世界快照前结束');
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = frame.split('\n');
          if (lines.includes('event: snapshot')) {
            const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
            const snapshot = JSON.parse(data) as { worldId?: string };
            if (snapshot.worldId && counts.has(snapshot.worldId)) {
              counts.set(snapshot.worldId, (counts.get(snapshot.worldId) ?? 0) + 1);
            }
          }
          boundary = buffer.indexOf('\n\n');
        }
      }
    };
    await Promise.race([
      collectTwoRounds(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('SSE 未按周期广播全部世界')), 2_000);
      }),
    ]);
    assert.deepEqual([...counts.keys()].sort(), ['w1', 'w2', 'w3']);
    assert.ok([...counts.values()].every((count) => count >= 2));
    controller.abort();
    await reader.cancel().catch(() => undefined);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
  }
});

test('统计与 hydration 按世界定址、幂等且数据库和种子状态互相隔离', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'town-world-stats-'));
  const worlds = [
    createManagedWorld('w1', 'mem-on', { dbPath: join(dir, 'w1.sqlite') }),
    createManagedWorld('w2', 'mem-off', { dbPath: join(dir, 'w2.sqlite') }),
    createManagedWorld('w3', 'rumor', { dbPath: join(dir, 'w3.sqlite') }),
  ];
  const main = worlds[0];
  let server: Awaited<ReturnType<typeof createTownServer>> | undefined;
  try {
    assert.equal(new Set(worlds.map((world) => world.db)).size, 3);
    assert.equal(new Set(worlds.map((world) => world.dbPath)).size, 3);
    assert.notStrictEqual(worlds[0].world.allAgents()[0].persona, worlds[1].world.allAgents()[0].persona);
    assert.notStrictEqual(worlds[0].world.allAgents()[0].persona.routine, worlds[1].world.allAgents()[0].persona.routine);
    assert.notStrictEqual(worlds[0].world.allObjects()[0], worlds[1].world.allObjects()[0]);

    const countAgents = (index: number) => (
      worlds[index].db.raw.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }
    ).n;
    assert.deepEqual(worlds.map((_world, index) => countAgents(index)), [6, 6, 6]);
    hydrateWorld(worlds[0].db, worlds[0].world);
    hydrateWorld(worlds[0].db, worlds[0].world);
    assert.deepEqual(worlds.map((_world, index) => countAgents(index)), [6, 6, 6]);

    server = await createTownServer({
      world: main.world, time: main.time, loop: main.loop, log: main.log,
      mind: main.mind, player: main.player, experiment: main.experiment ?? undefined,
      worlds, port: 0,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const login = await fetch(`${base}/api/guest/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '统计访客' }),
    });
    assert.equal(login.status, 200);
    hydrateWorld(worlds[0].db, worlds[0].world);
    hydrateWorld(worlds[0].db, worlds[0].world);
    assert.deepEqual(worlds.map((_world, index) => countAgents(index)), [7, 6, 6]);

    worlds[0].log.addEvent({
      id: 'stats-only-w1', type: 'system', actorId: null, targetIds: [], description: 'w1 独有',
      location: null, gameTime: 100, payload: { kind: 'stats_scope_w1' },
    });
    worlds[1].log.addEvent({
      id: 'stats-only-w2', type: 'system', actorId: null, targetIds: [], description: 'w2 独有',
      location: null, gameTime: 100, payload: { kind: 'stats_scope_w2' },
    });

    const statsW1 = await (await fetch(`${base}/api/stats?worldId=w1`)).json() as {
      worldId: string; overview: { dbPath: string; counts: { agents: number } };
      events: { byPayloadKind: Record<string, number> };
    };
    const statsW2 = await (await fetch(`${base}/api/stats?worldId=w2`)).json() as typeof statsW1;
    assert.equal(statsW1.worldId, 'w1');
    assert.equal(statsW2.worldId, 'w2');
    assert.equal(statsW1.overview.dbPath, worlds[0].dbPath);
    assert.equal(statsW2.overview.dbPath, worlds[1].dbPath);
    assert.equal(statsW1.overview.counts.agents, 7);
    assert.equal(statsW2.overview.counts.agents, 6);
    assert.equal(statsW1.events.byPayloadKind.stats_scope_w1, 1);
    assert.equal(statsW1.events.byPayloadKind.stats_scope_w2, undefined);
    assert.equal(statsW2.events.byPayloadKind.stats_scope_w2, 1);
    assert.equal(statsW2.events.byPayloadKind.stats_scope_w1, undefined);

    assert.equal((await fetch(`${base}/api/stats?worldId=missing`)).status, 404);
    for (const day of ['0', '-2', '2.5', 'NaN']) {
      assert.equal((await fetch(`${base}/api/stats?worldId=w3&day=${encodeURIComponent(day)}`)).status, 400);
    }
  } finally {
    if (server) await server.close();
    await Promise.all(worlds.map((world) => world.mind.dispose()));
    for (const world of worlds) world.db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
