// 测试共用工具（仅测试代码引用）

import type { Agent, Persona } from '../src/core/types';

export function persona(over: Partial<Persona> = {}): Persona {
  return {
    name: '测试员', age: 30, occupation: '测试', background: '无',
    traits: [], goals: [], speechStyle: '', routine: [],
    ...over,
  };
}

export function makeAgent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent:test', name: '测试员', persona: persona(),
    homeObjectId: 'obj:home', state: 'idle', locationId: 'obj:home',
    x: 0, y: 0, path: [], pathProgress: 0, action: null,
    actionEndsAt: 0, lastDecisionAt: 0, thought: null,
    ...over,
  };
}

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
