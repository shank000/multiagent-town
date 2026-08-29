// 悬浮面板：NPC 详情/档案/记忆/反思/对话/关系渲染 + #panel-tabs DOM 绑定
// 面板依赖（playing 集合 / togglePlay）由 main.ts 通过 updatePanelDeps 注入，panel.ts 不反向 import main.ts。

import type { ObjectView } from './types';

export interface AgentView {
  id: string; name: string; occupation: string; state: string;
  age: number; gender: string;
  appearance: { hairStyle: string; hairColor: string; skinTone: string; outfit: string };
  hobbies: string[]; skills: Record<string, number>; values: string[]; motivation: string;
  personality: { extraversion: number; empathy: number; honesty: number; curiosity: number; patience: number };
  x: number; y: number; locationId: string; locationName: string;
  verb: string; thought: string | null; targetName: string | null;
  spriteIndex: number; background: string;
}

export const STATE_NAME: Record<string, string> = { idle: '待机', thinking: '思考中', moving: '赶路中', acting: '行动中' };
export const TYPE_NAME: Record<string, string> = { town: '小镇', building: '建筑', room: '房间', furniture: '家具', zone: '区域', water: '水域' };

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PanelDeps {
  playing: ReadonlySet<string>;
  togglePlay: (id: string) => void;
}
let deps: PanelDeps | null = null;
let renderVersion = 0;

/** main.ts 注入面板依赖（playing 为同一 Set 引用，后续增删对渲染可见） */
export function updatePanelDeps(d: PanelDeps): void {
  deps = d;
}

export function renderDetail(body: HTMLElement, a: AgentView): void {
  renderVersion++;
  const isPlaying = deps?.playing.has(a.id) ?? false;
  body.innerHTML = `
    <h3>${escapeHtml(a.name)}</h3>
    <p><span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">状态</span> ${escapeHtml(STATE_NAME[a.state] ?? a.state)}</p>
    <p><span class="label">位置</span> ${escapeHtml(a.locationName)}</p>
    ${a.verb ? `<p><span class="label">正在</span> ${escapeHtml(a.verb)}</p>` : ''}
    ${a.thought ? `<p><span class="label">想法</span> ${escapeHtml(a.thought)}</p>` : ''}
    <p><span class="label">简介</span> ${escapeHtml(a.background)}</p>
    <button id="play-toggle">${isPlaying ? '退出扮演' : '🎮 扮演'}</button>`;
  document.getElementById('play-toggle')!.addEventListener('click', () => deps?.togglePlay(a.id));
}

export function renderProfile(body: HTMLElement, a: AgentView): void {
  renderVersion++;
  const skillBars = Object.entries(a.skills).map(([k, v]) =>
    `<div class="mem-item">${escapeHtml(k)}<div class="bar"><div class="bar-fill skill" style="width:${v * 10}%"></div><span>${v}/10</span></div></div>`).join('');
  const dims: [string, number][] = [
    ['外向', a.personality.extraversion], ['共情', a.personality.empathy], ['诚实', a.personality.honesty],
    ['好奇', a.personality.curiosity], ['耐心', a.personality.patience],
  ];
  const persBars = dims.map(([k, v]) =>
    `<div class="mem-item">${k}<div class="bar"><div class="bar-fill pers" style="width:${Math.round(v * 100)}%"></div></div></div>`).join('');
  const tags = a.hobbies.map((h) => `<span class="tag">${escapeHtml(h)}</span>`).join('');
  body.innerHTML = `
    <h3>${escapeHtml(a.name)} 的档案</h3>
    <p><span class="label">性别</span> ${escapeHtml(a.gender)} · <span class="label">年龄</span> ${a.age} · <span class="label">职业</span> ${escapeHtml(a.occupation)}</p>
    <p><span class="label">外貌</span> ${escapeHtml(a.appearance.hairStyle)}，${escapeHtml(a.appearance.hairColor)}，${escapeHtml(a.appearance.skinTone)}肤色，常穿${escapeHtml(a.appearance.outfit)}</p>
    <p class="label">爱好</p><p>${tags}</p>
    <p class="label">技能</p>${skillBars}
    <p class="label">性格五维</p>${persBars}
    <div class="profile-card"><p class="label">价值观</p><p>${a.values.map((v) => `· ${escapeHtml(v)}`).join('<br>')}</p></div>
    <div class="profile-card"><p class="label">动机</p><p>${escapeHtml(a.motivation)}</p></div>
    <div class="profile-card"><p class="label">背景故事</p><p>${escapeHtml(a.background)}</p></div>`;
}

