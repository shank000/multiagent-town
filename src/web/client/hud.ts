// HUD 层绘制：tooltip/横幅/气泡（像素风：直角 + 深色描边 + 角钉）+ 文本换行
// tooltip/banner 在 resetCamera 后的屏幕层绘制（坐标 CSS px，乘 dpr 转设备像素）；
// 气泡在世界层绘制（坐标随相机变换，已含 dpr，无需再乘）。

import { TILE } from './render';

export interface Bubble {
  kind: 'chat' | 'thought' | 'chat_summary';
  speaker: string;
  text: string;
  until: number;
  accent?: string;
}
export interface DisplayPos { x: number; y: number } // display 的像素坐标子集

export function dprScale(): number {
  return (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
}

/** 中英文连续文本按固定字符数换行。 */
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
  const occupied: { x: number; y: number; w: number; h: number }[] = [];
  for (const [id, b] of bubbles) {
    if (nowMs > b.until) {
      bubbles.delete(id);
      continue;
    }
    const d = display.get(id);
    if (!d) continue;
    const isDialogue = b.kind === 'chat' || b.kind === 'chat_summary';
    const prefix = b.kind === 'chat_summary' ? '📜' : b.kind === 'chat' ? '💬' : '💭';
    const rawLines = wrap(b.text, isDialogue ? 15 : 13);
    const textLines = rawLines.slice(0, isDialogue ? 4 : 3);
    if (rawLines.length > textLines.length) textLines[textLines.length - 1] = `${textLines[textLines.length - 1].slice(0, -1)}…`;
    const rows = isDialogue ? textLines : textLines.map((line) => `${prefix} ${line}`);
    const w = isDialogue ? 204 : Math.max(92, Math.max(...rows.map((line) => line.length)) * 13 + 20);
    const headerH = isDialogue ? 25 : 0;
    const h = headerH + rows.length * 17 + 15;
    const anchorX = Math.round(d.x + TILE / 2);
    const anchorY = Math.round(d.y - 18);
    let bx = Math.round(anchorX - w / 2);
    let by = Math.round(d.y - 42 - h);
    while (occupied.some((box) => bx < box.x + box.w && bx + w > box.x && by < box.y + box.h && by + h > box.y)) {
      by -= h + 8;
      bx += occupied.length % 2 === 0 ? 12 : -12;
    }
    occupied.push({ x: bx, y: by, w, h });
    if (isDialogue) {
      // 世界层像素尾从气泡底边连续指到说话者头顶，镜头缩放后仍保持最近邻边缘。
      const tailY = by + h - 2;
      const tailH = Math.max(4, anchorY - tailY);
      ctx.fillStyle = '#241d12';
      ctx.fillRect(anchorX - 3, tailY, 6, tailH);
      ctx.fillStyle = 'rgba(245,233,200,0.95)';
      ctx.fillRect(anchorX - 1, tailY, 2, Math.max(2, tailH - 2));
    }
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(bx + 4, by + 5, w, h);
    ctx.fillStyle = 'rgba(245,233,200,0.95)';
    ctx.fillRect(bx, by, w, h);
    ctx.strokeStyle = '#241d12';
    ctx.lineWidth = 2;
    ctx.strokeRect(bx, by, w, h);
    const accent = b.accent && /^#[0-9a-fA-F]{6}$/.test(b.accent) ? b.accent : '#e3b23c';
    ctx.fillStyle = accent;
    ctx.fillRect(bx, by, 2, 2);
    ctx.fillRect(bx + w - 2, by, 2, 2);
    ctx.fillRect(bx, by + h - 2, 2, 2);
    ctx.fillRect(bx + w - 2, by + h - 2, 2, 2);
    if (isDialogue) {
      ctx.fillStyle = '#2e2921';
      ctx.fillRect(bx + 2, by + 2, w - 4, headerH - 2);
      ctx.fillStyle = accent;
      ctx.fillRect(bx + 2, by + 2, 5, headerH - 2);
      ctx.fillStyle = '#fff7df';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(`${prefix} ${b.speaker}`, bx + 12, by + 18);
    }
    ctx.fillStyle = '#241d12';
    rows.forEach((line, index) => {
      ctx.font = '13px sans-serif';
      ctx.fillText(line, bx + 10, by + headerH + 17 + index * 17);
    });
  }
}
