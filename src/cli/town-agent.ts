#!/usr/bin/env node
// town-agent：AI 接入小镇的协议 CLI（Alicization 式「灵魂-物理分离」）
// 用法：
//   town-agent login --name 爱丽丝
//   town-agent look --name 爱丽丝
//   town-agent walk --name 爱丽丝 --target 中央广场
//   town-agent interact --name 爱丽丝 --target 林间咖啡馆
//   town-agent say --name 爱丽丝 --text 你好，小镇！
// 环境变量：TOWN_URL（默认 http://127.0.0.1:8787）

const BASE = process.env.TOWN_URL ?? 'http://127.0.0.1:8787';

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return text ? JSON.parse(text) : {};
}

async function get(path: string): Promise<unknown> {
  const res = await fetch(BASE + path);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? '';
  const name = arg('name');
  try {
    if (cmd === 'login') {
      if (!name) throw new Error('需要 --name');
      const r = (await post('/api/guest/login', { name })) as { x: number; y: number };
      console.log(`✅ 已登录小镇：位置 (${r.x}, ${r.y}) 中央广场`);
      return;
    }
    if (cmd === 'look') {
      if (!name) throw new Error('需要 --name');
      const r = (await get(`/api/guest/look?name=${encodeURIComponent(name)}`)) as {
        x: number; y: number; location: string; nearby: { id: string; name: string; state: string; verb: string }[];
      };
      const people = r.nearby.length
        ? r.nearby.map((n) => `${n.name}${n.verb ? `（${n.verb}）` : ''}`).join('、')
        : '附近暂时无人';
      console.log(`👁 你正位于「${r.location}」(${r.x},${r.y})。附近：${people}`);
      return;
    }
    if (cmd === 'walk' || cmd === 'interact') {
      const target = arg('target');
      if (!name || !target) throw new Error(`需要 --name 和 --target`);
      await post('/api/guest/act', { name, action: cmd, target });
      console.log(`${cmd === 'walk' ? '🚶' : '🛠'} ${cmd === 'walk' ? '前往' : '互动'}：${target}`);
      return;
    }
    if (cmd === 'say') {
      const text = arg('text');
      if (!name || !text) throw new Error('需要 --name 和 --text');
      await post('/api/guest/act', { name, action: 'say', text });
      console.log(`💬 你说：「${text}」`);
      return;
    }
    console.log(`用法：town-agent <login|look|walk|interact|say> --name <名字> [--target <对象>|--text <内容>]`);
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
}
void main();
