// 小镇种子数据：对象树（40×40 瓦片）+ 4 个 persona（M0 用结构化作息代替规划引擎）

import type { Agent, Persona, WorldObject } from '../core/types';
import { WorldState } from '../core/world';

export const TOWN_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 40, h: 40 },
  // 商业街
  { id: 'obj:cafe', name: '林间咖啡馆', type: 'building', parentId: 'obj:town', x: 8, y: 8, w: 4, h: 4 },
  { id: 'obj:cafe_counter', name: '咖啡馆吧台', type: 'room', parentId: 'obj:cafe', x: 9, y: 8, w: 2, h: 1 },
  { id: 'obj:cafe_table1', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 8, y: 9, w: 1, h: 1 },
  { id: 'obj:cafe_table2', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 11, y: 9, w: 1, h: 1 },
  { id: 'obj:bookstore', name: '默语书店', type: 'building', parentId: 'obj:town', x: 18, y: 8, w: 4, h: 4 },
  { id: 'obj:bookstore_counter', name: '书店柜台', type: 'room', parentId: 'obj:bookstore', x: 19, y: 8, w: 2, h: 1 },
  { id: 'obj:post_office', name: '小镇邮局', type: 'building', parentId: 'obj:town', x: 28, y: 8, w: 4, h: 4 },
  { id: 'obj:bakery', name: '晨光面包店', type: 'building', parentId: 'obj:town', x: 32, y: 18, w: 4, h: 4 },
  { id: 'obj:clinic', name: '小镇诊所', type: 'building', parentId: 'obj:town', x: 4, y: 18, w: 4, h: 4 },
  // 公共区域
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 18, y: 18, w: 6, h: 6 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 6, y: 26, w: 10, h: 6 },
  { id: 'obj:lake', name: '湖边', type: 'zone', parentId: 'obj:town', x: 16, y: 28, w: 4, h: 2 },
  { id: 'obj:park_easel', name: '公园画架', type: 'furniture', parentId: 'obj:park', x: 7, y: 27, w: 1, h: 1 },
  { id: 'obj:farm', name: '晨光农田', type: 'zone', parentId: 'obj:town', x: 24, y: 24, w: 8, h: 6 },
  { id: 'obj:path_main', name: '主街', type: 'zone', parentId: 'obj:town', x: 8, y: 16, w: 24, h: 2 },
  // 住宅（四角）
  { id: 'obj:home_lin', name: '林晚晴的家', type: 'building', parentId: 'obj:town', x: 2, y: 2, w: 4, h: 4 },
  { id: 'obj:home_chen', name: '陈默的家', type: 'building', parentId: 'obj:town', x: 34, y: 2, w: 4, h: 4 },
  { id: 'obj:home_shen', name: '沈屿的家', type: 'building', parentId: 'obj:town', x: 2, y: 34, w: 4, h: 4 },
  { id: 'obj:home_zhou', name: '周岚的家', type: 'building', parentId: 'obj:town', x: 34, y: 34, w: 4, h: 4 },
  // 家具（床 + 沙发，各户一件）
  { id: 'obj:bed_lin', name: '床', type: 'furniture', parentId: 'obj:home_lin', x: 3, y: 2, w: 1, h: 2 },
  { id: 'obj:bed_chen', name: '床', type: 'furniture', parentId: 'obj:home_chen', x: 35, y: 2, w: 1, h: 2 },
  { id: 'obj:bed_shen', name: '床', type: 'furniture', parentId: 'obj:home_shen', x: 3, y: 34, w: 1, h: 2 },
  { id: 'obj:bed_zhou', name: '床', type: 'furniture', parentId: 'obj:home_zhou', x: 35, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_lin', name: '沙发', type: 'furniture', parentId: 'obj:home_lin', x: 2, y: 4, w: 2, h: 1 },
  { id: 'obj:sofa_chen', name: '沙发', type: 'furniture', parentId: 'obj:home_chen', x: 34, y: 4, w: 2, h: 1 },
  { id: 'obj:sofa_shen', name: '沙发', type: 'furniture', parentId: 'obj:home_shen', x: 2, y: 36, w: 2, h: 1 },
  { id: 'obj:sofa_zhou', name: '沙发', type: 'furniture', parentId: 'obj:home_zhou', x: 34, y: 36, w: 2, h: 1 },
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
  greetingPool: ['今天的咖啡特别香，要来一杯吗？', '你看起来气色不错。', '常来坐坐呀，小镇最近可热闹了。'],
  personality: { extraversion: 0.7, empathy: 0.9, honesty: 0.8, curiosity: 0.6, patience: 0.7 },
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
  greetingPool: ['最近在读什么书？', '……嗯，好久不见。', '书店到了批新书，有空来看看。'],
  personality: { extraversion: 0.3, empathy: 0.7, honesty: 0.9, curiosity: 0.7, patience: 0.9 },
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
  greetingPool: ['今天的阳光是柠檬黄色的。', '我在画一张很特别的速写。', '要不要来公园看我的画？'],
  personality: { extraversion: 0.8, empathy: 0.6, honesty: 0.5, curiosity: 0.9, patience: 0.5 },
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
  greetingPool: ['有你的信吗？我帮你留意！', '早啊！今天也要加油。', '听说湖边傍晚特别好看。'],
  personality: { extraversion: 0.9, empathy: 0.8, honesty: 0.4, curiosity: 0.7, patience: 0.6 },
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
