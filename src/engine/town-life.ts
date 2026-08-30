// 小镇日常生活层：物件状态变化 → 距离约束的感官事件 → 居民观察记忆。

import { randomUUID } from 'node:crypto';
import { MINUTES_PER_DAY } from '../core/time';
import type { WorldState } from '../core/world';
import type { EventLog } from '../store/events';

export type TownLifeCategory = 'nature' | 'commerce' | 'care' | 'infrastructure' | 'neighborhood';

export interface TownLifeEventDefinition {
  id: string;
  minuteOfDay: number;
  objectId: string;
  category: TownLifeCategory;
  icon: string;
  stateLabel: string;
  description: string;
  sensoryCues: string[];
  radius: number;
  stateDurationMinutes: number;
}

/** 每个时段按天轮换一项，使世界有规律但不会每天机械重复。 */
export const TOWN_LIFE_SLOTS: readonly (readonly TownLifeEventDefinition[])[] = [
  [
    {
      id: 'sparrows-arrive', minuteOfDay: 420, objectId: 'obj:bird_feeder', category: 'nature', icon: '🐦',
      stateLabel: '鸟群聚集', description: '一群麻雀落在公园喂鸟台周围，争抢谷粒又警觉地观察行人。',
      sensoryCues: ['密集而短促的鸟鸣', '谷粒落在木盘上的细响'], radius: 6, stateDurationMinutes: 90,
    },
    {
      id: 'morning-bus', minuteOfDay: 430, objectId: 'obj:bus_stop', category: 'infrastructure', icon: '🚌',
      stateLabel: '早班车到站', description: '早班车在主街候车亭短暂停靠，带来报纸、包裹和几张陌生面孔。',
      sensoryCues: ['车轮压过石路的声音', '纸箱和车门碰撞声'], radius: 9, stateDurationMinutes: 60,
    },
    {
      id: 'pump-first-use', minuteOfDay: 410, objectId: 'obj:water_pump', category: 'infrastructure', icon: '💧',
      stateLabel: '清晨取水', description: '农田水泵被清晨第一位使用者压动，清水沿着水渠流向干燥的土垄。',
      sensoryCues: ['规律的金属吱呀声', '清水冲进沟渠的回响'], radius: 8, stateDurationMinutes: 100,
    },
  ],
  [
    {
      id: 'market-restock', minuteOfDay: 720, objectId: 'obj:market_stall', category: 'commerce', icon: '🧺',
      stateLabel: '午间补货', description: '日常集市摊位摆上了新鲜蔬果和刚出炉的面包，价格牌旁多了一篮可以交换的旧物。',
      sensoryCues: ['果蔬和麦香混在一起', '篮筐、零钱和问价声'], radius: 8, stateDurationMinutes: 150,
    },
    {
      id: 'fountain-leaves', minuteOfDay: 735, objectId: 'obj:plaza_fountain', category: 'care', icon: '⛲',
      stateLabel: '落叶积在泉边', description: '风把几片落叶吹进饮水泉的浅池，水流仍在石沿间发出清亮声响。',
      sensoryCues: ['持续的流水声', '湿叶贴在石面上的气味'], radius: 6, stateDurationMinutes: 120,
    },
    {
      id: 'new-notice', minuteOfDay: 710, objectId: 'obj:notice_board', category: 'neighborhood', icon: '📌',
      stateLabel: '出现新便笺', description: '公告栏上多了一张手写便笺：有人想借一把梯子，也有人在寻找一条蓝色围巾。',
      sensoryCues: ['纸角被风掀动的沙沙声', '尚未干透的墨水气味'], radius: 7, stateDurationMinutes: 240,
    },
  ],
  [
    {
      id: 'garden-dry-soil', minuteOfDay: 930, objectId: 'obj:community_garden', category: 'care', icon: '🌱',
      stateLabel: '菜园需要照料', description: '邻里共享菜园有一角土壤发白，几株幼苗微微低垂，木牌上的浇水记录还停在昨天。',
      sensoryCues: ['晒热的干土气味', '叶片在风里轻轻摩擦'], radius: 8, stateDurationMinutes: 180,
    },
    {
      id: 'tools-left-out', minuteOfDay: 945, objectId: 'obj:tool_rack', category: 'neighborhood', icon: '🧰',
      stateLabel: '工具待整理', description: '公共工具架旁留着一把沾泥的锄头，借用木牌没有写归还人的名字。',
      sensoryCues: ['金属轻碰木架的声音', '泥土与机油混合的气味'], radius: 7, stateDurationMinutes: 180,
    },
    {
      id: 'parcel-arrival', minuteOfDay: 920, objectId: 'obj:bus_stop', category: 'commerce', icon: '📦',
      stateLabel: '外镇包裹到达', description: '候车亭边新到了一批外镇包裹，其中一个纸箱写着“易碎”，正等人来认领。',
      sensoryCues: ['麻绳摩擦纸箱的声音', '班车远去后的尘土气味'], radius: 9, stateDurationMinutes: 150,
    },
  ],
  [
    {
      id: 'lake-evening', minuteOfDay: 1110, objectId: 'obj:park_bench', category: 'nature', icon: '🌆',
      stateLabel: '晚风正好', description: '傍晚的湖风吹到长椅边，水面映出橙色天光，路过的人不自觉放慢脚步。',
      sensoryCues: ['湖水拍岸和树叶摇动声', '逐渐变凉的潮湿空气'], radius: 7, stateDurationMinutes: 120,
    },
    {
      id: 'fountain-gathering', minuteOfDay: 1095, objectId: 'obj:plaza_fountain', category: 'neighborhood', icon: '💬',
      stateLabel: '泉边有人停留', description: '傍晚有人在饮水泉边停下接水，零散的招呼声让广场显得比平时热闹。',
      sensoryCues: ['流水声间夹着简短招呼', '杯子碰到石沿的轻响'], radius: 7, stateDurationMinutes: 100,
    },
    {
      id: 'stall-closing', minuteOfDay: 1125, objectId: 'obj:market_stall', category: 'commerce', icon: '🧹',
      stateLabel: '摊位准备收档', description: '集市摊位开始收档，还剩几篮未卖完的蔬菜和需要归还的空筐。',
      sensoryCues: ['篷布折叠和木筐叠放声', '蔬菜叶与干草的气味'], radius: 8, stateDurationMinutes: 90,
    },
  ],
] as const;

