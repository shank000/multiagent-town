import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearRelationshipDyadFocus,
  getRelationshipDyadFocus,
  renderMind,
  renderRelationshipDyadInspector,
  setRelationshipDyadFocus,
  type DyadMeasureKey,
  type DyadMeasureValue,
  type RelationshipDyadResponse,
} from '../src/web/client/panel';

const observed = (value: number, basis = 'partner_choice'): DyadMeasureValue => ({
  value, observed: true, numerator: 1, denominator: 2, basis,
});
const missing = (basis = 'partner_choice'): DyadMeasureValue => ({
  value: null, observed: false, numerator: null, denominator: null, basis,
});

const schemaRows: [DyadMeasureKey, string, 'existing-six' | 'added-four', 'directed' | 'dyad' | 'actor'][] = [
  ['partnerReturn', '伙伴回返', 'existing-six', 'directed'],
  ['tiePersistence', '关系持续性', 'existing-six', 'directed'],
  ['recencyEffect', '近因效应', 'existing-six', 'directed'],
  ['reciprocity', '互惠交换', 'existing-six', 'dyad'],
  ['relationalCarryOver', '关系延续效应', 'existing-six', 'directed'],
  ['partnerConcentration', '伙伴集中度', 'existing-six', 'actor'],
  ['interactionIntensity', '互动强度', 'added-four', 'directed'],
  ['multiplexity', '关系多重性', 'added-four', 'directed'],
  ['dependenceAsymmetry', '依赖不对称', 'added-four', 'dyad'],
  ['embeddedness', '网络嵌入性', 'added-four', 'dyad'],
];

function payload(): RelationshipDyadResponse {
  const aMeasures = Object.fromEntries(schemaRows.map(([key], index) => [key, observed((index + 1) / 12)]));
  const bMeasures = Object.fromEntries(schemaRows.map(([key], index) => [key, index === 0 ? missing() : observed((index + 2) / 13)]));
  aMeasures.partnerDependence = observed(.75);
  bMeasures.partnerDependence = observed(.5);
  return {
    schemaVersion: 'social-dyad.response/v2',
    worldId: 'w1',
    modelVersion: 'social-relations-v2',
    generatedGameTime: 3000,
    window: { days: 7, startGameTime: 0, endGameTime: 3000, label: '近 7 日' },
    proxyNotice: '<script>不是事实</script>',
    measureSchema: schemaRows.map(([key, label, family, level]) => ({
      key, label, family, level, shortLabel: label,
      source: 'source<unsafe>', description: `${label}<描述>`, caveat: '仅作探索<script>',
    })),
    dataQuality: ['证据覆盖有限<img src=x onerror=alert(1)>'],
    scope: { source: 'local_event_log<script>', validatedRun: null },
    people: {
      a: { id: 'agent:a', name: '甲<img src=x>' },
      b: { id: 'agent:b', name: '乙<script>' },
    },
    aToB: {
      fromId: 'agent:a', fromName: '甲', toId: 'agent:b', toName: '乙',
      dimensions: { closeness: .4, trust: .3, respect: .2, support: .1, tension: .05, frequency: .6 },
      measures: { ...aMeasures, channels: ['communication', 'partner_choice'] }, evidenceCount: 1,
    },
    bToA: {
      fromId: 'agent:b', fromName: '乙', toId: 'agent:a', toName: '甲',
      dimensions: { closeness: -.1, trust: .1, respect: .4, support: .2, tension: .3, frequency: .5 },
      measures: { ...bMeasures, channels: ['resource_exchange'] }, evidenceCount: 1,
    },
    dyad: {
      measures: {
        reciprocity: observed(.75, 'mixed'),
        dependenceAsymmetry: observed(.25),
        embeddedness: observed(.5, 'network_topology'),
      },
      commonNeighborCount: 2,
      unionNeighborCount: 4,
      tieLabel: '亲密关系事实',
    },
    evidenceSummary: { totalCount: 3, returnedCount: 2, truncated: true },
    evidenceTimeline: [{
      id: 'evidence:1', direction: '甲 → 乙<script>', sourceKind: 'dialogue<img>',
      sourceEventId: 'event:<unsafe>', sourceText: '一次坦诚交谈<script>', gameTime: 2200,
      affectionDelta: .1, respectDelta: .05, trustDelta: .1, supportDelta: 0, tensionDelta: 0,
    }],
    choiceEvents: [{ fromId: 'agent:a', toId: 'agent:b', gameTime: 2100, eventId: 'choice:<unsafe>' }],
    conversations: [{
      id: 'conversation:<unsafe>', status: 'completed', startedGameTime: 2000, endedGameTime: 2020,
      turnCount: 2, summary: '形成摘要<script>', errorText: '',
      participants: [{ id: 'agent:a', name: '甲' }, { id: 'agent:b', name: '乙' }],
      messages: [
        { id: 'm2', eventId: 'e2', turnIndex: 1, fromAgent: 'agent:b', fromName: '乙', toAgent: 'agent:a', toName: '甲', content: '后说<img>', gameTime: 2004 },
        { id: 'm1', eventId: 'e1', turnIndex: 0, fromAgent: 'agent:a', fromName: '甲', toAgent: 'agent:b', toName: '乙', content: '先说<script>', gameTime: 2002 },
      ],
    }],
  };
}

