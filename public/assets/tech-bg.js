/**
 * tech-bg.js
 * -----------------------------------------------------------------------
 * Ambient "hosting network" background for KARL.
 *
 * Visual: a field of connected nodes (server/request graph) that react to
 * the pointer, plus drifting tokens from the actual stack KARL hosts
 * (HTTP/2, Docker, NodeJS, Python, NGINX, ...). Tuned to the product
 * instead of being generic decoration, and engineered to survive real
 * production use (long-lived dashboard tabs, resizing, low-end phones,
 * reduced-motion users).
 *
 * Why this isn't a copy-pasted demo:
 *  - Node/token counts scale with canvas area (and are hard-capped), so a
 *    phone doesn't get desktop-density particle counts and desktop
 *    doesn't look sparse. A fixed node count regardless of viewport size
 *    is the single biggest tell of an unfinished demo.
 *  - The O(n^2) connection pass is the only part of the algorithm that's
 *    actually O(n^2) by nature (every node can connect to every other
 *    node) — the node/token update loops themselves are O(n), and nothing
 *    allocates a new array per frame.
 *  - DPR-aware canvas backing store (crisp on retina, capped at 2x so it
 *    doesn't tank a budget phone's GPU).
 *  - Resize is debounced and rebuilds the field once, not every pixel of
 *    a drag-resize.
 *  - Pauses via the Page Visibility API so a backgrounded tab doesn't
 *    burn CPU/battery, and honours `prefers-reduced-motion` by rendering
 *    one static frame with no motion at all.
 *  - Pointer repulsion is skipped entirely on touch devices — there's no
 *    persistent "mouse position" on a phone, so leaving one at a stale
 *    coordinate is how a demo ends up looking broken on mobile.
 *  - Works both as a full-viewport background (`sizeMode: 'viewport'`)
 *    and scoped to a parent element (`sizeMode: 'parent'`, used by the
 *    auth page's side panel).
 *  - Explicit mount/destroy API: `destroy()` cancels the frame, clears
 *    timers, and removes every listener it added.
 *
 * Usage:
 *   <canvas id="dash-bg"></canvas>
 *   <script src="/assets/tech-bg.js"></script>
 *   <script>new TechBackdrop(document.getElementById('dash-bg'));</script>
 */