export class TownLifeEngine {
  private fired = new Set<string>();

  constructor(private log: EventLog) {}

  tick(world: WorldState, dt: number, now: number): void {
    const previous = now - Math.max(1, dt);
    const firstDay = Math.max(1, Math.floor(Math.max(0, previous) / MINUTES_PER_DAY) + 1);
    const lastDay = Math.floor(now / MINUTES_PER_DAY) + 1;
    for (let day = firstDay; day <= lastDay; day++) {
      TOWN_LIFE_SLOTS.forEach((variants, slotIndex) => {
        const definition = variants[(day - 1 + slotIndex) % variants.length];
        const boundary = (day - 1) * MINUTES_PER_DAY + definition.minuteOfDay;
        if (boundary <= previous || boundary > now) return;
        const key = `${day}:${definition.id}`;
        if (this.fired.has(key)) return;
        this.fired.add(key);
        this.fire(world, definition, day, boundary);
      });
    }
    this.clearExpiredStates(world, now);
    if (this.fired.size > 64) {
      const oldestDayToKeep = Math.max(1, lastDay - 7);
      this.fired = new Set([...this.fired].filter((key) => Number(key.split(':', 1)[0]) >= oldestDayToKeep));
    }
  }

  private fire(world: WorldState, definition: TownLifeEventDefinition, day: number, now: number): void {
    const object = world.getObject(definition.objectId);
    if (!object) return;
    const center = world.centerOf(object);
    const observers = world.allAgents().filter((agent) => (
      Math.abs(agent.x - center.x) + Math.abs(agent.y - center.y) <= definition.radius
    ));
    const sensoryCues = [...new Set([...(object.sensoryCues ?? []), ...definition.sensoryCues])];
    object.state = {
      label: definition.stateLabel,
      detail: definition.description,
      updatedGameTime: now,
      expiresGameTime: now + definition.stateDurationMinutes,
    };
    this.log.addEvent({
      id: randomUUID(),
      type: 'broadcast',
      actorId: null,
      targetIds: observers.map((agent) => agent.id),
      description: definition.description,
      location: object.id,
      gameTime: now,
      payload: {
        kind: 'ambient_life',
        lifeEventId: definition.id,
        category: definition.category,
        icon: definition.icon,
        objectId: object.id,
        objectName: object.name,
        sensoryCues,
        perceptionRadius: definition.radius,
        observerIds: observers.map((agent) => agent.id),
        memoryAgentIds: observers.map((agent) => agent.id),
        day,
        source: 'simulation',
      },
    });
  }

  private clearExpiredStates(world: WorldState, now: number): void {
    for (const object of world.allObjects()) {
      if (object.state && object.state.expiresGameTime <= now) object.state = undefined;
    }
  }
}