test('dyad 检查器呈现互动/关系/结构三层、6+4 测量、双向观察与来源', () => {
  const html = renderRelationshipDyadInspector(payload());
  for (const expected of [
    '1 · 互动层', '2 · 关系层', '3 · 结构层',
    '既有六项测量（描述性）', '新增四项测量（描述性）',
    ...schemaRows.map(([, label]) => label),
    '甲&lt;img src=x&gt; → 乙&lt;script&gt;', '乙&lt;script&gt; → 甲&lt;img src=x&gt;',
    '缺少可识别观察', '探索性旧六维画像（非关系事实）',
    '连贯会话 turn', '伙伴选择', '证据时间线', '来源事件',
    '选择份额', '沟通', '资源交换',
  ]) assert.ok(html.includes(expected), expected);
  assert.ok(html.indexOf('先说&lt;script&gt;') < html.indexOf('后说&lt;img&gt;'), '会话 turn 应按轮次连续排列');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('亲密关系事实'), '旧分类不得作为关系事实进入检查器');
});

test('dyad 检查器把非法轮次值降级为安全顺序标签', () => {
  const unsafe = payload();
  const firstMessage = unsafe.conversations[0]?.messages[0];
  assert.ok(firstMessage);
  (firstMessage as unknown as { turnIndex: unknown }).turnIndex = '<img src=x onerror=alert(1)>';
  const html = renderRelationshipDyadInspector(unsafe);
  assert.ok(html.includes('顺序 2'));
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'));
});

test('dyad 检查器把世界终止中断与生成异常明确区分', () => {
  const interrupted = payload();
  interrupted.conversations[0]!.status = 'interrupted';
  interrupted.conversations[0]!.errorText = '有限世界达到终点';
  const html = renderRelationshipDyadInspector(interrupted);
  assert.ok(html.includes('运行结束'));
  assert.ok(html.includes('class="conversation-interruption"'));
  assert.ok(html.includes('有限世界达到终点'));
  assert.ok(!html.includes('异常结束'));
});

test('choice-only 方向不会被显示为已观察的关系状态画像', () => {
  const choiceOnly = payload();
  choiceOnly.aToB!.relationshipStateObserved = false;
  const html = renderRelationshipDyadInspector(choiceOnly);
  assert.ok(html.includes('缺少持久化关系状态；当前方向仅有行为观察'));
});

test('会话已有台词时仍区分下一轮审校的排队与执行状态', () => {
  const sample = payload();
  sample.conversations[0].status = 'active';
  sample.conversations[0].runtime = { phase: 'queued_model', stage: 'review', waitMs: 3000, queueWaitMs: 3000 };
  assert.match(renderRelationshipDyadInspector(sample), /等待语义审校 · 3 秒/);
  sample.conversations[0].runtime = { phase: 'generating_model', stage: 'review', waitMs: 5000, generationMs: 2000 };
  assert.match(renderRelationshipDyadInspector(sample), /正在核对这句话的语义与事实 · 2 秒/);
  sample.conversations[0].status = 'completed';
  assert.doesNotMatch(renderRelationshipDyadInspector(sample), /正在核对这句话/);
});

test('dyad focus API 校验居民、钳制窗口并返回只读副本', () => {
  clearRelationshipDyadFocus();
  assert.throws(() => setRelationshipDyadFocus('agent:a', 'agent:a'));
  setRelationshipDyadFocus('agent:a', 'agent:b', 9000);
  const copy = getRelationshipDyadFocus();
  assert.deepEqual(copy, { aId: 'agent:a', bId: 'agent:b', windowDays: 3650 });
  copy!.aId = 'mutated';
  assert.equal(getRelationshipDyadFocus()?.aId, 'agent:a');
  setRelationshipDyadFocus('agent:a', 'agent:b', 'all');
  assert.equal(getRelationshipDyadFocus()?.windowDays, 'all');
  clearRelationshipDyadFocus();
  assert.equal(getRelationshipDyadFocus(), null);
});

test('较旧 dyad 响应不能覆盖更新后的 focus', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  let resolveDyad: ((response: Response) => void) | undefined;
  const dyadResponse = new Promise<Response>((resolve) => { resolveDyad = resolve; });
  const requested: string[] = [];
  const jsonResponse = (value: unknown) => ({ ok: true, json: async () => value }) as Response;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested.push(String(input));
    callCount++;
    if (callCount === 1) return jsonResponse({ worldId: 'w1', memories: [], reflections: [], dialogues: [], conversations: [] });
    return dyadResponse;
  }) as typeof fetch;
  const body = { innerHTML: '', querySelector: () => null } as unknown as HTMLElement;
  try {
    setRelationshipDyadFocus('agent:a', 'agent:b', 30);
    const pending = renderMind(body, 'agent:a', 'relation', 'w1');
    while (callCount < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    setRelationshipDyadFocus('agent:a', 'agent:c', 7);
    resolveDyad!(jsonResponse(payload()));
    await pending;
    assert.equal(body.innerHTML, '<p class="label">加载中…</p>');
    assert.match(requested[1], /\/api\/relationships\/dyad\?/);
    assert.match(requested[1], /worldId=w1/);
    assert.match(requested[1], /aId=agent%3Aa/);
    assert.match(requested[1], /bId=agent%3Ab/);
    assert.match(requested[1], /windowDays=30/);
  } finally {
    globalThis.fetch = originalFetch;
    clearRelationshipDyadFocus();
  }
});
