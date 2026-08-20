// 小镇种子数据：对象树（48×44 瓦片）+ 4 个 persona（M0 用结构化作息代替规划引擎）

import type { Agent, Persona, WorldObject } from '../core/types';
import { WorldState } from '../core/world';

export const TOWN_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: 48, h: 44 },
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
  // 阶段 B 扩容地形带（x≥40 或 y≥40，纯装饰/水域；果园树为 zone 不阻挡）
  { id: 'obj:orchard', name: '西坡果园', type: 'zone', parentId: 'obj:town', x: 40, y: 2, w: 8, h: 10 },
  { id: 'obj:forest_ne', name: '东山树林', type: 'zone', parentId: 'obj:town', x: 42, y: 14, w: 6, h: 8 },
  { id: 'obj:river', name: '小镇河', type: 'water', parentId: 'obj:town', x: 8, y: 40, w: 40, h: 4 },
  { id: 'obj:farm_east', name: '东侧农田', type: 'zone', parentId: 'obj:town', x: 40, y: 24, w: 8, h: 10 },
  { id: 'obj:meadow_s', name: '南坡草地', type: 'zone', parentId: 'obj:town', x: 0, y: 40, w: 8, h: 4 },
  // 路灯（Task 5 灯火辉光用；zone 1×1 不阻挡）
  { id: 'obj:lamp_plaza', name: '广场路灯', type: 'zone', parentId: 'obj:town', x: 17, y: 18, w: 1, h: 1 },
  { id: 'obj:lamp_street1', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 10, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_street2', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 29, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_lake', name: '湖边路灯', type: 'zone', parentId: 'obj:town', x: 16, y: 27, w: 1, h: 1 },
];

export const LIN_PERSONA: Persona = {
  name: '林晚晴', age: 32, occupation: '咖啡馆老板', gender: '女',
  appearance: { hairStyle: '齐肩短发', hairColor: '深棕色', skinTone: '浅麦色', outfit: '米色围裙配深蓝衬衫' },
  hobbies: ['手冲咖啡', '观察路人', '写小说'],
  skills: { 手冲咖啡: 9, 倾听: 8, 写作: 7, 烘焙: 6 },
  values: ['咖啡馆是小镇的客厅', '真诚待人', '慢生活'],
  motivation: '把咖啡馆经营成小镇最温暖的公共空间，并写下小镇人物的故事。',
  background: '五年前从大城市回到小镇，在中央大街开了「林间咖啡馆」。她记得每一位常客的口味，也悄悄在笔记本里记下小镇人物的故事。陈默是她学生时代的老同学，这些年两人因为书店与咖啡馆的生意往来重新走近，却又总隔着一层没说出口的话。她想把咖啡馆经营成小镇的公共客厅，也盼着自己写的那本小说有一天能出版。',
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
  name: '陈默', age: 33, occupation: '书店老板', gender: '男',
  appearance: { hairStyle: '利落短发', hairColor: '黑色', skinTone: '偏白', outfit: '深灰开衫配白衬衫' },
  hobbies: ['读书', '整理书单', '下棋'],
  skills: { 选书推荐: 9, 记忆力: 8, 下棋: 6, 聊天: 4 },
  values: ['书是安静的陪伴', '少说多做', '诚信经营'],
  motivation: '让书店成为小镇的精神角落，修复与林晚晴逐渐疏远的旧谊。',
  background: '林晚晴的老同学，沉默寡言，却熟悉小镇每一个人的阅读口味。他把「默语书店」经营成小镇的沙龙，新书到货时总会在门口的小黑板上写一句推荐语。对林晚晴，他嘴上不说，却总在她来翻书时悄悄留一壶热水。最近他反复想着学生时代没送出去的那封信，犹豫要不要把当年的心意补上。',
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
  name: '沈屿', age: 35, occupation: '画家', gender: '男',
  appearance: { hairStyle: '微卷长发', hairColor: '栗色', skinTone: '浅麦色', outfit: '白色衬衫配旧围巾' },
  hobbies: ['油画写生', '收集明信片', '弹吉他'],
  skills: { 油画: 9, 观察力: 8, 吉他: 6, 社交: 7 },
  values: ['自由比稳定重要', '记录小镇的美', '真诚的表达'],
  motivation: '完成小镇系列画展，画出林晚晴开咖啡馆的样子。',
  background: '旅居小镇的画家，每天清晨在公园支起画架写生，午后到咖啡馆喝咖啡画速写。他喜欢把小镇的光线画成柠檬黄色，也悄悄给咖啡馆老板娘林晚晴画过许多张侧影。他计划在入冬前办一场小镇系列画展，最想展出的一幅，是林晚晴站在吧台后擦杯子的样子。',
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
  name: '周岚', age: 28, occupation: '邮差', gender: '女',
  appearance: { hairStyle: '高马尾', hairColor: '黑色', skinTone: '小麦色', outfit: '邮差绿制服配红围巾' },
  hobbies: ['骑自行车', '打听消息', '集邮'],
  skills: { 骑行: 9, 认路: 9, 集邮: 8, 保密: 3 },
  values: ['每一封信都要送到', '消息灵通是责任', '朋友的事就是我的事'],
  motivation: '把每一封信准时送到，并撮合沈屿与林晚晴。',
  background: '小镇唯一的邮差，骑着一辆绿色自行车穿行每一条街巷，是小镇消息最灵通的人。她收藏邮票也收藏故事，谁家的事都瞒不过她。最近她最大的心事是沈屿和林晚晴——一个天天画人家，一个天天煮咖啡给人家喝，就是没人先开口。她决定利用送信之便，给这对木头人制造点机会。',
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
