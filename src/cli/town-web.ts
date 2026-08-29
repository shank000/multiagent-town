// 像素小镇 Web 版：世界循环 + 本地网页服务（浏览器可视化，mock 默认离线）

import { LLMGateway } from '../llm/gateway';
import { providerNameFromEnv, gatewayConfigFromEnv } from '../llm/provider-config';
import { createTownServer } from '../web/server';
import { createManagedWorld, startAllWorlds, stopAllWorlds } from '../engine/world-factory';
import { assertFreshWorldDbPaths, parseArgs } from './town-web-config';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dbPaths = assertFreshWorldDbPaths(args);
  const provider = providerNameFromEnv();
  const gateway = new LLMGateway(gatewayConfigFromEnv());
  // 平行世界：三种社会实验各一世界（极简像素块示意见客户端小地图）
  const worlds = [
    createManagedWorld('w1', 'mem-on', {
      seed: 1,
      gameMinutesPerTick: args.speed * 0.5,
      gateway,
      dbPath: dbPaths.w1,
    }),
    createManagedWorld('w2', 'mem-off', {
      seed: 1,
      gameMinutesPerTick: args.speed * 0.5,
      gateway,
      dbPath: dbPaths.w2,
    }),
    createManagedWorld('w3', 'rumor', {
      seed: 1,
      gameMinutesPerTick: args.speed * 0.5,
      gateway,
      dbPath: dbPaths.w3,
    }),
  ];
  const main = worlds[0];
  const server = await createTownServer({ world: main.world, time: main.time, loop: main.loop, log: main.log, mind: main.mind, player: main.player, rels: main.mind.rels, rumors: main.mind.rumors, experiment: main.experiment ?? undefined, worlds, port: args.port });
  console.log(`[multiagent-town 像素小镇] provider=${provider} speed=${args.speed}游戏分钟/现实秒 db=${args.dbPath}`);
  console.log(`浏览器打开：http://127.0.0.1:${server.port} （按 Ctrl+C 停止）`);
  startAllWorlds(worlds);
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    stopAllWorlds(worlds);
    void (async () => {
      await server.close();
      await Promise.all(worlds.map((world) => world.loop.drain()));
      await Promise.all(worlds.map((world) => world.mind.dispose()));
      await gateway.drain();
      for (const world of worlds) world.db.raw.close();
      process.exit(0);
    })().catch((error) => {
      console.error('[town-web shutdown]', error);
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
