// 悬浮面板：NPC 详情/档案/记忆/反思/对话/关系渲染 + #panel-tabs DOM 绑定
// 面板依赖（playing 集合 / togglePlay）由 main.ts 通过 updatePanelDeps 注入，panel.ts 不反向 import main.ts。

import type { ObjectView } from './types';
import { pixelAvatarMarkup, type PixelAvatarView } from './avatar';

export interface AgentView {
  id: string; name: string; occupation: string; state: string;
  age: number; gender: string;
  appearance: { hairStyle: string; hairColor: string; skinTone: string; outfit: string };
  hobbies: string[]; skills: Record<string, number>; values: string[]; motivation: string;
  traits: string[]; goals: string[]; speechStyle: string;
  personality: { extraversion: number; empathy: number; honesty: number; curiosity: number; patience: number };
  avatar: PixelAvatarView;
  initialState: {
    valence: number; energy: number; stress: number; socialNeed: number; occupationalFocus: number;
    startingLocationId: string;
  };
  x: number; y: number; locationId: string; locationName: string;
  verb: string; thought: string | null;
  actionType: 'move_to' | 'interact' | 'idle' | null;
  targetId: string | null; targetName: string | null;
  path: { x: number; y: number }[];
  spriteIndex: number; background: string;
}

export const STATE_NAME: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
export const TYPE_NAME: Record<string, string> = { town: '小镇', building: '建筑', room: '房间', furniture: '家具', zone: '区域', water: '水域' };

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PanelDeps {
  playing: ReadonlySet<string>;
  togglePlay: (id: string) => void;
  agentById: (id: string) => AgentView | null;
  editProfile: (id: string) => void;
  openInteraction: (actorId: string) => void;
}
let deps: PanelDeps | null = null;
let renderVersion = 0;

const FALLBACK_AVATAR: PixelAvatarView = {
  sprite: 0, hair: '#3b2c28', skin: '#efc39f', outfit: '#526779', accent: '#d9aa67', accessory: 'none',
};

function avatarFor(id: string, name: string, className = 'conversation-avatar'): string {
  return pixelAvatarMarkup(name, deps?.agentById(id)?.avatar ?? FALLBACK_AVATAR, className);
}

export type RelationshipWindowDays = number | 'all';
export interface RelationshipDyadFocus {
  aId: string;
  bId: string;
  windowDays: RelationshipWindowDays;
}

let relationshipDyadFocus: RelationshipDyadFocus | null = null;

function normalizeRelationshipWindowDays(value: RelationshipWindowDays): RelationshipWindowDays {
  if (value === 'all') return value;
  if (!Number.isFinite(value)) return 7;
  return Math.max(1, Math.min(3650, Math.floor(value)));
}

/** 关系网络边调用此 API，把右栏关系页切换到指定二元关系检查器。 */
export function setRelationshipDyadFocus(
  aId: string,
  bId: string,
  windowDays: RelationshipWindowDays = 7,
): void {
  if (!aId || !bId || aId === bId) throw new Error('dyad focus requires two different resident ids');
  relationshipDyadFocus = { aId, bId, windowDays: normalizeRelationshipWindowDays(windowDays) };
  renderVersion++;
}

/** 清除边聚焦；下一次关系页渲染恢复人物的全部有向关系。 */
export function clearRelationshipDyadFocus(): void {
  relationshipDyadFocus = null;
  renderVersion++;
}

/** 返回只读副本，便于网络层同步选中态且不暴露内部可变对象。 */
export function getRelationshipDyadFocus(): RelationshipDyadFocus | null {
  return relationshipDyadFocus ? { ...relationshipDyadFocus } : null;
}

/** main.ts 注入面板依赖（playing 为同一 Set 引用，后续增删对渲染可见） */
export function updatePanelDeps(d: PanelDeps): void {
  deps = d;
}

export function renderDetail(body: HTMLElement, a: AgentView): void {
  renderVersion++;
  const isPlaying = deps?.playing.has(a.id) ?? false;
  body.innerHTML = `
    <div class="profile-identity">${pixelAvatarMarkup(a.name, a.avatar, 'profile-avatar')}<div><h3>${escapeHtml(a.name)}</h3><small>${escapeHtml(a.occupation)} · ${escapeHtml(a.gender)} · ${a.age} 岁</small></div></div>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${escapeHtml(STATE_NAME[a.state] ?? a.state)}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>
    <div class="panel-actions"><button id="social-open">发起互动</button><button id="play-toggle">${isPlaying ? '退出扮演' : '🎮 扮演'}</button></div>`;
  document.getElementById('social-open')!.addEventListener('click', () => deps?.openInteraction(a.id));
  document.getElementById('play-toggle')!.addEventListener('click', () => deps?.togglePlay(a.id));
}

