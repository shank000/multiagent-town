import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../src/web/client/panel';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}/public/index.html`, 'utf8');
const css = readFileSync(`${root}/public/style.css`, 'utf8');
const client = readFileSync(`${root}/src/web/client/main.ts`, 'utf8');
const panelClient = readFileSync(`${root}/src/web/client/panel.ts`, 'utf8');
const consoleClient = readFileSync(`${root}/src/web/client/console.ts`, 'utf8');
const avatarClient = readFileSync(`${root}/src/web/client/avatar.ts`, 'utf8');
const server = readFileSync(`${root}/src/web/server.ts`, 'utf8');
const statsHtml = readFileSync(`${root}/public/stats.html`, 'utf8');
const statsClient = readFileSync(`${root}/src/web/client/stats.ts`, 'utf8');
const logsHtml = readFileSync(`${root}/public/logs.html`, 'utf8');
const logsClient = readFileSync(`${root}/src/web/client/logs.ts`, 'utf8');
const packageJson = readFileSync(`${root}/package.json`, 'utf8');

test('research console exposes town, relationship and inspector viewports simultaneously', () => {
  for (const id of ['town-body', 'game', 'net-canvas', 'metrics-canvas', 'character-card', 'panel-body', 'narrative']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /class="viewport town-viewport"/);
  assert.match(html, /class="viewport relation-viewport"/);
  assert.match(html, /class="viewport inspector-viewport"/);
  assert.doesNotMatch(html, /id="view-(?:narrative|map|net|metrics)"/);
});

