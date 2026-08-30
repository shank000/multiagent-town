// 32×32 精灵：优先裁剪 a16z/ai-town 的 32x32folk.png（CC-BY 4.0, George Bailey，见 ATTRIBUTION.md），
// 图集不可用或姿态需要明确表达时，使用程序化像素角色。

export interface SpriteStyle {
  hair: string; skin: string; top: string; bottom: string; accent: string;
  kind: 'apron' | 'glasses' | 'beret' | 'cap';
}

export const PALETTES: SpriteStyle[] = [
  // 顺序对应图集 f1-f8；特殊姿态沿用同槽配色，避免坐下/睡觉时身份换装。
  { hair: '#20242b', skin: '#f0c7a0', top: '#59697d', bottom: '#323947', accent: '#d47455', kind: 'apron' },
  { hair: '#1b1c20', skin: '#805338', top: '#466763', bottom: '#263c3b', accent: '#b79272', kind: 'glasses' },
  { hair: '#3a3c42', skin: '#efc6a2', top: '#5a636d', bottom: '#333942', accent: '#bc6758', kind: 'beret' },
  { hair: '#e5e4df', skin: '#efc9a8', top: '#66616a', bottom: '#39363d', accent: '#b76358', kind: 'cap' },
  { hair: '#d9a534', skin: '#f1c59d', top: '#486691', bottom: '#34486c', accent: '#9d68ac', kind: 'apron' },
  { hair: '#d55388', skin: '#f0c3a0', top: '#685b91', bottom: '#423a65', accent: '#e08aae', kind: 'beret' },
  { hair: '#a85c32', skin: '#efc29a', top: '#a27250', bottom: '#67472f', accent: '#ead0a6', kind: 'apron' },
  { hair: '#766054', skin: '#edc29e', top: '#716051', bottom: '#473c35', accent: '#c8b08e', kind: 'glasses' },
];

export type Dir = 'up' | 'down' | 'left' | 'right';
export type NpcPose = 'idle' | 'walk' | 'think' | 'interact' | 'speak' | 'sit' | 'sleep';

export interface NpcMotion {
  frame: 0 | 1 | 2;
  bob: number;
  swing: number;
}

export interface NpcRenderOptions {
  pose: NpcPose;
  nowMs: number;
  phase: number;
  selected: boolean;
  name: string;
}

export interface ConversationPlacement {
  a: { cx: number; cy: number; dir: Dir };
  b: { cx: number; cy: number; dir: Dir };
}

export interface NpcPlacement { cx: number; cy: number; dir: Dir }
export interface PixelTargetRect { x: number; y: number; w: number; h: number }
export interface TilePoint { x: number; y: number }

const WALK_FRAMES = [0, 1, 0, 2] as const;
const WALK_BOB = [0, -1, 0, -1] as const;
const WALK_SWING = [0, -1, 0, 1] as const;
const paletteFor = (index: number) => PALETTES[((Math.trunc(index) % PALETTES.length) + PALETTES.length) % PALETTES.length];

/** 居民相位由稳定 id 派生，避免全镇同手同脚，同时保证相同快照可复现。 */
export function npcAnimationPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 480;
}

/** 仅返回整数像素运动量；相同时间、相位和姿态得到完全相同结果。 */
export function npcMotionAt(nowMs: number, phase: number, pose: NpcPose): NpcMotion {
  const beat = Math.floor((Math.max(0, nowMs) + phase) / 120) % 4;
  if (pose === 'walk') {
    return { frame: WALK_FRAMES[beat], bob: WALK_BOB[beat], swing: WALK_SWING[beat] };
  }
  if (pose === 'interact' || pose === 'speak') {
    return { frame: 0, bob: beat === 1 ? -1 : 0, swing: WALK_SWING[beat] };
  }
  return { frame: 0, bob: 0, swing: 0 };
}

/**
 * 把相邻会话双方排成稳定的面对面站位。输入与输出都是世界层整数像素，
 * 同格时用稳定 id 决定左右/上下顺序，避免每帧交换位置。
 */
