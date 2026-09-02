import { createHash } from 'node:crypto';
import type { Agent } from '../core/types';
import type { WorldState } from '../core/world';
import type { AgendaItem } from '../store/memory';

export type PlanningOptionKind = 'routine' | 'place_action' | 'observe' | 'rest' | 'social';

export interface PlanningOption {
  id: string;
  kind: PlanningOptionKind;
  actorId: string;
  locationId: string;
  verb: string;
  counterpartId: string | null;
  fromMinute: number | null;
  toMinute: number | null;
  label: string;
}

export interface HourOptionChoice {
  time: string;
  optionId: string;
}

export interface PlanningContractIssue {
  code: 'invalid_structure' | 'unknown_option' | 'duplicate_option' | 'wrong_actor' | 'wrong_hour';
  message: string;
}

export interface PlanningContractAssessment<T> {
  ok: boolean;
  value: T;
  issues: PlanningContractIssue[];
}

const EVENT_ATTENDANCE = /(?:参加|参与|出席).*(?:派对|读书会|集市|活动|展|聚会)/;

export function buildPlanningOptions(agent: Agent, world: WorldState): PlanningOption[] {
  const candidates: Omit<PlanningOption, 'id' | 'label'>[] = [];
  const knownPlaces = new Set(world.allObjects().map((object) => object.id));
  for (const slot of agent.persona.routine) {
    if (!slot.target || !knownPlaces.has(slot.target) || EVENT_ATTENDANCE.test(slot.verb)) continue;
    candidates.push({
      kind: 'routine', actorId: agent.id, locationId: slot.target, verb: slot.verb.trim(), counterpartId: null,
      fromMinute: slot.from, toMinute: slot.to,
    });
  }
  for (const object of world.allObjects()) {
    for (const affordance of object.affordances ?? []) {
      const verb = affordance.verb.trim();
      if (!verb || EVENT_ATTENDANCE.test(verb)) continue;
      candidates.push({
        kind: 'place_action', actorId: agent.id, locationId: object.id, verb, counterpartId: null,
        fromMinute: null, toMinute: null,
      });
    }
  }
  const observationPlaces = new Set<string>([
    agent.locationId,
    agent.homeObjectId,
    ...agent.persona.routine.map((slot) => slot.target).filter((target): target is string => !!target),
    ...world.allObjects().filter((object) => object.affordances?.length).map((object) => object.id),
  ]);
  for (const locationId of observationPlaces) {
    if (!knownPlaces.has(locationId)) continue;
    candidates.push({
      kind: 'observe', actorId: agent.id, locationId, verb: '观察周围情况', counterpartId: null,
      fromMinute: null, toMinute: null,
    });
  }
  for (const locationId of new Set([agent.locationId, agent.homeObjectId])) {
    if (!knownPlaces.has(locationId)) continue;
    candidates.push({
      kind: 'rest', actorId: agent.id, locationId, verb: '短暂休息', counterpartId: null,
      fromMinute: null, toMinute: null,
    });
  }
  for (const resident of world.allAgents()) {
    if (resident.id === agent.id || !knownPlaces.has(resident.locationId)) continue;
    for (const verb of [`与${resident.name}当面问候`, `与${resident.name}交流近况`]) {
      candidates.push({
        kind: 'social', actorId: agent.id, locationId: resident.locationId, verb, counterpartId: resident.id,
        fromMinute: null, toMinute: null,
      });
    }
  }

  const unique = new Map<string, Omit<PlanningOption, 'id' | 'label'>>();
  for (const candidate of candidates) {
    if (!candidate.verb) continue;
    const key = canonicalKey(candidate);
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return [...unique.entries()]
    .sort(([, left], [, right]) => compareOptions(left, right))
    .map(([key, candidate]) => {
      const place = world.getObject(candidate.locationId);
      const counterpart = candidate.counterpartId ? world.getAgent(candidate.counterpartId) : null;
      return {
        ...candidate,
        id: `plan:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        label: `去「${place?.name ?? candidate.locationId}」，准备“${candidate.verb}”${counterpart ? `（由${agent.name}主动联系${counterpart.name}）` : ''}`,
      };
    });
}

export function isEventAttendanceVerb(verb: string): boolean {
  return EVENT_ATTENDANCE.test(verb);
}

export function dailyPlanningOptionPool(
  options: readonly PlanningOption[],
  agent: Agent,
  limit = 18,
): PlanningOption[] {
  const routinePlaces = new Set([
    agent.locationId, agent.homeObjectId,
    ...agent.persona.routine.map((slot) => slot.target).filter((target): target is string => !!target),
  ]);
  return boundedOptions(options, limit, [
    (option) => option.kind === 'routine',
    (option) => option.kind === 'place_action' && routinePlaces.has(option.locationId),
    (option) => (option.kind === 'observe' || option.kind === 'rest') && routinePlaces.has(option.locationId),
    (option) => option.kind === 'social',
    (option) => option.kind === 'place_action',
    (option) => option.kind === 'observe' || option.kind === 'rest',
  ]);
}

export function hourPlanningOptionPool(
  options: readonly PlanningOption[],
  agent: Agent,
  hour: number,
  limit = 14,
): PlanningOption[] {
  const hourStart = hour * 60;
  const hourEnd = hourStart + 60;
  const relevantPlaces = new Set([agent.locationId, agent.homeObjectId]);
  for (const option of options) {
    if (option.kind === 'routine' && option.fromMinute !== null && option.toMinute !== null
        && option.fromMinute < hourEnd && option.toMinute > hourStart) relevantPlaces.add(option.locationId);
  }
  return boundedOptions(options, limit, [
    (option) => option.kind === 'routine' && option.fromMinute !== null && option.toMinute !== null
      && option.fromMinute < hourEnd && option.toMinute > hourStart,
    (option) => option.kind === 'place_action' && relevantPlaces.has(option.locationId),
    (option) => (option.kind === 'observe' || option.kind === 'rest') && relevantPlaces.has(option.locationId),
    (option) => option.kind === 'social',
    (option) => option.kind === 'routine',
    (option) => option.kind === 'place_action',
    (option) => option.kind === 'observe' || option.kind === 'rest',
  ]);
}

export function assessDailyOptionSelection(
  raw: unknown,
  options: readonly PlanningOption[],
  actorId: string,
): PlanningContractAssessment<PlanningOption[]> {
  const issues: PlanningContractIssue[] = [];
  if (!isExactRecord(raw, ['option_ids'])) {
    return failSelection('日计划必须只包含 option_ids', []);
  }
  const ids = (raw as { option_ids?: unknown }).option_ids;
  if (!Array.isArray(ids) || ids.length < 3 || ids.length > 5 || ids.some((id) => typeof id !== 'string')) {
    return failSelection('日计划必须选择 3 至 5 个选项 id', []);
  }
  const byId = new Map(options.map((option) => [option.id, option]));
  const selected: PlanningOption[] = [];
  const seen = new Set<string>();
  for (const id of ids as string[]) {
    if (seen.has(id)) {
      issues.push({ code: 'duplicate_option', message: `选项「${id}」重复` });
      continue;
    }
    seen.add(id);
    const option = byId.get(id);
    if (!option) {
      issues.push({ code: 'unknown_option', message: `选项「${id}」不属于当前世界` });
      continue;
    }
    if (option.actorId !== actorId) {
      issues.push({ code: 'wrong_actor', message: `选项「${id}」不属于当前居民` });
      continue;
    }
    selected.push(option);
  }
  return { ok: issues.length === 0 && selected.length === ids.length, value: selected, issues };
}

export function assessHourOptionSelection(
  raw: unknown,
  hour: number,
  options: readonly PlanningOption[],
  actorId: string,
): PlanningContractAssessment<HourOptionChoice[]> {
  if (!isExactRecord(raw, ['agenda'])) return failSelection('小时计划必须只包含 agenda', []);
  const agenda = (raw as { agenda?: unknown }).agenda;
  if (!Array.isArray(agenda) || agenda.length < 1 || agenda.length > 4) {
    return failSelection('小时计划必须包含 1 至 4 项', []);
  }
  const issues: PlanningContractIssue[] = [];
  const selected: HourOptionChoice[] = [];
  const byId = new Map(options.map((option) => [option.id, option]));
  const times = new Set<string>();
  const ids = new Set<string>();
  for (const item of agenda) {
    if (!isExactRecord(item, ['time', 'option_id'])) {
      issues.push({ code: 'invalid_structure', message: '小时条目只能包含 time 与 option_id' });
      continue;
    }
    const time = (item as { time?: unknown }).time;
    const optionId = (item as { option_id?: unknown }).option_id;
    if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      issues.push({ code: 'invalid_structure', message: `时间「${String(time)}」格式无效` });
      continue;
    }
    if (Number(time.slice(0, 2)) !== hour) {
      issues.push({ code: 'wrong_hour', message: `时间「${time}」不属于第 ${hour} 点` });
      continue;
    }
    if (times.has(time)) {
      issues.push({ code: 'duplicate_option', message: `时间「${time}」重复` });
      continue;
    }
    times.add(time);
    if (typeof optionId !== 'string') {
      issues.push({ code: 'invalid_structure', message: '小时条目缺少选项 id' });
      continue;
    }
    if (ids.has(optionId)) {
      issues.push({ code: 'duplicate_option', message: `选项「${optionId}」重复` });
      continue;
    }
    ids.add(optionId);
    const option = byId.get(optionId);
    if (!option) {
      issues.push({ code: 'unknown_option', message: `选项「${optionId}」不属于当前世界` });
      continue;
    }
    if (option.actorId !== actorId) {
      issues.push({ code: 'wrong_actor', message: `选项「${optionId}」不属于当前居民` });
      continue;
    }
    selected.push({ time, optionId });
  }
  return { ok: issues.length === 0 && selected.length === agenda.length, value: selected, issues };
}

export function renderDailyPlan(options: readonly PlanningOption[], world: WorldState): string {
  return `今天打算按顺序完成这些安排：${options.map((option) => renderClause(option, world)).join('；')}。`;
}

export function renderHourAgenda(
  choices: readonly HourOptionChoice[],
  options: readonly PlanningOption[],
): AgendaItem[] {
  const byId = new Map(options.map((option) => [option.id, option]));
  return choices.map((choice) => {
    const option = byId.get(choice.optionId);
    if (!option) throw new Error(`计划选项已失效：${choice.optionId}`);
    return { time: choice.time, action: option.verb, location: option.locationId };
  });
}

export function fallbackDailyOptions(options: readonly PlanningOption[], actorId: string): PlanningOption[] {
  const owned = options.filter((option) => option.actorId === actorId);
  const priority: PlanningOptionKind[] = ['routine', 'place_action', 'observe', 'rest', 'social'];
  const selected: PlanningOption[] = [];
  for (const kind of priority) {
    for (const option of owned.filter((candidate) => candidate.kind === kind)) {
      if (selected.length >= 5) break;
      selected.push(option);
    }
    if (selected.length >= 3) break;
  }
  return selected.slice(0, 5);
}

export function fallbackHourChoices(
  options: readonly PlanningOption[],
  actorId: string,
  hour: number,
): HourOptionChoice[] {
  const hourStart = hour * 60;
  const hourEnd = hourStart + 60;
  const owned = options.filter((option) => option.actorId === actorId);
  const option = owned.find((candidate) => (
    candidate.kind === 'routine'
    && candidate.fromMinute !== null && candidate.toMinute !== null
    && candidate.fromMinute < hourEnd && candidate.toMinute > hourStart
  )) ?? owned.find((candidate) => candidate.kind === 'observe')
    ?? owned.find((candidate) => candidate.kind === 'rest')
    ?? owned[0];
  return option ? [{ time: `${String(hour).padStart(2, '0')}:00`, optionId: option.id }] : [];
}

export function auditRenderedDailyPlan(
  broadPlan: string,
  options: readonly PlanningOption[],
  world: WorldState,
): PlanningContractAssessment<PlanningOption[]> {
  const prefix = '今天打算按顺序完成这些安排：';
  if (!broadPlan.startsWith(prefix) || !broadPlan.endsWith('。')) {
    return failSelection('日计划不是选项渲染器生成的文本', []);
  }
  const clauses = broadPlan.slice(prefix.length, -1).split('；').filter(Boolean);
  const byClause = new Map(options.map((option) => [renderClause(option, world), option]));
  const selected = clauses.map((clause) => byClause.get(clause));
  if (clauses.length < 3 || clauses.length > 5 || selected.some((option) => !option)) {
    return failSelection('日计划无法还原为 3 至 5 个当前选项', selected.filter((option): option is PlanningOption => !!option));
  }
  const unique = new Set(selected.map((option) => option!.id));
  if (unique.size !== selected.length) return failSelection('日计划包含重复选项', selected as PlanningOption[]);
  return { ok: true, value: selected as PlanningOption[], issues: [] };
}

export function auditRenderedHourAgenda(
  agenda: readonly AgendaItem[],
  hour: number,
  options: readonly PlanningOption[],
): PlanningContractAssessment<PlanningOption[]> {
  const issues: PlanningContractIssue[] = [];
  const selected: PlanningOption[] = [];
  const times = new Set<string>();
  for (const item of agenda) {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time) || Number(item.time.slice(0, 2)) !== hour) {
      issues.push({ code: 'wrong_hour', message: `时间「${item.time}」不属于第 ${hour} 点` });
      continue;
    }
    if (times.has(item.time)) {
      issues.push({ code: 'duplicate_option', message: `时间「${item.time}」重复` });
      continue;
    }
    times.add(item.time);
    const matches = options.filter((option) => option.locationId === item.location && option.verb === item.action);
    if (matches.length !== 1) {
      issues.push({ code: 'unknown_option', message: `「${item.action} @ ${item.location}」不是当前居民的唯一计划选项` });
      continue;
    }
    selected.push(matches[0]);
  }
  return { ok: issues.length === 0 && selected.length === agenda.length && agenda.length > 0, value: selected, issues };
}

function renderClause(option: PlanningOption, world: WorldState): string {
  const place = world.getObject(option.locationId)?.name ?? option.locationId;
  return `去「${place}」，准备“${option.verb}”`;
}

function canonicalKey(option: Omit<PlanningOption, 'id' | 'label'>): string {
  return JSON.stringify([
    option.actorId, option.locationId, option.verb, option.counterpartId,
  ]);
}

function compareOptions(
  left: Omit<PlanningOption, 'id' | 'label'>,
  right: Omit<PlanningOption, 'id' | 'label'>,
): number {
  const priority: Record<PlanningOptionKind, number> = { routine: 0, place_action: 1, observe: 2, rest: 3, social: 4 };
  return priority[left.kind] - priority[right.kind]
    || (left.fromMinute ?? Number.MAX_SAFE_INTEGER) - (right.fromMinute ?? Number.MAX_SAFE_INTEGER)
    || left.locationId.localeCompare(right.locationId)
    || left.verb.localeCompare(right.verb);
}

function boundedOptions(
  options: readonly PlanningOption[],
  limit: number,
  predicates: readonly ((option: PlanningOption) => boolean)[],
): PlanningOption[] {
  const selected: PlanningOption[] = [];
  const ids = new Set<string>();
  for (const predicate of predicates) {
    for (const option of options) {
      if (selected.length >= limit) return selected;
      if (ids.has(option.id) || !predicate(option)) continue;
      selected.push(option);
      ids.add(option.id);
    }
  }
  return selected;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function failSelection<T>(message: string, value: T): PlanningContractAssessment<T> {
  return { ok: false, value, issues: [{ code: 'invalid_structure', message }] };
}
