// 32×32 精灵：优先裁剪 a16z/ai-town 的 32x32folk.png（CC-BY 4.0, George Bailey，见 ATTRIBUTION.md），
// 图集未加载/失败时回退到程序绘制小人（四套配色）

export interface SpriteStyle {
  hair: string; skin: string; top: string; bottom: string; accent: string;
  kind: 'apron' | 'glasses' | 'beret' | 'cap';
}

export const PALETTES: SpriteStyle[] = [
  { hair: '#5b3a29', skin: '#f2c99c', top: '#d97757', bottom: '#6b4f6b', accent: '#f7e8d0', kind: 'apron' },
  { hair: '#2f2f2f', skin: '#e8c39a', top: '#4a6fa5', bottom: '#3a3a3a', accent: '#9fb8d8', kind: 'glasses' },
  { hair: '#7a4a2b', skin: '#f5d0a8', top: '#8a2f2f', bottom: '#5a4a3a', accent: '#c9a66b', kind: 'beret' },
  { hair: '#1f1f1f', skin: '#f2c99c', top: '#b33b3b', bottom: '#4a4a4a', accent: '#2f6b2f', kind: 'cap' },
];

export type Dir = 'up' | 'down' | 'left' | 'right';

const sheet = new Image();
let sheetReady = false;
sheet.onload = () => { sheetReady = true; };
sheet.onerror = () => { sheetReady = false; };
sheet.src = '/assets/32x32folk.png';

const DIR_ROW: Record<Dir, number> = { down: 0, left: 32, right: 64, up: 96 };

export function drawNpc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Dir,
  frame: 0 | 1 | 2,
  index: number,
  moving: boolean,
  selected: boolean,
  name: string,
  thinking: boolean
): void {
  const x = Math.round(cx);
  const y = Math.round(cy);
  // 影子
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(x, cy + 10, 7, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  if (sheetReady && sheet.complete && sheet.naturalWidth > 0) {
    const col = index % 4;
    const row = Math.floor(index / 4);
    // 每行 3 帧步态（0 站立/迈步 1/2），帧序列由调用方按 WALK_CYCLE 驱动
    const sx = col * 96 + frame * 32;
    const sy = row * 128 + (DIR_ROW[dir] ?? 0);
    ctx.drawImage(sheet, sx, sy, 32, 32, x - 16, y - 26, 32, 32);
  } else {
    drawNpcProcedural(ctx, x, y, dir, frame, index, moving);
  }
  if (thinking) {
    ctx.fillStyle = '#ffe9a8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('…', x - 8, y - 38);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '10px monospace';
  ctx.fillText(name, x - ctx.measureText(name).width / 2, y + 19);
  if (selected) {
    ctx.strokeStyle = '#ffd700';
    ctx.strokeRect(x - 9, y - 37, 18, 32);
  }
}

function drawNpcProcedural(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: Dir,
  frame: 0 | 1 | 2,
  index: number,
  moving: boolean
): void {
  const p = PALETTES[index % PALETTES.length];
  const yb = y + (moving ? Math.round(Math.sin(performance.now() / 150)) : 0);
  const step = frame === 0 ? 0 : 1;
  ctx.fillStyle = p.bottom;
  if (dir === 'left' || dir === 'right') {
    ctx.fillRect(x - 5 + step, yb - 8, 4, 9);
    ctx.fillRect(x + 1 - step, yb - 8, 4, 9);
  } else {
    ctx.fillRect(x - 5, yb - 8 + step, 4, 9);
    ctx.fillRect(x + 1, yb - 8 - step, 4, 9);
  }
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 6, yb - 19, 12, 12);
  if (p.kind === 'apron') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 3, yb - 19, 6, 12);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, yb - 19, 12, 3);
  }
  ctx.fillStyle = p.skin;
  if (moving && dir !== 'up') {
    ctx.fillRect(x - 8 + step * 3, yb - 18, 3, 9);
    ctx.fillRect(x + 5 - step * 3, yb - 18, 3, 9);
  } else {
    ctx.fillRect(x - 8, yb - 18, 3, 9);
    ctx.fillRect(x + 5, yb - 18, 3, 9);
  }
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 5, yb - 31, 10, 10);
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 6, yb - 33, 12, 4);
  if (dir !== 'up') ctx.fillRect(x - 6, yb - 29, 3, 6);
  if (p.kind === 'beret') {
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 7, yb - 35, 14, 3);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, yb - 34, 12, 3);
    ctx.fillRect(x - 8, yb - 31, 3, 2);
  }
  if (p.kind === 'glasses') {
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 4, yb - 27, 3, 3);
    ctx.fillRect(x + 1, yb - 27, 3, 3);
    ctx.fillRect(x - 1, yb - 26, 2, 1);
  }
  if (dir !== 'up') {
    ctx.fillStyle = '#1a1a1a';
    const ex = dir === 'left' ? x - 3 : dir === 'right' ? x + 1 : x - 1;
    ctx.fillRect(ex, yb - 27, 2, 2);
  }
}
