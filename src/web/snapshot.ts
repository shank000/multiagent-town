// 世界快照序列化：把引擎状态转成浏览器可消费的纯 JSON

import { TimeEngine, type ClockState } from '../core/time';
import { GRID_W, GRID_H, type WorldState } from '../core/world';
import type { Agent, WorldObject } from '../core/types';

export interface AgentView {
  id: string;
  name: string;
  occupation: string;
  age: number;
  gender: string;
  appearance: { hairStyle: string; hairColor: string; skinTone: string; outfit: string };
  hobbies: string[];
  skills: Record<string, number>;
  values: string[];
  motivation: string;
  personality: { extraversion: number; empathy: number; honesty: number; curiosity: number; patience: number };
  state: Agent['state'];
  x: number;
  y: number;
  locationId: string;
  locationName: string;
  verb: string;             // 当前动作动词；无动作时为空串
  thought: string | null;
  targetName: string | null; // 当前动作目标对象名
  spriteIndex: number;       // 客户端配色索引（0..3，按 allAgents 顺序）
  background: string;
}

export interface ObjectView {
  id: string;
  name: string;
  type: WorldObject['type'];
  x: number; y: number; w: number; h: number;
}

export interface WorldSnapshot {
  clock: ClockState;
  speedPerRealSecond: number; // 游戏分钟/现实秒 = gameMinutesPerTick × 2
  paused: boolean;
  gridW: number;
  gridH: number;
  objects: ObjectView[];
  agents: AgentView[];
  seq: number;
}

export function buildSnapshot(
  world: WorldState,
  time: TimeEngine,
  paused: boolean,
  seq: number
): WorldSnapshot {
  const agents: AgentView[] = world.allAgents().map((a, i) => {
    const action = a.action;
    const busy = a.state === 'acting' || a.state === 'moving';
    return {
      id: a.id,
      name: a.name,
      occupation: a.persona.occupation,
      age: a.persona.age,
      gender: a.persona.gender,
      appearance: a.persona.appearance,
      hobbies: a.persona.hobbies,
      skills: a.persona.skills,
      values: a.persona.values,
      motivation: a.persona.motivation,
      personality: a.persona.personality ?? { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 },
      state: a.state,
      x: a.x,
      y: a.y,
      locationId: a.locationId,
      locationName: world.getObject(a.locationId)?.name ?? a.locationId,
      verb: action && busy ? action.action.verb : '',
      thought: a.thought,
      targetName: action ? world.getObject(action.action.target)?.name ?? null : null,
      spriteIndex: i,
      background: a.persona.background,
    };
  });
  return {
    clock: time.state,
    speedPerRealSecond: time.gameMinutesPerTick * 2,
    paused,
    gridW: GRID_W,
    gridH: GRID_H,
    objects: world.allObjects().map((o) => ({
      id: o.id, name: o.name, type: o.type, x: o.x, y: o.y, w: o.w, h: o.h,
    })),
    agents,
    seq,
  };
}