export function renderObjectCard(body: HTMLElement, o: ObjectView): void {
  renderVersion++;
  body.innerHTML = `
    <h3>${escapeHtml(o.name)}</h3>
    <p><span class="label">类型</span> ${escapeHtml(TYPE_NAME[o.type] ?? o.type)}</p>
    <p><span class="label">尺寸</span> ${o.w}×${o.h}</p>`;
}

export async function renderMind(body: HTMLElement, agentId: string, tab: string, worldId: string): Promise<void> {
  const version = ++renderVersion;
  body.innerHTML = '<p class="label">加载中…</p>';
  try {
    const scope = `?worldId=${encodeURIComponent(worldId)}`;
    const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/mind${scope}`);
    if (!res.ok) throw new Error(String(res.status));
    const mind = (await res.json()) as {
      worldId: string;
      memories: { content: string; importance: number; kind: string }[];
      reflections: { insights: string[] }[];
      dialogues: { fromAgent: string; content: string }[];
    };
    if (version !== renderVersion || mind.worldId !== worldId) return;
    if (tab === 'memory') {
      body.innerHTML = mind.memories.length
        ? mind.memories.map((m) => `<div class="mem-item"><span class="stars">${'★'.repeat(Math.round(m.importance / 2))}</span> ${escapeHtml(m.content)}</div>`).join('')
        : '<p class="label">暂无记忆</p>';
    } else if (tab === 'reflection') {
      body.innerHTML = mind.reflections.length
        ? mind.reflections.map((r) => `<div class="ref-item">${r.insights.map((i) => `<div class="ins">💡 ${escapeHtml(i)}</div>`).join('')}</div>`).join('')
        : '<p class="label">暂无反思</p>';
    } else if (tab === 'relation') {
      const res2 = await fetch(`/api/relationships/${encodeURIComponent(agentId)}${scope}`);
      if (!res2.ok) throw new Error(String(res2.status));
      const rel = (await res2.json()) as {
        worldId: string;
        relations: { otherName: string; affection: number; respect: number }[];
        standings: { name: string; score: number }[];
      };
      if (version !== renderVersion || rel.worldId !== worldId) return;
      const bars = rel.relations.length
        ? rel.relations.map((r) => {
            const pct = (v: number) => Math.round(((v + 1) / 2) * 100);
            return `<div class="mem-item">${escapeHtml(r.otherName)}
              <div class="bar"><div class="bar-fill love" style="width:${pct(r.affection)}%"></div><span>💗${r.affection.toFixed(2)}</span></div>
              <div class="bar"><div class="bar-fill resp" style="width:${pct(r.respect)}%"></div><span>💙${r.respect.toFixed(2)}</span></div>
            </div>`;
          }).join('')
        : '<p class="label">暂无关系</p>';
      const top = rel.standings.slice(0, 3).map((s, i) => `<div class="dl-item">👑${i + 1} ${escapeHtml(s.name)}（${s.score.toFixed(3)}）</div>`).join('');
      body.innerHTML = `<p class="label">小镇声望榜</p>${top}<p class="label">对他人的看法</p>${bars}`;
    } else {
      body.innerHTML = mind.dialogues.length
        ? mind.dialogues.map((d) => `<div class="dl-item">${escapeHtml(d.fromAgent)}：${escapeHtml(d.content)}</div>`).join('')
        : '<p class="label">暂无对话</p>';
    }
  } catch {
    if (version === renderVersion) body.innerHTML = '<p class="label">加载失败</p>';
  }
}

/** 绑定 #panel-tabs 点击：切换 activeTab（经 setActiveTab 回调写回 main.ts）并刷新面板 */
export function bindPanel(setActiveTab: (tab: string) => void, updatePanel: () => void): void {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#panel-tabs .tab'));
  tabs.forEach((tab) => { tab.tabIndex = tab.classList.contains('active') ? 0 : -1; });
  const activate = (tab: HTMLButtonElement) => {
    setActiveTab(tab.dataset.tab ?? 'detail');
    for (const item of tabs) {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
      item.tabIndex = active ? 0 : -1;
    }
    updatePanel();
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => {
      activate(tab);
    });
    tab.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const target = tabs[(index + direction + tabs.length) % tabs.length];
      target.focus();
      activate(target);
    });
  });
}
