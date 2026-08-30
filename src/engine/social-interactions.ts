import { randomUUID } from 'node:crypto';
import type { Agent, GameEvent } from '../core/types';
import type { EventLog } from '../store/events';
import type { RelationshipSourceKind, RelationshipStore } from '../store/relationships';

export type SocialInteractionKind = 'observe' | 'assist' | 'share' | 'invite' | 'collaborate';

export interface SocialInteractionDefinition {
  kind: SocialInteractionKind;
  label: string;
  icon: string;
  description: string;
  channel: 'attention' | 'support' | 'information' | 'coordination' | 'shared_activity';
}

export const SOCIAL_INTERACTIONS: readonly SocialInteractionDefinition[] = [
  { kind: 'observe', label: '留意观察', icon: '◉', description: '从行动、状态和所处情境中形成单向观察记录。', channel: 'attention' },
  { kind: 'assist', label: '主动帮助', icon: '✦', description: '询问需要并提供一项具体支持。', channel: 'support' },
  { kind: 'share', label: '分享信息', icon: '◇', description: '分享与职业、爱好或现场有关的信息。', channel: 'information' },
  { kind: 'invite', label: '发出邀请', icon: '↗', description: '邀请对方参与之后的地点或活动。', channel: 'coordination' },
  { kind: 'collaborate', label: '共同做事', icon: '◆', description: '围绕现场任务开展一次短时协作。', channel: 'shared_activity' },
] as const;

export interface SocialInteractionInput {
  kind: SocialInteractionKind;
  actor: Agent;
  target: Agent;
  now: number;
  log: EventLog;
  rels: RelationshipStore;
  source?: 'simulation' | 'researcher';
}

export function socialInteractionDefinition(kind: string): SocialInteractionDefinition | null {
  return SOCIAL_INTERACTIONS.find((item) => item.kind === kind) ?? null;
}

export function performSocialInteraction(input: SocialInteractionInput): GameEvent {
  const definition = socialInteractionDefinition(input.kind);
  if (!definition) throw new Error('未知社会互动类型');
  if (input.actor.id === input.target.id) throw new Error('互动双方必须是不同居民');
  const source = input.source ?? 'simulation';
  const eventId = randomUUID();
  const text = interactionText(input.kind, input.actor, input.target);
  const memoryAgentIds = input.kind === 'observe'
    ? [input.actor.id]
    : [input.actor.id, input.target.id];
  const event: GameEvent = {
    id: eventId,
    type: 'interact',
    actorId: input.actor.id,
    targetIds: [input.target.id],
    description: text,
    location: input.actor.locationId,
    gameTime: input.now,
    payload: {
      kind: 'social_interaction',
      interactionType: input.kind,
      interactionLabel: definition.label,
      icon: definition.icon,
      channel: definition.channel,
      fromId: input.actor.id,
      toId: input.target.id,
      memoryAgentIds,
      source,
      researcherIntervention: source === 'researcher',
    },
  };
  input.log.addEvent(event);
  applyRelationshipEffects(input.rels, input.actor, input.target, event, definition, source);
  return event;
}

function interactionText(kind: SocialInteractionKind, actor: Agent, target: Agent): string {
  if (kind === 'observe') {
    const activity = target.action?.action.verb || stateLabel(target.state);
    return `${actor.name}留意到${target.name}正在${activity}，并把现场细节记在心里。`;
  }
  if (kind === 'assist') return `${actor.name}询问${target.name}是否需要帮忙，并主动搭了把手。`;
  if (kind === 'share') {
    const topic = actor.persona.hobbies[0] ?? actor.persona.occupation;
    return `${actor.name}向${target.name}分享了一条与${topic}有关的信息。`;
  }
  if (kind === 'invite') {
    const goal = actor.persona.goals[0] ?? '镇上的活动';
    return `${actor.name}邀请${target.name}之后一起参与“${goal}”。`;
  }
  const task = actor.action?.action.verb || target.action?.action.verb || '现场事务';
  return `${actor.name}与${target.name}围绕“${task}”共同做了一会儿事。`;
}

function stateLabel(state: Agent['state']): string {
  if (state === 'moving') return '赶路';
  if (state === 'acting') return '做事';
  if (state === 'thinking') return '思考';
  return '休息';
}

function applyRelationshipEffects(
  rels: RelationshipStore,
  actor: Agent,
  target: Agent,
  event: GameEvent,
  definition: SocialInteractionDefinition,
  source: 'simulation' | 'researcher',
): void {
  const effects = relationEffects(definition.kind);
  const metadata = { interactionType: definition.kind, channel: definition.channel, source };
  rels.update(actor.id, target.id, {
    affectionDelta: effects.actorAffection,
    respectDelta: effects.actorRespect,
    knowledge: [event.description],
    evidence: {
      kind: effects.sourceKind,
      eventId: event.id,
      text: event.description,
      trustDelta: effects.actorTrust,
      supportDelta: effects.actorSupport,
      metadata,
    },
  }, event.gameTime);
  if (definition.kind === 'observe') return;
  rels.update(target.id, actor.id, {
    affectionDelta: effects.targetAffection,
    respectDelta: effects.targetRespect,
    knowledge: [event.description],
    evidence: {
      kind: effects.sourceKind,
      eventId: event.id,
      text: event.description,
      trustDelta: effects.targetTrust,
      supportDelta: effects.targetSupport,
      metadata,
    },
  }, event.gameTime);
}

function relationEffects(kind: SocialInteractionKind): {
  sourceKind: RelationshipSourceKind;
  actorAffection: number; actorRespect: number; actorTrust: number; actorSupport: number;
  targetAffection: number; targetRespect: number; targetTrust: number; targetSupport: number;
} {
  if (kind === 'observe') return {
    sourceKind: 'observation', actorAffection: 0.005, actorRespect: 0.01, actorTrust: 0, actorSupport: 0,
    targetAffection: 0, targetRespect: 0, targetTrust: 0, targetSupport: 0,
  };
  if (kind === 'assist') return {
    sourceKind: 'assistance', actorAffection: 0.015, actorRespect: 0.01, actorTrust: 0.01, actorSupport: 0.04,
    targetAffection: 0.04, targetRespect: 0.035, targetTrust: 0.04, targetSupport: 0.06,
  };
  if (kind === 'share') return {
    sourceKind: 'information_share', actorAffection: 0.015, actorRespect: 0.01, actorTrust: 0.015, actorSupport: 0,
    targetAffection: 0.02, targetRespect: 0.02, targetTrust: 0.02, targetSupport: 0,
  };
  if (kind === 'invite') return {
    sourceKind: 'invitation', actorAffection: 0.02, actorRespect: 0.005, actorTrust: 0.01, actorSupport: 0.005,
    targetAffection: 0.025, targetRespect: 0.01, targetTrust: 0.01, targetSupport: 0.005,
  };
  return {
    sourceKind: 'collaboration', actorAffection: 0.025, actorRespect: 0.035, actorTrust: 0.03, actorSupport: 0.03,
    targetAffection: 0.025, targetRespect: 0.035, targetTrust: 0.03, targetSupport: 0.03,
  };
}
