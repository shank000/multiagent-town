import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceToSegment,
  drawMetrics,
  drawNetwork,
  hitTestNetwork,
  hitTestNetworkEdge,
  networkDyadEdgeId,
  networkEdgeId,
  networkLensLevel,
  networkLensValue,
  resetNetworkLayout,
  METRIC_DEFINITIONS,
  type MetricsPayload,
  type SocialNetworkEdge,
  type SocialNetworkPayload,
} from '../src/web/client/console';
import {
  emptyDirectedRelationalMeasures,
  emptyDyadRelationalMeasures,
} from '../src/engine/relational-measures';
import type { AgentView } from '../src/web/client/panel';

function agent(id: string, name: string): AgentView {
  return {
    id, name, occupation: '研究居民', state: 'idle', age: 30, gender: '未设定',
    appearance: { hairStyle: '', hairColor: '', skinTone: '', outfit: '' },
    hobbies: [], skills: {}, values: [], motivation: '',
    traits: [], goals: [], speechStyle: '',
    personality: { extraversion: 0.5, empathy: 0.5, honesty: 0.5, curiosity: 0.5, patience: 0.5 },
    avatar: { sprite: 0, hair: '#333333', skin: '#eeeeee', outfit: '#555555', accent: '#aaaaaa', accessory: 'none' },
    initialState: { valence: 0, energy: .5, stress: .5, socialNeed: .5, occupationalFocus: .5, startingLocationId: 'obj:plaza' },
    x: 0, y: 0, locationId: '', locationName: '', verb: '', thought: null,
    actionType: null, targetId: null, targetName: null, path: [], spriteIndex: 0, background: '',
  };
}

function canvasContext(): CanvasRenderingContext2D {
  return {
    fillStyle: '', strokeStyle: '', font: '', textAlign: 'left', lineWidth: 1, lineCap: 'butt',
    fillRect() {}, fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, fill() {}, arc() {},
  } as unknown as CanvasRenderingContext2D;
}

function canvasRecorder(): { ctx: CanvasRenderingContext2D; points: Array<[number, number]> } {
  const points: Array<[number, number]> = [];
  const ctx = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left',
    fillRect() {}, beginPath() {}, stroke() {}, fillText() {},
    moveTo(x: number, y: number) { points.push([x, y]); },
    lineTo(x: number, y: number) { points.push([x, y]); },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, points };
}

test('指标主图支持比例、多样性和负持续性三种量纲', () => {
  const { ctx, points } = canvasRecorder();
  const metrics: MetricsPayload = {
    repeat: [0.2, 0.8],
    recip: [0.5, 1.4],
    clus: [0.1, 0.3],
    div: [2, 4.5],
    hhi: [0.7, 0.9],
    persistence: [-0.6, 0.75],
    hub: [0, 1],
    pairs: [],
  };

  for (const metric of METRIC_DEFINITIONS) assert.doesNotThrow(() => drawMetrics(ctx, metrics, 900, 720, metric.key));
  assert.ok(points.length >= 12);
  assert.ok(points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(points.every(([, y]) => y >= 0 && y <= 720));
});

test('网络节点命中使用 CSS 坐标和可操作半径', () => {
  const nodes = [
    { agentId: 'agent:a', x: 100, y: 80, radius: 23 },
    { agentId: 'agent:b', x: 220, y: 120, radius: 26 },
  ];
  assert.equal(hitTestNetwork(nodes, 102, 82), 'agent:a');
  assert.equal(hitTestNetwork(nodes, 244, 120), 'agent:b');
  assert.equal(hitTestNetwork(nodes, 160, 200), null);
});

test('point-to-segment distance covers horizontal, vertical, diagonal, and zero-length geometry', () => {
  assert.equal(distanceToSegment(5, 3, 0, 0, 10, 0), 3);
  assert.equal(distanceToSegment(4, 5, 4, 0, 4, 10), 0);
  assert.ok(Math.abs(distanceToSegment(0, 2, 0, 0, 2, 2) - Math.SQRT2) < 1e-9);
  assert.equal(distanceToSegment(3, 4, 0, 0, 0, 0), 5);
});

test('directed parallel edges use stable ids and their actual drawn geometry for hit testing', () => {
  resetNetworkLayout();
  const result = drawNetwork(
    canvasContext(),
    [agent('agent:a', '甲'), agent('agent:b', '乙')],
    [{ pair: '0:1', count: 4 }, { pair: '1:0', count: 2 }],
    500,
    360,
    1_000,
    { mode: 'choice' },
  );

  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 2);
  assert.equal(result.totalEdges, 2);
  assert.equal(result.edges[0].id, networkEdgeId('choice', result.edges[0].fromId, result.edges[0].toId));
  for (const edge of result.edges) {
    const hit = hitTestNetworkEdge(result.edges, (edge.startX + edge.endX) / 2, (edge.startY + edge.endY) / 2);
    assert.equal(hit?.id, edge.id);
  }
  const firstMid = {
    x: (result.edges[0].startX + result.edges[0].endX) / 2,
    y: (result.edges[0].startY + result.edges[0].endY) / 2,
  };
  const secondMid = {
    x: (result.edges[1].startX + result.edges[1].endX) / 2,
    y: (result.edges[1].startY + result.edges[1].endY) / 2,
  };
  assert.equal(hitTestNetworkEdge(result.edges, (firstMid.x + secondMid.x) / 2, (firstMid.y + secondMid.y) / 2), null);
  const node = result.nodes[0];
  assert.equal(hitTestNetwork(result.nodes, node.x, node.y), node.agentId);
});