export function npcConversationPlacement(
  aId: string,
  bId: string,
  aCx: number,
  aCy: number,
  bCx: number,
  bCy: number
): ConversationPlacement {
  const ax = Math.round(aCx);
  const ay = Math.round(aCy);
  const bx = Math.round(bCx);
  const by = Math.round(bCy);
  const midX = Math.round((ax + bx) / 2);
  const midY = Math.round((ay + by) / 2);
  const horizontal = Math.abs(bx - ax) >= Math.abs(by - ay);
  const aFirst = horizontal
    ? (ax !== bx ? ax < bx : aId.localeCompare(bId) <= 0)
    : (ay !== by ? ay < by : aId.localeCompare(bId) <= 0);
  const halfGap = 11;
  if (horizontal) {
    const left = { cx: midX - halfGap, cy: midY, dir: 'right' as const };
    const right = { cx: midX + halfGap, cy: midY, dir: 'left' as const };
    return aFirst ? { a: left, b: right } : { a: right, b: left };
  }
  const top = { cx: midX, cy: midY - halfGap, dir: 'down' as const };
  const bottom = { cx: midX, cy: midY + halfGap, dir: 'up' as const };
  return aFirst ? { a: top, b: bottom } : { a: bottom, b: top };
}

/** 床/沙发/座椅姿态锚定到对象几何，不把角色压在对象中心瓦片上。 */
export function npcTargetPlacement(
  pose: NpcPose,
  target: PixelTargetRect,
  fallbackCx: number,
  fallbackCy: number,
  fallbackDir: Dir
): NpcPlacement {
  const centerX = Math.round(target.x + target.w / 2);
  const centerY = Math.round(target.y + target.h / 2);
  if (pose === 'sleep') {
    return {
      cx: centerX,
      cy: centerY,
      dir: target.h > target.w ? 'up' : 'left',
    };
  }
  if (pose === 'sit') {
    return {
      cx: centerX,
      cy: Math.round(target.y + target.h + 5),
      dir: 'up',
    };
  }
  return { cx: Math.round(fallbackCx), cy: Math.round(fallbackCy), dir: fallbackDir };
}

/**
 * 从两次服务器快照之间提取真实 A* 路段。合法路径逐瓦片返回；动作切换或
 * 路径记录不完整时只返回终点，调用方仍能确定性收敛而不会保留陈旧路线。
 */
export function npcRouteWaypoints(
  path: readonly TilePoint[],
  from: TilePoint,
  to: TilePoint,
  tileSize: number
): TilePoint[] {
  if (from.x === to.x && from.y === to.y) return [];
  const start = path.findIndex((tile) => tile.x === from.x && tile.y === from.y);
  const end = path.findIndex((tile, index) => index >= Math.max(0, start) && tile.x === to.x && tile.y === to.y);
  const tiles = start >= 0 && end > start ? path.slice(start + 1, end + 1) : [to];
  return tiles.map((tile) => ({
    x: Math.round(tile.x * tileSize),
    y: Math.round(tile.y * tileSize),
  }));
}

/** 快照状态到视觉姿态的确定性映射；插值尚未结束时始终优先显示行走。 */
export function npcPoseFor(state: string, targetName: string | null, walking: boolean, verb = ''): NpcPose {
  if (walking || state === 'moving') return 'walk';
  if (state === 'thinking') return 'think';
  const sleeping = /睡觉|睡眠|午睡|午休|小憩|打盹/.test(verb);
  if (state === 'acting' && sleeping && (!targetName || /床|沙发/.test(targetName))) return 'sleep';
  if (state === 'acting' && !!targetName && /沙发|咖啡桌|椅/.test(targetName)) return 'sit';
  if (state === 'acting') return 'interact';
  return 'idle';
}

let sheet: HTMLImageElement | null = null;
let spriteSheetReady = false;
if (typeof Image !== 'undefined') {
  const image = new Image();
  image.onload = () => { spriteSheetReady = true; };
  image.onerror = () => { spriteSheetReady = false; };
  image.src = '/assets/32x32folk.png';
  sheet = image;
}

