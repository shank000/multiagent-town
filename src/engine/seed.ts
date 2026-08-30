// 小镇种子数据：对象树（48×44 瓦片）+ 6 个 persona（M0 用结构化作息代替规划引擎）

import type { Agent, Persona, WorldObject } from '../core/types';
import { WorldState, GRID_W, GRID_H } from '../core/world';
import type { DbHandle } from '../store/db';
import { profileSetHash } from './agent-profile';

/** 世界水合：把内存中的居民/对象同步写入 SQLite 的 agents/objects 表（幂等 upsert）。
 * 这两张表是统计/回放的“名册”，与实际运行的内存世界保持一致。由 WorldLoop 构造时
 * 与访客登录时调用；数据统计（/api/stats）据此解析居民名与对象。 */
export function hydrateWorld(db: DbHandle, world: WorldState): void {
  const upsertAgent = db.raw.prepare(
    `INSERT INTO agents(id, name, persona_json, home_object, state_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, persona_json = excluded.persona_json,
       home_object = excluded.home_object, state_json = excluded.state_json, updated_at = excluded.updated_at`
  );
  const now = Date.now();
  for (const a of world.allAgents()) {
    upsertAgent.run(a.id, a.name, JSON.stringify(a.persona), a.homeObjectId,
      JSON.stringify({ x: a.x, y: a.y, state: a.state, locationId: a.locationId }), now, now);
  }
  const upsertObject = db.raw.prepare(
    `INSERT INTO objects(id, parent_id, name, type, x, y, w, h, state_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, name = excluded.name,
       type = excluded.type, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
       state_json = excluded.state_json`
  );
  for (const o of world.allObjects()) {
    const objectState = {
      description: o.description ?? null,
      affordances: o.affordances ?? [],
      sensoryCues: o.sensoryCues ?? [],
      observationRadius: o.observationRadius ?? null,
      state: o.state ?? null,
    };
    upsertObject.run(o.id, o.parentId, o.name, o.type, o.x, o.y, o.w, o.h, JSON.stringify(objectState));
  }
  db.raw.prepare(
    `INSERT INTO world_meta(key, value) VALUES ('profile_set_hash', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(profileSetHash(world));
}

export const TOWN_OBJECTS: WorldObject[] = [
  { id: 'obj:town', name: '小镇', type: 'town', parentId: null, x: 0, y: 0, w: GRID_W, h: GRID_H },
  // 商业街
  { id: 'obj:cafe', name: '林间咖啡馆', type: 'building', parentId: 'obj:town', x: 8, y: 8, w: 4, h: 4 },
  { id: 'obj:cafe_counter', name: '咖啡馆吧台', type: 'room', parentId: 'obj:cafe', x: 9, y: 8, w: 2, h: 1 },
  { id: 'obj:cafe_table1', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 8, y: 9, w: 1, h: 1 },
  { id: 'obj:cafe_table2', name: '咖啡桌', type: 'furniture', parentId: 'obj:cafe', x: 11, y: 9, w: 1, h: 1 },
  { id: 'obj:bookstore', name: '默语书店', type: 'building', parentId: 'obj:town', x: 18, y: 8, w: 4, h: 4 },
  {
    id: 'obj:bookstore_counter', name: '书店柜台', type: 'room', parentId: 'obj:bookstore', x: 19, y: 8, w: 2, h: 1,
    description: '书店内用于整理书目、接待读者和围坐交流的木柜台。',
    affordances: [
      { verb: '整理书架', outcome: '让书目位置与借阅记录保持一致' },
      { verb: '参加读书会', outcome: '在实际到场后与其他读者讨论同一主题' },
    ],
    sensoryCues: ['纸页翻动的声音', '旧木书架与纸张的气味'], observationRadius: 4,
  },
  { id: 'obj:post_office', name: '小镇邮局', type: 'building', parentId: 'obj:town', x: 28, y: 8, w: 4, h: 4 },
  { id: 'obj:bakery', name: '晨光面包店', type: 'building', parentId: 'obj:town', x: 32, y: 18, w: 4, h: 4 },
  { id: 'obj:clinic', name: '小镇诊所', type: 'building', parentId: 'obj:town', x: 4, y: 18, w: 4, h: 4 },
  // 公共区域
  { id: 'obj:plaza', name: '中央广场', type: 'zone', parentId: 'obj:town', x: 18, y: 18, w: 6, h: 6 },
  { id: 'obj:park', name: '湖边公园', type: 'zone', parentId: 'obj:town', x: 6, y: 26, w: 10, h: 6 },
  {
    id: 'obj:lake', name: '湖边', type: 'zone', parentId: 'obj:town', x: 16, y: 28, w: 4, h: 2,
    description: '靠近码头的开阔湖岸，可供居民散步、观察水面或举行小型聚会。',
    affordances: [
      { verb: '沿湖散步', outcome: '观察天气、水面和附近居民的活动' },
      { verb: '参加湖边聚会', outcome: '实际到场后形成可被核验的共同活动' },
    ],
    sensoryCues: ['湖水拍岸声', '带着水汽的晚风'], observationRadius: 6,
  },
  { id: 'obj:park_easel', name: '公园画架', type: 'furniture', parentId: 'obj:park', x: 7, y: 27, w: 1, h: 1 },
  { id: 'obj:farm', name: '晨光农田', type: 'zone', parentId: 'obj:town', x: 24, y: 24, w: 8, h: 6 },
  { id: 'obj:path_main', name: '主街', type: 'zone', parentId: 'obj:town', x: 8, y: 16, w: 24, h: 2 },
  // 可感知、可交互的公共生活物件；动作会留下旁观记忆与关系证据。
  {
    id: 'obj:notice_board', name: '广场公告栏', type: 'furniture', parentId: 'obj:plaza', x: 18, y: 18, w: 1, h: 1,
    description: '贴着失物招领、活动预告和居民手写便笺的木制公告栏。',
    affordances: [
      { verb: '阅读公告', outcome: '知道近期活动、需求和失物信息' },
      { verb: '张贴便笺', outcome: '把一条公开信息留给后来者' },
    ],
    sensoryCues: ['纸张被风吹动的沙沙声', '墨水与旧木板的气味'], observationRadius: 6,
  },
  {
    id: 'obj:market_stall', name: '日常集市摊位', type: 'furniture', parentId: 'obj:plaza', x: 22, y: 18, w: 2, h: 1,
    description: '居民轮流摆放蔬果、面包和手作小物的公共摊位。',
    affordances: [
      { verb: '挑选日用品', outcome: '了解今天的供应与价格' },
      { verb: '帮忙整理摊位', outcome: '与摊主共同完成一件日常事务' },
      { verb: '询问货物来历', outcome: '听到关于生产者和邻里的消息' },
      { verb: '参加晚间集市', outcome: '实际到场后浏览摊位并形成共同活动记录' },
    ],
    sensoryCues: ['新鲜果蔬和烤面包的混合香气', '零钱与篮筐碰撞声'], observationRadius: 7,
  },
  {
    id: 'obj:plaza_fountain', name: '广场饮水泉', type: 'furniture', parentId: 'obj:plaza', x: 22, y: 21, w: 1, h: 1,
    description: '一座可以接水、洗手，也常让人停下脚步的小石泉。',
    affordances: [
      { verb: '接一杯水', outcome: '短暂恢复精力并留意周围动静' },
      { verb: '清理泉边落叶', outcome: '维护公共空间并被附近居民看见' },
    ],
    sensoryCues: ['细小而持续的流水声', '潮湿石面带来的清凉'], observationRadius: 5,
  },
  {
    id: 'obj:park_bench', name: '湖边长椅', type: 'furniture', parentId: 'obj:park', x: 14, y: 30, w: 2, h: 1,
    description: '朝向湖面的旧木长椅，扶手上留着多年的细小刻痕。',
    affordances: [
      { verb: '坐下观察湖面', outcome: '安静整理心绪并观察经过的人' },
      { verb: '与身边人分享长椅', outcome: '形成低压力的共处机会' },
    ],
    sensoryCues: ['湖风吹过树叶的声音', '木板被晒暖后的气味'], observationRadius: 5,
  },
  {
    id: 'obj:bird_feeder', name: '公园喂鸟台', type: 'furniture', parentId: 'obj:park', x: 11, y: 28, w: 1, h: 1,
    description: '挂着谷物盒和浅水碟的小喂鸟台，清晨常聚来麻雀。',
    affordances: [
      { verb: '补充鸟食', outcome: '照料公园里的小动物' },
      { verb: '观察鸟群', outcome: '记录天气、季节和鸟群反应' },
    ],
    sensoryCues: ['细碎的鸟鸣', '翅膀扑动和谷粒落盘声'], observationRadius: 5,
  },
  {
    id: 'obj:water_pump', name: '农田水泵', type: 'furniture', parentId: 'obj:town', x: 23, y: 26, w: 1, h: 1,
    description: '连接灌溉水渠的手压泵，农忙时需要居民轮流使用。',
    affordances: [
      { verb: '压水灌溉', outcome: '为农田或公共花圃补水' },
      { verb: '检查水泵', outcome: '发现漏水、异响或维护需求' },
    ],
    sensoryCues: ['金属把手的吱呀声', '水流冲进木桶的回响'], observationRadius: 7,
  },
  {
    id: 'obj:community_garden', name: '邻里共享菜园', type: 'furniture', parentId: 'obj:farm', x: 29, y: 27, w: 2, h: 2,
    description: '由居民共同认领小块土地、记录播种与收成的共享菜园。',
    affordances: [
      { verb: '查看幼苗', outcome: '判断土壤、虫害和生长情况' },
      { verb: '除草浇水', outcome: '为共同资源投入劳动' },
      { verb: '留下种植记录', outcome: '把经验传给下一位照料者' },
    ],
    sensoryCues: ['湿土和青草气味', '叶片摩擦与昆虫低鸣'], observationRadius: 7,
  },
  {
    id: 'obj:tool_rack', name: '公共工具架', type: 'furniture', parentId: 'obj:farm', x: 31, y: 24, w: 1, h: 1,
    description: '放着锄头、剪枝钳、麻绳和修补工具的借用架。',
    affordances: [
      { verb: '借用工具', outcome: '为接下来的劳动准备器具' },
      { verb: '归还并整理工具', outcome: '留下可靠、守序的公共行为记录' },
      { verb: '修理松动工具', outcome: '为其他居民减少使用风险' },
    ],
    sensoryCues: ['木柄和金属轻碰的声音', '机油与干草气味'], observationRadius: 6,
  },
  {
    id: 'obj:bus_stop', name: '主街候车亭', type: 'furniture', parentId: 'obj:path_main', x: 31, y: 16, w: 1, h: 2,
    description: '贴着时刻表和外镇消息的简朴候车亭，也是接送包裹的地点。',
    affordances: [
      { verb: '查看时刻表', outcome: '了解外镇交通和今日班次' },
      { verb: '等候班车', outcome: '观察来往旅客和新到货物' },
      { verb: '帮忙搬取包裹', outcome: '为邻里提供一次可见的工具性支持' },
    ],
    sensoryCues: ['远处车轮压过石路的声音', '纸质时刻表被风掀动'], observationRadius: 8,
  },
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
  // 扩容地形带（x≥40 或 y≥40，纯装饰/水域；果园树为 zone 不阻挡）
  { id: 'obj:orchard', name: '西坡果园', type: 'zone', parentId: 'obj:town', x: 40, y: 2, w: 8, h: 10 },
  { id: 'obj:forest_ne', name: '东山树林', type: 'zone', parentId: 'obj:town', x: 42, y: 14, w: 6, h: 8 },
  { id: 'obj:river', name: '小镇河', type: 'water', parentId: 'obj:town', x: 8, y: 40, w: 40, h: 4 },
  { id: 'obj:farm_east', name: '东侧农田', type: 'zone', parentId: 'obj:town', x: 40, y: 24, w: 8, h: 10 },
  { id: 'obj:meadow_s', name: '南坡草地', type: 'zone', parentId: 'obj:town', x: 0, y: 40, w: 8, h: 4 },
  // 路灯（夜间辉光渲染用；zone 1×1 不阻挡）
  { id: 'obj:lamp_plaza', name: '广场路灯', type: 'zone', parentId: 'obj:town', x: 17, y: 18, w: 1, h: 1 },
  { id: 'obj:lamp_street1', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 10, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_street2', name: '主街路灯', type: 'zone', parentId: 'obj:town', x: 29, y: 16, w: 1, h: 1 },
  { id: 'obj:lamp_lake', name: '湖边路灯', type: 'zone', parentId: 'obj:town', x: 16, y: 27, w: 1, h: 1 },
  // 白露花店 / 杂货店 / 湖边码头与装饰
  { id: 'obj:flower_shop', name: '白露花店', type: 'building', parentId: 'obj:town', x: 12, y: 18, w: 4, h: 4 },
  {
    id: 'obj:flower_counter', name: '花店服务台', type: 'room', parentId: 'obj:flower_shop', x: 13, y: 18, w: 2, h: 1,
    description: '花店处理选花、包装、订单与小镇内配送的服务台。',
    affordances: [
      { verb: '购买鲜花', outcome: '支付金币并把鲜花加入个人物品' },
      { verb: '委托送花', outcome: '生成可追溯订单并把花束配送给指定居民' },
    ],
    sensoryCues: ['剪枝与包装纸摩擦声', '新鲜花枝和湿润泥土的气味'], observationRadius: 4,
  },
  { id: 'obj:grocer', name: '小镇杂货店', type: 'building', parentId: 'obj:town', x: 24, y: 12, w: 4, h: 4 },
  { id: 'obj:pier', name: '湖边码头', type: 'zone', parentId: 'obj:town', x: 16, y: 26, w: 4, h: 2 },
  { id: 'obj:boat', name: '小船', type: 'furniture', parentId: 'obj:pier', x: 17, y: 27, w: 2, h: 1 },
  { id: 'obj:flowerbed', name: '广场花坛', type: 'zone', parentId: 'obj:town', x: 20, y: 20, w: 2, h: 2 },
  { id: 'obj:fence_lake', name: '湖边栅栏', type: 'zone', parentId: 'obj:town', x: 14, y: 26, w: 2, h: 1 },
  { id: 'obj:home_bailu', name: '白露的家', type: 'building', parentId: 'obj:town', x: 12, y: 34, w: 4, h: 4 },
  { id: 'obj:home_zhoulao', name: '老周的家', type: 'building', parentId: 'obj:town', x: 18, y: 34, w: 4, h: 4 },
  { id: 'obj:bed_bailu', name: '床', type: 'furniture', parentId: 'obj:home_bailu', x: 13, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_bailu', name: '沙发', type: 'furniture', parentId: 'obj:home_bailu', x: 12, y: 36, w: 2, h: 1 },
  { id: 'obj:bed_zhoulao', name: '床', type: 'furniture', parentId: 'obj:home_zhoulao', x: 19, y: 34, w: 1, h: 2 },
  { id: 'obj:sofa_zhoulao', name: '沙发', type: 'furniture', parentId: 'obj:home_zhoulao', x: 18, y: 36, w: 2, h: 1 },
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
    { from: 720, to: 780, type: 'interact', target: 'obj:cafe_table1', verb: '坐会儿歇歇脚' },
    { from: 1080, to: 1140, type: 'interact', target: 'obj:sofa_lin', verb: '坐在沙发上看小说笔记' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_lin', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_lin', verb: '睡觉' },
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
    { from: 1080, to: 1140, type: 'interact', target: 'obj:sofa_chen', verb: '在沙发上看书' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_chen', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_chen', verb: '睡觉' },
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
    { from: 480, to: 660, type: 'interact', target: 'obj:park_easel', verb: '在公园写生' },
    { from: 660, to: 780, type: 'interact', target: 'obj:cafe_table2', verb: '在咖啡馆喝咖啡画速写' },
    { from: 1020, to: 1080, type: 'interact', target: 'obj:sofa_shen', verb: '在沙发上小憩' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_shen', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_shen', verb: '睡觉' },
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
    { from: 660, to: 720, type: 'interact', target: 'obj:cafe_counter', verb: '到咖啡馆吧台送信' },
    { from: 900, to: 960, type: 'interact', target: 'obj:bookstore', verb: '到书店送信' },
    { from: 1140, to: 1200, type: 'interact', target: 'obj:sofa_zhou', verb: '在沙发上整理信件' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_zhou', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_zhou', verb: '睡觉' },
  ],
  greetingPool: ['有你的信吗？我帮你留意！', '早啊！今天也要加油。', '听说湖边傍晚特别好看。'],
  personality: { extraversion: 0.9, empathy: 0.8, honesty: 0.4, curiosity: 0.7, patience: 0.6 },
};

export const BAILU_PERSONA: Persona = {
  name: '白露', age: 26, occupation: '花店老板', gender: '女',
  appearance: { hairStyle: '丸子头', hairColor: '浅棕色', skinTone: '白皙', outfit: '浅绿围裙配白衬衫' },
  hobbies: ['园艺', '插花', '收集种子'],
  skills: { 插花: 9, 园艺: 8, 记账: 5, 聊天: 7 },
  values: ['每一束花都有收花人', '小镇值得被装点', '勤恳经营'],
  motivation: '把花店开成小镇最香的地方，让每一个路过的人都带一束花回家。',
  background: '从小在祖母的花圃里长大，三年前在小镇开了「白露花店」。她能记住每位客人的喜好，周岚送信路过时总爱顺一束花。最近她在湖边码头旁种了一片野花，说是要送给小镇的夏天。',
  traits: ['温柔', '勤快', '有点害羞'],
  goals: ['把花店经营成小镇的风景', '在湖边种满野花'],
  speechStyle: '轻声细语，爱聊花草',
  routine: [
    { from: 480, to: 720, type: 'interact', target: 'obj:flower_shop', verb: '在花店理花插花' },
    { from: 780, to: 840, type: 'interact', target: 'obj:park', verb: '到公园赏花' },
    { from: 1080, to: 1140, type: 'interact', target: 'obj:sofa_bailu', verb: '坐在沙发上看园艺书' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_bailu', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_bailu', verb: '睡觉' },
  ],
  greetingPool: ['今天的玫瑰开得正好。', '要带一束花回家吗？', '湖边那片野花快开了。'],
  personality: { extraversion: 0.6, empathy: 0.9, honesty: 0.9, curiosity: 0.6, patience: 0.8 },
};

export const ZHOU_LAO_PERSONA: Persona = {
  name: '老周', age: 60, occupation: '渔夫', gender: '男',
  appearance: { hairStyle: '花白短发', hairColor: '灰白色', skinTone: '古铜色', outfit: '旧渔夫背心配草帽' },
  hobbies: ['钓鱼', '讲古', '修船'],
  skills: { 钓鱼: 9, 讲古: 8, 修船: 7, 看天气: 8 },
  values: ['湖里永远有鱼', '年轻人多出去走走', '慢工出细活'],
  motivation: '每天在码头钓鱼，把小镇的老故事讲给愿意听的人。',
  background: '在湖边钓了一辈子鱼的老渔夫，认识小镇上每一个人，连每片水面的脾气都摸得清。他白天在码头钓鱼修船，傍晚爱到广场给年轻人讲小镇的老故事。他总说白露花店的那片野花，是他见过最像春天的东西。',
  traits: ['豁达', '爱讲故事', '慢性子'],
  goals: ['钓上湖里最大的鱼', '把小镇的老故事传下去'],
  speechStyle: '慢悠悠，爱用俗语',
  routine: [
    { from: 480, to: 660, type: 'interact', target: 'obj:pier', verb: '在码头钓鱼' },
    { from: 660, to: 780, type: 'interact', target: 'obj:boat', verb: '划船巡湖' },
    { from: 1140, to: 1200, type: 'interact', target: 'obj:plaza', verb: '在广场讲古' },
    { from: 1230, to: 1290, type: 'interact', target: 'obj:sofa_zhoulao', verb: '坐在沙发上打盹' },
    { from: 1320, to: 1440, type: 'interact', target: 'obj:bed_zhoulao', verb: '睡觉' },
    { from: 0, to: 420, type: 'interact', target: 'obj:bed_zhoulao', verb: '睡觉' },
  ],
  greetingPool: ['今天湖面风平浪静。', '年轻人，坐会儿听个故事？', '这天气，鱼都懒得上钩咯。'],
  personality: { extraversion: 0.7, empathy: 0.7, honesty: 0.9, curiosity: 0.5, patience: 0.9 },
};

const HOME_BY_NAME: Record<string, string> = {
  '林晚晴': 'obj:home_lin',
  '陈默': 'obj:home_chen',
  '沈屿': 'obj:home_shen',
  '周岚': 'obj:home_zhou',
  '白露': 'obj:home_bailu',
  '老周': 'obj:home_zhoulao',
};

export interface TownSeed {
  objects: WorldObject[];
  personas: Persona[];
}

export const DEFAULT_SEED: TownSeed = {
  objects: TOWN_OBJECTS,
  personas: [LIN_PERSONA, CHEN_PERSONA, SHEN_PERSONA, ZHOU_PERSONA, BAILU_PERSONA, ZHOU_LAO_PERSONA],
};

export function buildTown(seed: TownSeed = DEFAULT_SEED): WorldState {
  // 平行世界从同一份种子构造，但运行态对象必须完全独立，避免一个世界的
  // persona / routine / 地图对象变更通过共享引用影响另一个世界。
  const objects = seed.objects.map((object) => ({
    ...object,
    affordances: object.affordances?.map((affordance) => ({ ...affordance })),
    sensoryCues: object.sensoryCues ? [...object.sensoryCues] : undefined,
    state: object.state ? { ...object.state } : undefined,
  }));
  const personas = seed.personas.map((persona): Persona => ({
    ...persona,
    appearance: { ...persona.appearance },
    hobbies: [...persona.hobbies],
    skills: { ...persona.skills },
    values: [...persona.values],
    traits: [...persona.traits],
    goals: [...persona.goals],
    routine: persona.routine.map((slot) => ({ ...slot })),
    greetingPool: persona.greetingPool ? [...persona.greetingPool] : undefined,
    personality: persona.personality ? { ...persona.personality } : undefined,
    avatar: persona.avatar ? { ...persona.avatar } : undefined,
    initialState: persona.initialState ? { ...persona.initialState } : undefined,
  }));
  const agents: Agent[] = personas.map((p) => {
    const homeId = HOME_BY_NAME[p.name];
    if (!homeId) throw new Error(`persona 没有对应住宅: ${p.name}`);
    const home = objects.find((o) => o.id === homeId);
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
  return new WorldState(objects, agents);
}

/** 协议访客：外部 AI 通过 town-agent CLI 驱动的临时角色（无作息，指令驱动） */
export function createGuestAgent(name: string): Agent {
  return {
    id: `agent:${name}`,
    name,
    persona: {
      name,
      age: 25,
      occupation: '访客',
      gender: '男',
      appearance: { hairStyle: '短发', hairColor: '黑色', skinTone: '浅麦色', outfit: '旅行者外套' },
      hobbies: ['漫游'],
      skills: {},
      values: ['友善'],
      motivation: '',
      background: '一位刚刚来到小镇的旅人。',
      traits: [],
      goals: [],
      speechStyle: '简短的招呼',
      routine: [],
      greetingPool: ['你好呀。', '镇上的人真热心。', '这里真不错。'],
      personality: { extraversion: 0.6, empathy: 0.6, honesty: 0.7, curiosity: 0.7, patience: 0.6 },
    },
    homeObjectId: 'obj:town',
    state: 'idle',
    locationId: 'obj:plaza',
    x: 22, y: 22, path: [], pathProgress: 0,
    action: null, actionEndsAt: 0, lastDecisionAt: 0, thought: null,
  };
}