test('network lenses keep directed and dyad measures separate and preserve missingness', () => {
  const measures = emptyDirectedRelationalMeasures();
  measures.partnerReturn = { value: 0.625, observed: true, numerator: 5, denominator: 8, basis: 'partner_choice' };
  const edge: SocialNetworkEdge = {
    fromId: 'a', fromName: '甲', toId: 'b', toName: '乙',
    strength: 0.4, valence: 0.2, recentChange: 0, evidenceCount: 3,
    tieType: 'acquaintance', tieLabel: '兼容画像',
    dimensions: { closeness: 0, trust: 0, respect: 0, support: 0, tension: 0, frequency: 0 },
    measures,
  };
  const dyadMeasures = emptyDyadRelationalMeasures();
  dyadMeasures.embeddedness = { value: 0.5, observed: true, numerator: 1, denominator: 2, basis: 'network_topology' };
  const dyad = {
    aId: 'a', aName: '甲', bId: 'b', bName: '乙', reciprocity: 0, asymmetry: 0,
    strength: 0.4, recentChange: 0, tieType: 'acquaintance' as const, tieLabel: '兼容画像',
    measures: dyadMeasures,
  } satisfies SocialNetworkPayload['dyads'][number];

  assert.equal(networkLensValue(edge, dyad, 'overall'), 0.4);
  assert.equal(networkLensValue(edge, dyad, 'partnerReturn'), 0.625);
  assert.equal(networkLensValue(edge, dyad, 'embeddedness'), 0.5);
  assert.equal(networkLensValue(edge, undefined, 'embeddedness'), null);
  assert.equal(networkLensValue(edge, dyad, 'tiePersistence'), null);
});

