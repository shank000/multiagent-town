// HUD 层绘制：tooltip/横幅/气泡（像素风：直角 + 深色描边 + 角钉）+ 文本换行
// tooltip/banner 在 resetCamera 后的屏幕层绘制（坐标 CSS px，乘 dpr 转设备像素）；
// 气泡在世界层绘制（坐标随相机变换，已含 dpr，无需再乘）。

import { TILE } from './render';

export interface Bubble { kind: 'chat' | 'thought' | 'chat_summary'; speaker: string; text: string; until: number }
export interface DisplayPos { x: number; y: number } // display 的像素坐标子集

function dprScale(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}

export function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [''];
}

export function drawTooltip(
  ctx: CanvasRenderingContext2D,
  tooltip: { text: string; x: number; y: number } | null,
  canvasW: number,
  canvasH: number
): void {
  if (!tooltip) return;
  const s = dprScale();
  const fontPx = 12 * s;
  const pad = 8 * s;
  const pin = 2 * s;
  ctx.font = `${fontPx}px monospace`;
  const w = ctx.measureText(tooltip.text).width + pad * 2;
  const h = 24 * s;
  let x = tooltip.x * s + 14 * s;
  let y = tooltip.y * s + 14 * s;
  if (x + w > canvasW) x = tooltip.x * s - 14 * s - w;
  if (y + h > canvasH) y = tooltip.y * s - 14 * s - h;
  ctx.fillStyle = 'rgba(30,26,20,0.92)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#6b5a3a';
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#e3b23c';
  ctx.fillRect(x, y, pin, pin);
  ctx.fillRect(x + w - pin, y, pin, pin);
  ctx.fillRect(x, y + h - pin, pin, pin);
  ctx.fillRect(x + w - pin, y + h - pin, pin, pin);
  ctx.fillStyle = '#f5e9c8';
  ctx.fillText(tooltip.text, x + pad, y + 16 * s);
}

export function drawBanner(
  ctx: CanvasRenderingContext2D,
  banner: { text: string; until: number } | null,
  nowMs: number,
  canvasW: number
): void {
  if (!banner) return;
  void nowMs;
  const s = dprScale();
  const fontPx = 14 * s;
  const pad = 18 * s;
  const pin = 2 * s;
  ctx.font = `bold ${fontPx}px monospace`;
  const w = ctx.measureText(banner.text).width + pad * 2;
  const h = 28 * s;
  const x = (canvasW - w) / 2;
  const y = 8 * s;
  ctx.fillStyle = 'rgba(227,178,60,0.95)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#241d12';
  ctx.lineWidth = 2 * s;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = '#241d12';
  ctx.fillRect(x, y, pin, pin);
  ctx.fillRect(x + w - pin, y, pin, pin);
  ctx.fillRect(x, y + h - pin, pin, pin);
  ctx.fillRect(x + w - pin, y + h - pin, pin, pin);
  ctx.fillStyle = '#241d12';
  ctx.fillText(banner.text, x + pad, y + 19 * s);
}

export function drawBubbles(
  ctx: CanvasRenderingContext2D,
  bubbles: Map<string, Bubble>,
  display: Map<string, DisplayPos>,
  nowMs: number
): void {
  for (const [id, b] of bubbles) {
    if (nowMs > b.until) {
      bubbles.delete(id);
      continue;
    }
    const d = display.get(id);
    if (!d) continue;
    const isDialogue = b.kind === 'chat' || b.kind === 'chat_summary';
    const prefix = b.kind === 'chat_summary' ? '📜' : b.kind === 'chat' ? '💬' : '💭';
    const textLines = wrap(b.text, 14);
    // 对话条：说话人姓名行 + 文本行、宽 180；thought 维持单行
    const rows = isDialogue ? [`${prefix} ${b.speaker}`, ...textLines] : textLines.map((l) => `${prefix}${l}`);
    const w = isDialogue ? 180 : Math.max(...textLines.map((l) => l.length)) * 12 + 14;
    const h = rows.length * 14 + 12;
    const bx = d.x + TILE / 2 - w / 2;
    const by = d.y - 40 - h;
    ctx.fillStyle = 'rgba(245,233,200,0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#241d12';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, w, h);
    ctx.fillStyle = '#e3b23c';
    ctx.fillRect(bx, by, 2, 2);
    ctx.fillRect(bx + w - 2, by, 2, 2);
    ctx.fillRect(bx, by + h - 2, 2, 2);
    ctx.fillRect(bx + w - 2, by + h - 2, 2, 2);
    ctx.fillStyle = '#241d12';
    rows.forEach((l, i) => {
      ctx.font = i === 0 && isDialogue ? 'bold 12px monospace' : '12px monospace';
      ctx.fillText(l, bx + 7, by + 16 + i * 14);
    });
  }
}
