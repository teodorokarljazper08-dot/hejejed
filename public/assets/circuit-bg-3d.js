/**
 * circuit-bg-3d.js
 * -----------------------------------------------------------------------
 * Real 3D (WebGL, via three.js) version of the ambient background.
 * Same visual metaphor as circuit-bg.js (a hosting network: nodes,
 * connections, travelling request pulses) but rendered as an actual 3D
 * point/line network in space, slowly rotating, with light parallax on
 * pointer move. Falls back to the 2D canvas version automatically if
 * WebGL isn't available (see CircuitField3D.supported()).
 *
 * Why this design, not a generic "3D particle background":
 *  - Nodes are laid out with a Fibonacci sphere (even, non-clumping
 *    distribution) and connected to their nearest neighbours — same
 *    "hosting network" idea as the 2D version, now legibly 3D via
 *    parallax and depth fog instead of just being noise in space.
 *  - Colour is restricted to the existing brand palette (amber accent,
 *    dim navy lines) so it reads as product chrome, not decoration.
 *
 * Engineering notes:
 *  - One scene/renderer per instance, explicit dispose() of all
 *    geometries/materials/textures on destroy() — WebGL contexts are a
 *    limited browser resource and must be released, unlike 2D canvases.
 *  - Pulses are pooled (fixed-size, reused in place) exactly like the 2D
 *    version — no per-frame allocation.
 *  - Renderer pixel ratio is capped at 2 and resolution is tied to the
 *    container element (not innerWidth/Height), so it behaves inside any
 *    layout, not just full-page use.
 *  - Delta-time driven rotation (not frame-count driven) so speed is
 *    consistent across refresh rates.
 *  - Pauses via Page Visibility API; honours prefers-reduced-motion by
 *    rendering one static frame with no rotation and no pulses.
 *  - Static capability check (CircuitField3D.supported()) lets callers
 *    feature-detect and fall back to the 2D CircuitField cleanly.
 *
 * Requires three.js r128 (loaded globally as THREE) before this file.
 *
 * Usage:
 *   <canvas id="bg3d"></canvas>
 *   <script src=".../three.min.js"></script>
 *   <script src="/assets/circuit-bg-3d.js"></script>
 *   <script>
 *     if (CircuitField3D.supported()) {
 *       new CircuitField3D(document.getElementById('bg3d'), { intensity: 'ambient' });
 *     }
 *   </script>
 */
