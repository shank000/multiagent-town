import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/store/db';
import { MemoryStore } from '../src/store/memory';
import { LLMGateway } from '../src/llm/gateway';
import { interviewAgent } from '../src/engine/interview';
import { buildTown } from '../src/engine/seed';

test('访谈回答引用检索到的记忆', async () => {
  const db = openDb(':memory:');
  const store = new MemoryStore(db);
  const agent = buildTown().allAgents()[0]; // 林晚晴
  store.addMemory({ agentId: agent.id, kind: 'observation', content: '第1天 10:00，林晚晴 开始「煮咖啡」，约 15 分钟', importance: 6, createdGameTime: 600 });
  const answer = await interviewAgent({ agent, question: '你今天做了什么？', llm: new LLMGateway({ provider: 'mock' }), store, now: 700 });
  assert.ok(answer.includes('我记得'));
  assert.ok(answer.includes('煮咖啡'));
});