export function renderProfile(body: HTMLElement, a: AgentView): void {
  renderVersion++;
  const skillBars = Object.entries(a.skills).map(([k, v]) =>
    `<div class="mem-item">${escapeHtml(k)}<div class="bar"><div class="bar-fill skill" style="width:${v * 10}%"></div><span>${v}/10</span></div></div>`).join('');
  const dims: [string, number][] = [
    ['外向', a.personality.extraversion], ['共情', a.personality.empathy], ['诚实', a.personality.honesty],
    ['好奇', a.personality.curiosity], ['耐心', a.personality.patience],
  ];
  const persBars = dims.map(([k, v]) =>
    `<div class="mem-item">${k}<div class="bar"><div class="bar-fill pers" style="width:${Math.round(v * 100)}%"></div></div></div>`).join('');
  const tags = a.hobbies.map((h) => `<span class="tag">${escapeHtml(h)}</span>`).join('');
  body.innerHTML = `
    <div class="profile-identity">${pixelAvatarMarkup(a.name, a.avatar, 'profile-avatar')}<div><h3>${escapeHtml(a.name)} 的档案</h3><small>${escapeHtml(a.speechStyle)}</small></div></div>
    <p><span class="label">性别</span> ${escapeHtml(a.gender)} · <span class="label">年龄</span> ${a.age} · <span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">外貌</span> ${escapeHtml(a.appearance.hairStyle)}，${escapeHtml(a.appearance.hairColor)}，${escapeHtml(a.appearance.skinTone)}肤色，常穿${escapeHtml(a.appearance.outfit)}</p>
    <p class="label">爱好</p><p>${tags}</p>
    <p class="label">技能</p>${skillBars}
    <p class="label">性格五维</p>${persBars}
    <div class="profile-card"><p class="label">价值观</p><p>${a.values.map((v) => `· ${escapeHtml(v)}`).join('<br>')}</p></div>
    <div class="profile-card"><p class="label">人格标签</p><p>${a.traits.map((v) => `· ${escapeHtml(v)}`).join('<br>')}</p></div>
    <div class="profile-card"><p class="label">长期目标</p><p>${a.goals.map((v) => `· ${escapeHtml(v)}`).join('<br>')}</p></div>
    <div class="profile-card"><p class="label">动机</p><p>${escapeHtml(a.motivation)}</p></div>
    <div class="profile-card"><p class="label">背景故事</p><p>${escapeHtml(a.background)}</p></div>
    <button id="profile-edit" class="wide-action">编辑身份、初始状态与像素头像</button>`;
  document.getElementById('profile-edit')!.addEventListener('click', () => deps?.editProfile(a.id));
}

export function renderObjectCard(body: HTMLElement, o: ObjectView): void {
  renderVersion++;
  const affordances = (o.affordances ?? []).map((item) => (
    `<li><strong>${escapeHtml(item.verb)}</strong><span>${escapeHtml(item.outcome)}</span></li>`
  )).join('');
  const cues = (o.sensoryCues ?? []).map((cue) => `<span class="sensory-chip">${escapeHtml(cue)}</span>`).join('');
  body.innerHTML = `
    <h3>${escapeHtml(o.name)}</h3>
    <p><span class="label">类型</span> ${escapeHtml(TYPE_NAME[o.type] ?? o.type)}</p>
    <p><span class="label">尺寸</span> ${o.w}×${o.h}</p>
    ${o.description ? `<div class="object-description">${escapeHtml(o.description)}</div>` : ''}
    ${o.state ? `<div class="object-live-state"><span>现场状态</span><strong>${escapeHtml(o.state.label)}</strong><p>${escapeHtml(o.state.detail)}</p></div>` : ''}
    ${affordances ? `<section class="object-affordances"><p class="label">居民可以在这里</p><ul>${affordances}</ul></section>` : ''}
    ${cues ? `<section class="object-senses"><p class="label">可以感到</p><div>${cues}</div></section>` : ''}
    ${o.observationRadius ? `<p class="object-observation-note">附近 ${o.observationRadius} 格内的居民可以见证这里发生的公共行动。</p>` : ''}`;
}