(function (global) {
  'use strict';

  const COLOR = {
    line: 0x252d45,     // var(--border2)
    node: 0xf5a623,     // var(--accent)
    pulseAmber: 0xf5a623,
    pulseGreen: 0x22c55e,
    fog: 0x07090f,      // var(--bg)
  };

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function fibonacciSphere(count, radius) {
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      pts.push({
        x: Math.cos(theta) * r * radius,
        y: y * radius,
        z: Math.sin(theta) * r * radius,
      });
    }
    return pts;
  }

  class CircuitField3D {
    static supported() {
      if (!global.THREE) return false;
      try {
        const c = document.createElement('canvas');
        return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch (e) {
        return false;
      }
    }

    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.intensity = opts.intensity === 'active' ? 'active' : 'ambient';
      this.sizeMode = opts.sizeMode === 'viewport' ? 'viewport' : 'parent';
      this.nodeCount = this.intensity === 'active' ? 42 : 26;
      this.maxPulses = this.intensity === 'active' ? 16 : 8;
      this.reduced = reducedMotion();

      this._raf = null;
      this._running = false;
      this._lastT = 0;
      this._pointer = { x: 0, y: 0 };
      this._resizeTimer = null;

      this._boundResize = this._onResize.bind(this);
      this._boundVisibility = this._onVisibility.bind(this);
      this._boundPointer = this._onPointer.bind(this);
      this._boundFrame = this._frame.bind(this);

      this._initScene();
      this._buildNetwork();
      this._bindEvents();
      this._resize();
      this._start();
    }

    // ---- setup -------------------------------------------------------------

    _initScene() {
      const THREE = global.THREE;
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));

      this.scene = new THREE.Scene();
      this.scene.fog = new THREE.FogExp2(COLOR.fog, 0.045);

      this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      this.camera.position.set(0, 0, 14);

      this.group = new THREE.Group();
      this.scene.add(this.group);
    }

    _buildNetwork() {
      const THREE = global.THREE;
      const radius = 7;
      this.nodePositions = fibonacciSphere(this.nodeCount, radius);

      // Points (nodes)
      const nodeGeom = new THREE.BufferGeometry();
      const nodeArr = new Float32Array(this.nodePositions.length * 3);
      this.nodePositions.forEach((p, i) => {
        nodeArr[i * 3] = p.x; nodeArr[i * 3 + 1] = p.y; nodeArr[i * 3 + 2] = p.z;
      });
      nodeGeom.setAttribute('position', new THREE.BufferAttribute(nodeArr, 3));
      const nodeMat = new THREE.PointsMaterial({
        color: COLOR.node, size: 0.16, transparent: true, opacity: 0.85, sizeAttenuation: true,
      });
      this.pointsMesh = new THREE.Points(nodeGeom, nodeMat);
      this.group.add(this.pointsMesh);

      // Edges: connect each node to its 2 nearest neighbours
      this.edges = [];
      const linePositions = [];
      for (let i = 0; i < this.nodePositions.length; i++) {
        const a = this.nodePositions[i];
        const dists = this.nodePositions
          .map((b, j) => ({ j, d: (i === j) ? Infinity : dist3(a, b) }))
          .sort((x, y) => x.d - y.d)
          .slice(0, 2);
        for (const { j } of dists) {
          if (j > i) { // avoid duplicate edges
            const b = this.nodePositions[j];
            linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
            this.edges.push({ a, b });
          }
        }
      }
      const lineGeom = new THREE.BufferGeometry();
      lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      const lineMat = new THREE.LineBasicMaterial({ color: COLOR.line, transparent: true, opacity: 0.5 });
      this.linesMesh = new THREE.LineSegments(lineGeom, lineMat);
      this.group.add(this.linesMesh);

      // Pulses: small emissive-looking spheres travelling along random edges
      const pulseGeom = new THREE.SphereGeometry(0.09, 8, 8);
      this.pulses = [];
      for (let i = 0; i < this.maxPulses; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: COLOR.pulseAmber, transparent: true, opacity: 0 });
        const mesh = new THREE.Mesh(pulseGeom, mat);
        this.group.add(mesh);
        this.pulses.push({ alive: false, edge: null, t: 0, speed: 0, mesh });
      }
    }

    _bindEvents() {
      global.addEventListener('resize', this._boundResize);
      document.addEventListener('visibilitychange', this._boundVisibility);
      if (!this.reduced) global.addEventListener('pointermove', this._boundPointer);
    }

    _onResize() {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => this._resize(), 120);
    }

    _onVisibility() {
      if (document.hidden) this._stop(); else this._start();
    }

    _onPointer(e) {
      // Normalize to [-1, 1], only used for a subtle parallax tilt.
      this._pointer.x = (e.clientX / global.innerWidth) * 2 - 1;
      this._pointer.y = (e.clientY / global.innerHeight) * 2 - 1;
    }

    _resize() {
      let w, h;
      if (this.sizeMode === 'viewport') {
        w = global.innerWidth;
        h = global.innerHeight;
      } else {
        const parent = this.canvas.parentElement;
        const rect = parent ? parent.getBoundingClientRect() : { width: global.innerWidth, height: global.innerHeight };
        w = Math.max(1, Math.ceil(rect.width));
        h = Math.max(1, Math.ceil(rect.height));
      }
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (!this._running) this.renderer.render(this.scene, this.camera);
    }

    // ---- pulses --------------------------------------------------------------

    _spawnPulse() {
      const slot = this.pulses.find(p => !p.alive);
      if (!slot || this.edges.length === 0) return;
      const edge = this.edges[Math.floor(Math.random() * this.edges.length)];
      slot.alive = true;
      slot.edge = edge;
      slot.t = 0;
      slot.speed = 0.28 + Math.random() * 0.3;
      const isGreen = Math.random() < 0.18;
      slot.mesh.material.color.setHex(isGreen ? COLOR.pulseGreen : COLOR.pulseAmber);
      slot.mesh.material.opacity = 0.95;
    }

    // ---- loop ------------------------------------------------------------

    _start() {
      if (this._running) return;
      if (this.reduced) { this.renderer.render(this.scene, this.camera); return; }
      this._running = true;
      this._lastT = performance.now();
      this._raf = requestAnimationFrame(this._boundFrame);
    }

    _stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
    }

    _frame(t) {
      if (!this._running) return;
      const dt = Math.min((t - this._lastT) / 1000, 0.05);
      this._lastT = t;

      // Slow ambient rotation + subtle pointer parallax.
      this.group.rotation.y += dt * 0.06;
      this.group.rotation.x += (this._pointer.y * 0.15 - this.group.rotation.x) * 0.02;
      this.group.rotation.z += (this._pointer.x * -0.08 - this.group.rotation.z) * 0.02;

      if (Math.random() < (this.intensity === 'active' ? 0.05 : 0.018)) this._spawnPulse();

      for (const p of this.pulses) {
        if (!p.alive) continue;
        p.t += p.speed * dt;
        if (p.t >= 1) {
          p.alive = false;
          p.mesh.material.opacity = 0;
          continue;
        }
        const { a, b } = p.edge;
        p.mesh.position.set(
          a.x + (b.x - a.x) * p.t,
          a.y + (b.y - a.y) * p.t,
          a.z + (b.z - a.z) * p.t
        );
      }

      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(this._boundFrame);
    }

    setIntensity(level) {
      this.intensity = level === 'active' ? 'active' : 'ambient';
    }

    destroy() {
      this._stop();
      clearTimeout(this._resizeTimer);
      global.removeEventListener('resize', this._boundResize);
      document.removeEventListener('visibilitychange', this._boundVisibility);
      global.removeEventListener('pointermove', this._boundPointer);

      this.pointsMesh.geometry.dispose();
      this.pointsMesh.material.dispose();
      this.linesMesh.geometry.dispose();
      this.linesMesh.material.dispose();
      for (const p of this.pulses) { p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
      this.renderer.dispose();
    }
  }

  function dist3(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  global.CircuitField3D = CircuitField3D;
})(window);
