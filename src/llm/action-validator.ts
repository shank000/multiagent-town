// 动作校验：结构化输出 + 对象树校验，失败降级 idle（design §5.5）

import type { Action, Decision } from '../core/types';

export interface ValidationResult {
  ok: boolean;
  decision: Decision; // !ok 时即为 idle 降级决策
  error?: string;
  errorCode?: 'ungrounded_interaction';
  normalization?: {
    code: 'idle_target_cleared' | 'interaction_verb_canonicalized';
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
  let canonicalVerb = verb;
  let normalization: ValidationResult['normalization'];
  if (type === 'interact' && target && context.interactionVerbs) {
    const allowed = [...new Set(context.interactionVerbs(target).map((item) => item.trim()).filter(Boolean))];
    const declared = canonicalDeclaredVerb(verb, allowed);
    const instructed = verbAppearsInInstruction(verb, context.playerInstruction);
    if (declared.kind === 'ambiguous' && !instructed) {
      return fail(
        `交互动词无法唯一映射到目标「${target}」的声明动词：${verb}；匹配动词：${declared.matches.join('、')}`,
        'ungrounded_interaction',
      );
    }
    if (declared.kind === 'none' && !instructed) {
      const allowedText = allowed.length ? allowed.join('、') : '无';
      return fail(
        `交互动词未由目标「${target}」的 affordance、人物作息或玩家指令声明：${verb}；允许动词：${allowedText}`,
        'ungrounded_interaction',
      );
    }
    if (declared.kind === 'matched') {
      canonicalVerb = declared.canonical;
      if (canonicalVerb !== verb.trim()) {
        normalization = {
          code: 'interaction_verb_canonicalized',
          detail: `交互动词「${verb}」已按唯一声明谓词规范为「${canonicalVerb}」`,
        };
      }
    }
  }
  const normalizedTarget = type === 'idle' ? null : target;
  if (type === 'idle' && target !== null) {
    normalization = {
      code: 'idle_target_cleared',
      detail: 'idle 动作携带了无效目标，目标已规范为 null',
    };
  }
  return {
    ok: true,
    decision: {
      thought,
      action: { type: type as Action['type'], target: normalizedTarget, verb: canonicalVerb } as Action,
      durationMinutes: Math.floor(duration),
    },
    ...(normalization ? { normalization } : {}),
  };
}

type DeclaredVerbMatch =
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: string[] }
  | { kind: 'matched'; canonical: string };

/**
 * 将模型给出的紧凑动作谓词映射回唯一的声明动词。
 * 仅接受规范化后完全相等或长度至少为 2、被声明动词完整包含的谓词；不做反向包含、编辑距离或语义猜测。
 */
function canonicalDeclaredVerb(verb: string, allowed: readonly string[]): DeclaredVerbMatch {
  const trimmed = verb.trim();
  const exact = allowed.find((item) => item === trimmed);
  if (exact) return { kind: 'matched', canonical: exact };

  const predicate = compact(trimmed);
  if (predicate.length < 2) return { kind: 'none' };
  const matches = allowed.filter((item) => {
    const declared = compact(item);
    return declared.includes(predicate);
  });
  if (matches.length === 1) return { kind: 'matched', canonical: matches[0] };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'none' };
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