test('dyad lenses render one undirected relationship while actor lenses render node rings', () => {
  const aMeasures = emptyDirectedRelationalMeasures();
  aMeasures.partnerConcentration = { value: 0.75, observed: true, numerator: 3, denominator: 4, basis: 'partner_choice' };
  const bMeasures = emptyDirectedRelationalMeasures();
  const socialEdges: SocialNetworkEdge[] = [
    {
      fromId: 'a', fromName: '甲', toId: 'b', toName: '乙', strength: 0.7, valence: 0.1,
      recentChange: 0, evidenceCount: 4, tieType: 'supportive', tieLabel: '支持画像',
      dimensions: { closeness: 0.4, trust: 0.3, respect: 0.2, support: 0.5, tension: 0, frequency: 0.6 },
      measures: aMeasures,
    },
    {
      fromId: 'b', fromName: '乙', toId: 'a', toName: '甲', strength: 0.5, valence: 0,
      recentChange: 0, evidenceCount: 2, tieType: 'familiar', tieLabel: '熟悉画像',
      dimensions: { closeness: 0.2, trust: 0.2, respect: 0.2, support: 0.1, tension: 0, frequency: 0.4 },
      measures: bMeasures,
    },
  ];
  const dyadMeasures = emptyDyadRelationalMeasures();
  dyadMeasures.reciprocity = { value: 0.5, observed: true, numerator: 2, denominator: 4, basis: 'mixed' };
  const dyads: SocialNetworkPayload['dyads'] = [{
    aId: 'a', aName: '甲', bId: 'b', bName: '乙', reciprocity: 0.5, asymmetry: 0.2,
    strength: 0.6, recentChange: 0, tieType: 'familiar', tieLabel: '熟悉画像',
    measures: dyadMeasures,
  }];
  const agents = [agent('a', '甲'), agent('b', '乙')];

  resetNetworkLayout();
  const dyadResult = drawNetwork(canvasContext(), agents, [], 500, 360, 1_000, {
    mode: 'social', lens: 'reciprocity', socialEdges, socialDyads: dyads,
  });
  assert.equal(networkLensLevel('reciprocity'), 'dyad');
  assert.equal(dyadResult.totalEdges, 1);
  assert.equal(dyadResult.edges.length, 1);
  assert.equal(dyadResult.edges[0].directed, false);
  assert.equal(dyadResult.edges[0].id, networkDyadEdgeId('social', 'a', 'b'));

  resetNetworkLayout();
  const actorResult = drawNetwork(canvasContext(), agents, [], 500, 360, 1_000, {
    mode: 'social', lens: 'partnerConcentration', socialEdges, socialDyads: dyads,
  });
  assert.equal(networkLensLevel('partnerConcentration'), 'actor');
  assert.equal(actorResult.countUnit, 'actor');
  assert.equal(actorResult.edges.length, 0);
  assert.equal(actorResult.totalActors, 2);
  assert.equal(actorResult.visibleActors, 1);
  assert.equal(actorResult.missingActors, 1);
  assert.equal(actorResult.nodes.find((node) => node.agentId === 'a')?.actorValueVisible, true);
  assert.equal(actorResult.nodes.find((node) => node.agentId === 'b')?.actorValue, null);
});

test('lens observation counts use focal events and Ego totals exclude unrelated relationships', () => {
  const observed = emptyDirectedRelationalMeasures();
  observed.recencyEffect = {
    value: 1,
    observed: true,
    numerator: 0,
    denominator: 10_080,
    basis: 'partner_choice',
  };
  observed.choiceCount = 1;
  const missing = emptyDirectedRelationalMeasures();
  const socialEdges: SocialNetworkEdge[] = [
    {
      fromId: 'a', fromName: '甲', toId: 'b', toName: '乙', strength: 0, valence: 0,
      recentChange: 0, evidenceCount: 0, relationshipStateObserved: false,
      tieType: 'acquaintance', tieLabel: '证据稀疏画像',
      dimensions: { closeness: 0, trust: 0, respect: 0, support: 0, tension: 0, frequency: 0 },
      measures: observed,
    },
    {
      fromId: 'c', fromName: '丙', toId: 'd', toName: '丁', strength: 0, valence: 0,
      recentChange: 0, evidenceCount: 0, relationshipStateObserved: false,
      tieType: 'acquaintance', tieLabel: '证据稀疏画像',
      dimensions: { closeness: 0, trust: 0, respect: 0, support: 0, tension: 0, frequency: 0 },
      measures: missing,
    },
  ];
  resetNetworkLayout();
  const result = drawNetwork(
    canvasContext(),
    [agent('a', '甲'), agent('b', '乙'), agent('c', '丙'), agent('d', '丁')],
    [],
    600,
    400,
    1_000,
    { mode: 'social', lens: 'recencyEffect', socialEdges, egoId: 'a' },
  );
  assert.equal(result.totalEdges, 1);
  assert.equal(result.missingEdges, 0);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].evidenceCount, 1, '半衰期分母不是事件计数');
  assert.equal(result.edges[0].relationshipStateObserved, false);
});
