import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { formatWithOptions } from 'node:util';

export type BackendLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BackendLogEntry {
  sequence: number;
  timestamp: string;
  level: BackendLogLevel;
  source: string;
  message: string;
}

export interface BackendLogQuery {
  level?: BackendLogLevel | 'all';
  search?: string;
  after?: number;
  limit?: number;
}

export interface BackendLogSnapshot {
  sessionId: string;
  startedAt: string;
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  totalEntries: number;
  bufferedEntries: number;
  entries: BackendLogEntry[];
}

interface ConsoleMethods {
  debug: typeof console.debug;
  error: typeof console.error;
  info: typeof console.info;
  log: typeof console.log;
  warn: typeof console.warn;
}

/**
 * 当前后端进程的结构化 JSONL 日志。
 * 内存只保留最近条目，磁盘文件保留本次运行的完整序列；所有输出统一脱敏。
 */
export class BackendRuntimeLog {
  private readonly entries: BackendLogEntry[] = [];
  private readonly startedAtValue = new Date().toISOString();
  private readonly sessionIdValue: string;
  private readonly originalConsole: ConsoleMethods;
  private sequence = 0;
  private consoleInstalled = false;
  private fileWritable = true;

  constructor(
    readonly filePath: string,
    private readonly options: { captureConsole?: boolean; maxEntries?: number } = {},
  ) {
    this.sessionIdValue = `${process.pid}-${Date.now().toString(36)}`;
    this.originalConsole = {
      debug: console.debug.bind(console),
      error: console.error.bind(console),
      info: console.info.bind(console),
      log: console.log.bind(console),
      warn: console.warn.bind(console),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    this.record('info', 'lifecycle', `后端日志会话开始 session=${this.sessionIdValue}`);
    if (options.captureConsole !== false) this.installConsoleCapture();
  }

  get sessionId(): string { return this.sessionIdValue; }
  get startedAt(): string { return this.startedAtValue; }
  get fileName(): string { return basename(this.filePath); }

  debug(source: string, message: string): BackendLogEntry { return this.record('debug', source, message); }
  info(source: string, message: string): BackendLogEntry { return this.record('info', source, message); }
  warn(source: string, message: string): BackendLogEntry { return this.record('warn', source, message); }
  error(source: string, message: string): BackendLogEntry { return this.record('error', source, message); }

  query(query: BackendLogQuery = {}): BackendLogSnapshot {
    const level = query.level ?? 'all';
    const search = (query.search ?? '').trim().toLocaleLowerCase('zh-CN');
    const after = Math.max(0, query.after ?? 0);
    const limit = Math.max(1, Math.min(2_000, query.limit ?? 500));
    const matching = this.entries.filter((entry) => (
      entry.sequence > after
      && (level === 'all' || entry.level === level)
      && (!search || `${entry.source}\n${entry.message}`.toLocaleLowerCase('zh-CN').includes(search))
    ));
    return {
      sessionId: this.sessionIdValue,
      startedAt: this.startedAtValue,
      filePath: this.filePath,
      fileName: this.fileName,
      fileSizeBytes: this.fileSize(),
      totalEntries: this.sequence,
      bufferedEntries: this.entries.length,
      entries: matching.slice(-limit),
    };
  }

  close(): void {
    this.record('info', 'lifecycle', `后端日志会话结束 session=${this.sessionIdValue}`);
    this.restoreConsole();
  }

  private record(level: BackendLogLevel, source: string, rawMessage: string): BackendLogEntry {
    const entry: BackendLogEntry = {
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      level,
      source: cleanSource(source),
      message: redactSecrets(rawMessage).slice(0, 32_000),
    };
    this.entries.push(entry);
    const maxEntries = Math.max(100, this.options.maxEntries ?? 5_000);
    if (this.entries.length > maxEntries) this.entries.splice(0, this.entries.length - maxEntries);
    if (this.fileWritable) {
      try {
        appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
      } catch (error) {
        this.fileWritable = false;
        this.originalConsole.error('[backend-log] 无法继续写入日志文件', error);
      }
    }
    return entry;
  }

  private installConsoleCapture(): void {
    if (this.consoleInstalled) return;
    this.consoleInstalled = true;
    console.debug = (...args: unknown[]) => this.captureConsole('debug', args);
    console.info = (...args: unknown[]) => this.captureConsole('info', args);
    console.log = (...args: unknown[]) => this.captureConsole('info', args);
    console.warn = (...args: unknown[]) => this.captureConsole('warn', args);
    console.error = (...args: unknown[]) => this.captureConsole('error', args);
  }

  private captureConsole(level: BackendLogLevel, args: unknown[]): void {
    this.originalConsole[level](...args);
    const rendered = formatWithOptions(
      { colors: false, depth: 6, maxArrayLength: 100, maxStringLength: 32_000, breakLength: 160 },
      ...args,
    );
    const tagged = /^\[([^\]\r\n]{1,80})\]\s*(.*)$/s.exec(rendered);
    this.record(level, tagged?.[1] ?? 'backend', tagged?.[2] ?? rendered);
  }

  private restoreConsole(): void {
    if (!this.consoleInstalled) return;
    console.debug = this.originalConsole.debug;
    console.info = this.originalConsole.info;
    console.log = this.originalConsole.log;
    console.warn = this.originalConsole.warn;
    console.error = this.originalConsole.error;
    this.consoleInstalled = false;
  }

  private fileSize(): number {
    try { return statSync(this.filePath).size; } catch { return 0; }
  }
}

export function runtimeLogPathForDatabase(databasePath: string): string {
  if (databasePath === ':memory:') {
    return join(process.cwd(), 'data', 'runs', `town-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.runtime.jsonl`);
  }
  const extension = extname(databasePath);
  const stem = basename(databasePath, extension);
  return join(dirname(databasePath), `${stem}.runtime.jsonl`);
}

export function redactSecrets(value: string): string {
  return value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|authorization|password|access[_-]?token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-[REDACTED]');
}

function cleanSource(source: string): string {
  const cleaned = source.trim().replace(/[^\p{L}\p{N}_.:/-]+/gu, '-').slice(0, 80);
  return cleaned || 'backend';
}
