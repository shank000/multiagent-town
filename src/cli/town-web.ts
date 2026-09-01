// 像素小镇 Web 版：世界循环 + 本地网页服务（浏览器可视化，mock 默认离线）

import { LLMGateway } from '../llm/gateway';
import { providerNameFromEnv, gatewayConfigFromEnv } from '../llm/provider-config';
import { createTownServer } from '../web/server';
import { startAllWorlds } from '../engine/world-factory';
import { parseArgs } from './town-web-config';
import { loadAgentProfileConfig } from '../store/agent-profile-config';
import { BackendRuntimeLog, runtimeLogPathForDatabase } from '../runtime/backend-log';
import { ExperimentWorkspaceRuntime, nextWorkspaceDatabasePath } from '../engine/workspace';

let runtimeLog: BackendRuntimeLog | null = null;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  runtimeLog = new BackendRuntimeLog(runtimeLogPathForDatabase(args.dbPath));
  const provider = providerNameFromEnv();
  const gateway = new LLMGateway({
    ...gatewayConfigFromEnv(),
    expectedActiveAgents: args.worldKinds.length * 6,
    onDiagnostic: (event) => {
      const message = JSON.stringify(event);
      if (event.status === 'failed') runtimeLog?.error('llm-request', message);
      else runtimeLog?.debug('llm-request', message);
    },
  });
  const profileStorePath = process.env.TOWN_PROFILE_PATH?.trim() || undefined;
  const workspaceOptions = {
    gateway,
    runtimeLog,
    profileOverrides: () => loadAgentProfileConfig(profileStorePath),
    nextDatabasePath: () => nextWorkspaceDatabasePath(args.dbPath),
  };
  const workspace = args.resume
    ? await ExperimentWorkspaceRuntime.resume(args.dbPath, workspaceOptions)
    : await ExperimentWorkspaceRuntime.create({
        name: args.workspaceName,
        seed: args.seed,
        worldSpeed: args.speed,
        defaultExperimentDays: 30,
        worldKinds: args.worldKinds,
        startPaused: false,
      }, workspaceOptions, args.dbPath, args.dbPathExplicit);
  const main = workspace.current.worlds[0];
  const server = await createTownServer({
    world: main.world, time: main.time, loop: main.loop, log: main.log, mind: main.mind,
    player: main.player, rels: main.mind.rels, rumors: main.mind.rumors,
    experiment: main.experiment ?? undefined, worlds: workspace.current.worlds, workspace,
    port: args.port, llm: gateway, profileStorePath, runtimeLog,
  });
  console.log(`[multiagent-town 像素小镇] provider=${provider} workspace=${workspace.current.meta.name} worlds=${workspace.current.meta.worldIds.join(',')} speed=${workspace.current.meta.worldSpeed}游戏分钟/现实秒 db=${args.dbPath} resumed=${args.resume}`);
  console.log(`后端日志：${runtimeLog.filePath}`);
  console.log(`浏览器打开：http://127.0.0.1:${server.port} （按 Ctrl+C 停止）`);
  startAllWorlds(workspace.current.worlds);
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    void (async () => {
      await server.close();
      await workspace.dispose();
      await gateway.drain();
      runtimeLog?.close();
      process.exit(0);
    })().catch((error) => {
      console.error('[town-web shutdown]', error);
      process.exit(1);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  console.error('[town-web startup]', error);
  runtimeLog?.close();
  process.exitCode = 1;
});
