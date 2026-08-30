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
export type ActionVisualKind =
  | 'sleep' | 'rest' | 'stroll' | 'coffee' | 'read' | 'write' | 'paint'
  | 'mail' | 'flower' | 'water' | 'fish' | 'repair' | 'clean' | 'trade'
  | 'carry' | 'observe' | 'cook' | 'social' | 'generic';

export interface ActionVisual {
  kind: ActionVisualKind;
  pose: NpcPose;
}

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
  actionVisual?: ActionVisual | null;
}

export interface ConversationPlacement {
  a: { cx: number; cy: number; dir: Dir };
  b: { cx: number; cy: number; dir: Dir };
}

export interface NpcPlacement { cx: number; cy: number; dir: Dir }
export interface PixelTargetRect { x: number; y: number; w: number; h: number }
export interface TilePoint { x: number; y: number }

const WALK_FRAMES = [0, 1, 1, 0, 0, 2, 2, 0] as const;
const WALK_BOB = [0, -1, -1, 0, 0, -1, -1, 0] as const;
const WALK_SWING = [0, -1, -2, -1, 0, 1, 2, 1] as const;
const paletteFor = (index: number) => PALETTES[((Math.trunc(index) % PALETTES.length) + PALETTES.length) % PALETTES.length];

/** 居民相位由稳定 id 派生，避免全镇同手同脚，同时保证相同快照可复现。 */
export function npcAnimationPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 720;
}

/** 仅返回整数像素运动量；相同时间、相位和姿态得到完全相同结果。 */
export function npcMotionAt(nowMs: number, phase: number, pose: NpcPose): NpcMotion {
  const beat = Math.floor((Math.max(0, nowMs) + phase) / 90) % 8;
  if (pose === 'walk') {
    return { frame: WALK_FRAMES[beat], bob: WALK_BOB[beat], swing: WALK_SWING[beat] };
  }
  if (pose === 'interact' || pose === 'speak') {
    return { frame: 0, bob: beat === 2 || beat === 6 ? -1 : 0, swing: Math.sign(WALK_SWING[beat]) };
  }
  return { frame: 0, bob: 0, swing: 0 };
}

/**
 * 把当前动作文本收敛为可观察的像素行为。每个 acting 动作都有确定结果，
 * 未命中专门语义时使用通用交互动作，保证画面不会只剩静止角色。
 */