const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
const gameTimeLabel = (gameTime: number) => {
  const day = Math.floor(gameTime / 1440) + 1;
  const minute = ((gameTime % 1440) + 1440) % 1440;
  return `第${day}天 ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
};

export interface ReflectionView {
  kind?: 'daily' | 'triggered';
  day?: number;
  diary?: string;
  insights?: string[];
  evidenceIds?: string[];
  mindState?: {
    valence?: number; energy?: number; stress?: number; socialNeed?: number;
    occupationalFocus?: number; summary?: string;
  };
  beliefs?: {
    statement?: string; confidence?: number; evidenceIds?: string[];
    status?: 'new' | 'reinforced' | 'revised'; supersedes?: string | null;
  }[];
  revisions?: { previous?: string; revised?: string; reason?: string; evidenceIds?: string[] }[];
  guidance?: string[];
}

const bounded = (value: unknown, min: number, max: number, fallback = 0) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, number));
};
const textItems = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  : [];

/** 结构化反思日记；所有模型文本在插入 HTML 前统一转义。 */
export function renderReflectionCards(reflections: ReflectionView[]): string {
  if (!reflections.length) return '<p class="label">暂无反思</p>';
  return reflections.map((reflection, index) => {
    const kind = reflection.kind === 'daily' ? 'daily' : reflection.kind === 'triggered' ? 'triggered' : 'legacy';
    const kindLabel = kind === 'daily' ? '每日复盘' : kind === 'triggered' ? '触发反思' : '历史反思';
    const day = typeof reflection.day === 'number' && Number.isFinite(reflection.day) && reflection.day > 0
      ? `第 ${Math.floor(reflection.day)} 天`
      : '日期未记录';
    const evidenceCount = Array.isArray(reflection.evidenceIds) ? reflection.evidenceIds.length : 0;
    const diary = typeof reflection.diary === 'string' ? reflection.diary.trim() : '';
    const insights = textItems(reflection.insights);
    const guidance = textItems(reflection.guidance);
    const state = reflection.mindState;
    const stateRows: [string, number, string][] = state ? [
      ['情绪效价', (bounded(state.valence, -1, 1) + 1) / 2, bounded(state.valence, -1, 1).toFixed(2)],
      ['精力', bounded(state.energy, 0, 1), bounded(state.energy, 0, 1).toFixed(2)],
      ['压力', bounded(state.stress, 0, 1), bounded(state.stress, 0, 1).toFixed(2)],
      ['社交需要', bounded(state.socialNeed, 0, 1), bounded(state.socialNeed, 0, 1).toFixed(2)],
      ['职业专注', bounded(state.occupationalFocus, 0, 1), bounded(state.occupationalFocus, 0, 1).toFixed(2)],
    ] : [];
    const stateHtml = stateRows.length ? `
      <section class="reflection-section"><h4>心态截面</h4>
        ${typeof state?.summary === 'string' && state.summary.trim() ? `<p class="mind-summary">${escapeHtml(state.summary)}</p>` : ''}
        <div class="mind-state-grid">${stateRows.map(([label, value, shown]) => `
          <div class="mind-state-row"><span>${label}</span><i><b style="width:${Math.round(value * 100)}%"></b></i><strong>${shown}</strong></div>`).join('')}</div>
      </section>` : '';
    const beliefs = Array.isArray(reflection.beliefs) ? reflection.beliefs : [];
    const beliefHtml = beliefs.length ? `
      <section class="reflection-section"><h4>信念更新</h4><div class="belief-list">${beliefs.map((belief) => {
        const statement = typeof belief?.statement === 'string' ? belief.statement : '';
        if (!statement) return '';
        const status = belief.status === 'revised' ? 'revised' : belief.status === 'reinforced' ? 'reinforced' : 'new';
        const statusLabel = status === 'revised' ? '已修正' : status === 'reinforced' ? '获强化' : '新形成';
        const confidence = bounded(belief.confidence, 0, 1, .5);
        const beliefEvidence = Array.isArray(belief.evidenceIds) ? belief.evidenceIds.length : 0;
        return `<article class="belief-item" data-status="${status}"><div><span>${statusLabel}</span><b>置信 ${confidence.toFixed(2)}</b></div><p>${escapeHtml(statement)}</p><small>证据 ${beliefEvidence} 条${typeof belief.supersedes === 'string' && belief.supersedes ? ` · 修订自：${escapeHtml(belief.supersedes)}` : ''}</small></article>`;
      }).join('')}</div></section>` : '';
    const revisions = Array.isArray(reflection.revisions) ? reflection.revisions : [];
    const revisionHtml = revisions.length ? `
      <section class="reflection-section"><h4>认知修订</h4>${revisions.map((revision) => {
        const previous = typeof revision?.previous === 'string' ? revision.previous : '';
        const revised = typeof revision?.revised === 'string' ? revision.revised : '';
        const reason = typeof revision?.reason === 'string' ? revision.reason : '';
        const revisionEvidence = Array.isArray(revision?.evidenceIds) ? revision.evidenceIds.length : 0;
        return `<div class="revision-item"><p><del>${escapeHtml(previous)}</del><span aria-hidden="true">→</span><ins>${escapeHtml(revised)}</ins></p>${reason ? `<small>${escapeHtml(reason)} · 证据 ${revisionEvidence} 条</small>` : ''}</div>`;
      }).join('')}</section>` : '';
    const guidanceHtml = guidance.length ? `<section class="reflection-section"><h4>后续行为指引</h4><ol class="guidance-list">${guidance.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>` : '';
    const insightHtml = insights.length ? `<section class="reflection-section"><h4>洞察</h4>${insights.map((insight) => `<div class="ins">💡 ${escapeHtml(insight)}</div>`).join('')}</section>` : '';
    return `<details class="reflection-card" data-kind="${kind}" ${index === 0 ? 'open' : ''}>
      <summary><span class="reflection-kind">${kindLabel}</span><strong>${day}</strong><small>证据 ${evidenceCount} 条</small></summary>
      <div class="reflection-body">
        ${diary ? `<section class="reflection-section diary"><h4>第一人称日记</h4><p>${escapeHtml(diary)}</p></section>` : ''}
        ${stateHtml}${beliefHtml}${revisionHtml}${guidanceHtml}${insightHtml}
      </div>
    </details>`;
  }).join('');
}

export type DyadMeasureKey =
  | 'partnerReturn' | 'tiePersistence' | 'recencyEffect' | 'reciprocity'
  | 'relationalCarryOver' | 'partnerConcentration' | 'interactionIntensity'
  | 'multiplexity' | 'dependenceAsymmetry' | 'embeddedness';

export interface DyadMeasureValue {
  value: number | null;
  observed: boolean;
  numerator: number | null;
  denominator: number | null;
  basis: string;
}

interface DyadMeasureDefinition {
  key: DyadMeasureKey;
  label: string;
  shortLabel: string;
  family: 'existing-six' | 'added-four';
  level: 'directed' | 'dyad' | 'actor';
  source: string;
  description: string;
  caveat: string;
}

type DyadMeasureMap = Partial<Record<DyadMeasureKey | 'partnerDependence', DyadMeasureValue>> & {
  channels?: string[];
  interactionEventCount?: number;
  choiceCount?: number;
  commonNeighborCount?: number;
  unionNeighborCount?: number;
};
type LegacyDimensionKey = 'closeness' | 'trust' | 'respect' | 'support' | 'tension' | 'frequency';

interface DyadDirectionView {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  dimensions?: Partial<Record<LegacyDimensionKey, number>>;
  measures?: DyadMeasureMap;
  evidenceCount?: number;
  relationshipStateObserved?: boolean;
}

interface DyadEvidenceView {
  id: string;
  direction: string;
  sourceKind: string;
  sourceEventId: string | null;
  sourceText: string;
  gameTime: number;
  affectionDelta: number;
  respectDelta: number;
  trustDelta: number;
  supportDelta: number;
  tensionDelta: number;
}

interface DyadConversationView {
  id: string;
  status: 'active' | 'completed' | 'error' | 'interrupted';
  startedGameTime: number;
  endedGameTime: number | null;
  turnCount: number;
  summary: string;
  errorText: string;
  runtime?: ConversationRuntimeView | null;
  participants: { id: string; name: string }[];
  messages: {
    id: string; eventId: string | null; turnIndex: number | null;
    fromAgent: string; fromName: string; toAgent: string; toName: string;
    content: string; gameTime: number;
  }[];
}

interface ConversationRuntimeView {
  phase: 'waiting_model' | 'queued_model' | 'generating_model' | 'ready' | 'summarizing';
  waitMs: number;
  queueWaitMs?: number;
  generationMs?: number;
  stage?: 'generate' | 'review';
}

function conversationWaitingLabel(runtime: ConversationRuntimeView | null | undefined): string {
  if (runtime?.stage === 'review') {
    const queued = runtime.phase === 'queued_model';
    const seconds = Math.max(1, Math.ceil((queued ? runtime.queueWaitMs ?? runtime.waitMs : runtime.generationMs ?? runtime.waitMs) / 1000));
    return `${queued ? '等待语义审校' : '正在核对这句话的语义与事实'} · ${seconds} 秒`;
  }
  if (runtime?.phase === 'summarizing') return '正在形成会话摘要与关系证据';
  if (runtime?.phase === 'waiting_model') {
    const seconds = Math.max(1, Math.ceil((runtime.waitMs || 0) / 1000));
    return `本地模型排队或生成中 · ${seconds} 秒`;
  }
  if (runtime?.phase === 'queued_model') {
    const seconds = Math.max(1, Math.ceil((runtime.queueWaitMs || runtime.waitMs || 0) / 1000));
    return `本地模型排队中 · ${seconds} 秒`;
  }
  if (runtime?.phase === 'generating_model') {
    const generationSeconds = Math.max(1, Math.ceil((runtime.generationMs || 0) / 1000));
    const queueSeconds = Math.ceil((runtime.queueWaitMs || 0) / 1000);
    return `本地模型生成中 · ${generationSeconds} 秒${queueSeconds ? `（排队 ${queueSeconds} 秒）` : ''}`;
  }
  return '等待第一轮发言';
}

export interface RelationshipDyadResponse {
  schemaVersion: string;
  worldId: string;
  modelVersion: string;
  generatedGameTime: number;
  window: { days: number | null; startGameTime: number; endGameTime: number; label: string };
  proxyNotice: string;
  measureSchema: DyadMeasureDefinition[];
  dataQuality: string[];
  scope: { source: string; validatedRun: unknown };
  people: { a: { id: string; name: string }; b: { id: string; name: string } };
  aToB: DyadDirectionView | null;
  bToA: DyadDirectionView | null;
  dyad: {
    measures?: DyadMeasureMap;
    commonNeighborCount?: number;
    unionNeighborCount?: number;
    tieLabel?: string;
  } | null;
  evidenceSummary: { totalCount: number; returnedCount: number; truncated: boolean };
  evidenceTimeline: DyadEvidenceView[];
  choiceEvents: { fromId: string; toId: string; gameTime: number; eventId?: string }[];
  conversations: DyadConversationView[];
}

const basisLabels: Record<string, string> = {
  partner_choice: '伙伴选择',
  relationship_evidence: '关系证据',
  mixed: '混合观察',
  network_topology: '网络拓扑',
  none: '无来源',
};

const evidenceKindLabels: Record<string, string> = {
  dialogue: '对话',
  gift_sent: '馈礼送出',
  gift_received: '馈礼收到',
  shared_activity: '共同活动',
  observation: '留意观察',
  assistance: '主动帮助',
  information_share: '信息分享',
  invitation: '活动邀请',
  collaboration: '共同协作',
  manual: '研究者记录',
  other: '其他关系事件',
};

const channelLabels: Record<string, string> = {
  communication: '沟通',
  resource_exchange: '资源交换',
  shared_activity: '共同活动',
  attention: '注意与观察',
  partner_choice: '伙伴选择',
  other: '其他',
};

function safeGameTimeLabel(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? gameTimeLabel(Math.floor(value))
    : '时间未记录';
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function safeTurnLabel(value: unknown, fallbackIndex: number): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `第 ${Math.floor(value) + 1} 轮`
    : `顺序 ${fallbackIndex + 1}`;
}

function renderMeasureValue(measure: DyadMeasureValue | null | undefined): string {
  if (!measure || !measure.observed || measure.value === null || !Number.isFinite(measure.value)) {
    return '<span class="label">缺少可识别观察</span>';
  }
  const numerator = typeof measure.numerator === 'number' && Number.isFinite(measure.numerator)
    ? measure.numerator.toFixed(2)
    : null;
  const denominator = typeof measure.denominator === 'number' && Number.isFinite(measure.denominator)
    ? measure.denominator.toFixed(2)
    : null;
  const ratio = numerator !== null && denominator !== null ? ` · ${numerator}/${denominator}` : '';
  const basis = basisLabels[measure.basis] ?? '未识别来源';
  return `<b>${bounded(measure.value, 0, 1).toFixed(3)}</b><small> · ${basis}${ratio}</small>`;
}

function measureFor(
  response: RelationshipDyadResponse,
  direction: DyadDirectionView | null,
  definition: DyadMeasureDefinition,
): DyadMeasureValue | null {
  if (definition.level === 'dyad') return response.dyad?.measures?.[definition.key] ?? null;
  return direction?.measures?.[definition.key] ?? null;
}

function renderMeasureGroup(
  response: RelationshipDyadResponse,
  definitions: DyadMeasureDefinition[],
  title: string,
): string {
  if (!definitions.length) return '';
  const aName = response.people.a.name;
  const bName = response.people.b.name;
  return `<section class="relation-card"><h4>${title}</h4>${definitions.map((definition) => {
    const aValue = measureFor(response, response.aToB, definition);
    const bValue = measureFor(response, response.bToA, definition);
    const directionValue = (direction: DyadDirectionView | null, value: DyadMeasureValue | null) => {
      const channels = definition.key === 'multiplexity' && direction?.measures?.channels?.length
        ? `<div class="dyad-channel-list">${direction.measures.channels.map((channel) => `<span>${escapeHtml(channelLabels[channel] ?? channel)}</span>`).join('')}</div>`
        : '';
      return `${renderMeasureValue(value)}${channels}`;
    };
    const dependenceParts = definition.key === 'dependenceAsymmetry'
      ? `<div class="dyad-direction-grid dyad-dependence-parts">
          <div class="dl-item dyad-direction-cell"><strong>${escapeHtml(aName)} 对 ${escapeHtml(bName)} 的选择份额</strong><br>${renderMeasureValue(response.aToB?.measures?.partnerDependence)}</div>
          <div class="dl-item dyad-direction-cell"><strong>${escapeHtml(bName)} 对 ${escapeHtml(aName)} 的选择份额</strong><br>${renderMeasureValue(response.bToA?.measures?.partnerDependence)}</div>
        </div>`
      : '';
    const values = definition.level === 'dyad'
      ? `<div class="dl-item dyad-direction-cell"><strong>双向共同量</strong><br>${renderMeasureValue(aValue)}</div>${dependenceParts}`
      : `<div class="dyad-direction-grid">
          <div class="dl-item dyad-direction-cell"><strong>${escapeHtml(aName)} → ${escapeHtml(bName)}</strong><br>${directionValue(response.aToB, aValue)}</div>
          <div class="dl-item dyad-direction-cell"><strong>${escapeHtml(bName)} → ${escapeHtml(aName)}</strong><br>${directionValue(response.bToA, bValue)}</div>
        </div>`;
    return `<article class="mem-item dyad-measure-card"><h5>${escapeHtml(definition.label)}</h5>${values}
      <p class="relation-notice">${escapeHtml(definition.description)}<br>来源：${escapeHtml(definition.source)} · 限制：${escapeHtml(definition.caveat)}</p></article>`;
  }).join('')}</section>`;
}

function renderLegacyDimensions(response: RelationshipDyadResponse): string {
  const dimensions: { key: LegacyDimensionKey; label: string; signed: boolean }[] = [
    { key: 'closeness', label: '情感亲密代理', signed: true },
    { key: 'trust', label: '信任代理', signed: true },
    { key: 'respect', label: '尊重/地位代理', signed: true },
    { key: 'support', label: '支持代理', signed: false },
    { key: 'tension', label: '张力代理', signed: false },
    { key: 'frequency', label: '互动频率代理', signed: false },
  ];
  const column = (from: string, to: string, direction: DyadDirectionView | null) => `
    <div class="dl-item dyad-direction-cell"><strong>${escapeHtml(from)} → ${escapeHtml(to)}</strong>
      ${direction ? direction.relationshipStateObserved !== false ? dimensions.map((dimension) => {
        const raw = direction.dimensions?.[dimension.key];
        const value = typeof raw === 'number' && Number.isFinite(raw)
          ? (dimension.signed ? bounded(raw, -1, 1) : bounded(raw, 0, 1)).toFixed(2)
          : '缺少可识别观察';
        return `<div>${dimension.label}：<b>${value}</b></div>`;
      }).join('') : '<p class="label">缺少持久化关系状态；当前方向仅有行为观察</p>' : '<p class="label">缺少可识别观察</p>'}
    </div>`;
  return `<section class="relation-card"><h4>探索性旧六维画像（非关系事实）</h4>
    <p class="relation-notice">这些代理量用于检查旧字段与证据覆盖，不构成对两人关系类型或社会事实的判定。</p>
    <div class="dyad-direction-grid">
      ${column(response.people.a.name, response.people.b.name, response.aToB)}
      ${column(response.people.b.name, response.people.a.name, response.bToA)}
    </div></section>`;
}

function renderDyadConversations(response: RelationshipDyadResponse): string {
  const statusLabels = { active: '进行中', completed: '已完成', error: '异常结束', interrupted: '运行结束' } as const;
  if (!Array.isArray(response.conversations) || !response.conversations.length) {
    return '<p class="label">没有可识别的连贯会话</p>';
  }
  return response.conversations.map((conversation, index) => {
    const messages = [...(conversation.messages ?? [])].sort((left, right) => (
      (left.turnIndex ?? Number.MAX_SAFE_INTEGER) - (right.turnIndex ?? Number.MAX_SAFE_INTEGER)
        || left.gameTime - right.gameTime
        || left.id.localeCompare(right.id)
    ));
    const transcript = messages.map((message, messageIndex) => {
      const turn = safeTurnLabel(message.turnIndex, messageIndex);
      return `<div class="conversation-turn ${message.fromAgent === response.people.a.id ? 'mine' : 'theirs'}">
        ${avatarFor(message.fromAgent, message.fromName)}
        <div class="conversation-content"><div><b>${escapeHtml(message.fromName)}</b><span>→ ${escapeHtml(message.toName)} · ${turn}</span></div>
        <p>${escapeHtml(message.content)}</p><time>${safeGameTimeLabel(message.gameTime)}</time></div>
      </div>`;
    }).join('');
    const status = conversation.status === 'active' || conversation.status === 'completed' || conversation.status === 'interrupted'
      ? conversation.status
      : 'error';
    return `<details class="conversation-card" ${index === 0 || status === 'active' ? 'open' : ''}>
      <summary><span>会话 ${escapeHtml(conversation.id.slice(0, 12))}</span><b data-status="${status}">${statusLabels[status]}</b><small>${safeCount(conversation.turnCount)} 轮</small></summary>
      <div class="conversation-meta">${safeGameTimeLabel(conversation.startedGameTime)}${conversation.endedGameTime === null ? '' : ` — ${safeGameTimeLabel(conversation.endedGameTime)}`}</div>
      <div class="conversation-transcript">${transcript || `<p class="label">${conversationWaitingLabel(conversation.runtime)}</p>`}${transcript && status === 'active' && conversation.runtime?.stage === 'review' ? `<p class="label">${conversationWaitingLabel(conversation.runtime)}</p>` : ''}</div>
      ${conversation.summary ? `<div class="conversation-summary"><span>会话摘要</span>${escapeHtml(conversation.summary)}</div>` : ''}
      ${conversation.errorText ? `<div class="${status === 'interrupted' ? 'conversation-interruption' : 'conversation-error'}">${escapeHtml(conversation.errorText)}</div>` : ''}
    </details>`;
  }).join('');
}

function renderChoiceEvents(response: RelationshipDyadResponse): string {
  if (!Array.isArray(response.choiceEvents) || !response.choiceEvents.length) {
    return '<p class="label">没有可识别的伙伴选择观察</p>';
  }
  const names = new Map([
    [response.people.a.id, response.people.a.name],
    [response.people.b.id, response.people.b.name],
  ]);
  return [...response.choiceEvents]
    .sort((left, right) => right.gameTime - left.gameTime)
    .map((choice) => `<div class="dl-item"><strong>${escapeHtml(names.get(choice.fromId) ?? choice.fromId)} → ${escapeHtml(names.get(choice.toId) ?? choice.toId)}</strong>
      <div>${safeGameTimeLabel(choice.gameTime)}${choice.eventId ? ` · 来源事件 ${escapeHtml(choice.eventId.slice(0, 12))}` : ' · 来源事件未记录'}</div></div>`)
    .join('');
}

function renderEvidenceTimeline(response: RelationshipDyadResponse): string {
  if (!Array.isArray(response.evidenceTimeline) || !response.evidenceTimeline.length) {
    return '<p class="label">没有可识别的关系变化证据</p>';
  }
  return [...response.evidenceTimeline]
    .sort((left, right) => right.gameTime - left.gameTime || right.id.localeCompare(left.id))
    .map((item) => {
      const net = item.affectionDelta * .45 + item.respectDelta * .25
        + item.trustDelta * .2 + item.supportDelta * .1 - item.tensionDelta * .45;
      return `<div class="evidence-item"><div><span>${escapeHtml(item.direction)} · ${escapeHtml(evidenceKindLabels[item.sourceKind] ?? item.sourceKind)}</span><time>${safeGameTimeLabel(item.gameTime)}</time></div>
        <p>${escapeHtml(item.sourceText)}</p><small>净变化 ${Number.isFinite(net) ? signed(net) : '—'}${item.sourceEventId ? ` · 来源事件 ${escapeHtml(item.sourceEventId.slice(0, 12))}` : ' · 来源事件未记录'}</small></div>`;
    }).join('');
}

/** 三层 dyad 检查器：只陈述观察、代理与来源，不把旧分类呈现为关系事实。 */
export function renderRelationshipDyadInspector(response: RelationshipDyadResponse): string {
  const existing = (response.measureSchema ?? []).filter((definition) => definition.family === 'existing-six');
  const added = (response.measureSchema ?? []).filter((definition) => definition.family === 'added-four');
  const validatedRun = response.scope?.validatedRun == null
    ? '未绑定验证运行；当前结果仅供探索'
    : '已绑定验证运行';
  const dataQuality = textItems(response.dataQuality);
  return `<article class="dyad-inspector">
    <header class="relation-card"><div><h3>${escapeHtml(response.people.a.name)} ↔ ${escapeHtml(response.people.b.name)}</h3>
      <p class="relation-notice">${escapeHtml(response.window.label)} · 生成于 ${safeGameTimeLabel(response.generatedGameTime)}</p></div>
      <button type="button" data-clear-dyad-focus>返回人物关系</button>
      <p class="relation-notice">${escapeHtml(response.proxyNotice)} 所有指标与画像均为描述性、探索性投影，不是关系事实或因果结论。</p>
    </header>
    <section class="relation-card" aria-labelledby="dyad-interaction-layer"><h4 id="dyad-interaction-layer">1 · 互动层：可追溯观察</h4>
      <p class="label">连贯会话 turn</p>${renderDyadConversations(response)}
      <p class="label">伙伴选择</p>${renderChoiceEvents(response)}
      <details class="relation-evidence" open><summary>证据时间线 ${safeCount(response.evidenceSummary?.returnedCount)} / ${safeCount(response.evidenceSummary?.totalCount)} 条${response.evidenceSummary?.truncated ? '（已截断）' : ''}</summary>${renderEvidenceTimeline(response)}</details>
    </section>
    <section aria-labelledby="dyad-relation-layer"><h4 id="dyad-relation-layer">2 · 关系层：描述性测量</h4>
      ${renderMeasureGroup(response, existing, '既有六项测量（描述性）')}
      ${renderMeasureGroup(response, added, '新增四项测量（描述性）')}
      ${renderLegacyDimensions(response)}
    </section>
    <section class="relation-card" aria-labelledby="dyad-structure-layer"><h4 id="dyad-structure-layer">3 · 结构层：网络位置与数据边界</h4>
      <div class="relation-summary"><span>共同邻居 <b>${safeCount(response.dyad?.measures?.commonNeighborCount ?? response.dyad?.commonNeighborCount)}</b></span><span>邻居并集 <b>${safeCount(response.dyad?.measures?.unionNeighborCount ?? response.dyad?.unionNeighborCount)}</b></span><span>会话 <b>${safeCount(response.conversations?.length)}</b></span><span>选择 <b>${safeCount(response.choiceEvents?.length)}</b></span></div>
      <p class="relation-notice">范围来源：${escapeHtml(response.scope?.source ?? '未记录')} · ${validatedRun}<br>模型：${escapeHtml(response.modelVersion)} · Schema：${escapeHtml(response.schemaVersion)}</p>
      ${dataQuality.length ? `<ul>${dataQuality.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="label">暂无额外数据质量说明</p>'}
    </section>
  </article>`;
}

export async function renderMind(body: HTMLElement, agentId: string, tab: string, worldId: string): Promise<void> {
  const version = ++renderVersion;
  const requestedDyadFocus = relationshipDyadFocus
    && (relationshipDyadFocus.aId === agentId || relationshipDyadFocus.bId === agentId)
    ? { ...relationshipDyadFocus }
    : null;
  body.innerHTML = '<p class="label">加载中…</p>';
  try {
    const scope = `?worldId=${encodeURIComponent(worldId)}`;
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/mind${scope}`);
    if (!res.ok) throw new Error(String(res.status));
    const mind = (await res.json()) as {
      worldId: string;
      memories: { content: string; importance: number; kind: string }[];
      reflections: ReflectionView[];
      dialogues: { fromAgent: string; toAgent: string; content: string; gameTime: number }[];
      conversations: {
        id: string; status: 'active' | 'completed' | 'error' | 'interrupted'; startedGameTime: number;
        endedGameTime: number | null; turnCount: number; summary: string; errorText: string;
        runtime?: ConversationRuntimeView | null;
        participants: { id: string; name: string }[];
        messages: {
          fromAgent: string; fromName: string; toAgent: string; toName: string;
          content: string; gameTime: number; turnIndex: number | null;
        }[];
      }[];
    };
    if (version !== renderVersion || mind.worldId !== worldId) return;
    if (tab === 'memory') {
      body.innerHTML = mind.memories.length
        ? mind.memories.map((m) => `<div class="mem-item"><span class="stars">${'★'.repeat(Math.round(m.importance / 2))}</span> ${escapeHtml(m.content)}</div>`).join('')
        : '<p class="label">暂无记忆</p>';
    } else if (tab === 'reflection') {
      body.innerHTML = renderReflectionCards(mind.reflections);
    } else if (tab === 'relation') {
      if (requestedDyadFocus) {
        const query = new URLSearchParams({
          worldId,
          aId: requestedDyadFocus.aId,
          bId: requestedDyadFocus.bId,
          windowDays: String(requestedDyadFocus.windowDays),
        });
        const dyadRes = await fetch(`/api/relationships/dyad?${query.toString()}`);
        if (!dyadRes.ok) throw new Error(String(dyadRes.status));
        const dyad = (await dyadRes.json()) as RelationshipDyadResponse;
        if (version !== renderVersion || dyad.worldId !== worldId) return;
        if (dyad.people.a.id !== requestedDyadFocus.aId || dyad.people.b.id !== requestedDyadFocus.bId) return;
        body.innerHTML = renderRelationshipDyadInspector(dyad);
        body.querySelector<HTMLButtonElement>('[data-clear-dyad-focus]')?.addEventListener('click', () => {
          clearRelationshipDyadFocus();
          body.dispatchEvent(new CustomEvent('relationship-dyad-focus-cleared', { bubbles: true }));
          void renderMind(body, agentId, 'relation', worldId);
        });
        return;
      }
      const res2 = await fetch(`/api/relationships/${encodeURIComponent(agentId)}${scope}`);
      if (!res2.ok) throw new Error(String(res2.status));
      const rel = (await res2.json()) as {
        worldId: string; proxyNotice: string;
        relations: {
          otherName: string; affection: number; respect: number;
          reciprocity: number; asymmetry: number; dyadLabel: string;
          direction: null | {
            directionLabel: string; strength: number; valence: number; recentChange: number;
            evidenceCount: number; tieLabel: string;
            dimensions: { closeness: number; trust: number; respect: number; support: number; tension: number; frequency: number };
            evidence: {
              id: string; sourceKind: string; sourceEventId: string | null; sourceText: string; gameTime: number;
              affectionDelta: number; respectDelta: number; trustDelta: number; supportDelta: number; tensionDelta: number;
            }[];
          };
          reverseDirection: null | { directionLabel: string; strength: number; valence: number; recentChange: number };
        }[];
        standings: { name: string; score: number }[];
      };
      if (version !== renderVersion || rel.worldId !== worldId) return;
      const bars = rel.relations.length
        ? rel.relations.map((r) => {
            const direction = r.direction;
            const signedPct = (value: number) => Math.round(((Math.max(-1, Math.min(1, value)) + 1) / 2) * 100);
            const positivePct = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 100);
            const dimensions: [string, number, boolean][] = direction ? [
              ['情感亲密', direction.dimensions.closeness, true],
              ['信任代理', direction.dimensions.trust, true],
              ['尊重/地位', direction.dimensions.respect, true],
              ['支持代理', direction.dimensions.support, false],
              ['张力代理', direction.dimensions.tension, false],
              ['互动频率', direction.dimensions.frequency, false],
            ] : [];
            const dimensionRows = direction ? dimensions.map(([label, value, isSigned]) => `
              <div class="relation-dimension">
                <span>${label}</span>
                <div class="relation-track ${isSigned ? 'signed' : ''}"><i style="width:${isSigned ? signedPct(value) : positivePct(value)}%"></i></div>
                <b>${isSigned ? signed(value) : value.toFixed(2)}</b>
              </div>`).join('') : '<p class="relation-direction-empty">当前人物 → 对方：尚无有向关系记录</p>';
            const evidence = direction?.evidence.length
              ? `<details class="relation-evidence"><summary>近期证据 ${direction.evidenceCount} 条</summary>${direction.evidence.map((item) => {
                  const delta = item.affectionDelta * .45 + item.respectDelta * .25
                    + item.trustDelta * .2 + item.supportDelta * .1 - item.tensionDelta * .45;
                  return `<div class="evidence-item">
                    <div><span>${escapeHtml(evidenceKindLabels[item.sourceKind] ?? item.sourceKind)}</span><time>${gameTimeLabel(item.gameTime)}</time></div>
                    <p>${escapeHtml(item.sourceText)}</p>
                    <small>净变化 ${signed(delta)}${item.sourceEventId ? ` · 事件 ${escapeHtml(item.sourceEventId.slice(0, 8))}` : ''}</small>
                  </div>`;
                }).join('')}</details>`
              : '<p class="label">暂无可追溯变化证据</p>';
            return `<article class="relation-card">
              <header><div><strong>${escapeHtml(r.otherName)}</strong><small>探索性方向画像：${escapeHtml(direction?.directionLabel ?? r.reverseDirection?.directionLabel ?? '有向观察')}</small></div><span class="relation-type">探索性 · ${escapeHtml(r.dyadLabel)}</span></header>
              <div class="relation-summary">
                <span>我方强度 <b>${direction?.strength.toFixed(2) ?? '0.00'}</b></span>
                <span>互惠 <b>${r.reciprocity.toFixed(2)}</b></span>
                <span>不对称 <b>${r.asymmetry.toFixed(2)}</b></span>
                <span>近 7 日 <b class="${(direction?.recentChange ?? 0) < 0 ? 'negative' : 'positive'}">${signed(direction?.recentChange ?? 0)}</b></span>
              </div>
              ${dimensionRows}
              <div class="direction-compare"><span>我 → 对方 ${direction?.strength.toFixed(2) ?? '—'}</span><span>对方 → 我 ${r.reverseDirection?.strength.toFixed(2) ?? '—'}</span></div>
              ${evidence}
            </article>`;
          }).join('')
        : '<p class="label">暂无关系</p>';
      const top = rel.standings.slice(0, 3).map((s, i) => `<div class="dl-item">👑${i + 1} ${escapeHtml(s.name)}（${s.score.toFixed(3)}）</div>`).join('');
      body.innerHTML = `<p class="label">小镇声望榜</p>${top}<p class="label">有向社会关系探索性投影</p><p class="relation-notice">${escapeHtml(rel.proxyNotice)} 分类与维度用于描述性检查，不作为关系事实。</p>${bars}`;
    } else {
      const statusLabel = { active: '进行中', completed: '已完成', error: '异常结束', interrupted: '运行结束' } as const;
      body.innerHTML = mind.conversations.length
        ? mind.conversations.map((conversation, index) => {
            const people = conversation.participants.map((participant) => participant.name).join(' ↔ ');
            const transcript = conversation.messages.map((message) => `
              <div class="conversation-turn ${message.fromAgent === agentId ? 'mine' : 'theirs'}">
                ${avatarFor(message.fromAgent, message.fromName)}
                <div class="conversation-content"><div><b>${escapeHtml(message.fromName)}</b><span>→ ${escapeHtml(message.toName)} · 第${(message.turnIndex ?? 0) + 1}轮</span></div>
                <p>${escapeHtml(message.content)}</p>
                <time>${gameTimeLabel(message.gameTime)}</time></div>
              </div>`).join('');
            return `<details class="conversation-card" ${conversation.status === 'active' || index === 0 ? 'open' : ''}>
              <summary><span>${escapeHtml(people)}</span><b data-status="${conversation.status}">${statusLabel[conversation.status]}</b><small>${conversation.turnCount} 轮</small></summary>
              <div class="conversation-meta">会话 ${escapeHtml(conversation.id.slice(0, 8))} · ${gameTimeLabel(conversation.startedGameTime)}${conversation.endedGameTime === null ? '' : ` — ${gameTimeLabel(conversation.endedGameTime)}`}</div>
              <div class="conversation-transcript">${transcript || `<p class="label">${conversationWaitingLabel(conversation.runtime)}</p>`}${transcript && conversation.status === 'active' && conversation.runtime?.stage === 'review' ? `<p class="label">${conversationWaitingLabel(conversation.runtime)}</p>` : ''}</div>
              ${conversation.summary ? `<div class="conversation-summary"><span>会话摘要</span>${escapeHtml(conversation.summary)}</div>` : ''}
              ${conversation.errorText ? `<div class="${conversation.status === 'interrupted' ? 'conversation-interruption' : 'conversation-error'}">${escapeHtml(conversation.errorText)}</div>` : ''}
            </details>`;
          }).join('')
        : mind.dialogues.length
          ? mind.dialogues.map((message) => `<div class="dl-item dialogue-row">${avatarFor(message.fromAgent, message.fromAgent)}<span>${escapeHtml(message.fromAgent)} → ${escapeHtml(message.toAgent)}：${escapeHtml(message.content)}</span></div>`).join('')
          : '<p class="label">暂无对话</p>';
    }
  } catch {
    if (version === renderVersion) body.innerHTML = '<p class="label">加载失败</p>';
  }
}

/** 绑定 #panel-tabs 点击：切换 activeTab（经 setActiveTab 回调写回 main.ts）并刷新面板 */
export function bindPanel(setActiveTab: (tab: string) => void, updatePanel: () => void): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#panel-tabs .tab'));
  tabs.forEach((tab) => { tab.tabIndex = tab.classList.contains('active') ? 0 : -1; });
  const activate = (tab: HTMLButtonElement) => {
    setActiveTab(tab.dataset.tab ?? 'detail');
    for (const item of tabs) {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    }
    updatePanel();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      activate(tab);
    });
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const target = tabs[(index + direction + tabs.length) % tabs.length];
      target.focus();
      activate(target);
    });
  });
}
