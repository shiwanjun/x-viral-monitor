import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const imageViewer = readFileSync(resolve(here, '..', 'lib', 'image-viewer.js'), 'utf8');

function createViewer() {
  const listeners = new Map();
  const style = { backgroundImage: 'url("https://pbs.twimg.com/media/test")', transform: '' };
  const base = { left: 100, top: 100, width: 600, height: 400 };
  const visual = {
    style,
    parentElement: null,
    getBoundingClientRect() {
      const match = style.transform.match(/scale\(([^)]+)\) translate\(([^p]+)px, ([^p]+)px\)/);
      if (!match) return { ...base, right: 700, bottom: 500 };
      const scale = Number(match[1]);
      const tx = Number(match[2]) * scale;
      const ty = Number(match[3]) * scale;
      const width = base.width * scale;
      const height = base.height * scale;
      const left = base.left + base.width / 2 + tx - width / 2;
      const top = base.top + base.height / 2 + ty - height / 2;
      return { left, top, width, height, right: left + width, bottom: top + height };
    },
  };
  const swipe = {
    parentElement: null,
    contains: (target) => target === visual,
    appendChild() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600,
      right: 800, bottom: 600 }),
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'div' ? [visual] : [],
  };
  visual.parentElement = swipe;
  const indicator = { classList: { add() {}, remove() {} }, remove() {} };
  const document = {
    body: { appendChild() {} },
    createElement: () => indicator,
    querySelector: () => ({ querySelectorAll: () => [swipe] }),
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  runInNewContext(imageViewer, {
    window: { __xvmLiv: undefined, innerWidth: 800, innerHeight: 600 },
    document,
    location: { pathname: '' },
    MutationObserver: class { observe() {} },
    WheelEvent: { DOM_DELTA_PIXEL: 0, DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 },
    setTimeout: () => 1,
    clearTimeout() {},
  });
  return { visual, wheel: listeners.get('wheel') };
}

function sendWheel(viewer, overrides) {
  const event = {
    target: viewer.visual,
    ctrlKey: false,
    clientX: 250,
    clientY: 200,
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
    ...overrides,
  };
  viewer.wheel(event);
  return event;
}

describe('image viewer gestures', () => {
  it('keeps cursor-anchored zoom in one shared function', () => {
    expect(imageViewer).toContain('function panLimit(contentSize, viewportSize)');
    expect(imageViewer).toContain('Math.abs(contentSize - viewportSize) / 2');
    expect(imageViewer).toContain('function zoomAt(nextScale, clientX, clientY)');
    expect(imageViewer).toContain('tx += cx * (1 - ratio)');
    expect(imageViewer).toContain('zoomAt(DOUBLE_CLICK_SCALE, e.clientX, e.clientY)');
  });

  it('uses trackpad pinch for direct, cursor-anchored zoom', () => {
    expect(imageViewer).toContain('if (e.ctrlKey)');
    expect(imageViewer).toContain('Math.exp(-clamp(deltaY, -25, 25) * PINCH_ZOOM_SENSITIVITY)');
    expect(imageViewer).toContain('applyTransform(false)');
  });

  it('uses ordinary two-finger scrolling to pan an enlarged image', () => {
    expect(imageViewer).toContain('if (!e.ctrlKey && scale <= MIN_SCALE) return;');
    expect(imageViewer).toContain('tx -= deltaX');
    expect(imageViewer).toContain('ty -= deltaY');
  });

  it('keeps an off-center pinch anchored before the image fills the viewport', () => {
    // Given
    const viewer = createViewer();

    // When
    const event = sendWheel(viewer, { ctrlKey: true, deltaY: -10 });

    // Then
    const rect = viewer.visual.getBoundingClientRect();
    expect(rect.width).toBeLessThan(800);
    expect(rect.left + rect.width * 0.25).toBeCloseTo(250, 6);
    expect(rect.top + rect.height * 0.25).toBeCloseTo(200, 6);
    expect(event.defaultPrevented).toBe(true);
    expect(viewer.visual.style.transition).toBe('none');
  });

  it('pans an enlarged image even before it fills the viewport', () => {
    // Given
    const viewer = createViewer();
    sendWheel(viewer, { ctrlKey: true, deltaY: -10 });
    const before = viewer.visual.getBoundingClientRect();

    // When
    const event = sendWheel(viewer, { deltaX: 30, deltaY: 40 });

    // Then
    const after = viewer.visual.getBoundingClientRect();
    expect(after.left - before.left).toBeCloseTo(-30, 6);
    expect(after.top - before.top).toBeCloseTo(-40, 6);
    expect(event.defaultPrevented).toBe(true);
  });

  it('passes ordinary scrolling through at fit scale', () => {
    // Given
    const viewer = createViewer();

    // When
    const event = sendWheel(viewer, { deltaY: 40 });

    // Then
    expect(event.defaultPrevented).toBe(false);
    expect(viewer.visual.style.transform).toBe('');
  });
});
