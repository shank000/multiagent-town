type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface BackendLogEntry {
  sequence: number;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
}

interface BackendLogSnapshot {
  sessionId: string;
  startedAt: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  totalEntries: number;
  bufferedEntries: number;
  entries: BackendLogEntry[];
}

const levelNames: Record<LogLevel, string> = {
  debug: '调试',
  info: '信息',
  warn: '警告',
  error: '错误',
};

let activeController: AbortController | null = null;
let requestSequence = 0;
let lastPath = '';
let searchTimer = 0;

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function render(snapshot: BackendLogSnapshot): void {
  const root = document.getElementById('logs-root');
  if (!root) return;
  const follow = (document.getElementById('logs-follow') as HTMLInputElement | null)?.checked ?? true;
  const previousDistance = root.scrollHeight - root.scrollTop - root.clientHeight;
  root.innerHTML = snapshot.entries.length
    ? snapshot.entries.map((entry) => `
      <li class="log-entry level-${entry.level}" data-sequence="${entry.sequence}">
        <span class="log-sequence">#${entry.sequence}</span>
        <time datetime="${escapeHtml(entry.timestamp)}">${escapeHtml(formatTime(entry.timestamp))}</time>
        <span class="log-level">${levelNames[entry.level]}</span>
        <span class="log-source">${escapeHtml(entry.source)}</span>
        <pre>${escapeHtml(entry.message)}</pre>
      </li>`).join('')
    : '<li class="logs-empty">当前筛选条件下没有日志。</li>';
  root.setAttribute('aria-busy', 'false');
  document.getElementById('logs-session')!.textContent = `${snapshot.sessionId} · ${formatTime(snapshot.startedAt)}`;
  document.getElementById('logs-count')!.textContent = `${snapshot.totalEntries} 条（内存 ${snapshot.bufferedEntries}）`;
  document.getElementById('logs-size')!.textContent = formatBytes(snapshot.fileSizeBytes);
  document.getElementById('logs-path')!.textContent = snapshot.filePath;
  document.getElementById('logs-visible-count')!.textContent = `${snapshot.entries.length} 条可见`;
  lastPath = snapshot.filePath;
  if (follow) root.scrollTop = root.scrollHeight;
  else root.scrollTop = Math.max(0, root.scrollHeight - root.clientHeight - previousDistance);
}

async function loadLogs(): Promise<void> {
  const sequence = ++requestSequence;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const level = (document.getElementById('logs-level') as HTMLSelectElement | null)?.value ?? 'all';
  const search = (document.getElementById('logs-search') as HTMLInputElement | null)?.value.trim() ?? '';
  const query = new URLSearchParams({ level, q: search, limit: '1000' });
  const status = document.getElementById('logs-status');
  const refresh = document.getElementById('logs-refresh') as HTMLButtonElement | null;
  if (status) { status.textContent = '读取中…'; status.dataset.state = 'loading'; }
  if (refresh) refresh.disabled = true;
  try {
    const response = await fetch(`/api/runtime-logs?${query.toString()}`, {
      cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
    const snapshot = await response.json() as BackendLogSnapshot;
    if (sequence !== requestSequence) return;
    render(snapshot);
    if (status) { status.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`; status.dataset.state = 'ready'; }
  } catch (error) {
    if (controller.signal.aborted || sequence !== requestSequence) return;
    if (status) {
      status.textContent = error instanceof Error ? error.message : '读取后端日志失败';
      status.dataset.state = 'error';
    }
    document.getElementById('logs-root')?.setAttribute('aria-busy', 'false');
  } finally {
    if (sequence === requestSequence && refresh) refresh.disabled = false;
  }
}

function bind(): void {
  document.getElementById('logs-refresh')?.addEventListener('click', () => void loadLogs());
  document.getElementById('logs-level')?.addEventListener('change', () => void loadLogs());
  document.getElementById('logs-search')?.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void loadLogs(), 250);
  });
  document.getElementById('logs-copy-path')?.addEventListener('click', async () => {
    if (!lastPath) return;
    const status = document.getElementById('logs-status');
    try {
      await navigator.clipboard.writeText(lastPath);
      if (status) { status.textContent = '日志路径已复制'; status.dataset.state = 'ready'; }
    } catch {
      if (status) { status.textContent = '浏览器未允许复制，请手动选择路径'; status.dataset.state = 'error'; }
    }
  });
}

bind();
void loadLogs();
window.setInterval(() => {
  if ((document.getElementById('logs-auto') as HTMLInputElement | null)?.checked) void loadLogs();
}, 2_000);
