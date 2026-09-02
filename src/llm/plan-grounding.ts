import type { Agent, WorldObject } from '../core/types';
import type { WorldState } from '../core/world';
import type { AgendaItem } from '../store/memory';

export interface PlanningResident {
  id: string;
  name: string;
}

export interface PlanningPlace {
  id: string;
  name: string;
  availableActions: string[];
}

export interface PlanningWorldContext {
  residents: PlanningResident[];
  places: PlanningPlace[];
}

export type GroundingIssueCode =
  | 'empty_narrative'
  | 'internal_term'
  | 'unknown_object'
  | 'unknown_resident'
  | 'invalid_agenda'
  | 'wrong_hour'
  | 'duplicate_time'
  | 'unknown_location';

export interface GroundingIssue {
  code: GroundingIssueCode;
  message: string;
}

export interface GroundingAssessment<T> {
  ok: boolean;
  value: T;
  issues: GroundingIssue[];
}

const INTERNAL_NARRATIVE = /\b(?:affordances?|available_actions?|interactionverbs?|target[_ ]?id|object[_ ]?id|validator|schema|json)\b|对象\s*ID|校验器|允许交互动词|唯一允许|必须使用该动词/iu;
const OBJECT_ID = /obj:[\p{L}\p{N}_:-]+/giu;
const GENERIC_PEOPLE = new Set([
  '客人', '顾客', '老人', '年轻人', '朋友', '邻居', '居民', '同事', '路人', '学生', '孩子', '家人',
]);

export function planningContextFromWorld(world: WorldState): PlanningWorldContext {
  return {
    residents: world.allAgents().map((resident) => ({ id: resident.id, name: resident.name })),
    places: world.allObjects().map(toPlanningPlace),
  };
}

function toPlanningPlace(object: WorldObject): PlanningPlace {
  return {
    id: object.id,
    name: object.name,
    availableActions: object.affordances?.map((item) => item.verb.trim()).filter(Boolean) ?? [],
  };
}

export function assessNarrative(
  raw: unknown,
  context: PlanningWorldContext,
): GroundingAssessment<string> {
  const value = typeof raw === 'string' ? raw.trim().slice(0, 300) : '';
  const issues: GroundingIssue[] = [];
  if (!value) issues.push({ code: 'empty_narrative', message: '内容为空' });
  if (INTERNAL_NARRATIVE.test(value)) {
    issues.push({ code: 'internal_term', message: '内容包含面向程序的内部说明' });
  }
  const knownObjects = new Set(context.places.map((place) => place.id));
  for (const objectId of value.match(OBJECT_ID) ?? []) {
    if (!knownObjects.has(objectId)) {
      issues.push({ code: 'unknown_object', message: `地点「${objectId}」不在当前小镇中` });
    } else {
      issues.push({ code: 'internal_term', message: '叙事内容应使用地点名称，不直接引用程序地点编号' });
    }
  }
  const knownResidents = new Set(context.residents.map((resident) => resident.name));
  if (knownResidents.size > 0) {
    for (const name of socialResidentMentions(value)) {
      if (!knownResidents.has(name) && !GENERIC_PEOPLE.has(name)) {
        issues.push({ code: 'unknown_resident', message: `居民「${name}」不在当前名册中` });
      }
    }
  }
  return { ok: issues.length === 0, value, issues: uniqueIssues(issues) };
}

export function assessDailyPlan(raw: unknown, context: PlanningWorldContext): GroundingAssessment<string> {
  return assessNarrative(raw, context);
}

export function assessHourAgenda(
  raw: unknown,
  hour: number,
  context: PlanningWorldContext,
): GroundingAssessment<AgendaItem[]> {
  const issues: GroundingIssue[] = [];
  if (!Array.isArray(raw) || raw.length === 0) {
    return {
      ok: false,
      value: [],
      issues: [{ code: 'invalid_agenda', message: '小时安排至少需要一项具体行动' }],
    };
  }
  const result: AgendaItem[] = [];
  const times = new Set<string>();
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      issues.push({ code: 'invalid_agenda', message: '小时安排中有一项结构不完整' });
      continue;
    }
    const record = item as Record<string, unknown>;
    const time = typeof record.time === 'string' ? record.time.trim() : '';
    const actionAssessment = assessNarrative(record.action, context);
    issues.push(...actionAssessment.issues);
    const timeValid = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time);
    if (!timeValid) {
      issues.push({ code: 'invalid_agenda', message: `时间「${time || '空'}」格式无效` });
    }
    const hourValid = timeValid && Number(time.slice(0, 2)) === hour;
    if (timeValid && !hourValid) {
      issues.push({ code: 'wrong_hour', message: `时间「${time}」不属于第 ${hour} 点` });
    }
    const duplicate = timeValid && times.has(time);
    if (duplicate) {
      issues.push({ code: 'duplicate_time', message: `时间「${time}」重复` });
    }
    if (timeValid) times.add(time);
    const location = normalizeLocation(record.location, context);
    if (!location) {
      issues.push({
        code: 'unknown_location',
        message: `地点「${typeof record.location === 'string' ? record.location.trim() : '空'}」不在当前小镇中或名字不唯一`,
      });
    }
    if (timeValid && hourValid && !duplicate && location && actionAssessment.ok) {
      result.push({ time, action: actionAssessment.value.slice(0, 60), location });
    }
  }
  return { ok: issues.length === 0 && result.length > 0, value: result, issues: uniqueIssues(issues) };
}

