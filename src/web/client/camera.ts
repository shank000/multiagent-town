// 全屏相机纯函数：fit-to-screen 缩放与光标锚定缩放（无 DOM 依赖，可 node 测试）

export interface FitCamera { scale: number; offX: number; offY: number }
export const PIXEL_ZOOM_LEVELS = [1, 2, 3, 4] as const;

/** 整图适配窗口：scale = min(w/gridW, h/gridH)，居中（信箱留白在两侧或上下） */
export function computeFit(viewW: number, viewH: number, gridW: number, gridH: number, tile: number): FitCamera {
  const scale = Math.min(viewW / (gridW * tile), viewH / (gridH * tile));
  return {
    scale,
    offX: (viewW - gridW * tile * scale) / 2,
    offY: (viewH - gridH * tile * scale) / 2,
  };
}

/** 缩放系数钳制到 [fit, fit×4] */
export function zoomScale(current: number, factor: number, fitScale: number): number {
  return Math.max(fitScale, Math.min(fitScale * 4, current * factor));
}

/** 默认细节倍率使用整数级别；窄三栏从 1:1 开始浏览，像素不会被任意小数压缩。 */
export function detailScale(fitScale: number): number {
  if (fitScale < 1) return 1;
  return Math.max(1, Math.floor(fitScale));
}

/** 在固定整数倍率之间逐级缩放。 */
export function stepPixelZoom(current: number, direction: -1 | 1): number {
  if (direction > 0) return PIXEL_ZOOM_LEVELS.find((level) => level > current + 1e-6) ?? PIXEL_ZOOM_LEVELS.at(-1)!;
  return [...PIXEL_ZOOM_LEVELS].reverse().find((level) => level < current - 1e-6) ?? PIXEL_ZOOM_LEVELS[0];
}

/** 平移边界：至少保留 margin CSS px 的世界区域在视窗中。 */
export function clampCameraOffsets(
  viewW: number,
  viewH: number,
  worldW: number,
  worldH: number,
  scale: number,
  offX: number,
  offY: number,
  margin = 72
): { offX: number; offY: number } {
  const scaledW = worldW * scale;
  const scaledH = worldH * scale;
  const clampAxis = (view: number, content: number, offset: number): number => {
    if (content <= view) return (view - content) / 2;
    return Math.max(view - content - margin, Math.min(margin, offset));
  };
  return { offX: clampAxis(viewW, scaledW, offX), offY: clampAxis(viewH, scaledH, offY) };
}

/** 以屏幕锚点 (anchorX,anchorY) 为中心缩放后的新偏移：锚点下的世界坐标保持不变 */
export function zoomOffsets(
  anchorX: number, anchorY: number,
  prevScale: number, newScale: number,
  prevOffX: number, prevOffY: number,
  tile: number
): { offX: number; offY: number } {
  // 锚点世界坐标守恒：锚点与偏移均为 CSS px，scale 为 CSS 尺度；wx = (ax - offX)/(scale*tile)（CSS 瓦片数）
  const wx = (anchorX - prevOffX) / (prevScale * tile);
  const wy = (anchorY - prevOffY) / (prevScale * tile);
  return {
    offX: anchorX - wx * newScale * tile,
    offY: anchorY - wy * newScale * tile,
  };
}
