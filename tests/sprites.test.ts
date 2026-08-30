import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTES,
  drawNpc,
  npcAnimationPhase,
  npcConversationPlacement,
  npcMotionAt,
  npcPoseFor,
  npcRouteWaypoints,
  npcTargetPlacement,
  spriteSourceRect,
  type NpcPose,
} from '../src/web/client/sprites';

function recordingCtx() {
  const fillRects: number[][] = [];
  const strokeRects: number[][] = [];
  const texts: string[] = [];
  const textPositions: number[][] = [];
  let drawImages = 0;
  const ctx = {
    fillRect: (...args: number[]) => { fillRects.push(args); },
    strokeRect: (...args: number[]) => { strokeRects.push(args); },
    fillText: (text: string, ...position: number[]) => { texts.push(text); textPositions.push(position); },
    measureText: (text: string) => ({ width: text.length * 6 }),
    drawImage: () => { drawImages++; },
    imageSmoothingEnabled: true,
    fillStyle: '', strokeStyle: '', font: '',
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fillRects, strokeRects, texts, textPositions, drawImageCount: () => drawImages };
}

test('居民步态相位稳定且不同居民不强制同步', () => {
  const lin = npcAnimationPhase('agent:lin');
  const chen = npcAnimationPhase('agent:chen');
  assert.equal(npcAnimationPhase('agent:lin'), lin);
  assert.ok(Number.isInteger(lin) && lin >= 0 && lin < 480);
  assert.ok(Number.isInteger(chen) && chen >= 0 && chen < 480);
  assert.notEqual(lin, chen);
});

test('步态四拍包含独立帧、bob 与左右摆动且全为整数像素', () => {
  const expected = [
    { frame: 0, bob: 0, swing: 0 },
    { frame: 1, bob: -1, swing: -1 },
    { frame: 0, bob: 0, swing: 0 },
    { frame: 2, bob: -1, swing: 1 },
  ];
  assert.deepEqual([0, 120, 240, 360].map((time) => npcMotionAt(time, 0, 'walk')), expected);
  for (const motion of expected) {
    assert.ok(Object.values(motion).every(Number.isInteger));
  }
  assert.deepEqual(npcMotionAt(360, 0, 'idle'), { frame: 0, bob: 0, swing: 0 });
});

test('快照状态与动作语义映射为明确且可证伪的视觉姿态', () => {
  const cases: [string, string | null, boolean, string, NpcPose][] = [
    ['idle', null, false, '', 'idle'],
    ['thinking', null, false, '', 'think'],
    ['acting', '床', false, '睡觉', 'sleep'],
    ['acting', '沙发', false, '坐在沙发上打盹', 'sleep'],
    ['acting', '床', false, '整理床铺', 'interact'],
    ['acting', '沙发', false, '坐在沙发上看书', 'sit'],
    ['acting', '咖啡馆吧台', false, '制作饮品', 'interact'],
    ['acting', '床', true, '睡觉', 'walk'],
    ['moving', null, false, '', 'walk'],
  ];
  for (const [state, target, walking, verb, expected] of cases) {
    assert.equal(npcPoseFor(state, target, walking, verb), expected, `${state}/${target}/${walking}/${verb}`);
  }
});

test('八槽图集索引循环合法且每个方向源矩形都在 384×256 范围内', () => {
  assert.equal(PALETTES.length, 8);
  assert.equal(new Set(PALETTES.map((palette) => `${palette.hair}/${palette.top}/${palette.bottom}`)).size, 8);
  for (const index of [-1, 0, 7, 8, 31]) {
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      for (const frame of [0, 1, 2] as const) {
        const source = spriteSourceRect(index, dir, frame);
        assert.ok(source.sx >= 0 && source.sx + source.sw <= 384, `${index}/${dir}/${frame}`);
        assert.ok(source.sy >= 0 && source.sy + source.sh <= 256, `${index}/${dir}/${frame}`);
      }
    }
  }
  assert.deepEqual(spriteSourceRect(8, 'down', 0), spriteSourceRect(0, 'down', 0));
  assert.deepEqual(spriteSourceRect(-1, 'up', 2), spriteSourceRect(7, 'up', 2));
});

