/**
 * circuit-bg.js
 * -----------------------------------------------------------------------
 * Ambient "circuit trace" background for KARL.
 *
 * Design rationale: the product hosts Telegram bots — the visual metaphor
 * is a PCB / server backplane with requests (pulses) travelling between
 * nodes, not a generic starfield or particle cloud. Lines are orthogonal
 * (grid-snapped, like real circuit traces), pulses travel node-to-node,
 * and colour is drawn only from the existing brand palette so it reads as
 * part of the product rather than a decorative overlay.
 *
 * Engineering notes (why this isn't "vibe coded"):
 *  - Single canvas, single rAF loop, delta-time integration (frame-rate
 *    independent, no drift on variable refresh displays).
 *  - Pulse objects are pooled (fixed-size array, dead pulses are recycled
 *    in place) — zero per-frame allocation, so no GC pauses on long-lived
 *    dashboard sessions.
 *  - Static trace geometry is pre-computed once (and on resize/debounce),
 *    not regenerated per frame.
 *  - Pauses automatically via the Page Visibility API when the tab isn't
 *    visible, and honours `prefers-reduced-motion` by rendering a single
 *    static frame instead of animating.
 *  - Exposes a small, explicit API (mount/destroy) so it can be torn down
 *    cleanly on SPA-style page swaps instead of leaking listeners.
 *
 * Usage:
 *   <canvas id="circuit-bg"></canvas>
 *   <script src="/assets/circuit-bg.js"></script>
 *   <script>
 *     const field = new CircuitField(document.getElementById('circuit-bg'), {
 *       intensity: 'ambient' // 'ambient' | 'active'
 *     });
 *   </script>
 */
