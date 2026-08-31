// 动作校验：结构化输出 + 对象树校验，失败降级 idle（design §5.5）

import type { Action, Decision } from '../core/types';

export interface ValidationResult {
  ok: boolean;
  decision: Decision; // !ok 时即为 idle 降级决策
  error?: string;
  errorCode?: 'ungrounded_interaction';
  normalization?: {
    code: 'idle_target_cleared';
    detail: string;
  };
}

export interface DecisionValidationContext {
  /** 目标对象由环境 affordance 与人物明确作息共同声明的可执行动词。 */
  interactionVerbs?: (targetId: string) => readonly string[];
  /** 玩家明确指令中的动作短语是独立的人工授权来源。 */
  playerInstruction?: string | null;
}

const ACTION_TYPES = new Set(['move_to', 'interact', 'idle']);

export function validateDecision(
  raw: unknown,
  hasObject: (id: string) => boolean,
  context: DecisionValidationContext = {},
): ValidationResult {
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
  if (type === 'interact' && target && context.interactionVerbs) {
    const allowed = [...new Set(context.interactionVerbs(target).map((item) => item.trim()).filter(Boolean))];
    const declared = allowed.includes(verb.trim());
    const instructed = verbAppearsInInstruction(verb, context.playerInstruction);
    if (!declared && !instructed) {
      const allowedText = allowed.length ? allowed.join('、') : '无';
      return fail(
        `交互动词未由目标「${target}」的 affordance、人物作息或玩家指令声明：${verb}；允许动词：${allowedText}`,
        'ungrounded_interaction',
      );
    }
  }
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

function fail(reason: string, errorCode?: ValidationResult['errorCode']): ValidationResult {
  return {
    ok: false,
    error: reason,
    ...(errorCode ? { errorCode } : {}),
    decision: idleDecision(`${reason}，休息一下`),
  };
}

function verbAppearsInInstruction(verb: string, instruction: string | null | undefined): boolean {
  if (!instruction) return false;
  const compactVerb = compact(verb);
  const compactInstruction = compact(instruction);
  return compactVerb.length >= 2 && compactInstruction.includes(compactVerb);
}

function compact(value: string): string {
  return value.replace(/[^\p{Script=Han}a-z0-9]/giu, '').toLocaleLowerCase();
}

export function idleDecision(thought: string): Decision {
  return { thought, action: { type: 'idle', target: null, verb: '休息' }, durationMinutes: 10 };
}