const DIR_ROW: Record<Dir, number> = { down: 0, left: 32, right: 64, up: 96 };
const SPRITE_SLOTS = 8;

export interface SpriteSourceRect { sx: number; sy: number; sw: 32; sh: 32 }

/** 图集只有八个角色槽；访客索引循环使用合法槽，绝不裁到图像范围外。 */
export function spriteSourceRect(index: number, dir: Dir, frame: 0 | 1 | 2): SpriteSourceRect {
  const slot = ((Math.trunc(index) % SPRITE_SLOTS) + SPRITE_SLOTS) % SPRITE_SLOTS;
  return {
    sx: (slot % 4) * 96 + frame * 32,
    sy: Math.floor(slot / 4) * 128 + DIR_ROW[dir],
    sw: 32,
    sh: 32,
  };
}

export function drawNpc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Dir,
  index: number,
  options: NpcRenderOptions
): void {
  const groundX = Math.round(cx);
  const groundY = Math.round(cy);
  const motion = npcMotionAt(options.nowMs, options.phase, options.pose);
  const lateral = options.pose === 'walk' && (dir === 'left' || dir === 'right') ? motion.swing : 0;
  const x = groundX + lateral;
  const y = groundY + motion.bob;

  drawPixelShadow(ctx, groundX, groundY, options.pose, dir);
  if (options.pose === 'sleep') {
    drawSleepingNpc(ctx, groundX, groundY, dir, index);
  } else if (options.pose === 'sit') {
    drawSeatedNpc(ctx, groundX, groundY, dir, index);
  } else if (spriteSheetReady && sheet?.complete && sheet.naturalWidth > 0) {
    const source = spriteSourceRect(index, dir, motion.frame);
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, source.sx, source.sy, source.sw, source.sh, x - 16, y - 26, 32, 32);
    ctx.imageSmoothingEnabled = smoothing;
    if (options.pose === 'interact' || options.pose === 'speak') {
      drawInteractionHand(ctx, x, y, dir, index, motion.swing);
    }
  } else {
    drawNpcProcedural(ctx, x, y, dir, motion, index, options.pose);
  }

  if (options.pose === 'speak') drawSpeechPulse(ctx, x, y, dir, motion.swing);

  if (options.pose === 'think') {
    ctx.fillStyle = '#ffe9a8';
    ctx.font = 'bold 14px monospace';
    ctx.fillText('…', groundX - 8, groundY - 38);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.font = '10px monospace';
  ctx.fillText(options.name, Math.round(groundX - ctx.measureText(options.name).width / 2), groundY + 19);
  if (options.selected) drawSelection(ctx, groundX, groundY, options.pose, dir);
}

function drawSpeechPulse(ctx: CanvasRenderingContext2D, x: number, y: number, dir: Dir, swing: number): void {
  // 嘴部前方的两级像素声纹随四拍收放，和气泡尾共同标明当前发言者。
  const reach = Math.abs(swing);
  ctx.fillStyle = '#fff0b8';
  if (dir === 'left') {
    ctx.fillRect(x - 11 - reach, y - 26, 2, 2);
    if (reach) ctx.fillRect(x - 15, y - 25, 2, 1);
  } else if (dir === 'right') {
    ctx.fillRect(x + 9 + reach, y - 26, 2, 2);
    if (reach) ctx.fillRect(x + 13, y - 25, 2, 1);
  } else {
    const side = dir === 'up' ? -1 : 1;
    ctx.fillRect(x + 7 * side, y - 26, 2, 2);
    if (reach) ctx.fillRect(x + 10 * side, y - 25, 2, 1);
  }
}

function drawPixelShadow(ctx: CanvasRenderingContext2D, x: number, y: number, pose: NpcPose, dir: Dir): void {
  const wide = pose === 'sleep' && (dir === 'left' || dir === 'right') ? 11 : 7;
  ctx.fillStyle = 'rgba(0,0,0,0.24)';
  ctx.fillRect(x - wide, y + 8, wide * 2, 3);
  ctx.fillRect(x - wide + 2, y + 11, wide * 2 - 4, 2);
}