test('three-view layout has desktop and responsive grid contracts', () => {
  assert.match(css, /#research-workspace\s*\{[^}]*display:\s*grid/s);
  assert.match(css, /grid-template-columns:\s*minmax\(480px,[^;]+;/);
  assert.match(css, /@media \(max-width:\s*1380px\)/);
  assert.match(css, /@media \(max-width:\s*980px\)/);
  assert.match(css, /#research-workspace\[data-focus/);
  assert.match(css, /#research-workspace\[data-focus="relations"\]\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /#research-workspace\[data-focus="relations"\] \.relation-viewport\s*\{[^}]*min-height:\s*980px/s);
  assert.match(css, /grid-template-rows:\s*minmax\(520px,\s*1fr\)\s*minmax\(300px,\s*\.9fr\)/);
  assert.match(css, /\.relation-viewport \.viewport-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /@media \(max-width:\s*620px\)[\s\S]*?\.network-stage\s*\{[^}]*min-height:\s*320px/s);
  assert.match(css, /grid-template-rows:\s*minmax\(720px,\s*1fr\)\s*minmax\(320px,\s*\.75fr\)/);
  assert.match(css, /@media \(max-width:\s*420px\)[\s\S]*?grid-template-rows:\s*minmax\(900px,\s*1fr\)\s*minmax\(320px,\s*\.6fr\)/s);
});

test('research console exposes readable controls and keyboard-accessible semantics', () => {
  for (const id of ['map-zoom-out', 'map-reset', 'map-zoom-in', 'network-reset', 'metric-tabs', 'ui-toast']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /data-focus-view="town"/);
  assert.match(html, /role="tab" aria-selected="true"/);
  assert.match(css, /font-size:\s*14px/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /image-rendering:\s*pixelated/);
});

test('hidden research canvases preserve their last usable layout', () => {
  assert.match(client, /if \(width <= 0 \|\| height <= 0\) return \{ width: 0, height: 0, dpr, visible: false \}/);
  assert.match(client, /if \(netViewport\.visible\)/);
  assert.match(client, /if \(metricViewport\.visible\)/);
  assert.match(client, /if \(width <= 0 \|\| height <= 0\) return;/);
  assert.match(client, /pendingCameraTarget = \{ x: worldX, y: worldY \}/);
});

test('relationship viewport switches between social projection and choice network with world/window-safe refresh', () => {
  assert.match(html, /data-network-mode="social"/);
  assert.match(html, /data-network-mode="choice"/);
  assert.match(client, /fetchSocialNetwork\(requestedWorld, requestedWindow, controller\.signal\)/);
  assert.match(client, /requestSeq !== socialNetworkRequestSeq \|\| activeWorldId !== requestedWorld \|\| activeSocialNetworkWindow\(\) !== requestedWindow/);
  assert.match(client, /socialNetworkByWorld\.get\(socialNetworkCacheKey\(activeWorldId, requestedWindow\)\)/);
  assert.match(client, /#panel-tabs \[data-tab="relation"\]/);
  assert.match(consoleClient, /result\.worldId !== worldId/);
  assert.match(consoleClient, /mode === 'social'/);
});

test('relationship viewport exposes edge interaction, 6+4 lenses, filters, and keyboard alternatives', () => {
  for (const id of [
    'network-lens', 'network-window', 'network-scope', 'network-threshold',
    'network-edge-select', 'network-filter-reset', 'network-edge-count', 'network-edge-tooltip',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /id="net-canvas"[^>]*tabindex="0"[^>]*aria-describedby=/);
  assert.match(html, /aria-describedby="network-zone-label network-edge-count network-edge-tooltip"/);
  assert.match(html, /id="network-edge-tooltip"[^>]*role="tooltip"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(client, /hitTestNetworkEdge\(networkEdges/);
  assert.match(client, /setRelationshipDyadFocus\([\s\S]*?edge\.fromId,[\s\S]*?edge\.toId/);
  assert.match(client, /networkScope === 'ego'/);
  assert.match(consoleClient, /NETWORK_LENSES/);
  assert.match(consoleClient, /missingEdges/);
  assert.match(css, /\.network-field select\s*\{[^}]*min-height:\s*40px/s);
});

test('inspector exposes directed relationship evidence and groups dialogue by persistent conversation', () => {
  for (const label of ['情感亲密', '信任代理', '尊重/地位', '支持代理', '张力代理', '互动频率']) {
    assert.match(panelClient, new RegExp(label));
  }
  assert.match(panelClient, /direction\.evidence/);
  assert.match(panelClient, /r\.asymmetry/);
  assert.match(panelClient, /mind\.conversations/);
  assert.match(panelClient, /message\.fromName/);
  assert.match(panelClient, /conversation\.status/);
});

test('resident editor, pixel identity and multi-channel social interactions are visible and research-scoped', () => {
  for (const id of ['agent-editor', 'agent-editor-form', 'social-interaction-dialog', 'social-interaction-form']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  for (const interaction of ['observe', 'assist', 'share', 'invite', 'collaborate']) {
    assert.match(html, new RegExp(`value=["']${interaction}["']`));
  }
  assert.doesNotMatch(html, /data-value="360"/);
  assert.match(client, /loadedWorldCount/);
  assert.match(html, /researcher intervention/);
  assert.match(panelClient, /avatarFor\(message\.fromAgent/);
  assert.match(avatarClient, /pixelAvatarMarkup/);
  assert.match(css, /\.workspace-dialog/);
  assert.match(css, /\.pixel-avatar/);
  assert.match(server, /agent_profile_updated/);
  assert.match(server, /\/api\/social\/interact/);
});

test('Agent 模型运行方式在 UI 明确提供 Mock、本地模型与 API 三种可执行配置', () => {
  for (const id of [
    'llm-config-card', 'llm-config-status', 'llm-config-safety', 'llm-config-test', 'llm-config-apply',
    'llm-mode-mock', 'llm-mode-ollama', 'llm-mode-api', 'llm-ollama-num-ctx', 'llm-api-key',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  for (const mode of ['mock', 'ollama', 'api']) assert.match(html, new RegExp(`value=["']${mode}["']`));
  assert.match(html, /行动决策、日程规划、对话、摘要与反思/);
  assert.match(html, /凭据仅驻内存/);
  assert.match(client, /\/api\/llm\/config/);
  assert.match(client, /\/api\/llm\/test/);
  assert.match(client, /应用到当前工作空间已加载的/);
  assert.match(server, /llm_runtime_config_changed/);
  assert.match(server, /credentialPolicy: 'memory_only'/);
  assert.match(css, /\.model-mode-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3/s);
});

test('experiment workspace UI creates a town from initial config and selects one to three world templates', () => {
  for (const id of [
    'workspace-summary', 'workspace-create-open', 'workspace-create-dialog', 'workspace-create-form',
    'workspace-world-options', 'workspace-create-safety', 'workspace-create-submit',
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  for (const kind of ['mem-on', 'mem-off', 'rumor']) assert.match(html, new RegExp(`value=["']${kind}["']`));
  assert.match(client, /fetch\('\/api\/workspace'/);
  assert.match(client, /data\.getAll\('worldKinds'\)/);
  assert.match(client, /window\.location\.reload\(\)/);
  assert.match(server, /WORLD_TEMPLATE_CATALOG/);
  assert.match(server, /opts\.workspace\.replace\(body\)/);
  assert.match(css, /\.workspace-world-options\s*\{[^}]*grid-template-columns:\s*repeat\(3/s);
});

test('narrative stream distinguishes planned, travelling, verified, cancelled and fulfilled world facts', () => {
  for (const kind of ['town_event_announcement', 'town_event_departure', 'town_event', 'town_event_cancelled']) {
    assert.match(client, new RegExp(`it\\.kind === ['"]${kind}['"]`));
  }
  for (const label of ['尚未发生', '途中', '到场已核验', '未成行', '订单已完成']) assert.match(client, new RegExp(label));
  assert.match(client, /data-object-id/);
  assert.match(server, /participantCount/);
  assert.match(server, /sourceObjectId/);
  assert.match(server, /deliveryLocationId/);
  assert.match(css, /\.scene-contract\.verified/);
});

test('frequently used research controls meet the 40px target baseline', () => {
  assert.match(css, /button, select, input\[type="number"\]\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.network-mode button\s*\{[^}]*min-height:\s*40px;[^}]*font-size:\s*13px/s);
  assert.match(css, /\.mini-action\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.metric-tab\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /#panel-tabs \.tab\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.icon-btn\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.nar-ava\s*\{[^}]*width:\s*40px;\s*height:\s*40px/s);
  assert.match(css, /\.cand\s*\{[^}]*min-height:\s*40px/s);
  assert.match(css, /\.conversation-summary span\s*\{[^}]*font-size:\s*12px/s);
});

test('panel text escaping is safe in both text and attribute contexts', () => {
  assert.equal(escapeHtml(`a\"b'c<&>`), 'a&quot;b&#39;c&lt;&amp;&gt;');
});

test('world and player transitions reconcile remote state before local commit', () => {
  assert.match(client, /if \(actualWorldId === requestedWorldId\)/);
  assert.match(client, /状态已重新确认/);
  assert.match(client, /let playStopPromise: Promise<void> \| null = null/);
  const stopPlay = client.slice(client.indexOf('async function stopPlay'), client.indexOf('async function sendPlay'));
  assert.ok(stopPlay.indexOf("method: 'DELETE'") < stopPlay.indexOf('playing.delete(id)'));
});

test('deep statistics stays world-scoped, read-only and race-safe', () => {
  assert.match(html, /href="\/stats\.html"[^>]*>深度统计<\/a>/);
  assert.match(statsHtml, /id="stats-world"/);
  assert.match(statsHtml, /id="stats-day"/);
  assert.match(statsClient, /new URLSearchParams\(\{ worldId \}\)/);
  assert.match(statsClient, /report\.worldId !== worldId/);
  assert.match(statsClient, /activeController\?\.abort\(\)/);
  assert.match(statsClient, /sequence !== requestSequence/);
  assert.doesNotMatch(statsClient, /\/api\/world\/switch/);
});

test('后端日志入口提供筛选、跟随、路径复制和完整文件保存', () => {
  assert.match(html, /href="\/logs\.html"[^>]*>后端日志<\/a>/);
  for (const id of [
    'logs-level', 'logs-search', 'logs-refresh', 'logs-auto', 'logs-follow',
    'logs-download', 'logs-copy-path', 'logs-path', 'logs-root',
  ]) assert.match(logsHtml, new RegExp(`id=["']${id}["']`));
  assert.match(logsHtml, /href="\/api\/runtime-logs\/download"/);
  assert.match(logsHtml, /敏感凭据在写入前统一脱敏/);
  assert.match(logsClient, /new URLSearchParams\(\{ level, q: search, limit: '1000' \}\)/);
  assert.match(logsClient, /activeController\?\.abort\(\)/);
  assert.match(logsClient, /navigator\.clipboard\.writeText\(lastPath\)/);
  assert.match(server, /\/api\/runtime-logs\/download/);
  assert.doesNotMatch(server, /searchParams\.get\(['"]path['"]\)/);
  assert.match(css, /#logs-page\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /#logs-root\s*\{[^}]*overflow:\s*auto/s);
});

test('deep statistics escapes dynamic markup and keeps readable targets', () => {
  assert.match(statsClient, /r\.map\(\(c\) => `<td>\$\{esc\(c\)\}<\/td>`\)/);
  assert.match(statsClient, /option\.textContent = world\.kind/);
  assert.match(css, /#stats-page\s*\{[^}]*font-size:\s*14px/s);
  assert.match(css, /#stats-page\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto/s);
  assert.match(css, /#stats-page\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /\.stats-toolbar select,[\s\S]*?min-height:\s*40px/);
  assert.match(css, /\.hud-link\s*\{[^}]*min-height:\s*40px/s);
});

test('web build emits both research console and statistics clients', () => {
  assert.match(packageJson, /src\/web\/client\/main\.ts[^\n]+public\/client\.js/);
  assert.match(packageJson, /src\/web\/client\/stats\.ts[^\n]+public\/stats\.js/);
  assert.match(packageJson, /src\/web\/client\/logs\.ts[^\n]+public\/logs\.js/);
});
