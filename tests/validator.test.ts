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

test('非法类型与非法时长不通过；idle 携带目标时安全规范化', () => {
  assert.equal(validateDecision({ action: { type: 'fly', target: 'obj:cafe' }, duration_minutes: 10 }, has).ok, false);
  const normalized = validateDecision({
    thought: '在公园休息',
    action: { type: 'idle', target: 'obj:cafe', verb: '休息' },
    duration_minutes: 10,
  }, has);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.decision.action.target, null);
  assert.equal(normalized.decision.thought, '在公园休息');
  assert.equal(normalized.normalization?.code, 'idle_target_cleared');
  assert.equal(validateDecision({ action: { type: 'interact', target: 'obj:cafe' }, duration_minutes: 0 }, has).ok, false);
  assert.equal(validateDecision({ action: { type: 'interact', target: 'obj:cafe' }, duration_minutes: 121 }, has).ok, false);
});

test('动作目标类型保持严格，非字符串目标不被静默转换', () => {
  const result = validateDecision({ action: { type: 'idle', target: 42 }, duration_minutes: 10 }, has);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /目标格式非法/);
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
