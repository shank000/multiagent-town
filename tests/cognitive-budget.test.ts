import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveCognitiveBudgetOptions, runCognitiveBudgetHarness } from '../src/cli/cognitive-budget';

interface BaselineFixture {
  baselineCommit: string;
  nonDialogueCalls: number;
  callsByTemplate: Record<string, number>;
}

const baseline = JSON.parse(readFileSync(fileURLToPath(
  new URL('./fixtures/cognitive-budget-m0.json', import.meta.url),
), 'utf8')) as BaselineFixture;

test('预算 harness 参数默认稳定并接受协调器 7 日配置', () => {
  assert.deepEqual(resolveCognitiveBudgetOptions(), { days: 2, tickMinutes: 5 });
  assert.deepEqual(resolveCognitiveBudgetOptions({ days: 7, tickMinutes: 10 }), { days: 7, tickMinutes: 10 });
  assert.throws(() => resolveCognitiveBudgetOptions({ days: 0 }), /days 必须是 1\.\.30/);
  assert.throws(() => resolveCognitiveBudgetOptions({ tickMinutes: 61 }), /tickMinutes 必须是 1\.\.60/);
});

test('2 日 6 人 custom counting harness 满足候选认知预算与落盘门', async () => {
  assert.equal(baseline.baselineCommit, 'bd6d943637b664e9349cd032625b36456ea02ef4');
  assert.equal(Object.values(baseline.callsByTemplate)
    .reduce((sum, calls) => sum + calls, 0) - baseline.callsByTemplate.dialogue - baseline.callsByTemplate.dialogue_summary,
  baseline.nonDialogueCalls);

  const candidate = await runCognitiveBudgetHarness();
  const calls = (template: string) => candidate.callsByTemplate[template] ?? 0;
  assert.ok(candidate.nonDialogueCalls <= baseline.nonDialogueCalls * 0.15,
    `candidate=${candidate.nonDialogueCalls}, baseline=${baseline.nonDialogueCalls}`);
  assert.equal(calls('importance'), 0);
  assert.equal(calls('hour_plan'), 0);
  assert.equal(calls('reflection_questions'), 0);
  assert.equal(calls('reflection_insights'), 0);
  assert.ok(calls('reflection_journal') <= candidate.persistedReflections);
  assert.ok(calls('action_decision') <= 24 * candidate.agents * candidate.days + candidate.agents);
  assert.ok(calls('daily_plan') <= candidate.agents * candidate.days * 2);
  assert.equal(candidate.cognitionBudget.modelRequests, calls('action_decision'));
  assert.ok(candidate.cognitionBudget.groundedContinuations > 0);
  assert.equal(candidate.providerAndGatewayCountsMatch, true);
  assert.equal(candidate.plansPresent, candidate.plansExpected);
  assert.equal(candidate.agendasPresent, candidate.plansExpected);
  assert.equal(candidate.dailyReflectionsPresent, candidate.dailyReflectionsExpected);
  assert.equal(candidate.dialogueCompleted, true);
  assert.ok(candidate.dialogueTurns >= 4 && candidate.dialogueTurns <= 6);
  assert.ok(candidate.dialogueCalls > 0);
  assert.equal(candidate.thinkingAgents, 0);
  assert.equal(candidate.schedulerActive, 0);
  assert.equal(candidate.schedulerQueued, 0);
});
