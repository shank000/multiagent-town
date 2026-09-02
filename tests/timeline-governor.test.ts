import test from 'node:test';
import assert from 'node:assert/strict';
import { TimelineGovernor } from '../src/engine/timeline-governor';
import { LLMGateway } from '../src/llm/gateway';
import type { LLMProvider, LLMResponse } from '../src/llm/types';

const measuredProvider = (totalMs: number, outputTokensPerSecond: number): LLMProvider => ({
  name: `measured-${totalMs}`,
  async complete(): Promise<LLMResponse> {
    return {
      content: '{}', parsed: {}, usage: { inputTokens: 1_000, outputTokens: 60, costYuan: 0 },
      performance: { totalMs, generationMs: totalMs, outputTokensPerSecond },
    };
  },
});

const request = {
  tier: 'small' as const, template: 'dialogue', messages: [], jsonMode: true,
  maxTokens: 128, priority: 'dialogue' as const,
};

test('智能时间治理器把极慢模型直接降到最低可持续档位', async () => {
  const gateway = new LLMGateway({
    provider: measuredProvider(60_000, 1), retries: 0, maxConcurrent: 1, expectedActiveAgents: 6,
  });
  await gateway.complete(request);
  await gateway.complete(request);
  const worlds = [{ id: 'w1', time: { gameMinutesPerTick: 0.5 } }];
  const adjustments: number[] = [];
  const governor = new TimelineGovernor(gateway, { onAdjustment: (event) => adjustments.push(event.toSpeed) });
  const state = governor.enableAdaptive(worlds);
  assert.equal(state.mode, 'adaptive');
  assert.equal(state.selectedSpeed, 0.05);
  assert.equal(state.manualSpeedLimit, 0.05);
  assert.equal(state.manualSpeedLimitReason, 'measured_capacity');
  assert.equal(worlds[0].time.gameMinutesPerTick, 0.025);
  assert.deepEqual(adjustments, [0.05]);
});

test('智能时间治理器降速立即生效，恢复提速需要连续稳定并逐档完成', async () => {
  const gateway = new LLMGateway({
    provider: measuredProvider(100, 600), retries: 0, maxConcurrent: 8, expectedActiveAgents: 1,
  });
  const worlds = [{ id: 'w1', time: { gameMinutesPerTick: 0.5 } }];
  const governor = new TimelineGovernor(gateway, { stableEvaluationsBeforeUpshift: 3 });
  governor.enableAdaptive(worlds);
  assert.equal(worlds[0].time.gameMinutesPerTick * 2, 0.2);
  await gateway.complete(request);
  governor.reconcile(worlds);
  governor.reconcile(worlds);
  assert.equal(worlds[0].time.gameMinutesPerTick * 2, 0.2);
  const recovered = governor.reconcile(worlds);
  assert.equal(recovered.selectedSpeed, 0.3);
  assert.equal(recovered.mode, 'adaptive');
});

test('手动档位保留小数速度并退出持续自适应', () => {
  const gateway = new LLMGateway({ provider: 'mock' });
  const worlds = [{ id: 'w1', time: { gameMinutesPerTick: 0.5 } }];
  const governor = new TimelineGovernor(gateway);
  const state = governor.setManual(0.3, worlds);
  assert.equal(state.mode, 'manual');
  assert.equal(state.selectedSpeed, 0.3);
  assert.equal(state.effectiveSpeed, 0.3);
  assert.equal(state.manualSpeedLimit, 60);
  assert.equal(state.manualSpeedLimitReason, 'mock_capacity');
});

test('真实 provider 在吞吐样本形成前采用保守手动速度上限', () => {
  const gateway = new LLMGateway({ provider: measuredProvider(1_000, 10), retries: 0 });
  const governor = new TimelineGovernor(gateway);
  assert.deepEqual(governor.manualSpeedLimit(), {
    manualSpeedLimit: 0.2,
    manualSpeedLimitReason: 'warming_up',
  });
});
