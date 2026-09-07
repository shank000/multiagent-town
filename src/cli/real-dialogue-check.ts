/** 用独立内存世界验收六位居民的连续对话，原生台词与安全兜底分别统计。 */
import { DialogueEngine, type DialogueQualityResult } from '../engine/dialogue';
import { buildTown } from '../engine/seed';
import { LLMGateway } from '../llm/gateway';
import { gatewayConfigFromEnv, providerNameFromEnv } from '../llm/provider-config';
import { openDb } from '../store/db';
import { EventLog } from '../store/events';
import { MemoryStore } from '../store/memory';

const cases = [
  { a: '陈默', b: '沈屿', place: 'obj:bookstore', topic: '身旁的书架上有一本《乡土中国》。', aFact: '最近在读费孝通的《乡土中国》，喜欢其中对熟人社会的观察。', bFact: '最近没有在读书，主要精力都放在为画展补一幅雨天作品。' },
  { a: '林晚晴', b: '白露', place: 'obj:cafe', topic: '桌上有一杯尚未饮用的无糖手冲咖啡。', aFact: '这杯咖啡是手冲，暂时没有加糖。', bFact: '我喜欢喝不加糖的咖啡。' },
  { a: '周岚', b: '老周', place: 'obj:plaza', topic: '周岚和老周在广场相遇。', aFact: '今天送信时发现一封信写着旧地址，后来在广场找到了收信人并核对姓名。', bFact: '早上在广场看见两个年轻人匆忙赶路。' },
] as const;

async function main(): Promise<void> {
  if (providerNameFromEnv() === 'mock') throw new Error('连续对话验收需要显式配置真实模型 LLM_PROVIDER=ollama|deepseek');
  const gateway = new LLMGateway({ ...gatewayConfigFromEnv(), maxConcurrent: 1 });
  const started = Date.now();
  const initialMemory = process.memoryUsage();
  const results = [];
  for (const fixture of cases) {
    const db = openDb(':memory:');
    const store = new MemoryStore(db);
    const log = new EventLog(db);
    const world = buildTown();
    const a = world.allAgents().find((agent) => agent.name === fixture.a)!;
    const b = world.allAgents().find((agent) => agent.name === fixture.b)!;
    const engine = new DialogueEngine(gateway, store, log, 6, undefined, undefined, { scopeId: `real-dialogue-check:${a.id}` });
    let now = 600;
    try {
      const place = world.getObject(fixture.place);
      if (!place) throw new Error(`验收地点不存在：${fixture.place}`);
      a.x = place.x + 1; a.y = place.y + 1; b.x = a.x + 1; b.y = a.y;
      a.locationId = fixture.place; b.locationId = fixture.place;
      for (const [agentId, content] of [[a.id, fixture.aFact], [b.id, fixture.bFact]]) {
        store.addMemory({ agentId, kind: 'observation', content, importance: 8, createdGameTime: now - 1 });
      }
      if (!engine.start(a, b, now, {
        source: 'manual', world, trigger: { initiatorId: a.id, reason: 'co_presence', evidence: [fixture.topic], evidenceEventIds: [] },
      })) throw new Error('独立验收场景未能启动会话');
      for (let step = 0; step < 32; step += 1) {
        await engine.drain();
        now += 2;
        engine.tick(world, 2, now);
        if (store.conversationsFor(a.id)[0]?.status !== 'active') break;
      }
      await engine.drain();
      const conversation = store.conversationsFor(a.id)[0];
      const evidence = log.eventsForDay(1).filter((event) => event.payload?.kind === 'chat');
      const turns = (conversation?.messages ?? []).map((message) => ({
        speaker: world.getAgent(message.fromAgent).name,
        listener: world.getAgent(message.toAgent).name,
        content: message.content,
        quality: evidence.find((event) => event.id === message.eventId)?.payload?.quality as DialogueQualityResult | undefined,
      }));
      const completed = conversation?.status === 'completed' && turns.length >= 4 && turns.length <= 6;
      const modelTurns = turns.filter((turn) => turn.quality?.status === 'validated').length;
      const repairedTurns = turns.filter((turn) => turn.quality?.status === 'validated' && (turn.quality.attempts ?? 0) > 1).length;
      const fallbackTurns = turns.filter((turn) => turn.quality?.status === 'safe_fallback').length;
      const reviewedTurns = turns.filter((turn) => turn.quality?.semanticReview.status === 'accepted').length;
      const result = { pair: `${a.name} ↔ ${b.name}`, completed, status: conversation?.status, error: conversation?.errorText, modelTurns, repairedTurns, fallbackTurns, reviewedTurns, turns };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await engine.drain();
      db.raw.close();
    }
  }
  const scheduler = gateway.schedulerSnapshot();
  const runtimeIdle = scheduler.active === 0 && scheduler.queued === 0 && !scheduler.backpressured;
  const automaticGatePassed = runtimeIdle && results.every((result) => result.completed && result.fallbackTurns === 0 && result.reviewedTurns === result.turns.length);
  console.log(`REAL_DIALOGUE_CHECK_SUMMARY ${JSON.stringify({ automaticGatePassed, humanReviewRequired: true, cases: results.length, completed: results.filter((result) => result.completed).length, modelTurns: results.reduce((sum, result) => sum + result.modelTurns, 0), repairedTurns: results.reduce((sum, result) => sum + result.repairedTurns, 0), fallbackTurns: results.reduce((sum, result) => sum + result.fallbackTurns, 0), reviewedTurns: results.reduce((sum, result) => sum + result.reviewedTurns, 0), runtimeIdle, elapsedMs: Date.now() - started, memoryBytes: { before: initialMemory, after: process.memoryUsage() }, scheduler, metrics: gateway.metricSummary() })}`);
  if (!automaticGatePassed) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
