// 地图渲染：地形/建筑细节/湖水波光/昼夜着色

import type { ObjectView } from './types';

export const TILE = 32;

const ROOFS = ['#b35d45', '#8a5a3a', '#5a7a8a', '#6b4f6b', '#8a7a3a', '#4a6a4a'];

export function drawTerrain(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#7fb069';
  ctx.fillRect(0, 0, w, h);
  // 石板小径：中央十字
  ctx.fillStyle = '#c9b79c';
  for (let x = 0; x < w; x += TILE) {
    ctx.fillRect(x, 4 * TILE + 8, TILE, 8);
    ctx.fillRect(x + 4, 4 * TILE, 8, TILE);
  }
  // 花点
  ctx.fillStyle = '#e8d5a0';
  for (let i = 0; i < 12; i++) {
    const fx = (i * 37) % w;
    const fy = ((i * 53) % h);
    ctx.fillRect(fx, fy, 2, 2);
  }
}

export function drawLake(ctx: CanvasRenderingContext2D, px: number, py: number, pw: number, ph: number, nowMs: number): void {
  ctx.fillStyle = '#5b9bd1';
  ctx.fillRect(px, py, pw, ph);
  const wave = Math.floor(nowMs / 400) % 2;
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  for (let x = px + 4 + wave * 6; x < px + pw; x += 12) {
    ctx.fillRect(x, py + 6, 5, 2);
    ctx.fillRect(x + 5, py + ph - 12, 5, 2);
  }
}

export function drawObjectDetail(ctx: CanvasRenderingContext2D, o: ObjectView, nowMs: number): void {
  const px = o.x * TILE, py = o.y * TILE, pw = o.w * TILE, ph = o.h * TILE;
  if (o.type === 'zone') {
    if (o.id === 'obj:park') {
      ctx.fillStyle = '#6aa84f';
      ctx.fillRect(px, py, pw, ph);
      for (const [tx, ty] of [[px + 10, py + 10], [px + pw - 22, py + ph - 24]]) {
        ctx.fillStyle = '#4a3520';
        ctx.fillRect(tx, ty, 6, 16);
        ctx.fillStyle = '#2f7a3a';
        ctx.fillRect(tx - 7, ty - 10, 20, 14);
      }
    } else if (o.id === 'obj:lake') {
      drawLake(ctx, px, py, pw, ph, nowMs);
    } else {
      ctx.fillStyle = '#c9b79c';
      ctx.fillRect(px, py, pw, ph);
      ctx.strokeStyle = '#a3937a';
      for (let x = px + 8; x < px + pw; x += 16) {
        for (let y = py + 8; y < py + ph; y += 16) ctx.strokeRect(x, y, 16, 16);
      }
      ctx.fillStyle = '#6b9bd1';
      ctx.fillRect(px + pw / 2 - 10, py + ph / 2 - 10, 20, 20);
    }
  } else if (o.type === 'building') {
    ctx.fillStyle = '#e8d5b7';
    ctx.fillRect(px, py, pw, ph);
    ctx.fillStyle = ROOFS[hash(o.id) % ROOFS.length];
    ctx.fillRect(px, py, pw, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(px + 4, py + 3, pw - 8, 3);
    // 窗
    ctx.fillStyle = '#7a5a3a';
    for (let wx = px + 8; wx < px + pw - 8; wx += 16) {
      ctx.fillRect(wx, py + 16, 8, 8);
      ctx.strokeStyle = '#4a3520';
      ctx.strokeRect(wx, py + 16, 8, 8);
    }
    // 门
    ctx.fillStyle = '#6b4a2f';
    const doorX = px + pw / 2 - 6;
    ctx.fillRect(doorX, py + ph - 14, 12, 14);
    // 招牌
    if (o.id === 'obj:cafe' || o.id === 'obj:bookstore' || o.id === 'obj:post_office') {
      ctx.fillStyle = '#e3b23c';
      ctx.fillRect(px + pw - 16, py + 2, 12, 8);
    }
  } else if (o.type === 'room') {
    ctx.fillStyle = '#d9b48f';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = '#a97c50';
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
  } else {
    ctx.fillStyle = '#8a6f4d';
    ctx.fillRect(px + 6, py + 6, pw - 12, ph - 12);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.font = '11px monospace';
  ctx.fillText(o.name, px + 3, py + 24);
}

export function applyDayNight(ctx: CanvasRenderingContext2D, w: number, h: number, minuteOfDay: number): void {
  let color = '';
  let alpha = 0;
  if (minuteOfDay >= 300 && minuteOfDay < 480) { color = '#ff9a3c'; alpha = 0.1; }
  else if (minuteOfDay >= 1020 && minuteOfDay < 1200) { color = '#ff7a3c'; alpha = 0.16; }
  else if (minuteOfDay >= 1200 || minuteOfDay < 300) { color = '#1a2a4a'; alpha = 0.3; }
  if (alpha > 0) {
    ctx.fillStyle = color;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
