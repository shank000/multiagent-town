// 小镇种子数据：对象树（12×8 瓦片）+ 4 个 persona（M0 用结构化作息代替规划引擎）

import type { Agent, Persona, WorldObject } from '../core/types';
import { WorldState } from '../core/world';

export const TOWN_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 12, h: 8 },
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 4, y: 2, w: 3, h: 3 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 8, y: 5, w: 3, h: 2 },
  { id: 'obj:cafe', name: '林间咖啡馆', type: 'building', parentId: 'obj:town', x: 2, y: 1, w: 2, h: 2 },
  { id: 'obj:cafe_counter', name: '咖啡馆吧台', type: 'room', parentId: 'obj:cafe', x: 2, y: 1, w: 1, h: 1 },
  { id: 'obj:bookstore', name: '默语书店', type: 'building', parentId: 'obj:town', x: 6, y: 1, w: 2, h: 2 },
  { id: 'obj:bookstore_counter', name: '书店柜台', type: 'room', parentId: 'obj:bookstore', x: 6, y: 1, w: 1, h: 1 },
  { id: 'obj:park_easel', name: '公园画架', type: 'furniture', parentId: 'obj:park', x: 9, y: 6, w: 1, h: 1 },
  { id: 'obj:home_lin', name: '林晚晴的家', type: 'building', parentId: 'obj:town', x: 1, y: 6, w: 2, h: 2 },
  { id: 'obj:home_chen', name: '陈默的家', type: 'building', parentId: 'obj:town', x: 9, y: 1, w: 2, h: 2 },
  { id: 'obj:home_shen', name: '沈屿的家', type: 'building', parentId: 'obj:town', x: 10, y: 6, w: 2, h: 2 },
  { id: 'obj:home_zhou', name: '周岚的家', type: 'building', parentId: 'obj:town', x: 0, y: 0, w: 2, h: 2 },
  { id: 'obj:post_office', name: '小镇邮局', type: 'building', parentId: 'obj:town', x: 4, y: 5, w: 2, h: 2 },
];

export const LIN_PERSONA: Persona = {
  name: '林晚晴', age: 32, occupation: '咖啡馆老板',
  background: '五年前从大城市回到小镇开了间咖啡馆，喜欢观察客人。',
  traits: ['温和', '健谈', '有点理想主义'],
  goals: ['把咖啡馆经营成小镇的公共客厅', '写一本关于小镇人物的小说'],
  speechStyle: '语气轻柔，爱用比喻',
  routine: [
    { from: 450, to: 540, type: 'interact', target: 'obj:cafe_counter', verb: '开店准备' },
    { from: 540, to: 720, type: 'interact', target: 'obj:cafe_counter', verb: '煮咖啡招待客人' },
    { from: 840, to: 900, type: 'interact', target: 'obj:bookstore', verb: '去书店翻翻新书' },
    { from: 1020, to: 1080, type: 'interact', target: 'obj:park', verb: '在公园散步' },
  ],
};

export const CHEN_PERSONA: Persona = {
  name: '陈默', age: 33, occupation: '书店老板',
  background: '林晚晴的老同学，沉默寡言，熟悉小镇每一个人的阅读口味。',
  traits: ['内敛', '细心', '爱书成癖'],
  goals: ['把书店办成小镇的沙龙', '修复与林晚晴逐渐疏远的关系'],
  speechStyle: '话不多，但句句实在',
  routine: [
    { from: 480, to: 540, type: 'interact', target: 'obj:bookstore_counter', verb: '开店整理书架' },
    { from: 540, to: 1080, type: 'interact', target: 'obj:bookstore_counter', verb: '接待顾客' },
    { from: 1140, to: 1200, type: 'interact', target: 'obj:plaza', verb: '到广场散步' },
  ],
};

export const SHEN_PERSONA: Persona = {
  name: '沈屿', age: 35, occupation: '画家',
  background: '旅居小镇的画家，每天在公园写生，常去咖啡馆喝咖啡。',
  traits: ['浪漫', '随性', '观察力强'],
  goals: ['完成小镇系列画展', '画出林晚晴开咖啡馆的样子'],
  speechStyle: '热情洋溢，喜欢描述颜色',
  routine: [
    { from: 480, to: 720, type: 'interact', target: 'obj:park_easel', verb: '在公园写生' },
    { from: 900, to: 1020, type: 'interact', target: 'obj:cafe', verb: '在咖啡馆喝咖啡画速写' },
  ],
};

export const ZHOU_PERSONA: Persona = {
  name: '周岚', age: 28, occupation: '邮差',
  background: '小镇唯一的邮差，骑自行车穿行每条街巷，是小镇消息最灵通的人。',
  traits: ['爽朗', '热心', '藏不住话'],
  goals: ['把每一封信准时送到', '撮合沈屿与林晚晴'],
  speechStyle: '语速快，爱开玩笑',
  routine: [
    { from: 480, to: 540, type: 'interact', target: 'obj:post_office', verb: '分拣信件' },
    { from: 540, to: 660, type: 'interact', target: 'obj:plaza', verb: '到广场送信' },
    { from: 660, to: 720, type: 'interact', target: 'obj:cafe', verb: '到咖啡馆送信' },
    { from: 900, to: 960, type: 'interact', target: 'obj:bookstore', verb: '到书店送信' },
  ],
};

const HOME_BY_NAME: Record<string, string> = {
  '林晚晴': 'obj:home_lin',
  '陈默': 'obj:home_chen',
  '沈屿': 'obj:home_shen',
  '周岚': 'obj:home_zhou',
};

export interface TownSeed {
  objects: WorldObject[];
  personas: Persona[];
}

export const DEFAULT_SEED: TownSeed = {
  objects: TOWN_OBJECTS,
  personas: [LIN_PERSONA, CHEN_PERSONA, SHEN_PERSONA, ZHOU_PERSONA],
};

export function buildTown(seed: TownSeed = DEFAULT_SEED): WorldState {
  const agents: Agent[] = seed.personas.map((p) => {
    const homeId = HOME_BY_NAME[p.name];
    if (!homeId) throw new Error(`persona 没有对应住宅: ${p.name}`);
    const home = seed.objects.find((o) => o.id === homeId);
    if (!home) throw new Error(`对象不存在: ${homeId}`);
    return {
      id: `agent:${p.name}`,
      name: p.name,
      persona: p,
      homeObjectId: homeId,
      state: 'idle',
      locationId: homeId,
      x: home.x + Math.floor(home.w / 2),
      y: home.y + Math.floor(home.h / 2),
      path: [],
      pathProgress: 0,
      action: null,
      actionEndsAt: 0,
      lastDecisionAt: 0,
      thought: null,
    };
  });
  return new WorldState(seed.objects, agents);
}
