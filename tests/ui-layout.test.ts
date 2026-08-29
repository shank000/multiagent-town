import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../src/web/client/panel';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(`${root}/public/index.html`, 'utf8');
const css = readFileSync(`${root}/public/style.css`, 'utf8');
const client = readFileSync(`${root}/src/web/client/main.ts`, 'utf8');
const statsHtml = readFileSync(`${root}/public/stats.html`, 'utf8');
const statsClient = readFileSync(`${root}/src/web/client/stats.ts`, 'utf8');
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
  assert.match(css, /@media \(max-width:\s*1500px\)/);
  assert.match(css, /@media \(max-width:\s*980px\)/);
  assert.match(css, /#research-workspace\[data-focus/);
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

test('frequently used research controls meet the desktop target baseline', () => {
  assert.match(css, /\.mini-action\s*\{[^}]*min-height:\s*36px/s);
  assert.match(css, /\.metric-tab\s*\{[^}]*min-height:\s*36px/s);
  assert.match(css, /\.nar-ava\s*\{[^}]*width:\s*36px;\s*height:\s*36px/s);
  assert.match(css, /\.cand\s*\{[^}]*min-height:\s*36px/s);
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

test('deep statistics escapes dynamic markup and keeps readable targets', () => {
  assert.match(statsClient, /r\.map\(\(c\) => `<td>\$\{esc\(c\)\}<\/td>`\)/);
  assert.match(statsClient, /option\.textContent = world\.kind/);
  assert.match(css, /#stats-page\s*\{[^}]*font-size:\s*14px/s);
  assert.match(css, /\.stats-toolbar select,[\s\S]*?min-height:\s*40px/);
  assert.match(css, /\.hud-link\s*\{[^}]*min-height:\s*36px/s);
});

test('web build emits both research console and statistics clients', () => {
  assert.match(packageJson, /src\/web\/client\/main\.ts[^\n]+public\/client\.js/);
  assert.match(packageJson, /src\/web\/client\/stats\.ts[^\n]+public\/stats\.js/);
});
