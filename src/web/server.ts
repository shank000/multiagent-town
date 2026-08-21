// 像素小镇本地 Web 服务：静态页面 + 快照/事件 SSE + 世界控制（零新增依赖，node:http）

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TimeEngine } from '../core/time';
import type { WorldState } from '../core/world';
import type { WorldLoop } from '../engine/loop';
import type { EventLog } from '../store/events';
import type { RelationshipStore } from '../store/relationships';
import type { RumorTracker } from '../engine/rumors';
import type { GameEvent } from '../core/types';
import type { MindEngine } from '../engine/mind';
import type { PlayerDirector } from '../engine/player';
import { computeStanding } from '../engine/status';
import { buildSnapshot, type WorldSnapshot } from './snapshot';

export interface TownWebOptions {
  world: WorldState;
  time: TimeEngine;
  loop: WorldLoop;
  log: EventLog;
  mind?: MindEngine;    // M1 认知核心（心智面板数据源）
  player?: PlayerDirector;    // 玩家扮演
  rels?: RelationshipStore;  // M3 关系存储（声望/关系 API 数据源）
  rumors?: RumorTracker;  // M3 谣言追踪（种子 API 数据源）
  publicDir?: string;   // 默认 <cwd>/public
  snapshotMs?: number;  // 默认 200
  port?: number;        // 默认 0 = 系统随机端口
}

export interface TownWebServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

