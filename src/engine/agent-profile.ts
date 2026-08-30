import { createHash } from 'node:crypto';
import type {
  Agent,
  AgentInitialState,
  Appearance,
  Persona,
  Personality,
  PixelAvatar,
  PixelAvatarAccessory,
} from '../core/types';
import type { WorldState } from '../core/world';
import type { ReflectionMindState } from '../store/memory';

export interface AgentProfileDefinition {
  name: string;
  age: number;
  occupation: string;
  gender: '男' | '女';
  appearance: Appearance;
  hobbies: string[];
  skills: Record<string, number>;
  values: string[];
  motivation: string;
  background: string;
  traits: string[];
  goals: string[];
  speechStyle: string;
  personality: Personality;
  avatar: PixelAvatar;
  initialState: AgentInitialState;
}

const ACCESSORIES = new Set<PixelAvatarAccessory>(['none', 'glasses', 'beret', 'cap', 'ribbon', 'beard']);
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const DEFAULT_AVATARS: readonly PixelAvatar[] = [
  { sprite: 0, hair: '#3b2c28', skin: '#efc39f', outfit: '#365a78', accent: '#d9aa67', accessory: 'ribbon' },
  { sprite: 1, hair: '#191b20', skin: '#edc4a2', outfit: '#4f5c68', accent: '#8fb8b0', accessory: 'glasses' },
  { sprite: 2, hair: '#6b3f2d', skin: '#e8b98e', outfit: '#6d6c76', accent: '#b95d55', accessory: 'beret' },
  { sprite: 3, hair: '#1d2026', skin: '#c88d63', outfit: '#4e765b', accent: '#c94e58', accessory: 'cap' },
  { sprite: 4, hair: '#2f241e', skin: '#f0c7a4', outfit: '#7a5f79', accent: '#e0a96b', accessory: 'ribbon' },
  { sprite: 7, hair: '#c5c2b8', skin: '#d9ad89', outfit: '#685a4d', accent: '#b79368', accessory: 'beard' },
];

export function avatarOf(persona: Persona, fallbackIndex = 0): PixelAvatar {
  const fallback = DEFAULT_AVATARS[((fallbackIndex % DEFAULT_AVATARS.length) + DEFAULT_AVATARS.length) % DEFAULT_AVATARS.length];
  return persona.avatar ? { ...persona.avatar } : { ...fallback };
}

export function initialStateOf(persona: Persona, fallbackLocationId = 'obj:plaza'): AgentInitialState {
  return persona.initialState ? { ...persona.initialState } : {
    valence: 0.15,
    energy: 0.72,
    stress: 0.25,
    socialNeed: 0.5,
    occupationalFocus: 0.7,
    startingLocationId: fallbackLocationId,
  };
}

export function initialMindStateOf(persona: Persona): ReflectionMindState {
  const state = initialStateOf(persona);
  return {
    valence: state.valence,
    energy: state.energy,
    stress: state.stress,
    socialNeed: state.socialNeed,
    occupationalFocus: state.occupationalFocus,
    summary: `${persona.name}的实验初始心态基线`,
  };
}

export function profileDefinitionOf(agent: Agent, fallbackIndex = 0): AgentProfileDefinition {
  const persona = agent.persona;
  return {
    name: agent.name,
    age: persona.age,
    occupation: persona.occupation,
    gender: persona.gender,
    appearance: { ...persona.appearance },
    hobbies: [...persona.hobbies],
    skills: { ...persona.skills },
    values: [...persona.values],
    motivation: persona.motivation,
    background: persona.background,
    traits: [...persona.traits],
    goals: [...persona.goals],
    speechStyle: persona.speechStyle,
    personality: { ...defaultPersonality(), ...(persona.personality ?? {}) },
    avatar: avatarOf(persona, fallbackIndex),
    initialState: initialStateOf(persona, agent.homeObjectId),
  };
}

export function normalizeAgentProfile(
  input: unknown,
  current: Agent,
  world: WorldState,
  fallbackIndex = 0,
): AgentProfileDefinition {
  const value = recordOf(input, '居民档案');
  const definition: AgentProfileDefinition = {
    name: textOf(value.name, '姓名', 1, 16),
    age: integerOf(value.age, '年龄', 16, 100),
    occupation: textOf(value.occupation, '职业', 1, 32),
    gender: value.gender === '男' || value.gender === '女' ? value.gender : invalid('性别必须为男或女'),
    appearance: appearanceOf(value.appearance),
    hobbies: stringsOf(value.hobbies, '爱好', 0, 8, 24),
    skills: skillsOf(value.skills),
    values: stringsOf(value.values, '价值观', 1, 8, 60),
    motivation: textOf(value.motivation, '动机', 1, 240),
    background: textOf(value.background, '背景故事', 1, 2000),
    traits: stringsOf(value.traits, '人格标签', 1, 8, 24),
    goals: stringsOf(value.goals, '目标', 1, 8, 120),
    speechStyle: textOf(value.speechStyle, '说话风格', 1, 160),
    personality: personalityOfInput(value.personality),
    avatar: avatarOfInput(value.avatar, avatarOf(current.persona, fallbackIndex)),
    initialState: initialStateOfInput(value.initialState, world, current.homeObjectId),
  };
  const duplicate = world.allAgents().find((agent) => agent.id !== current.id && agent.name === definition.name);
  if (duplicate) throw new Error(`姓名“${definition.name}”已被其他居民使用`);
  return definition;
}

