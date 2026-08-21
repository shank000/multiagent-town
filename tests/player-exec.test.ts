import test from 'node:test';
import assert from 'node:assert/strict';
import { WorldState } from '../src/core/world';
import { AgentExecutor } from '../src/core/state-machine';
import { PlayerDirector } from '../src/engine/player';
import { LLMGateway } from '../src/llm/gateway';
import { openDb } from '../src/store/db';
import { EventLog } from '../src/store/events';
import { makeAgent, persona, flush } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 8, y: 5, w: 3, h: 2 },
];

test('玩家指令驱动 agent 前往指定对象', async () => {
  const db = openDb(':memory:');
  const log = new EventLog(db);
  const agent = makeAgent({ id: 'agent:1', name: '甲', x: 0, y: 0, locationId: 'obj:town' });
  const world = new WorldState(OBJS, [agent]);
  const gateway = new LLMGateway({ provider: 'mock' });
  const player = new PlayerDirector();
  const executor = new AgentExecutor(gateway, world, log, undefined, player);
  player.act('agent:1', '去湖边公园写生', 0);
  executor.progress(agent, 0, 10);
  await flush();
  executor.progress(agent, 0, 10);
  assert.equal(agent.state, 'moving');
  for (let i = 0; i < 40 && agent.state === 'moving'; i++) {
    executor.progress(agent, 5, 15 + i * 5);
    await flush();
  }
  // 到达公园（目标中心 (9,5)）
  assert.ok(agent.x >= 8 && agent.x <= 10 && agent.y >= 5 && agent.y <= 6, `位置 ${agent.x},${agent.y}`);
});
