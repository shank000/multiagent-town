import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fingerprintWebInputs, publishWebBuild, WEB_BUILD_CONFIG, WEB_PAGES, type WebBundles } from '../src/runtime/web-build';

export function webBuildFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'town-web-build-'));
  const sources = [...WEB_BUILD_CONFIG, 'src/web/client/main.ts', 'src/web/client/stats.ts', 'src/web/client/logs.ts'];
  for (const name of sources) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture');
  }
  mkdirSync(join(root, 'public'));
  for (const name of WEB_PAGES) writeFileSync(join(root, 'public', name), `<html>${name}</html>`);
  publishWebBuild(root, fixtureBundles(), fingerprintWebInputs(root));
  return root;
}

export function fixtureBundles(): WebBundles {
  return { 'client.js': Buffer.from('void 1;'), 'stats.js': Buffer.from('void 2;'), 'logs.js': Buffer.from('void 3;') };
}