export function groundedDailyFallback(agent: Agent, context: PlanningWorldContext): string {
  const knownPlaces = new Set(context.places.map((place) => place.id));
  const routines = agent.persona.routine.filter((slot) => slot.target && knownPlaces.has(slot.target));
  if (routines.length === 0) return '今天按自己的生活节奏处理日常事务，留意周围变化，并安排适当休息。';
  const summary = routines.slice(0, 3).map((slot) => {
    const place = context.places.find((candidate) => candidate.id === slot.target)?.name ?? '熟悉的地方';
    return `在${place}${slot.verb}`;
  });
  return `今天先按平时作息${summary.join('，然后')}。其余时间留意周围变化，并安排适当休息。`;
}

export function groundedHourFallback(
  agent: Agent,
  hour: number,
  context: PlanningWorldContext,
): AgendaItem[] {
  const start = hour * 60;
  const end = start + 60;
  const knownPlaces = new Set(context.places.map((place) => place.id));
  const routines = agent.persona.routine.filter((slot) => (
    slot.target && knownPlaces.has(slot.target) && slot.from < end && slot.to > start
  ));
  const chosen = routines.slice(0, 4).map((slot, index) => ({
    time: hhmm(Math.min(end - 1, Math.max(start + index * 5, slot.from))),
    action: slot.verb.trim() || '处理日常事务',
    location: slot.target!,
  }));
  if (chosen.length > 0) return chosen;
  const location = [agent.locationId, agent.homeObjectId, context.places[0]?.id]
    .find((id): id is string => typeof id === 'string' && knownPlaces.has(id));
  if (!location) return [];
  return [{ time: hhmm(start), action: '整理当前事务并观察周围情况', location }];
}

export function planningRepairInstruction(
  issues: readonly GroundingIssue[],
  context: PlanningWorldContext,
  kind: 'daily' | 'hour',
  hour?: number,
): string {
  const residents = context.residents.map((resident) => resident.name).join('、') || '暂无其他居民';
  const places = context.places.map((place) => `${place.name}（${place.id}）`).join('、') || '暂无地点';
  const problem = issues.map((issue) => issue.message).join('；') || '内容没有通过现实边界检查';
  const task = kind === 'daily'
    ? '请重新给出今天的大计划。'
    : `请重新给出第 ${hour} 点这一小时的安排，每个时间都应以 ${String(hour).padStart(2, '0')}: 开头。`;
  return `${task}\n上一版的问题：${problem}\n当前居民只有：${residents}\n当前地点只有：${places}\n只引用这些居民和地点，使用居民日常会说的自然语言，不要解释检查过程。`;
}

function normalizeLocation(raw: unknown, context: PlanningWorldContext): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const exactId = context.places.find((place) => place.id === value);
  if (exactId) return exactId.id;
  const byName = context.places.filter((place) => place.name === value);
  return byName.length === 1 ? byName[0].id : null;
}

function socialResidentMentions(text: string): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:与|和|跟|向|给)([\p{Script=Han}]{2,3}?)(?=一起|一同|交流|聊天|见面|散步|吃饭|喝咖啡|商量|道谢|问候|分享|确认|，|。|；|、|$)/gu,
    /(?:邀请|拜访|联系|寻找|看望|询问|告诉|陪伴)([\p{Script=Han}]{2,3}?)(?=一起|交流|聊天|见面|散步|吃饭|喝咖啡|商量|道谢|问候|分享|确认|，|。|；|、|$)/gu,
    /(?:为|给)?(?:一位)?常客([\p{Script=Han}]{2,3}?)(?=和|与|跟|、|一起|交流|聊天|见面|续|准备|点单|，|。|；|$)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) names.push(match[1]);
  }
  return [...new Set(names)];
}

function uniqueIssues(issues: GroundingIssue[]): GroundingIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hhmm(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
