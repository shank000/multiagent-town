// 动作校验：结构化输出 + 对象树校验，失败降级 idle（design §5.5）

import type { Action, Decision } from '../core/types';

export interface ValidationResult {
  ok: boolean;
  decision: Decision; // !ok 时即为 idle 降级决策
  error?: string;
  normalization?: {
    code: 'idle_target_cleared';
    detail: string;
  };
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
  const rawTarget = obj.action?.target;
  if (rawTarget !== null && rawTarget !== undefined && typeof rawTarget !== 'string') {
    return fail(`动作目标格式非法：${typeof rawTarget}`);
  }
  const target = typeof rawTarget === 'string' ? rawTarget : null;
  if (type !== 'idle' && (!target || !hasObject(target))) return fail(`动作目标不存在：${String(target)}`);
  if (!Number.isFinite(duration) || duration < 1 || duration > 120) return fail(`时长非法：${duration}`);
  const verb = typeof obj.action?.verb === 'string' && obj.action.verb.length > 0 ? obj.action.verb : type;
  const normalizedTarget = type === 'idle' ? null : target;
  return {
    ok: true,
    decision: {
      thought,
      action: { type: type as Action['type'], target: normalizedTarget, verb } as Action,
      durationMinutes: Math.floor(duration),
    },
    ...(type === 'idle' && target !== null ? {
      normalization: {
        code: 'idle_target_cleared' as const,
        detail: 'idle 动作携带了无效目标，目标已规范为 null',
      },
    } : {}),
  };
}

function fail(reason: string): ValidationResult {
  return { ok: false, error: reason, decision: idleDecision(`${reason}，休息一下`) };
}

export function idleDecision(thought: string): Decision {
  return { thought, action: { type: 'idle', target: null, verb: '休息' }, durationMinutes: 10 };
}
