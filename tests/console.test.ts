import test from 'node:test';
import assert from 'node:assert/strict';
import { drawMetrics, hitTestNetwork, METRIC_DEFINITIONS, type MetricsPayload } from '../src/web/client/console';

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
