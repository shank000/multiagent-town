import { reviewDialogueTurn, type DialogueReviewResult } from '../engine/dialogue-review';
import { LLMGateway } from '../llm/gateway';
import type { LLMRequest } from '../llm/types';
import { gatewayConfigFromEnv, providerNameFromEnv } from '../llm/provider-config';
import { dialogueReviewCases, dialogueReviewHoldoutCases } from './fixtures/dialogue-review-cases';
import { dialogueReviewTransferCases } from './fixtures/dialogue-review-transfer-cases';

async function main(): Promise<void> {
  if (providerNameFromEnv() === 'mock') throw new Error('语义审校验收需要显式配置真实模型 LLM_PROVIDER=ollama|deepseek');
  const gateway = new LLMGateway({ ...gatewayConfigFromEnv(), maxConcurrent: 1 });
  const thinking = process.argv.includes('--thinking');
  const reviewer = thinking ? { complete: (request: LLMRequest) => gateway.complete({ ...request, reasoning: true, maxTokens: 2048 }) } : gateway;
  const results: (DialogueReviewResult & { id: string; cohort: string; expected: 'accepted' | 'revise'; matched: boolean })[] = [];
  const transfer = process.argv.includes('--transfer');
  const fixtures = transfer ? dialogueReviewTransferCases.map((fixture) => ({ ...fixture, cohort: 'transfer' })) : [
    ...dialogueReviewCases.map((fixture) => ({ ...fixture, cohort: 'calibration' })),
    ...dialogueReviewHoldoutCases.map((fixture) => ({ ...fixture, cohort: 'holdout' })),
  ];
  for (const fixture of fixtures) {
    const result = await reviewDialogueTurn(reviewer, fixture.context, { agentId: `review-check:${fixture.id}`, scopeId: 'real-review-check' });
    const row = { id: fixture.id, cohort: fixture.cohort, thinking, expected: fixture.expected, matched: result.status === fixture.expected, ...result };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  const matched = results.filter((result) => result.matched).length;
  console.log(`REAL_REVIEW_CHECK_SUMMARY ${JSON.stringify({ thinking, cases: results.length, matched, cohorts: [...new Set(results.map((result) => result.cohort))].map((cohort) => ({ cohort, cases: results.filter((result) => result.cohort === cohort).length, matched: results.filter((result) => result.cohort === cohort && result.matched).length })), missed: results.filter((result) => result.expected === 'revise' && result.status === 'accepted').length, falseRejections: results.filter((result) => result.expected === 'accepted' && result.status === 'revise').length, unavailable: results.filter((result) => result.status === 'unavailable').length, metrics: gateway.metricSummary() })}`);
  if (matched !== results.length) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