function drawSelection(ctx: CanvasRenderingContext2D, x: number, y: number, pose: NpcPose, dir: Dir): void {
  ctx.strokeStyle = '#ffd700';
  if (pose === 'sleep' && (dir === 'left' || dir === 'right')) ctx.strokeRect(x - 15, y - 13, 30, 22);
  else if (pose === 'sleep') ctx.strokeRect(x - 11, y - 18, 22, 34);
  else if (pose === 'sit') ctx.strokeRect(x - 11, y - 34, 22, 33);
  else ctx.strokeRect(x - 10, y - 38, 20, 34);
}

function drawSleepingNpc(ctx: CanvasRenderingContext2D, x: number, y: number, dir: Dir, index: number): void {
  const p = paletteFor(index);
  if (dir === 'up' || dir === 'down') {
    const headY = dir === 'up' ? y - 16 : y + 6;
    const bodyY = dir === 'up' ? y - 6 : y - 10;
    ctx.fillStyle = p.hair;
    ctx.fillRect(x - 6, headY, 12, 5);
    ctx.fillStyle = p.skin;
    ctx.fillRect(x - 5, headY + (dir === 'up' ? 3 : -2), 10, 8);
    ctx.fillStyle = '#4a3520';
    ctx.fillRect(x - 2, headY + (dir === 'up' ? 7 : 0), 4, 1);
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 6, bodyY, 12, 13);
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 5, bodyY + 2, 10, 4);
    ctx.fillStyle = p.bottom;
    ctx.fillRect(x - 5, dir === 'up' ? y + 7 : y - 15, 10, 7);
    return;
  }
  const headLeft = dir === 'left';
  const headX = headLeft ? x - 13 : x + 4;
  const bodyX = headLeft ? x - 3 : x - 11;
  const feetX = headLeft ? x + 10 : x - 15;
  ctx.fillStyle = p.hair;
  ctx.fillRect(headX, y - 9, 9, 9);
  ctx.fillStyle = p.skin;
  ctx.fillRect(headX + (headLeft ? 2 : -1), y - 7, 8, 7);
  ctx.fillStyle = '#4a3520';
  ctx.fillRect(headX + (headLeft ? 3 : 4), y - 4, 3, 1);
  ctx.fillStyle = p.top;
  ctx.fillRect(bodyX, y - 7, 14, 9);
  ctx.fillStyle = p.bottom;
  ctx.fillRect(feetX, y - 6, 5, 8);
  ctx.fillStyle = p.accent;
  ctx.fillRect(headLeft ? x : x - 11, y - 8, 11, 3);
}

function drawSeatedNpc(ctx: CanvasRenderingContext2D, x: number, y: number, dir: Dir, index: number): void {
  const p = paletteFor(index);
  if (dir === 'up' || dir === 'down') {
    ctx.fillStyle = p.bottom;
    ctx.fillRect(x - 6, y - 9, 5, 7);
    ctx.fillRect(x + 1, y - 9, 5, 7);
    ctx.fillRect(x - 8, y - 3, 5, 3);
    ctx.fillRect(x + 3, y - 3, 5, 3);
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 6, y - 20, 12, 12);
    ctx.fillStyle = p.skin;
    ctx.fillRect(x - 8, y - 18, 3, 8);
    ctx.fillRect(x + 5, y - 18, 3, 8);
    ctx.fillRect(x - 5, y - 31, 10, 10);
    ctx.fillStyle = p.hair;
    ctx.fillRect(x - 6, y - 33, 12, dir === 'up' ? 8 : 4);
    if (dir === 'down') {
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(x - 3, y - 27, 2, 2);
      ctx.fillRect(x + 2, y - 27, 2, 2);
    }
    return;
  }
  const facing = dir === 'left' ? -1 : 1;
  ctx.fillStyle = p.bottom;
  ctx.fillRect(x - 5, y - 9, 10, 6);
  ctx.fillRect(x + (facing > 0 ? 2 : -7), y - 4, 7, 4);
  ctx.fillStyle = '#3a2b24';
  ctx.fillRect(x + (facing > 0 ? 7 : -9), y - 3, 3, 3);
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 6, y - 20, 12, 12);
  if (p.kind === 'apron') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 3, y - 19, 6, 10);
  }
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 5, y - 31, 10, 10);
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 6, y - 33, 12, 4);
  ctx.fillStyle = p.skin;
  ctx.fillRect(x + (facing > 0 ? 5 : -8), y - 18, 3, 8);
}