test('活跃会话站位把双方稳定排近并严格相向', () => {
  const horizontal = npcConversationPlacement('agent:a', 'agent:b', 48, 48, 80, 48);
  assert.deepEqual(horizontal, {
    a: { cx: 53, cy: 48, dir: 'right' },
    b: { cx: 75, cy: 48, dir: 'left' },
  });
  const vertical = npcConversationPlacement('agent:a', 'agent:b', 48, 48, 48, 80);
  assert.deepEqual(vertical, {
    a: { cx: 48, cy: 53, dir: 'down' },
    b: { cx: 48, cy: 75, dir: 'up' },
  });
  const sameTile = npcConversationPlacement('agent:a', 'agent:b', 64.4, 64.4, 64.4, 64.4);
  assert.equal(sameTile.a.dir, 'right');
  assert.equal(sameTile.b.dir, 'left');
  assert.ok([sameTile.a.cx, sameTile.a.cy, sameTile.b.cx, sameTile.b.cy].every(Number.isInteger));
});

test('睡眠与坐姿按家具几何取得自然锚点和方向', () => {
  assert.deepEqual(
    npcTargetPlacement('sleep', { x: 96, y: 64, w: 32, h: 64 }, 112, 112, 'right'),
    { cx: 112, cy: 96, dir: 'up' },
  );
  assert.deepEqual(
    npcTargetPlacement('sleep', { x: 64, y: 128, w: 64, h: 32 }, 112, 144, 'down'),
    { cx: 96, cy: 144, dir: 'left' },
  );
  assert.deepEqual(
    npcTargetPlacement('sit', { x: 64, y: 128, w: 64, h: 32 }, 112, 144, 'right'),
    { cx: 96, cy: 165, dir: 'up' },
  );
  assert.deepEqual(
    npcTargetPlacement('idle', { x: 0, y: 0, w: 32, h: 32 }, 48.4, 64.4, 'left'),
    { cx: 48, cy: 64, dir: 'left' },
  );
});

test('睡觉与坐姿使用独立程序化轮廓，不绘制直立图集且不产生亚像素', () => {
  for (const [pose, dir] of [['sleep', 'right'], ['sleep', 'up'], ['sit', 'right'], ['sit', 'up']] as const) {
    const recording = recordingCtx();
    drawNpc(recording.ctx, 48.4, 64.4, dir, 7, {
      pose, nowMs: 360, phase: 0, selected: true, name: '林晚晴',
    });
    assert.equal(recording.drawImageCount(), 0, `${pose}/${dir}`);
    assert.ok(recording.fillRects.length >= 8, `${pose}/${dir}`);
    assert.equal(recording.strokeRects.length, 1, `${pose}/${dir}`);
    assert.ok(recording.texts.includes('林晚晴'));
    for (const args of [...recording.fillRects, ...recording.strokeRects, ...recording.textPositions]) {
      assert.ok(args.every(Number.isInteger), `${pose}/${dir} 出现非整数像素：${args.join(',')}`);
    }
  }
});

test('说话姿态有独立整数像素声纹与轻微四拍动作', () => {
  assert.notDeepEqual(npcMotionAt(0, 0, 'speak'), npcMotionAt(120, 0, 'speak'));
  const recording = recordingCtx();
  drawNpc(recording.ctx, 48.4, 64.4, 'left', 2, {
    pose: 'speak', nowMs: 120, phase: 0, selected: false, name: '说话者',
  });
  assert.ok(recording.fillRects.length >= 10);
  for (const args of recording.fillRects) assert.ok(args.every(Number.isInteger), args.join(','));
});

test('高倍速快照沿服务器 A* waypoint 逐段追赶，不把转角压成斜线', () => {
  const path = [
    { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 },
    { x: 3, y: 2 }, { x: 3, y: 3 },
  ];
  assert.deepEqual(
    npcRouteWaypoints(path, { x: 1, y: 1 }, { x: 3, y: 3 }, 32),
    [{ x: 64, y: 32 }, { x: 96, y: 32 }, { x: 96, y: 64 }, { x: 96, y: 96 }],
  );
  assert.deepEqual(
    npcRouteWaypoints([], { x: 1, y: 1 }, { x: 4, y: 5 }, 32),
    [{ x: 128, y: 160 }],
  );
});
