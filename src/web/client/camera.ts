// 全屏相机纯函数：fit-to-screen 缩放与光标锚定缩放（无 DOM 依赖，可 node 测试）

export interface FitCamera { scale: number; offX: number; offY: number }

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

/** 以屏幕锚点 (anchorX,anchorY) 为中心缩放后的新偏移：锚点下的世界坐标保持不变 */
export function zoomOffsets(
  anchorX: number, anchorY: number,
  prevScale: number, newScale: number,
  prevOffX: number, prevOffY: number,
  tile: number
): { offX: number; offY: number } {
  // 锚点世界坐标守恒：wx = (ax - offX)/(scale*tile)
  const wx = (anchorX - prevOffX) / (prevScale * tile);
  const wy = (anchorY - prevOffY) / (prevScale * tile);
  return {
    offX: anchorX - wx * newScale * tile,
    offY: anchorY - wy * newScale * tile,
  };
}
