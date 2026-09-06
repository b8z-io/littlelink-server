'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { sortNodes } from '../Sort/Sort';
import type { HelixOptions, HelixStyle } from '../../config/helixConfig';
import {
  clamp,
  place,
  project,
  strandPoint,
  twistPerStep,
  wrap,
  type Viewport,
} from './helixMath';

import './Helix.css';

export interface HelixProps {
  options: HelixOptions;
  children?: React.ReactNode;
}

interface Palette {
  /** Specular highlight along the near side of a strand. */
  core: string;
  /** Main strand colour at its nearest point. */
  body: string;
  /** Strand colour at its furthest point. */
  deep: string;
  /** Out-of-focus helices in the background. */
  far: string;
  /** Nucleotide beads travelling along the backbone. */
  bead: string;
  /** Strength of the bloom pass. */
  glow: number;
}

const PALETTES: Record<HelixStyle, Palette> = {
  bio: {
    core: '#e2fdff',
    body: '#2ad4ff',
    deep: '#0d6b9e',
    far: '#12547f',
    bead: '#ccf6ff',
    glow: 0.9,
  },
  chroma: {
    core: '#ffeaff',
    body: '#9a6bff',
    deep: '#2b3fb8',
    far: '#3a2a86',
    bead: '#e6d2ff',
    glow: 1,
  },
  clinical: {
    core: '#ffffff',
    body: '#bcdaea',
    deep: '#4a6b7d',
    far: '#26404f',
    bead: '#eaf6fb',
    glow: 0.6,
  },
};

/** Base pairs, cycled to label each rung. */
const PAIRS = ['A·T', 'G·C', 'C·G', 'T·A', 'A·T', 'G·C', 'T·A', 'C·G'];

const PERSPECTIVE = 1400;
const DEPTH = 300;

interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z: number;
  scale: number;
  near: number;
  fade: number;
}

interface Bead {
  px: number;
  py: number;
  scale: number;
  near: number;
  fade: number;
  z: number;
}

/** Linear blend between two #rrggbb colours. */
function mix(a: string, b: string, k: number): string {
  const parse = (h: string): [number, number, number] => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  const at = (x: number, y: number) => Math.round(x + (y - x) * k);
  return `rgb(${at(r1, r2)},${at(g1, g2)},${at(b1, b2)})`;
}

/**
 * Read the colour a brand stylesheet gave a button.
 *
 * Measured on a detached probe carrying the same classes and inline styles,
 * so the answer is the stock brand colour rather than whatever the helix
 * style has already painted over it.
 *
 * Most buttons carry a flat background-color. The handful that use a gradient
 * report a transparent background-color, so the middle stop of the gradient is
 * used instead, which is a fair representative of the brand.
 */
function readBrandColour(anchor: HTMLElement): string | null {
  const probe = document.createElement('a');
  probe.className = anchor.className;
  const inline = anchor.getAttribute('style');
  if (inline) probe.setAttribute('style', inline);
  probe.style.position = 'absolute';
  probe.style.left = '-9999px';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);

  const computed = getComputedStyle(probe);
  const flat = computed.backgroundColor;
  const stops = computed.backgroundImage?.match(
    /rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi,
  );
  probe.remove();

  if (flat && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(flat)) {
    return flat;
  }
  if (stops && stops.length > 0) return stops[Math.floor(stops.length / 2)];
  return null;
}

/**
 * Render the sorted link buttons as the base pairs of a DNA double helix.
 *
 * Every button stays a real anchor in the document. Only the backbone, its
 * bloom and the background are drawn to canvas, so the page keeps its
 * crawlable links, its keyboard order and its context menus.
 */