export function applyAgentProfile(
  world: WorldState,
  agentId: string,
  definition: AgentProfileDefinition,
  options: { resetRuntime?: boolean } = {},
): Agent {
  const agent = world.getAgent(agentId);
  agent.name = definition.name;
  agent.persona = {
    ...agent.persona,
    name: definition.name,
    age: definition.age,
    occupation: definition.occupation,
    gender: definition.gender,
    appearance: { ...definition.appearance },
    hobbies: [...definition.hobbies],
    skills: { ...definition.skills },
    values: [...definition.values],
    motivation: definition.motivation,
    background: definition.background,
    traits: [...definition.traits],
    goals: [...definition.goals],
    speechStyle: definition.speechStyle,
    personality: { ...definition.personality },
    avatar: { ...definition.avatar },
    initialState: { ...definition.initialState },
  };
  if (options.resetRuntime) {
    const object = world.getObject(definition.initialState.startingLocationId);
    if (!object) throw new Error(`起始位置不存在：${definition.initialState.startingLocationId}`);
    const tile = world.centerOf(object);
    agent.locationId = object.id;
    agent.x = tile.x;
    agent.y = tile.y;
    agent.path = [];
    agent.pathProgress = 0;
    agent.state = 'idle';
    agent.action = null;
    agent.actionEndsAt = 0;
    agent.lastDecisionAt = 0;
    agent.thought = null;
  }
  return agent;
}

export function profileSetHash(world: WorldState): string {
  const canonical = world.allAgents()
    .map((agent, index) => [agent.id, profileDefinitionOf(agent, index)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function defaultPersonality(): Personality {
  return { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 };
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}

function textOf(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label}必须是文本`);
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length < min || normalized.length > max) throw new Error(`${label}长度必须为 ${min}..${max}`);
  return normalized;
}

function integerOf(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label}必须为 ${min}..${max} 的整数`);
  }
  return value as number;
}

function numberOf(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}必须为 ${min}..${max} 的数字`);
  }
  return Math.round(value * 100) / 100;
}

function stringsOf(value: unknown, label: string, min: number, max: number, itemMax: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${label}数量必须为 ${min}..${max}`);
  }
  const result = value.map((item, index) => textOf(item, `${label}第${index + 1}项`, 1, itemMax));
  if (new Set(result).size !== result.length) throw new Error(`${label}不能包含重复项`);
  return result;
}

function appearanceOf(value: unknown): Appearance {
  const appearance = recordOf(value, '外貌');
  return {
    hairStyle: textOf(appearance.hairStyle, '发型', 1, 40),
    hairColor: textOf(appearance.hairColor, '发色', 1, 40),
    skinTone: textOf(appearance.skinTone, '肤色', 1, 40),
    outfit: textOf(appearance.outfit, '服装', 1, 80),
  };
}

function skillsOf(value: unknown): Record<string, number> {
  const skills = recordOf(value, '技能');
  const entries = Object.entries(skills);
  if (entries.length > 12) throw new Error('技能最多 12 项');
  const result: Record<string, number> = {};
  for (const [rawName, score] of entries) {
    const name = textOf(rawName, '技能名称', 1, 24);
    result[name] = numberOf(score, `技能“${name}”`, 0, 10);
  }
  return result;
}

function personalityOfInput(value: unknown): Personality {
  const personality = recordOf(value, '人格五维');
  return {
    extraversion: numberOf(personality.extraversion, '外向', 0, 1),
    empathy: numberOf(personality.empathy, '共情', 0, 1),
    honesty: numberOf(personality.honesty, '诚实', 0, 1),
    curiosity: numberOf(personality.curiosity, '好奇', 0, 1),
    patience: numberOf(personality.patience, '耐心', 0, 1),
  };
}

function colorOf(value: unknown, label: string, fallback: string): string {
  const color = value === undefined ? fallback : value;
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw new Error(`${label}必须是 #RRGGBB 颜色`);
  return color.toLowerCase();
}

function avatarOfInput(value: unknown, fallback: PixelAvatar): PixelAvatar {
  const avatar = recordOf(value, '像素头像');
  const accessory = avatar.accessory;
  if (typeof accessory !== 'string' || !ACCESSORIES.has(accessory as PixelAvatarAccessory)) {
    throw new Error('头像配饰无效');
  }
  return {
    sprite: integerOf(avatar.sprite, '角色图集槽位', 0, 7),
    hair: colorOf(avatar.hair, '头像发色', fallback.hair),
    skin: colorOf(avatar.skin, '头像肤色', fallback.skin),
    outfit: colorOf(avatar.outfit, '头像服装色', fallback.outfit),
    accent: colorOf(avatar.accent, '头像强调色', fallback.accent),
    accessory: accessory as PixelAvatarAccessory,
  };
}

function initialStateOfInput(value: unknown, world: WorldState, fallbackLocationId: string): AgentInitialState {
  const state = recordOf(value, '初始状态');
  const startingLocationId = typeof state.startingLocationId === 'string' && state.startingLocationId
    ? state.startingLocationId
    : fallbackLocationId;
  const object = world.getObject(startingLocationId);
  if (!object || object.type === 'water') throw new Error('起始位置必须是小镇中可进入的对象');
  const tile = world.centerOf(object);
  if (!world.walkable(tile.x, tile.y)) throw new Error('起始位置中心不可通行');
  return {
    valence: numberOf(state.valence, '初始情绪', -1, 1),
    energy: numberOf(state.energy, '初始精力', 0, 1),
    stress: numberOf(state.stress, '初始压力', 0, 1),
    socialNeed: numberOf(state.socialNeed, '初始社交需要', 0, 1),
    occupationalFocus: numberOf(state.occupationalFocus, '初始职业专注', 0, 1),
    startingLocationId,
  };
}

function invalid(message: string): never {
  throw new Error(message);
}
