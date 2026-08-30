// 浏览器快照兼容层：允许新版前端继续观察由较早后端进程产生的内存世界。

import { normalizePixelAvatar } from './avatar';
import type { AgentView } from './panel';

const stringItems = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  : [];

const finite = (value: unknown, fallback: number): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
);

/**
 * 补齐头像、研究档案与初始心态字段。当前字段完整时只生成防御性副本，
 * 因此初始 HTTP 快照和后续 SSE 快照可以共用同一入口。
 */
export function normalizeAgentView(agent: AgentView, index = 0): AgentView {
  const source = agent as Partial<AgentView>;
  const spriteIndex = Math.max(0, Math.floor(finite(source.spriteIndex, index)));
  const initial = source.initialState as Partial<AgentView['initialState']> | undefined;
  const goals = stringItems(source.goals);
  const motivation = typeof source.motivation === 'string' ? source.motivation : '';
  return {
    ...agent,
    traits: stringItems(source.traits),
    goals: goals.length > 0 ? goals : motivation ? [motivation] : [],
    speechStyle: typeof source.speechStyle === 'string' && source.speechStyle.trim()
      ? source.speechStyle
      : '自然、清晰地回应事实，并结合自己的经历表达观点。',
    spriteIndex,
    avatar: normalizePixelAvatar(source.avatar, spriteIndex),
    initialState: {
      valence: finite(initial?.valence, 0),
      energy: finite(initial?.energy, 0.7),
      stress: finite(initial?.stress, 0.25),
      socialNeed: finite(initial?.socialNeed, 0.5),
      occupationalFocus: finite(initial?.occupationalFocus, 0.7),
      startingLocationId: typeof initial?.startingLocationId === 'string' && initial.startingLocationId
        ? initial.startingLocationId
        : source.locationId ?? '',
    },
  };
}

export function normalizeAgentViews(agents: readonly AgentView[]): AgentView[] {
  return agents.map((agent, index) => normalizeAgentView(agent, index));
}
