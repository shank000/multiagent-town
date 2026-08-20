import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStanding } from '../src/engine/status';
import type { Relationship } from '../src/store/relationships';

function rel(a: string, b: string, affection: number, respect: number): Relationship {
  return { agentA: a, agentB: b, knowledge: [], affection, respect, updatedGameTime: 0 };
}

test('声望：被多人重视者分高；双向互惠加成', () => {
  const rels = [
    rel('agent:b', 'agent:a', 0.8, 0.6), // 两人都重视 A
    rel('agent:c', 'agent:a', 0.7, 0.5),
    rel('agent:a', 'agent:b', 0.8, 0.6), // A 也重视 B → 互惠加成
  ];
  const s = computeStanding(rels);
  assert.ok(s.get('agent:a')! > s.get('agent:b')!, `A 应高于 B：${s.get('agent:a')} vs ${s.get('agent:b')}`);
  assert.ok(s.get('agent:b')! > s.get('agent:c')!, `B 应高于 C（互惠）：${s.get('agent:b')} vs ${s.get('agent:c')}`);
  assert.ok([...s.values()].every((v) => Number.isFinite(v) && v > 0));
});

test('声望：无关系时所有节点等分', () => {
  const s = computeStanding([rel('agent:a', 'agent:b', 0, 0)]);
  assert.equal(s.get('agent:a'), s.get('agent:b'));
});