export async function createTownServer(opts: TownWebOptions): Promise<TownWebServer> {
  const publicDir = opts.publicDir ?? resolve(process.cwd(), 'public');
  const snapshotMs = opts.snapshotMs ?? 200;
  const { world, time, loop, log } = opts;
  const clients = new Set<ServerResponse>();
  let seq = 0;
  let paused = false;

  function currentSnapshot(): WorldSnapshot {
    return buildSnapshot(world, time, paused, ++seq);
  }
  function send(res: ServerResponse, event: string, data: unknown): void {
    if (res.writableEnded || res.destroyed) {
      clients.delete(res);
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  function broadcast(event: string, data: unknown): void {
    for (const c of clients) send(c, event, data);
  }
  const unsubLog = log.subscribe((e: GameEvent) => broadcast('event', e));

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        send(res, 'snapshot', currentSnapshot());
        req.on('close', () => clients.delete(res));
        res.on('error', () => clients.delete(res));
        return;
      }
      if (url.pathname === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(currentSnapshot()));
        return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (!opts.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const standing = computeStanding(opts.rels.allPairs());
        const list = [...standing.entries()]
          .map(([id, score]) => ({ id, name: world.allAgents().find((a) => a.id === id)?.name ?? id, score }))
          .sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(list));
        return;
      }
      if (url.pathname.startsWith('/api/relationships/') && req.method === 'GET') {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/relationships/'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        if (!opts.rels) {
          res.writeHead(404);
          res.end('关系未启用');
          return;
        }
        const relations = opts.rels.allFor(id).map((r) => ({
          otherId: r.agentB,
          otherName: world.allAgents().find((a) => a.id === r.agentB)?.name ?? r.agentB,
          affection: r.affection,
          respect: r.respect,
          knowledgeCount: r.knowledge.length,
        }));
        const standings = [...computeStanding(opts.rels.allPairs()).entries()]
          .map(([sid, score]) => ({ id: sid, name: world.allAgents().find((a) => a.id === sid)?.name ?? sid, score }))
          .sort((a, b) => b.score - a.score);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ relations, standings }));
        return;
      }
      if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/mind') && req.method === 'GET') {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/mind'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        if (!opts.mind) {
          res.writeHead(404);
          res.end('mind 未启用');
          return;
        }
        const body: { memories: unknown[]; reflections: unknown[]; plans: unknown[]; dialogues: unknown[] } = {
          memories: opts.mind.store.recentMemories(id, 50),
          reflections: opts.mind.store.reflectionsFor(id),
          plans: [], // 计划列表：取当天与前一天
          dialogues: opts.mind.store.messagesFor(id, 50),
        };
        for (let day = Math.floor(time.state.totalMinutes / 1440) + 1; day >= 1 && body.plans.length < 4; day--) {
          const p = opts.mind.store.planFor(id, day);
          if (p) body.plans.push(p);
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
        return;
      }
      if (url.pathname.startsWith('/api/player/') && url.pathname.endsWith('/act')) {
        let id: string;
        try {
          id = decodeURIComponent(url.pathname.slice('/api/player/'.length, -'/act'.length));
        } catch {
          res.writeHead(400);
          res.end('bad id');
          return;
        }
        if (req.method === 'POST') {
          const body = (await readBody(req)) as { instruction?: unknown };
          const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 120) : '';
          if (!instruction) {
            res.writeHead(400);
            res.end('指令不能为空');
            return;
          }
          if (!opts.player) {
            res.writeHead(404);
            res.end('扮演未启用');
            return;
          }
          opts.player.act(id, instruction, time.state.totalMinutes);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'DELETE') {
          opts.player?.clear(id);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }
      if (url.pathname === '/api/broadcast' && req.method === 'POST') {
        const body = (await readBody(req)) as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        if (!text) {
          res.writeHead(400);
          res.end('广播内容不能为空');
          return;
        }
        log.addEvent({
          id: randomUUID(),
          type: 'broadcast',
          actorId: null,
          targetIds: world.allAgents().map((a) => a.id),
          description: `小镇广播：${text}`,
          location: null,
          gameTime: time.state.totalMinutes,
          payload: { kind: 'broadcast', text },
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === '/api/rumor' && req.method === 'POST') {
        const body = (await readBody(req)) as { text?: unknown; sourceId?: unknown };
        const text = typeof body.text === 'string' ? body.text.slice(0, 120) : '';
        const sourceId = typeof body.sourceId === 'string' ? body.sourceId : world.allAgents()[0]?.id;
        if (!text || !sourceId || !opts.rumors) {
          res.writeHead(400);
          res.end('谣言内容/来源无效');
          return;
        }
        const id = opts.rumors.seed(sourceId, text, time.state.totalMinutes);
        // 源头确定性高重要度记忆（不依赖 LLM 打分）
        opts.mind?.store.addMemory({ agentId: sourceId, kind: 'observation', content: `第${Math.floor(time.state.totalMinutes / 1440) + 1}天 我知道了一个秘密：${text}`, importance: 9, createdGameTime: time.state.totalMinutes });
        log.addEvent({
          id: randomUUID(), type: 'system', actorId: sourceId, targetIds: [],
          description: `「${world.getAgent(sourceId)?.name ?? sourceId}」听说了一个秘密：${text}`, location: null,
          gameTime: time.state.totalMinutes, payload: { kind: 'rumor_seed', rumorId: id, text },
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, id }));
        return;
      }
      if (url.pathname === '/api/world/control' && req.method === 'POST') {
        const body = (await readBody(req)) as { action?: string; value?: number };
        if (body.action === 'pause') {
          paused = true;
          loop.stop();
        } else if (body.action === 'resume') {
          paused = false;
          loop.start();
        } else if (body.action === 'speed' && typeof body.value === 'number' && body.value > 0) {
          time.gameMinutesPerTick = body.value * 0.5;
          if (!paused) {
            loop.stop();
            loop.start();
          }
        } else {
          res.writeHead(400);
          res.end('bad control');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname.startsWith('/assets/') && req.method === 'GET') {
        const name = url.pathname.slice('/assets/'.length);
        if (!/^[A-Za-z0-9_-]+(\.[A-Za-z0-9]+)?$/.test(name)) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        return await file(res, resolve(publicDir, 'assets', name));
      }
      if (url.pathname === '/') return await file(res, resolve(publicDir, 'index.html'));
      if (url.pathname === '/client.js' || url.pathname === '/style.css') {
        return await file(res, resolve(publicDir, url.pathname.slice(1)));
      }
      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      res.writeHead(500);
      res.end(e instanceof Error ? e.message : String(e));
    }
  });

  async function file(res: ServerResponse, path: string): Promise<void> {
    const content = await readFile(path);
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  }
  async function readBody(req: IncomingMessage): Promise<unknown> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const interval = setInterval(() => broadcast('snapshot', currentSnapshot()), snapshotMs);
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (c.writableEnded || c.destroyed) clients.delete(c);
      else c.write(': ping\n\n');
    }
  }, 15_000);

  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        loop.stop(); // 服务停止时一并停掉世界循环（调速/恢复可能由本服务启动过 loop）
        unsubLog();  // 解除事件订阅，防止 close 后订阅泄漏
        clearInterval(interval);
        clearInterval(heartbeat);
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}
