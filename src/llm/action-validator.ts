// 动作校验：结构化输出 + 对象树校验，失败降级 idle（design §5.5）

import type { Action, Decision } from '../core/types';

export interface ValidationResult {
  ok: boolean;
  decision: Decision; // !ok 时即为 idle 降级决策
  error?: string;
}

const ACTION_TYPES = new Set(['move_to', 'interact', 'idle']);

export function validateDecision(raw: unknown, hasObject: (id: string) => boolean): ValidationResult {
  const obj = (raw ?? null) as {
    thought?: unknown;
    action?: { type?: unknown; target?: unknown; verb?: unknown } | null;
    duration_minutes?: unknown;
  } | null;
  if (!obj || typeof obj !== 'object') return fail('决策输出不是对象');
  const thought = typeof obj.thought === 'string' ? obj.thought.slice(0, 200) : '';
  const type = obj.action?.type;
  const duration = Number(obj.duration_minutes);
  if (typeof type !== 'string' || !ACTION_TYPES.has(type)) return fail(`动作类型非法：${String(type)}`);
  const target =
    obj.action?.target === null || obj.action?.target === undefined
      ? null
      : typeof obj.action.target === 'string' ? obj.action.target : null;
  if (type !== 'idle' && (!target || !hasObject(target))) return fail(`动作目标不存在：${String(target)}`);
  if (type === 'idle' && target !== null) return fail('idle 不能带目标');
  if (!Number.isFinite(duration) || duration < 1 || duration > 120) return fail(`时长非法：${duration}`);
  const verb = typeof obj.action?.verb === 'string' && obj.action.verb.length > 0 ? obj.action.verb : type;
  return {
    ok: true,
    decision: {
      thought,
      action: { type: type as Action['type'], target, verb } as Action,
      durationMinutes: Math.floor(duration),
    },
  };
}

function fail(reason: string): ValidationResult {
  return { ok: false, error: reason, decision: idleDecision(`${reason}，休息一下`) };
}

export function idleDecision(thought: string): Decision {
  return { thought, action: { type: 'idle', target: null, verb: '休息' }, durationMinutes: 10 };
}
