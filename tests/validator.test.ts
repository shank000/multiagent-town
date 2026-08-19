import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision, idleDecision } from '../src/llm/action-validator';

const has = (id: string) => ['obj:cafe', 'obj:park'].includes(id);

test('合法 interact 通过并保持字段', () => {
  const r = validateDecision(
    { thought: '煮咖啡', action: { type: 'interact', target: 'obj:cafe', verb: '煮咖啡' }, duration_minutes: 10 },
    has
  );
  assert.equal(r.ok, true);
  assert.equal(r.decision.action.target, 'obj:cafe');
  assert.equal(r.decision.durationMinutes, 10);
});

test('未知目标 → 不通过且降级为 idle', () => {
  const r = validateDecision({ action: { type: 'interact', target: 'obj:mars' }, duration_minutes: 10 }, has);
  assert.equal(r.ok, false);
  assert.equal(r.decision.action.type, 'idle');
  assert.equal(r.decision.action.target, null);
});

test('非法类型 / idle 带目标 / 非法时长 → 均不通过', () => {
  assert.equal(validateDecision({ action: { type: 'fly', target: 'obj:cafe' }, duration_minutes: 10 }, has).ok, false);
  assert.equal(validateDecision({ action: { type: 'idle', target: 'obj:cafe' }, duration_minutes: 10 }, has).ok, false);
  assert.equal(validateDecision({ action: { type: 'interact', target: 'obj:cafe' }, duration_minutes: 0 }, has).ok, false);
  assert.equal(validateDecision({ action: { type: 'interact', target: 'obj:cafe' }, duration_minutes: 121 }, has).ok, false);
});

test('时长边界 1 与 120 通过；非对象输出不通过', () => {
  assert.equal(validateDecision({ action: { type: 'idle', target: null }, duration_minutes: 1 }, has).ok, true);
  assert.equal(validateDecision({ action: { type: 'idle', target: null }, duration_minutes: 120 }, has).ok, true);
  assert.equal(validateDecision(null, has).ok, false);
});

test('idleDecision 构造兜底决策', () => {
  assert.deepEqual(idleDecision('累了'), {
    thought: '累了',
    action: { type: 'idle', target: null, verb: '休息' },
    durationMinutes: 10,
  });
});