export function actionVisualFor(verb: string, targetName: string | null): ActionVisual {
  const text = `${verb} ${targetName ?? ''}`;
  if (/睡觉|睡眠|午睡|午休|小憩|打盹|就寝/.test(text)) return { kind: 'sleep', pose: 'sleep' };
  if (/散步|走走|巡逻|巡视|巡湖|漫步/.test(text)) return { kind: 'stroll', pose: 'walk' };
  if (/钓鱼|垂钓|鱼竿/.test(text)) return { kind: 'fish', pose: 'interact' };
  if (/浇水|灌溉|压水|接.*水|水泵/.test(text)) return { kind: 'water', pose: 'interact' };
  if (/写生|画画|绘画|速写|画布|插画/.test(text)) return { kind: 'paint', pose: 'interact' };
  if (/看书|读书|阅读|翻.*书|小说|书架|园艺书/.test(text)) {
    return { kind: 'read', pose: /沙发|长椅|座椅|咖啡桌/.test(text) ? 'sit' : 'interact' };
  }
  if (/写信|记录|便笺|笔记|时刻表|公告|书目/.test(text)) return { kind: 'write', pose: 'interact' };
  if (/送信|信件|分拣|邮件|邮局|送花|配送/.test(text)) return { kind: 'mail', pose: 'interact' };
  if (/咖啡|饮品|喝茶|泡茶|饮水|一杯水/.test(text)) return { kind: 'coffee', pose: /沙发|桌|椅/.test(text) ? 'sit' : 'interact' };
  if (/煮|烤|烹饪|做饭|厨房|备餐|面包/.test(text)) return { kind: 'cook', pose: 'interact' };
  if (/花店|鲜花|花束|插花|理花|赏花|幼苗|菜园|除草|种植|鸟食|谷粒/.test(text)) return { kind: 'flower', pose: 'interact' };
  if (/工具|修理|修补|维护|检查|整理床铺/.test(text)) return { kind: 'repair', pose: 'interact' };
  if (/清理|打扫|扫地|落叶|清洁/.test(text)) return { kind: 'clean', pose: 'interact' };
  if (/摊位|日用品|货物|购买|交易|集市|挑选|开店|接待顾客/.test(text)) return { kind: 'trade', pose: 'interact' };
  if (/包裹|搬取|搬运|运送|划船/.test(text)) return { kind: 'carry', pose: 'interact' };
  if (/观察|查看|留意|检查|洞察|倾听|赏/.test(text)) return { kind: 'observe', pose: 'interact' };
  if (/交谈|分享|讲古|招待|问候|读书会|聚会/.test(text)) return { kind: 'social', pose: 'interact' };
  if (/休息|歇|整理思绪|放慢节奏|发呆/.test(text)) return { kind: 'rest', pose: 'think' };
  return { kind: 'generic', pose: 'interact' };
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
  if (pose === 'interact' && target.w <= 64 && target.h <= 64) {
    // 角色按抵达方向停在物体近侧并朝向物体，避免站进水泵、画架、吧台等轮廓里。
    const gap = Math.min(14, Math.max(10, Math.round(Math.min(target.w, target.h) * .38)));
    if (fallbackDir === 'right') return { cx: centerX - gap, cy: centerY + 5, dir: 'right' };
    if (fallbackDir === 'left') return { cx: centerX + gap, cy: centerY + 5, dir: 'left' };
    if (fallbackDir === 'down') return { cx: centerX, cy: centerY - gap + 5, dir: 'down' };
    return { cx: centerX, cy: centerY + gap + 5, dir: 'up' };
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
export function npcPoseFor(
  state: string,
  targetName: string | null,
  walking: boolean,
  verb = '',
  actionVisual: ActionVisual | null = null,
): NpcPose {
  if (walking || state === 'moving') return 'walk';
  if (state === 'thinking') return 'think';
  if (state === 'acting' && actionVisual) return actionVisual.pose;
  const sleeping = /睡觉|睡眠|午睡|午休|小憩|打盹|就寝/.test(verb);
  if (state === 'acting' && sleeping && (!targetName || /床|沙发/.test(targetName))) return 'sleep';
  if (state === 'acting' && !!targetName && /沙发|咖啡桌|椅|长椅/.test(targetName)) return 'sit';
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
  if (options.actionVisual) {
    drawActionVisual(ctx, groundX, groundY, dir, options.actionVisual, options.nowMs, options.phase);
  }

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

export interface ActionAnimationBeat {
  beat: number;
  reach: number;
  lift: number;
}

/** 八拍动作节奏；输出全部为整数，便于像素动画复验。 */
export function actionAnimationBeat(nowMs: number, phase: number): ActionAnimationBeat {
  const beat = Math.floor((Math.max(0, nowMs) + phase) / 120) % 8;
  const reaches = [0, 1, 2, 1, 0, -1, -2, -1] as const;
  const lifts = [0, 0, -1, -1, 0, 0, 1, 1] as const;
  return { beat, reach: reaches[beat], lift: lifts[beat] };
}

/** 当前动作的程序化像素道具；与 actionVisualFor 一一对应，不依赖外部图标字体。 */
export function drawActionVisual(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dir: Dir,
  visual: ActionVisual,
  nowMs: number,
  phase: number,
): void {
  const x = Math.round(cx);
  const y = Math.round(cy);
  const motion = actionAnimationBeat(nowMs, phase);
  const side = dir === 'left' ? -1 : 1;
  const frontX = dir === 'left' ? x - 15 : dir === 'right' ? x + 10 : x + 7;
  const frontY = y - 17 + motion.lift;
  const px = (color: string, rx: number, ry: number, rw: number, rh: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(rx), Math.round(ry), Math.round(rw), Math.round(rh));
  };

  if (visual.kind === 'sleep') {
    const drift = Math.floor(motion.beat / 2);
    px('#b9d9ef', x + 9 + drift, y - 29 - drift, 5, 2);
    px('#b9d9ef', x + 12 + drift, y - 27 - drift, 2, 2);
    px('#b9d9ef', x + 9 + drift, y - 25 - drift, 5, 2);
    return;
  }
  if (visual.kind === 'stroll') {
    if (motion.beat === 2 || motion.beat === 6) {
      px('rgba(211,193,150,.58)', x - side * 5, y + 10, 3, 2);
      px('rgba(211,193,150,.36)', x - side * 9, y + 9, 2, 1);
    }
    return;
  }
  if (visual.kind === 'rest') {
    const pulse = motion.beat < 4 ? 0 : 1;
    px('#9fc6d7', x + 9, y - 28 - pulse, 2, 2);
    px('#9fc6d7', x + 13, y - 31 - pulse, 2, 2);
    return;
  }
  if (visual.kind === 'coffee') {
    px('#5d3d2b', frontX, frontY, 7, 6);
    px('#e8d5b2', frontX + 1, frontY + 1, 5, 3);
    px('#5d3d2b', frontX + (side > 0 ? 7 : -2), frontY + 1, 2, 3);
    if (motion.beat % 2 === 0) {
      px('rgba(244,239,220,.84)', frontX + 2, frontY - 4, 1, 3);
      px('rgba(244,239,220,.62)', frontX + 5, frontY - 6, 1, 3);
    }
    return;
  }
  if (visual.kind === 'read' || visual.kind === 'write') {
    const bookX = x - 7;
    const bookY = visual.pose === 'sit' ? y - 14 : y - 19;
    px('#704b38', bookX - 1, bookY - 1, 16, 9);
    px('#f0dfb8', bookX, bookY, 7, 7);
    px('#e7d2a5', bookX + 8, bookY, 7, 7);
    px('#9c7b55', bookX + 7, bookY, 1, 7);
    if (visual.kind === 'write') {
      px('#405f77', bookX + 9 + (motion.beat % 3), bookY + 1 + Math.floor(motion.beat / 4), 1, 6);
    } else if (motion.beat === 3 || motion.beat === 4) {
      px('#fff1c9', bookX + 8, bookY, 6, 1);
    }
    return;
  }
  if (visual.kind === 'paint') {
    const easelX = frontX + side * 2;
    px('#6d4930', easelX, y - 26, 2, 20);
    px('#6d4930', easelX + side * 8, y - 26, 2, 20);
    px('#dfc99b', Math.min(easelX, easelX + side * 8) - 1, y - 27, 12, 12);
    px('#6da0ba', Math.min(easelX, easelX + side * 8) + 2, y - 24, 5, 3);
    px(motion.beat < 4 ? '#d96b5f' : '#e0b553', frontX + side * (3 + Math.abs(motion.reach)), y - 21, 3, 2);
    return;
  }
  if (visual.kind === 'mail') {
    px('#f2dfb9', frontX, frontY - 1, 11, 8);
    px('#b88b61', frontX + 1, frontY, 9, 1);
    px('#b88b61', frontX + 2, frontY + 2, 2, 1);
    px('#b88b61', frontX + 7, frontY + 2, 2, 1);
    px('#b64f47', frontX + 7 + (motion.beat % 2), frontY + 5, 2, 2);
    return;
  }
  if (visual.kind === 'flower') {
    px('#3f8c48', frontX + 4, frontY - 1, 2, 12);
    px('#5da85d', frontX + 1, frontY + 5, 4, 2);
    px('#d75f77', frontX + 1 + motion.lift, frontY - 4, 4, 4);
    px('#efc557', frontX + 2 + motion.lift, frontY - 3, 2, 2);
    return;
  }
  if (visual.kind === 'water') {
    px('#65838c', frontX, frontY, 9, 7);
    px('#91a9ad', frontX + 2, frontY - 2, 5, 2);
    px('#65838c', frontX + (side > 0 ? 8 : -5), frontY + 2, 6, 2);
    for (let i = 0; i < 3; i++) {
      const dropY = y - 8 + ((motion.beat + i * 2) % 6) * 3;
      px('#65b8d2', frontX + side * (11 + i * 2), dropY, 2, 3);
    }
    return;
  }
  if (visual.kind === 'fish') {
    const rodX = frontX;
    for (let i = 0; i < 6; i++) px('#72513a', rodX + side * i * 2, y - 23 - i * 2, 2, 3);
    const tipX = rodX + side * 11;
    px('#c8d4d1', tipX, y - 32, 1, 22 + (motion.beat % 2));
    px('#d45b49', tipX - 1, y - 10 + (motion.beat % 2), 3, 3);
    px('rgba(143,205,220,.76)', tipX - 5, y - 5, 10, 1);
    return;
  }
  if (visual.kind === 'repair') {
    const toolX = frontX + motion.reach;
    px('#704b32', toolX + 3, frontY - 2, 2, 12);
    px('#aeb7b5', toolX, frontY - 4, 8, 4);
    if (motion.beat === 2 || motion.beat === 6) px('#f2d36e', toolX + side * 9, frontY + 4, 2, 2);
    return;
  }
  if (visual.kind === 'clean') {
    const broomX = frontX + motion.reach;
    for (let i = 0; i < 7; i++) px('#765137', broomX + side * i, frontY - 5 + i * 3, 2, 4);
    px('#c79d55', broomX + side * 6 - 3, frontY + 15, 8, 5);
    if (motion.beat === 2 || motion.beat === 6) px('rgba(207,188,145,.55)', broomX + side * 13, y + 8, 3, 2);
    return;
  }
  if (visual.kind === 'trade') {
    px('#765038', frontX - 1, frontY + 1, 12, 8);
    px('#a97948', frontX + 1, frontY - 2, 8, 4);
    px('#d98a4c', frontX + 2, frontY + 2, 3, 3);
    px('#79a758', frontX + 7, frontY + 3, 3, 3);
    if (motion.beat === 1 || motion.beat === 5) px('#f0cf63', frontX + 11, frontY - 2, 3, 3);
    return;
  }
  if (visual.kind === 'carry') {
    px('#765038', x - 8, y - 19 + motion.lift, 16, 11);
    px('#a97948', x - 6, y - 17 + motion.lift, 12, 7);
    px('#d5b071', x - 1, y - 18 + motion.lift, 2, 9);
    return;
  }
  if (visual.kind === 'observe') {
    px('#394e57', frontX, frontY - 5, 5, 5);
    px('#394e57', frontX + 7, frontY - 5, 5, 5);
    px('#7fb0bd', frontX + 1, frontY - 4, 3, 3);
    px('#7fb0bd', frontX + 8, frontY - 4, 3, 3);
    px('#394e57', frontX + 5, frontY - 3, 2, 2);
    if (motion.beat === 2) px('#f6dda0', frontX + side * 14, frontY - 4, 2, 2);
    return;
  }
  if (visual.kind === 'cook') {
    px('#38434a', frontX - 1, frontY + 2, 12, 4);
    px('#6f7d82', frontX + (side > 0 ? 10 : -6), frontY + 3, 7, 2);
    px('#d98a4c', frontX + 3, frontY, 5, 3);
    if (motion.beat % 2 === 0) {
      px('rgba(242,235,214,.78)', frontX + 3, frontY - 6, 1, 5);
      px('rgba(242,235,214,.62)', frontX + 7, frontY - 8, 1, 5);
    }
    return;
  }
  if (visual.kind === 'social') {
    const waveY = frontY - 6 - Math.abs(motion.reach);
    px('#f4d38d', frontX + side * 3, waveY, 3, 4);
    px('#ffe8a8', frontX + side * 8, waveY - 3, 2, 2);
    px('#ffe8a8', frontX + side * 11, waveY + 1, 2, 2);
    return;
  }
  // 通用交互仍呈现手部触碰与两拍反馈，确保未知动作也有明确的执行状态。
  px('#d5b070', frontX + motion.reach, frontY, 6, 5);
  if (motion.beat === 2 || motion.beat === 6) {
    px('#f4dc82', frontX + side * 9, frontY - 4, 2, 2);
    px('#f4dc82', frontX + side * 12, frontY, 2, 2);
  }
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
