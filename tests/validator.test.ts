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

test('interact 动词必须由目标 affordance、作息或明确玩家指令落地', () => {
  const context = {
    interactionVerbs: (targetId: string) => targetId === 'obj:park' ? ['在公园写生'] : ['煮咖啡'],
  };
  const hallucinated = validateDecision(
    { thought: '检查画架', action: { type: 'interact', target: 'obj:park', verb: '修理电器' }, duration_minutes: 10 },
    has,
    context,
  );
  assert.equal(hallucinated.ok, false);
  assert.equal(hallucinated.errorCode, 'ungrounded_interaction');
  assert.match(hallucinated.error ?? '', /允许动词：在公园写生/);

  const routineVerb = validateDecision(
    { thought: '开始写生', action: { type: 'interact', target: 'obj:park', verb: '在公园写生' }, duration_minutes: 10 },
    has,
    context,
  );
  assert.equal(routineVerb.ok, true);

  const playerVerb = validateDecision(
    { thought: '服从指令', action: { type: 'interact', target: 'obj:park', verb: '给画架系红丝带' }, duration_minutes: 10 },
    has,
    { ...context, playerInstruction: '请去公园给画架系红丝带' },
  );
  assert.equal(playerVerb.ok, true);

  const expandedWithHallucination = validateDecision(
    { thought: '做更多事情', action: { type: 'interact', target: 'obj:cafe', verb: '煮咖啡并修理电器' }, duration_minutes: 10 },
    has,
    context,
  );
  assert.equal(expandedWithHallucination.ok, false, '模型扩写不得通过反向包含获得授权');
  assert.equal(expandedWithHallucination.errorCode, 'ungrounded_interaction');
});

test('紧凑 interact 谓词仅在唯一匹配时规范为声明动词', () => {
  const result = validateDecision(
    { thought: '开始营业', action: { type: 'interact', target: 'obj:cafe', verb: '煮咖啡' }, duration_minutes: 10 },
    has,
    { interactionVerbs: () => ['开店准备', '煮咖啡招待客人'] },
  );

  assert.equal(result.ok, true);
  assert.equal(result.decision.action.verb, '煮咖啡招待客人');
  assert.equal(result.normalization?.code, 'interaction_verb_canonicalized');
  assert.match(result.normalization?.detail ?? '', /煮咖啡.*煮咖啡招待客人/);

  const suffixPredicate = validateDecision(
    { thought: '开始写生', action: { type: 'interact', target: 'obj:park', verb: '写生' }, duration_minutes: 10 },
    has,
    { interactionVerbs: () => ['在公园写生'] },
  );
  assert.equal(suffixPredicate.ok, true);
  assert.equal(suffixPredicate.decision.action.verb, '在公园写生');
  assert.equal(suffixPredicate.normalization?.code, 'interaction_verb_canonicalized');
});

test('紧凑 interact 谓词匹配多个声明时拒绝执行', () => {
  const result = validateDecision(
    { thought: '开始营业', action: { type: 'interact', target: 'obj:cafe', verb: '煮咖啡' }, duration_minutes: 10 },
    has,
    { interactionVerbs: () => ['煮咖啡招待客人', '煮咖啡准备外带'] },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ungrounded_interaction');
  assert.match(result.error ?? '', /无法唯一映射/);
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
