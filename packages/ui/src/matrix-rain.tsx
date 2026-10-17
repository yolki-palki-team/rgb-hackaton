import * as React from 'react';

const defaultCharacters =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';

type Column = { head: number; seed: number; velocity: number };

export type MatrixRainProps = Omit<React.ComponentPropsWithoutRef<'div'>, 'children'> & {
  background?: string;
  characters?: string;
  color?: string;
  density?: number;
  fontSize?: number;
  glow?: number;
  highlight?: string;
  pointerResponse?: boolean;
  speed?: number;
  trail?: number;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function randomFrom(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function createColumn(index: number): Column {
  const seed = index * 47.17 + 11.3;
  return {
    head: 1.5 - randomFrom(seed + 2.4) * 10.5,
    seed,
    velocity: 9 + randomFrom(seed + 5.7) * 11,
  };
}

export function MatrixRain({
  'aria-hidden': ariaHidden = true,
  'aria-label': ariaLabel = 'Animated field of falling characters',
  background = '#020604',
  characters = defaultCharacters,
  className,
  color = '#39ff68',
  density = 0.9,
  fontSize = 28,
  glow = 8,
  highlight = '#eaffed',
  pointerResponse = true,
  speed = 1,
  style,
  trail = 0.9,
  ...props
}: MatrixRainProps) {
  const rootRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;

    const safeFontSize = clamp(fontSize, 10, 32);
    const safeDensity = clamp(density, 0.45, 1.4);
    const safeSpeed = clamp(speed, 0.2, 2.5);
    const safeTrail = clamp(trail, 0.72, 0.97);
    const glyphs = Array.from(characters || defaultCharacters);
    const pointer = { active: false, x: 0, y: 0 };
    let columns: Column[] = [];
    let columnWidth = safeFontSize / safeDensity;
    let frame: number | undefined;
    let lastTime = performance.now();
    let elapsed = 0;
    let frameAccumulator = 0;
    let visible = true;
    const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduceMotion = motionPreference.matches;

    function resize() {
      if (!root || !canvas || !context) return;
      const bounds = root.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(bounds.width * ratio));
      const height = Math.max(1, Math.round(bounds.height * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      columnWidth = safeFontSize / safeDensity;
      columns = Array.from({ length: Math.ceil(bounds.width / columnWidth) + 1 }, (_, index) =>
        createColumn(index),
      );
      context.fillStyle = background;
      context.fillRect(0, 0, bounds.width, bounds.height);
    }

    function characterAt(seed: number) {
      return glyphs[Math.floor(randomFrom(seed) * glyphs.length)] ?? glyphs[0] ?? '0';
    }

    function drawStatic() {
      if (!root || !context) return;
      const bounds = root.getBoundingClientRect();
      context.globalAlpha = 1;
      context.fillStyle = background;
      context.fillRect(0, 0, bounds.width, bounds.height);
      context.font = `500 ${safeFontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        if (!column) continue;
        const x = index * columnWidth + columnWidth * 0.5;
        const rows = Math.ceil(bounds.height / safeFontSize);
        const head = Math.floor(randomFrom(column.seed + 8) * rows);
        const length = 10 + Math.floor(randomFrom(column.seed + 9) * 16);
        for (let offset = 0; offset < length; offset += 1) {
          const row = head - offset;
          if (row < 0) continue;
          context.globalAlpha = Math.pow(1 - offset / length, 2.2);
          context.fillStyle = offset === 0 ? highlight : color;
          context.fillText(characterAt(column.seed + row * 2.73), x, row * safeFontSize);
        }
      }
      context.globalAlpha = 1;
    }

    function drawRainTick(deltaSeconds: number) {
      if (!root || !context) return;
      const bounds = root.getBoundingClientRect();
      const rows = Math.ceil(bounds.height / safeFontSize);
      const pointerRadius = Math.max(84, safeFontSize * 7.5);
      context.globalAlpha = (1 - safeTrail) * 0.5;
      context.fillStyle = background;
      context.fillRect(0, 0, bounds.width, bounds.height);
      context.font = `500 ${safeFontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index];
        if (!column) continue;
        column.head += column.velocity * safeSpeed * deltaSeconds;
        if (column.head > rows + 4) {
          const reset = createColumn(index + Math.floor(elapsed * 0.01));
          column.head = -4 - randomFrom(reset.seed + 9) * rows * 0.5;
          column.seed = reset.seed;
          column.velocity = reset.velocity;
        }
        const x = index * columnWidth + columnWidth * 0.5;
        const y = Math.floor(column.head) * safeFontSize;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        const influence =
          pointerResponse && pointer.active ? Math.max(0, 1 - distance / pointerRadius) : 0;
        const displacement = distance ? ((x - pointer.x) / distance) * influence * 7 : 0;
        const glyph = characterAt(column.seed + Math.floor(column.head) * 2.73 + elapsed * 0.0041);
        context.globalAlpha = 0.82 + influence * 0.18;
        context.fillStyle = color;
        context.shadowColor = color;
        context.shadowBlur = clamp(glow, 0, 18) * (0.7 + influence * 0.5);
        context.fillText(glyph, x + displacement, y);
        context.globalAlpha = 0.62 + influence * 0.38;
        context.fillStyle = highlight;
        context.shadowBlur = clamp(glow, 0, 18) * 0.45;
        context.fillText(glyph, x + displacement, y);
      }
      context.globalAlpha = 1;
      context.shadowBlur = 0;
    }

    function tick(time: number) {
      const deltaSeconds = Math.min((time - lastTime) / 1000, 0.05);
      lastTime = time;
      elapsed += deltaSeconds * 1000;
      frameAccumulator += deltaSeconds;
      if (frameAccumulator >= 0.05) {
        drawRainTick(frameAccumulator);
        frameAccumulator = 0;
      }
      frame =
        visible && !reduceMotion && !document.hidden
          ? window.requestAnimationFrame(tick)
          : undefined;
    }

    function start() {
      if (frame !== undefined || !visible || reduceMotion || document.hidden) return;
      lastTime = performance.now();
      frame = window.requestAnimationFrame(tick);
    }

    function stop() {
      if (frame === undefined) return;
      window.cancelAnimationFrame(frame);
      frame = undefined;
    }

    function handlePointerMove(event: PointerEvent) {
      if (!root) return;
      const bounds = root.getBoundingClientRect();
      pointer.active =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
    }

    function handlePointerLeave() {
      pointer.active = false;
    }

    function handleMotionPreference() {
      reduceMotion = motionPreference.matches;
      if (reduceMotion) {
        stop();
        drawStatic();
      } else start();
    }

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (reduceMotion) drawStatic();
      else drawRainTick(0);
    });
    const visibilityObserver = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
      else stop();
    });
    resize();
    if (reduceMotion) drawStatic();
    else drawRainTick(0);
    start();
    resizeObserver.observe(root);
    visibilityObserver.observe(root);
    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerleave', handlePointerLeave);
    document.addEventListener('visibilitychange', start);
    motionPreference.addEventListener('change', handleMotionPreference);
    return () => {
      stop();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerleave', handlePointerLeave);
      document.removeEventListener('visibilitychange', start);
      motionPreference.removeEventListener('change', handleMotionPreference);
    };
  }, [
    background,
    characters,
    color,
    density,
    fontSize,
    glow,
    highlight,
    pointerResponse,
    speed,
    trail,
  ]);

  return (
    <div
      ref={rootRef}
      aria-hidden={ariaHidden}
      aria-label={ariaHidden ? undefined : ariaLabel}
      className={className}
      data-slot="matrix-rain"
      role={ariaHidden ? undefined : 'img'}
      style={{ overflow: 'hidden', background, pointerEvents: 'none', ...style }}
      {...props}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}

export default MatrixRain;
