// M0 共享类型：世界状态、agent、对象树、事件、动作

export type AgentState = 'idle' | 'thinking' | 'moving' | 'acting';

export type ActionType = 'move_to' | 'interact' | 'idle';

export interface Action {
  type: ActionType;
  target: string | null; // object_id；idle 时为 null
  verb: string;          // 动作描述，如「煮咖啡」
}

export interface Decision {
  thought: string;
  action: Action;
  durationMinutes: number; // 1~120
}

export interface RoutineSlot {
  from: number; // 当日分钟，如 9:00 = 540
  to: number;
  type: ActionType;
  target: string | null;
  verb: string;
}

export interface Personality {
  extraversion: number; // 0..1
  empathy: number;
  honesty: number;
  curiosity: number;
  patience: number;
}

export interface Appearance {
  hairStyle: string;
  hairColor: string;
  skinTone: string;
  outfit: string;
}

export type PixelAvatarAccessory = 'none' | 'glasses' | 'beret' | 'cap' | 'ribbon' | 'beard';

export interface PixelAvatar {
  /** 32×32 角色图集槽位，0..7。 */
  sprite: number;
  hair: string;
  skin: string;
  outfit: string;
  accent: string;
  accessory: PixelAvatarAccessory;
}

export interface AgentInitialState {
  valence: number;       // -1..1
  energy: number;        // 0..1
  stress: number;        // 0..1
  socialNeed: number;    // 0..1
  occupationalFocus: number; // 0..1
  startingLocationId: string;
}

export interface Persona {
  name: string;
  age: number;
  occupation: string;
  gender: '男' | '女';
  appearance: Appearance;
  hobbies: string[];              // 2~4 项
  skills: Record<string, number>; // 0..10
  values: string[];               // 2~4 条
  motivation: string;             // 一句话动机
  background: string;
  traits: string[];
  goals: string[];
  speechStyle: string;
  /** M0 用结构化作息代替规划引擎（M1 起由 Planner 生成） */
  routine: RoutineSlot[];
  /** 相邻闲聊的台词池（M2-lite 社交气泡用；缺省用通用台词） */
  greetingPool?: string[];
  /** 性格五维（M3；缺省 0.5） */
  personality?: Personality;
  /** 可编辑像素头像；地图角色与人物面板共用同一身份槽位。 */
  avatar?: PixelAvatar;
  /** 首次反思前的心态基线，以及新实验的起始位置。 */
  initialState?: AgentInitialState;
}

export interface Agent {
  id: string;
  name: string;
  persona: Persona;
  homeObjectId: string;
  state: AgentState;
  locationId: string;   // 当前所在对象
  x: number;            // 网格坐标（瓦片）
  y: number;
  path: Tile[];
  pathProgress: number; // 已走完的瓦片数（含小数）
  action: Decision | null;
  actionEndsAt: number; // 游戏分钟（绝对）
  lastDecisionAt: number;
  thought: string | null;
}

export interface Tile { x: number; y: number }

export type ObjectType = 'town' | 'building' | 'room' | 'furniture' | 'zone' | 'water';

export interface WorldObject {
  id: string;
  name: string;
  type: ObjectType;
  parentId: string | null;
  x: number; y: number; w: number; h: number; // 瓦片坐标与尺寸
}

export type EventType = 'move' | 'chat' | 'interact' | 'broadcast' | 'system' | 'player';

export interface GameEvent {
  id: string;
  type: EventType;
  actorId: string | null;
  targetIds: string[];
  description: string;   // 第三人称中文客观描述
  location: string | null;
  gameTime: number;      // 自纪元起分钟数
  payload: Record<string, unknown> | null;
}
