// 访谈命令：pnpm interview -- --agent 林晚晴 --question "昨天做了什么"

import { resolve } from 'node:path';
import { buildTown } from '../engine/seed';
import { openDb } from '../store/db';
import { MemoryStore } from '../store/memory';
import { LLMGateway } from '../llm/gateway';
import { interviewAgent } from '../engine/interview';

export interface InterviewArgs {
  agentName: string;
  question: string;
  dbPath: string;
}

export function parseArgs(argv: string[]): InterviewArgs {
  const args: InterviewArgs = { agentName: '', question: '', dbPath: resolve(process.cwd(), 'data/town.sqlite') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') args.agentName = argv[++i];
    else if (argv[i] === '--question') args.question = argv[++i];
    else if (argv[i] === '--db') args.dbPath = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.agentName || !args.question) {
    console.error('用法：pnpm interview -- --agent <名字> --question "<问题>" [--db 路径]');
    process.exit(1);
  }
  const agent = buildTown().allAgents().find((a) => a.name === args.agentName);
  if (!agent) {
    console.error(`找不到 agent：${args.agentName}`);
    process.exit(1);
  }
  const provider = process.env.LLM_PROVIDER === 'deepseek' ? 'deepseek' : 'mock';
  const llm = new LLMGateway({ provider, deepseek: { apiKey: process.env.DEEPSEEK_API_KEY ?? '' }, retries: 2 });
  const db = openDb(args.dbPath);
  const store = new MemoryStore(db);
  const now = Number(db.getMeta('game_time') ?? '0');
  const answer = await interviewAgent({ agent, question: args.question, llm, store, now });
  console.log(`问：${args.question}`);
  console.log(`${agent.name}：${answer}`);
}

void main();