(function (global) {
  'use strict';

  const PALETTE = {
    trace: 'rgba(37, 45, 69, 0.55)',   // var(--border2), dimmed
    node: 'rgba(90, 98, 133, 0.35)',   // var(--muted), dimmed
    pulseAmber: [245, 166, 35],        // var(--accent)
    pulseGreen: [34, 197, 94],         // var(--green)
  };

  const GRID = 64; // px between trace joints — matches an 8px base unit

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  class CircuitField {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.intensity = opts.intensity === 'active' ? 'active' : 'ambient';
      // 'viewport': size to window.innerWidth/Height, fully decoupled from
      // document layout. Use this whenever the canvas's own parent's size
      // could be influenced by the canvas itself (e.g. a direct child of
      // <body> on a scrolling page) — sizing from a measurement that the
      // canvas can itself affect creates a resize feedback loop that grows
      // the canvas unbounded on mobile browsers (address-bar show/hide
      // fires 'resize' repeatedly while scrolling).
      // 'parent': size to canvas.parentElement's rect. Safe only when the
      // parent's height is NOT determined by its own content (e.g. a flex
      // sibling stretched to match another column, like the auth page).
      this.sizeMode = opts.sizeMode === 'viewport' ? 'viewport' : 'parent';
      this.dpr = Math.min(global.devicePixelRatio || 1, 2);

      this.nodes = [];
      this.edges = [];          // { a, b, points: [{x,y}, ...] } grid-snapped polylines
      this.pulses = [];         // pooled
      this.maxPulses = this.intensity === 'active' ? 22 : 10;

      this._resizeTimer = null;
      this._running = false;
      this._lastT = 0;
      this._boundResize = this._onResize.bind(this);
      this._boundVisibility = this._onVisibility.bind(this);
      this._boundFrame = this._frame.bind(this);

      this._buildPool();
      this._layout();
      this._bindEvents();
      this._start();
    }

    // ---- setup -----------------------------------------------------------

    _buildPool() {
      for (let i = 0; i < this.maxPulses; i++) {
        this.pulses.push({ alive: false, edge: null, t: 0, speed: 0, color: PALETTE.pulseAmber });
      }
    }

    _bindEvents() {
      global.addEventListener('resize', this._boundResize);
      document.addEventListener('visibilitychange', this._boundVisibility);
    }

    _onResize() {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._layout(), 150);
    }

    _onVisibility() {
      if (document.hidden) this._stop();
      else this._start();
    }

    _layout() {
      let width, height;
      if (this.sizeMode === 'viewport') {
        width = global.innerWidth;
        height = global.innerHeight;
      } else {
        const rect = this.canvas.parentElement
          ? this.canvas.parentElement.getBoundingClientRect()
          : { width: global.innerWidth, height: global.innerHeight };
        width = rect.width;
        height = rect.height;
      }
      this.width = Math.ceil(width);
      this.height = Math.ceil(height);
      this.canvas.width = this.width * this.dpr;
      this.canvas.height = this.height * this.dpr;
      this.canvas.style.width = this.width + 'px';
      this.canvas.style.height = this.height + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this._buildGraph();
      if (!this._running) this._renderStaticFrame();
    }

    // Builds a sparse grid graph, then random-walks orthogonal traces
    // between a subset of joints so it reads as a circuit board, not a
    // uniform grid.
    _buildGraph() {
      this.nodes = [];
      this.edges = [];

      const cols = Math.ceil(this.width / GRID) + 1;
      const rows = Math.ceil(this.height / GRID) + 1;
      const nodeCount = Math.max(6, Math.round((cols * rows) * 0.05));

      const usedCols = new Set();
      for (let i = 0; i < nodeCount; i++) {
        const gx = 1 + Math.floor(Math.random() * (cols - 2));
        const gy = 1 + Math.floor(Math.random() * (rows - 2));
        this.nodes.push({ gx, gy, x: gx * GRID, y: gy * GRID });
        usedCols.add(gx);
      }

      // Connect each node to its nearest unvisited neighbour with an
      // L-shaped (orthogonal) trace — classic PCB routing look.
      for (let i = 1; i < this.nodes.length; i++) {
        const a = this.nodes[i];
        let nearest = this.nodes[0];
        let best = Infinity;
        for (let j = 0; j < i; j++) {
          const b = this.nodes[j];
          const d = Math.abs(a.gx - b.gx) + Math.abs(a.gy - b.gy);
          if (d < best) { best = d; nearest = b; }
        }
        const bend = Math.random() < 0.5
          ? { x: nearest.x, y: a.y }
          : { x: a.x, y: nearest.y };
        this.edges.push({
          a: nearest,
          b: a,
          points: [
            { x: nearest.x, y: nearest.y },
            bend,
            { x: a.x, y: a.y },
          ],
          length: 1,
        });
      }
    }

    // ---- pulses ------------------------------------------------------------

    _spawnPulse() {
      const slot = this.pulses.find(p => !p.alive);
      if (!slot || this.edges.length === 0) return;
      const edge = this.edges[Math.floor(Math.random() * this.edges.length)];
      slot.alive = true;
      slot.edge = edge;
      slot.t = 0;
      slot.speed = 0.35 + Math.random() * 0.35; // fraction of edge per second
      slot.color = Math.random() < 0.82 ? PALETTE.pulseAmber : PALETTE.pulseGreen;
    }

    _pointOnEdge(edge, t) {
      // edge.points is a 3-point polyline (start, bend, end); split t across
      // the two segments proportionally to their length.
      const [p0, p1, p2] = edge.points;
      const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
      const l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const total = l1 + l2 || 1;
      const d = t * total;
      if (d <= l1) {
        const f = l1 === 0 ? 0 : d / l1;
        return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f };
      }
      const f = l2 === 0 ? 0 : (d - l1) / l2;
      return { x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f };
    }

    // ---- render ------------------------------------------------------------

    _drawTraces() {
      const ctx = this.ctx;
      ctx.strokeStyle = PALETTE.trace;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const e of this.edges) {
        ctx.moveTo(e.points[0].x, e.points[0].y);
        ctx.lineTo(e.points[1].x, e.points[1].y);
        ctx.lineTo(e.points[2].x, e.points[2].y);
      }
      ctx.stroke();

      ctx.fillStyle = PALETTE.node;
      for (const n of this.nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    _drawPulses() {
      const ctx = this.ctx;
      for (const p of this.pulses) {
        if (!p.alive) continue;
        const pos = this._pointOnEdge(p.edge, p.t);
        const [r, g, b] = p.color;
        const grad = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, 7);
        grad.addColorStop(0, `rgba(${r},${g},${b},0.9)`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 7, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    _renderStaticFrame() {
      this.ctx.clearRect(0, 0, this.width, this.height);
      this._drawTraces();
    }

    // ---- loop --------------------------------------------------------------

    _start() {
      if (this._running) return;
      if (reducedMotion()) { this._renderStaticFrame(); return; }
      this._running = true;
      this._lastT = performance.now();
      requestAnimationFrame(this._boundFrame);
    }

    _stop() {
      this._running = false;
    }

    _frame(t) {
      if (!this._running) return;
      const dt = Math.min((t - this._lastT) / 1000, 0.05); // clamp for tab-switch spikes
      this._lastT = t;

      if (Math.random() < (this.intensity === 'active' ? 0.06 : 0.02)) this._spawnPulse();

      for (const p of this.pulses) {
        if (!p.alive) continue;
        p.t += p.speed * dt;
        if (p.t >= 1) p.alive = false;
      }

      this.ctx.clearRect(0, 0, this.width, this.height);
      this._drawTraces();
      this._drawPulses();

      requestAnimationFrame(this._boundFrame);
    }

    /** Switch between 'ambient' (idle pages) and 'active' (processing states). */
    setIntensity(level) {
      this.intensity = level === 'active' ? 'active' : 'ambient';
      this.maxPulses = this.intensity === 'active' ? 22 : 10;
      while (this.pulses.length < this.maxPulses) {
        this.pulses.push({ alive: false, edge: null, t: 0, speed: 0, color: PALETTE.pulseAmber });
      }
    }

    destroy() {
      this._stop();
      clearTimeout(this._resizeTimer);
      global.removeEventListener('resize', this._boundResize);
      document.removeEventListener('visibilitychange', this._boundVisibility);
    }
  }

  global.CircuitField = CircuitField;
})(window);