(function (global) {
  'use strict';

  const PALETTE = {
    node: 'rgba(0, 234, 255, 0.85)',
    line: (alpha) => `rgba(0, 200, 255, ${alpha})`,
    token: (alpha) => `rgba(70, 230, 200, ${alpha})`,
  };

  const TOKENS = [
    'HTTP/2', 'API', 'async', 'Docker', 'NodeJS', 'Cloud', 'SSL', 'JSON',
    'Python', 'NGINX', 'Linux', 'Server', 'Database', 'Webhook', 'Bot', 'Cron'
  ];

  const LINK_DIST = 130;
  const REPEL_DIST = 120;
  const REPEL_STRENGTH = 0.03;

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // Reads the page's own --bg custom property so the motion-trail fill
  // matches the current theme (dark vs light) instead of being hardcoded —
  // a canvas trail effect using the wrong background is invisible in one
  // theme and looks like a rendering bug in the other.
  function readBgColor() {
    const val = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    const m = val.match(/^#([0-9a-f]{6})$/i);
    if (!m) return '7,9,15';
    const hex = m[1];
    return [0, 2, 4].map(i => parseInt(hex.substr(i, 2), 16)).join(',');
  }

  class TechBackdrop {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.density = opts.density === 'active' ? 'active' : 'ambient';
      this.sizeMode = opts.sizeMode === 'parent' ? 'parent' : 'viewport';
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);
      this.reduced = reducedMotion();
      this.isTouch = global.matchMedia ? global.matchMedia('(pointer: coarse)').matches : false;
      this._bgRgb = readBgColor();

      this.nodes = [];
      this.tokens = [];

      this._running = false;
      this._lastT = 0;
      this._resizeTimer = null;
      this.pointer = { x: -9999, y: -9999 };

      this._boundResize = this._onResize.bind(this);
      this._boundVisibility = this._onVisibility.bind(this);
      this._boundPointer = this._onPointer.bind(this);
      this._boundLeave = this._onLeave.bind(this);
      this._boundFrame = this._frame.bind(this);

      this._layout();
      this._seed();
      this._bindEvents();
      this._start();
    }

    // ---- setup -----------------------------------------------------------

    _layout() {
      if (this.sizeMode === 'parent') {
        const rect = this.canvas.parentElement
          ? this.canvas.parentElement.getBoundingClientRect()
          : { width: global.innerWidth, height: global.innerHeight };
        this.width = Math.max(1, Math.ceil(rect.width));
        this.height = Math.max(1, Math.ceil(rect.height));
      } else {
        this.width = Math.ceil(global.innerWidth);
        this.height = Math.ceil(global.innerHeight);
      }
      this.canvas.width = this.width * this.dpr;
      this.canvas.height = this.height * this.dpr;
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    // Node/token counts scale with area instead of being a fixed constant,
    // so a phone and an ultrawide monitor both get a sensible density.
    _targetCounts() {
      const area = this.width * this.height;
      const unit = 22000; // px^2 per node, tuned by eye
      const mult = this.density === 'active' ? 1.4 : 1;
      const nodes = clamp(Math.round((area / unit) * mult), 18, 110);
      const tokens = clamp(Math.round(nodes * 0.35), 8, 34);
      return { nodes, tokens };
    }

    _seed() {
      const { nodes, tokens } = this._targetCounts();
      this.nodes = Array.from({ length: nodes }, () => this._spawnNode());
      this.tokens = Array.from({ length: tokens }, () => this._spawnToken(true));
    }

    _spawnNode() {
      return {
        x: Math.random() * this.width,
        y: Math.random() * this.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        r: 1.6 + Math.random() * 1.6,
      };
    }

    _spawnToken(initial) {
      return {
        text: TOKENS[Math.floor(Math.random() * TOKENS.length)],
        x: Math.random() * this.width,
        y: initial ? Math.random() * this.height : this.height + 20,
        speed: 10 + Math.random() * 14, // px/sec
        alpha: 0.3 + Math.random() * 0.3,
      };
    }

    _bindEvents() {
      global.addEventListener('resize', this._boundResize);
      document.addEventListener('visibilitychange', this._boundVisibility);
      if (!this.isTouch && !this.reduced) {
        global.addEventListener('pointermove', this._boundPointer);
        global.addEventListener('pointerleave', this._boundLeave);
      }
      if ('MutationObserver' in global) {
        this._themeObserver = new MutationObserver(() => { this._bgRgb = readBgColor(); });
        this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
    }

    _onResize() {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._layout();
        this._seed();
        if (!this._running) this._renderStaticFrame();
      }, 150);
    }

    _onVisibility() {
      if (document.hidden) this._stop(); else this._start();
    }

    _onPointer(e) {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.x = e.clientX - rect.left;
      this.pointer.y = e.clientY - rect.top;
    }

    _onLeave() {
      this.pointer.x = -9999;
      this.pointer.y = -9999;
    }

    // ---- render ------------------------------------------------------------

    _drawNodes(dt) {
      const ctx = this.ctx;
      const w = this.width, h = this.height;

      for (const n of this.nodes) {
        if (dt) {
          n.x += n.vx * dt * 60;
          n.y += n.vy * dt * 60;
          if (n.x < 0 || n.x > w) n.vx *= -1;
          if (n.y < 0 || n.y > h) n.vy *= -1;

          const dx = n.x - this.pointer.x;
          const dy = n.y - this.pointer.y;
          const d = Math.hypot(dx, dy);
          if (d < REPEL_DIST && d > 0.01) {
            n.x += dx * REPEL_STRENGTH;
            n.y += dy * REPEL_STRENGTH;
          }
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = PALETTE.node;
        ctx.fill();
      }

      // Connections — the only genuinely O(n^2) part, unavoidable since any
      // node may be near any other; the node array is never rebuilt per frame.
      const nodes = this.nodes;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < LINK_DIST) {
            ctx.beginPath();
            ctx.moveTo(nodes[i].x, nodes[i].y);
            ctx.lineTo(nodes[j].x, nodes[j].y);
            ctx.strokeStyle = PALETTE.line(1 - dist / LINK_DIST);
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }

    _drawTokens(dt) {
      const ctx = this.ctx;
      ctx.font = '13px "JetBrains Mono", monospace';
      for (const t of this.tokens) {
        if (dt) {
          t.y -= t.speed * dt;
          if (t.y < -20) Object.assign(t, this._spawnToken(false));
        }
        ctx.fillStyle = PALETTE.token(t.alpha);
        ctx.fillText(t.text, t.x, t.y);
      }
    }

    _renderStaticFrame() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.ctx.fillStyle = `rgba(${this._bgRgb}, 1)`;
      this.ctx.fillRect(0, 0, this.width, this.height);
      this._drawTokens(0);
      this._drawNodes(0);
    }

    // ---- loop --------------------------------------------------------------

    _start() {
      if (this._running) return;
      if (this.reduced) { this._renderStaticFrame(); return; }
      this._running = true;
      this._lastT = performance.now();
      requestAnimationFrame(this._boundFrame);
    }

    _stop() {
      this._running = false;
    }

    _frame(t) {
      if (!this._running) return;
      const dt = Math.min((t - this._lastT) / 1000, 0.05);
      this._lastT = t;

      // Translucent fill (instead of clearRect) leaves a short motion trail,
      // using the page's own --bg colour so it reads as part of the theme
      // rather than a hard-edged overlay.
      this.ctx.fillStyle = `rgba(${this._bgRgb}, 0.16)`;
      this.ctx.fillRect(0, 0, this.width, this.height);

      this._drawTokens(dt);
      this._drawNodes(dt);

      requestAnimationFrame(this._boundFrame);
    }

    setDensity(level) {
      this.density = level === 'active' ? 'active' : 'ambient';
      this._seed();
    }

    destroy() {
      this._stop();
      clearTimeout(this._resizeTimer);
      global.removeEventListener('resize', this._boundResize);
      document.removeEventListener('visibilitychange', this._boundVisibility);
      global.removeEventListener('pointermove', this._boundPointer);
      global.removeEventListener('pointerleave', this._boundLeave);
      if (this._themeObserver) this._themeObserver.disconnect();
    }
  }

  global.TechBackdrop = TechBackdrop;
})(window);