function Helix({ options, children }: HelixProps) {
  const items = useMemo(() => sortNodes(children), [children]);
  const count = items.length;

  const stageRef = useRef<HTMLDivElement>(null);
  const rungsRef = useRef<(HTMLDivElement | null)[]>([]);
  const bgRef = useRef<HTMLCanvasElement>(null);
  const backRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);

  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stage = stageRef.current;
    const canvases = [
      bgRef.current,
      backRef.current,
      glowRef.current,
      frontRef.current,
    ];
    if (!stage || canvases.some(c => !c) || count === 0) return;

    const [bgC, backC, glowC, frontC] = canvases as HTMLCanvasElement[];
    const bg = bgC.getContext('2d');
    const back = backC.getContext('2d');
    const glow = glowC.getContext('2d');
    const front = frontC.getContext('2d');
    if (!bg || !back || !glow || !front) return;

    const palette = PALETTES[options.style];
    const twist = twistPerStep(options.turns, count);
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    // Tint each tablet with the brand colour the stock stylesheet already
    // gave it, so no button definition needs to know about the helix. This
    // has to run before the style modifier class is applied, because that
    // class is what replaces the brand background.
    rungsRef.current.forEach(rung => {
      const anchor = rung?.querySelector<HTMLElement>('.button');
      if (!rung || !anchor) return;
      const brand = readBrandColour(anchor);
      if (brand) rung.style.setProperty('--hx-bc', brand);
      rung.dataset.label = (anchor.textContent || '').trim();
    });

    let width = 0;
    let height = 0;
    let cx = 0;
    let cy = 0;
    let uMax = 6;
    const view: Viewport = {
      radius: options.radius,
      rise: options.rise,
      fade: 520,
      depth: DEPTH,
      perspective: PERSPECTIVE,
    };
    const motes: { x: number; y: number; r: number; s: number; a: number }[] =
      [];

    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = stage!.clientWidth;
      height = stage!.clientHeight;
      cx = width / 2;
      cy = height / 2;

      for (const c of [bgC, backC, glowC, frontC]) {
        c.width = width * dpr;
        c.height = height * dpr;
        const ctx = c.getContext('2d');
        ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      // Fit the helix to the viewport so phones get a narrower, tighter strand.
      view.radius = Math.min(options.radius, (width - 46) / 2);
      view.rise = options.rise * clamp(height / 880, 0.6, 1.15);
      view.fade = Math.max(360, height * 0.56);
      uMax = Math.min(count / 2 - 0.25, view.fade / view.rise + 1.7);

      const tablet = clamp(view.radius * 2 - 74, 148, 268);
      stage!.style.setProperty('--hx-tablet', `${tablet}px`);
      stage!.style.setProperty(
        '--hx-tablet-size',
        `${clamp(tablet / 16.2, 13, 17).toFixed(1)}px`,
      );

      motes.length = 0;
      for (let i = 0; i < 46; i += 1) {
        motes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          r: Math.random() * 1.7 + 0.3,
          s: Math.random() * 0.24 + 0.05,
          a: Math.random() * 0.5 + 0.12,
        });
      }
    }

    function buildSegments(): Segment[] {
      const segments: Segment[] = [];
      const step = 0.035;
      for (const strand of [0, 1] as const) {
        let prev: ReturnType<typeof strandPoint> | null = null;
        let prevProj = { px: 0, py: 0, scale: 1 };
        let prevFade = 0;
        for (let d = -uMax; d <= uMax + step; d += step) {
          const point = strandPoint(d, strand, twist, view);
          const proj = project(
            point.x,
            point.y,
            point.z,
            cx,
            cy,
            view.perspective,
          );
          const { fade } = place(d, twist, view);
          if (prev) {
            segments.push({
              x0: prevProj.px,
              y0: prevProj.py,
              x1: proj.px,
              y1: proj.py,
              z: (prev.z + point.z) / 2,
              scale: (prevProj.scale + proj.scale) / 2,
              near: (prev.near + point.near) / 2,
              fade: (prevFade + fade) / 2,
            });
          }
          prev = point;
          prevProj = proj;
          prevFade = fade;
        }
      }
      return segments.sort((a, b) => a.z - b.z);
    }

    function buildBeads(pos: number): Bead[] {
      const beads: Bead[] = [];
      const step = 0.22;
      const start = Math.ceil((pos - uMax) / step) * step;
      for (const strand of [0, 1] as const) {
        for (let m = start; m - pos <= uMax; m += step) {
          const d = m - pos;
          const point = strandPoint(d, strand, twist, view);
          const proj = project(
            point.x,
            point.y,
            point.z,
            cx,
            cy,
            view.perspective,
          );
          beads.push({
            px: proj.px,
            py: proj.py,
            scale: proj.scale,
            near: point.near,
            fade: place(d, twist, view).fade,
            z: point.z,
          });
        }
      }
      return beads.sort((a, b) => a.z - b.z);
    }

    function drawStrand(
      ctx: CanvasRenderingContext2D,
      segments: Segment[],
      beads: Bead[],
      alpha: number,
    ) {
      ctx.lineCap = 'round';

      for (const s of segments) {
        if (s.fade <= 0.02) continue;
        ctx.strokeStyle = mix(palette.deep, palette.body, s.near);
        ctx.globalAlpha = (0.13 + 0.28 * s.near) * s.fade * alpha;
        ctx.lineWidth = (9 + 16 * s.near) * s.scale;
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.stroke();
      }

      for (const s of segments) {
        if (s.fade <= 0.02) continue;
        ctx.strokeStyle = mix(palette.deep, palette.body, s.near * s.near);
        ctx.globalAlpha = (0.46 + 0.52 * s.near) * s.fade * alpha;
        ctx.lineWidth = (3.4 + 7.2 * s.near) * s.scale;
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.stroke();
      }

      for (const b of beads) {
        if (b.fade <= 0.02) continue;
        const r = (2.6 + 5.2 * b.near) * b.scale;
        const g = ctx.createRadialGradient(b.px, b.py, 0, b.px, b.py, r * 2.4);
        g.addColorStop(0, palette.bead);
        g.addColorStop(0.42, mix(palette.body, palette.core, 0.3));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.globalAlpha = (0.22 + 0.58 * b.near) * b.fade * alpha;
        ctx.beginPath();
        ctx.arc(b.px, b.py, r * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const s of segments) {
        if (s.fade <= 0.02 || s.near < 0.52) continue;
        ctx.strokeStyle = palette.core;
        ctx.globalAlpha = (s.near - 0.52) * 1.5 * s.fade * alpha * 0.9;
        ctx.lineWidth = (1 + 2.2 * s.near) * s.scale;
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
    }

    function drawBackground(pos: number, dt: number) {
      bg!.clearRect(0, 0, width, height);
      const ghosts = [
        {
          r: view.radius * 1.85,
          rise: view.rise * 1.5,
          z: -620,
          ox: -width * 0.34,
          phase: 1.2,
          par: 0.42,
          a: 0.34,
        },
        {
          r: view.radius * 1.25,
          rise: view.rise * 1.1,
          z: -980,
          ox: width * 0.38,
          phase: 3.9,
          par: 0.24,
          a: 0.24,
        },
      ];
      for (const g of ghosts) {
        for (const strand of [0, 1]) {
          bg!.beginPath();
          let first = true;
          for (let d = -9; d <= 9; d += 0.06) {
            const angle =
              (d + pos * g.par) * twist * 0.72 +
              g.phase +
              (strand ? Math.PI : 0);
            const proj = project(
              g.r * Math.cos(angle) + g.ox,
              d * g.rise,
              -g.r * Math.sin(angle) + g.z,
              cx,
              cy,
              view.perspective,
            );
            if (first) {
              bg!.moveTo(proj.px, proj.py);
              first = false;
            } else {
              bg!.lineTo(proj.px, proj.py);
            }
          }
          bg!.strokeStyle = palette.far;
          bg!.lineWidth = 13;
          bg!.globalAlpha = g.a * 1.35;
          bg!.stroke();
        }
      }
      bg!.globalAlpha = 1;
      for (const m of motes) {
        m.y -= m.s * dt * 40;
        if (m.y < -8) {
          m.y = height + 8;
          m.x = Math.random() * width;
        }
        bg!.fillStyle = palette.bead;
        bg!.globalAlpha = m.a * 0.5;
        bg!.beginPath();
        bg!.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        bg!.fill();
      }
      bg!.globalAlpha = 1;
    }

    // ── state ───────────────────────────────────────────────────────────
    let pos = 0;
    let velocity = 0;
    let pointerInside = false;
    let dragging = false;
    let lastY = 0;
    let dragged = 0;
    let lastIndex = -1;
    let last = performance.now();
    let raf = 0;

    function frame(now: number) {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      if (options.drift && !pointerInside && !dragging && !reduced) {
        pos += 0.135 * dt;
      }
      pos += velocity;
      velocity *= 0.915;
      if (
        (!options.drift || pointerInside) &&
        !dragging &&
        Math.abs(velocity) < 0.0035
      ) {
        pos += (Math.round(pos) - pos) * Math.min(1, 7 * dt);
      }

      for (let i = 0; i < count; i += 1) {
        const rung = rungsRef.current[i];
        if (!rung) continue;
        const d = wrap(i - pos, count);
        const p = place(d, twist, view);
        rung.style.transform =
          `translate(-50%,-50%) translate3d(0,${p.y.toFixed(2)}px,` +
          `${p.z.toFixed(1)}px) rotateY(${p.angle.toFixed(4)}rad)`;
        rung.style.opacity = p.fade.toFixed(3);
        rung.style.filter =
          p.t > 0.08 ? `blur(${(p.t * p.t * 5.5).toFixed(2)}px)` : 'none';
        rung.style.width = `${view.radius * 2}px`;

        const cos = Math.cos(p.angle);
        const sin = Math.sin(p.angle);
        const side = Math.abs(sin);
        // The near edge catches the light; the far edge falls into shadow.
        rung.style.setProperty('--hx-dir', sin >= 0 ? '1' : '-1');
        rung.style.setProperty('--hx-hl', (side * 0.17 * p.fade).toFixed(3));
        rung.style.setProperty('--hx-sh', (side * 0.36 * p.fade).toFixed(3));
        rung.classList.toggle('is-back', cos < 0);
        rung.style.pointerEvents =
          Math.abs(cos) > 0.34 && p.fade > 0.45 ? 'auto' : 'none';
      }

      const segments = buildSegments();
      const beads = buildBeads(pos);
      back!.clearRect(0, 0, width, height);
      drawStrand(back!, segments, beads, 1);
      glow!.clearRect(0, 0, width, height);
      glow!.globalAlpha = palette.glow;
      glow!.drawImage(backC, 0, 0, width, height);
      glow!.globalAlpha = 1;
      front!.clearRect(0, 0, width, height);
      drawStrand(
        front!,
        segments.filter(s => s.z > view.radius * 0.18),
        beads.filter(b => b.z > view.radius * 0.18),
        0.62,
      );
      drawBackground(pos, dt);

      const index = ((Math.round(pos) % count) + count) % count;
      if (index !== lastIndex && readoutRef.current) {
        lastIndex = index;
        const label = rungsRef.current[index]?.dataset.label || '';
        readoutRef.current.innerHTML =
          `bp ${String(index + 1).padStart(2, '0')} / ${count}` +
          `<b>${label.replace(/[<>&]/g, '')}</b>`;
      }

      raf = requestAnimationFrame(frame);
    }

    // ── input ───────────────────────────────────────────────────────────
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('[data-helix-overlay]')) return;
      e.preventDefault();
      velocity += clamp(e.deltaY, -140, 140) * 0.00042;
    };
    const onEnter = () => {
      pointerInside = true;
    };
    const onLeave = () => {
      pointerInside = false;
      dragging = false;
    };
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('[data-helix-overlay]')) return;
      dragging = true;
      dragged = 0;
      lastY = e.clientY;
      stage!.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      dragged += Math.abs(dy);
      pos -= dy / view.rise;
      velocity = (-dy / view.rise) * 0.35;
    };
    const onUp = () => {
      dragging = false;
    };
    // Suppress the click that ends a drag, so a fling never opens a link.
    const onClick = (e: MouseEvent) => {
      if (dragged > 7) {
        e.preventDefault();
        e.stopPropagation();
        dragged = 0;
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('[data-helix-overlay]')) return;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') {
        velocity += 0.07;
        e.preventDefault();
      }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') {
        velocity -= 0.07;
        e.preventDefault();
      }
    };
    // Keep a tabbed-to link in view rather than leaving focus off-screen.
    const onFocusIn = (e: FocusEvent) => {
      const rung = (e.target as HTMLElement).closest<HTMLElement>('.hx-rung');
      if (!rung) return;
      const index = rungsRef.current.indexOf(rung as HTMLDivElement);
      if (index >= 0) {
        pos = index;
        velocity = 0;
      }
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('pointerenter', onEnter);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('click', onClick, true);
    stage.addEventListener('focusin', onFocusIn);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', resize);

    document.body.classList.add('hx-lock');
    resize();
    setReady(true);
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      document.body.classList.remove('hx-lock');
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('pointerenter', onEnter);
      stage.removeEventListener('pointerleave', onLeave);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp);
      stage.removeEventListener('click', onClick, true);
      stage.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', resize);
    };
  }, [count, options]);

  if (count === 0) return null;

  return (
    <div
      className={`hx-stage hx--${options.style}${ready ? ' is-ready' : ''}`}
      ref={stageRef}
    >
      <canvas className="hx-canvas hx-bg" ref={bgRef} aria-hidden="true" />
      <canvas className="hx-canvas hx-back" ref={backRef} aria-hidden="true" />
      <canvas className="hx-canvas hx-glow" ref={glowRef} aria-hidden="true" />

      <div className="hx-scene">
        <div className="hx-axis">
          {items.map((child, i) => (
            <div
              className="hx-rung"
              key={i}
              ref={el => {
                rungsRef.current[i] = el;
              }}
            >
              <span className="hx-shaft" aria-hidden="true" />
              <span className="hx-tablet">
                {child}
                <span className="hx-bp" aria-hidden="true">
                  {PAIRS[i % PAIRS.length]} · {String(i + 1).padStart(2, '0')}
                </span>
              </span>
              <span className="hx-shaft hx-shaft--right" aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>

      <canvas
        className="hx-canvas hx-front"
        ref={frontRef}
        aria-hidden="true"
      />
      <div className="hx-vignette" aria-hidden="true" />
      <div className="hx-fade hx-fade--top" aria-hidden="true" />
      <div className="hx-fade hx-fade--bottom" aria-hidden="true" />

      <aside className="hx-hud" aria-hidden="true">
        <span className="hx-hud__end">5′ → 3′</span>
        <span className="hx-hud__tick" />
        <span className="hx-hud__now" ref={readoutRef} />
        <span className="hx-hud__tick" />
        <span className="hx-hud__end">3′ → 5′</span>
      </aside>

      <p className="hx-hint">
        <span className="hx-hint__wheel" aria-hidden="true" />
        scroll · drag · swipe
        <span className="hx-hint__long">
          {' '}
          &nbsp;·&nbsp; strand loops forever
        </span>
      </p>
    </div>
  );
}

export default Helix;
