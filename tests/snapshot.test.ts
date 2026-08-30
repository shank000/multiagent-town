import test from 'node:test';
import assert from 'node:assert/strict';
import { TimeEngine } from '../src/core/time';
import { WorldState } from '../src/core/world';
import { buildSnapshot } from '../src/web/snapshot';
import { makeAgent, persona } from './helpers';
import type { WorldObject } from '../src/core/types';

const OBJS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
];

function setup() {
  const agent = makeAgent({
    id: 'agent:1', name: '甲', x: 1, y: 2, locationId: 'obj:plaza',
    persona: persona({ occupation: '测试员', background: '喜欢测试。', name: '甲' }),
  });
  const world = new WorldState(OBJS, [agent]);
  const time = new TimeEngine(30); // speed = 60 游戏分钟/现实秒
  return { world, time, agent };
}

test('快照包含时钟/速度/网格/对象/agent 全字段', () => {
  const { world, time, agent } = setup();
  const snap = buildSnapshot(world, time, false, 7);
  assert.equal(snap.seq, 7);
  assert.equal(snap.paused, false);
  assert.equal(snap.speedPerRealSecond, 60);
  assert.equal(snap.gridW, 48);
  assert.equal(snap.gridH, 44);
  assert.equal(snap.clock.totalMinutes, 0);
  assert.equal(snap.objects.length, 2);
  assert.equal(snap.objects[0].type, 'town');
  assert.equal(snap.agents.length, 1);
  const v = snap.agents[0];
  assert.equal(v.id, agent.id);
  assert.equal(v.occupation, '测试员');
  assert.equal(v.background, '喜欢测试。');
  assert.equal(v.locationName, '中央广场');
  assert.equal(v.spriteIndex, 0);
  assert.equal(v.state, 'idle');
  assert.equal(v.verb, ''); // 无当前动作 → 空
  assert.equal(v.thought, null);
  assert.equal(v.actionType, null);
  assert.equal(v.targetId, null);
  assert.equal(v.targetName, null);
  assert.deepEqual(v.path, []);
  assert.deepEqual(snap.activeConversations, []);
});

test('快照携带活动会话 ID、参与者和当前说话者的只读投影', () => {
  const { world, time } = setup();
  const active = [{ conversationId: 'conversation:1', aId: 'agent:1', bId: 'agent:2', speakerId: 'agent:2' }];
  const snap = buildSnapshot(world, time, false, 2, active);
  assert.deepEqual(snap.activeConversations, active);
  assert.notStrictEqual(snap.activeConversations[0], active[0]);
});

test('行动中快照携带 verb 与目标名；paused 透传', () => {
  const { world, time, agent } = setup();
  agent.action = { thought: '干活', action: { type: 'interact', target: 'obj:plaza', verb: '扫地' }, durationMinutes: 10 };
  agent.state = 'acting';
  agent.thought = '干活';
  const snap = buildSnapshot(world, time, true, 1);
  assert.equal(snap.paused, true);
  assert.equal(snap.agents[0].verb, '扫地');
  assert.equal(snap.agents[0].actionType, 'interact');
  assert.equal(snap.agents[0].targetId, 'obj:plaza');
  assert.equal(snap.agents[0].targetName, '中央广场');
  assert.equal(snap.agents[0].thought, '干活');
});