function drawInteractionHand(ctx: CanvasRenderingContext2D, x: number, y: number, dir: Dir, index: number, swing: number): void {
  const p = paletteFor(index);
  ctx.fillStyle = p.skin;
  if (dir === 'left') ctx.fillRect(x - 10 - Math.max(0, -swing), y - 17 + Math.abs(swing), 4, 4);
  else if (dir === 'right') ctx.fillRect(x + 6 + Math.max(0, swing), y - 17 + Math.abs(swing), 4, 4);
  else if (dir === 'up') ctx.fillRect(x - 2 + swing, y - 22 - Math.abs(swing), 4, 4);
  else ctx.fillRect(x + 5 + swing, y - 17, 4, 4);
}

function drawNpcProcedural(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  dir: Dir,
  motion: NpcMotion,
  index: number,
  pose: NpcPose
): void {
  const p = paletteFor(index);
  const step = motion.frame === 1 ? -2 : motion.frame === 2 ? 2 : 0;
  ctx.fillStyle = p.bottom;
  if (dir === 'left' || dir === 'right') {
    ctx.fillRect(x - 5 + Math.max(0, step), y - 8, 4, 9);
    ctx.fillRect(x + 1 + Math.min(0, step), y - 8, 4, 9);
  } else {
    ctx.fillRect(x - 5, y - 8 + Math.max(0, step), 4, 9);
    ctx.fillRect(x + 1, y - 8 + Math.max(0, -step), 4, 9);
  }
  ctx.fillStyle = p.top;
  ctx.fillRect(x - 6, y - 19, 12, 12);
  if (p.kind === 'apron') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 3, y - 19, 6, 12);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, y - 19, 12, 3);
  }
  ctx.fillStyle = p.skin;
  if (pose === 'walk') {
    ctx.fillRect(x - 8, y - 18 + Math.max(0, -step), 3, 9);
    ctx.fillRect(x + 5, y - 18 + Math.max(0, step), 3, 9);
  } else if (pose === 'interact' || pose === 'speak') {
    drawInteractionHand(ctx, x, y, dir, index, motion.swing);
    ctx.fillRect(x - 8, y - 18, 3, 8);
  } else {
    ctx.fillRect(x - 8, y - 18, 3, 9);
    ctx.fillRect(x + 5, y - 18, 3, 9);
  }
  ctx.fillStyle = p.skin;
  ctx.fillRect(x - 5, y - 31, 10, 10);
  ctx.fillStyle = p.hair;
  ctx.fillRect(x - 6, y - 33, 12, 4);
  if (dir !== 'up') ctx.fillRect(x - 6, y - 29, 3, 6);
  if (p.kind === 'beret') {
    ctx.fillStyle = p.top;
    ctx.fillRect(x - 7, y - 35, 14, 3);
  }
  if (p.kind === 'cap') {
    ctx.fillStyle = p.accent;
    ctx.fillRect(x - 6, y - 34, 12, 3);
    ctx.fillRect(x - 8, y - 31, 3, 2);
  }
  if (p.kind === 'glasses') {
    ctx.fillStyle = '#111111';
    ctx.fillRect(x - 4, y - 27, 3, 3);
    ctx.fillRect(x + 1, y - 27, 3, 3);
    ctx.fillRect(x - 1, y - 26, 2, 1);
  }
  if (dir !== 'up') {
    ctx.fillStyle = '#1a1a1a';
    const eyeX = dir === 'left' ? x - 3 : dir === 'right' ? x + 1 : x - 1;
    ctx.fillRect(eyeX, y - 27, 2, 2);
  }
}
