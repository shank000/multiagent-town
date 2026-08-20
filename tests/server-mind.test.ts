import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { WorldLoop } from '../src/engine/loop';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { MindEngine } from '../src/engine/mind';
import { createTownServer } from '../src/web/server';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
];

test('mind API 返回记忆/反思/计划/对话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-mind-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, persona: persona({ name: '甲' }) });
  const world = new WorldState(OBJS, [agent]);
  const time = new TimeEngine(5);
  const gateway = new LLMGateway({ provider: 'mock' });
  const mind = new MindEngine({ db, llm: gateway, log });
  mind.store.addMemory({ agentId: 'agent:1', kind: 'observation', content: '第1天 09:00，甲 开始「煮咖啡」', importance: 6, createdGameTime: 540 });
  mind.store.addReflection({ agentId: 'agent:1', parentId: null, depth: 0, questions: ['q'], insights: ['我常去咖啡馆。'], evidenceIds: [], triggerScore: 160, createdGameTime: 700 });
  const executor = new AgentExecutor(gateway, world, log, mind);
  const loop = new WorldLoop(time, world, executor, log, db, {}, undefined, mind);
  const server = await createTownServer({ world, time, loop, log, mind, publicDir: dir });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/agents/${encodeURIComponent('agent:1')}/mind`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { memories: unknown[]; reflections: unknown[] };
    assert.equal(body.memories.length, 1);
    assert.equal(body.reflections.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});
