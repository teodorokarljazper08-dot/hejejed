(function (global) {
  'use strict';

  function reducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  const STYLE_ID = 'boot-sequence-style';
  const CSS = `
  .boot-overlay{position:fixed;inset:0;z-index:9999;background:#07090f;display:flex;
    align-items:center;justify-content:center;opacity:0;transition:opacity .35s ease}
  .boot-overlay.visible{opacity:1}
  .boot-overlay canvas{position:absolute;inset:0;opacity:.5}
  .boot-panel{position:relative;width:100%;max-width:440px;padding:0 28px}
  .boot-brand{font-family:'JetBrains Mono',monospace;font-size:.7rem;font-weight:700;
    letter-spacing:3px;text-transform:uppercase;color:#f5a623;margin-bottom:28px;
    display:flex;align-items:center;gap:10px}
  .boot-brand .dot{width:6px;height:6px;border-radius:50%;background:#f5a623;
    box-shadow:0 0 8px #f5a623;animation:boot-pulse 1.4s ease-in-out infinite}
  @keyframes boot-pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .boot-log{font-family:'JetBrains Mono',monospace;font-size:.78rem;line-height:2.1;
    min-height:180px}
  .boot-line{display:flex;align-items:center;gap:10px;color:#5a6285;opacity:0;
    transform:translateY(4px);transition:opacity .25s ease,transform .25s ease}
  .boot-line.shown{opacity:1;transform:translateY(0)}
  .boot-line.done{color:#eef0f7}
  .boot-icon{width:14px;flex-shrink:0;text-align:center;font-size:.72rem}
  .boot-icon .spin{display:inline-block;width:9px;height:9px;border-radius:50%;
    border:1.5px solid #252d45;border-top-color:#f5a623;animation:boot-spin .7s linear infinite}
  @keyframes boot-spin{to{transform:rotate(360deg)}}
  .boot-icon .check{color:#22c55e}
  .boot-bar-wrap{margin-top:24px;height:2px;background:#1c2238;border-radius:2px;overflow:hidden}
  .boot-bar{height:100%;width:0%;background:#f5a623;box-shadow:0 0 8px rgba(245,166,35,.6);
    transition:width .5s cubic-bezier(.4,0,.2,1)}
  .boot-pct{margin-top:10px;font-family:'JetBrains Mono',monospace;font-size:.65rem;
    color:#5a6285;letter-spacing:1px;display:flex;justify-content:space-between}
  @media (prefers-reduced-motion: reduce){
    .boot-line{transition:none}.boot-bar{transition:none}.boot-icon .spin{animation:none;border-top-color:#252d45}
  }`;

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  class BootSequence {
    constructor(opts = {}) {
      this.steps = opts.steps && opts.steps.length ? opts.steps : [
        'Creating account',
        'Verifying activation token',
        'Provisioning free trial',
        'Finalizing workspace',
      ];
      this.brand = opts.brand || 'KARL';
      this.reduced = reducedMotion();
      this._build();
    }

    _build() {
      injectStyle();

      this.overlay = document.createElement('div');
      this.overlay.className = 'boot-overlay';
      this.overlay.setAttribute('role', 'alertdialog');
      this.overlay.setAttribute('aria-label', 'Setting up your account');

      const canvas = document.createElement('canvas');
      this.overlay.appendChild(canvas);

      const panel = document.createElement('div');
      panel.className = 'boot-panel';
      panel.innerHTML = `
        <div class="boot-brand"><span class="dot"></span>${this.brand}</div>
        <div class="boot-log" aria-live="polite"></div>
        <div class="boot-bar-wrap"><div class="boot-bar"></div></div>
        <div class="boot-pct"><span class="boot-pct-label">Setting up your account</span><span class="boot-pct-num">0%</span></div>
      `;
      this.overlay.appendChild(panel);
      document.body.appendChild(this.overlay);

      this.logEl = panel.querySelector('.boot-log');
      this.barEl = panel.querySelector('.boot-bar');
      this.pctEl = panel.querySelector('.boot-pct-num');

      if (global.CircuitField3D && global.CircuitField3D.supported()) {
        this.field = new global.CircuitField3D(canvas, { intensity: 'active' });
      } else if (global.CircuitField) {
        this.field = new global.CircuitField(canvas, { intensity: 'active' });
      }

      requestAnimationFrame(() => this.overlay.classList.add('visible'));
    }

    _line(text) {
      const row = document.createElement('div');
      row.className = 'boot-line';
      row.innerHTML = `<span class="boot-icon"><span class="spin"></span></span><span class="boot-text">${text}</span>`;
      this.logEl.appendChild(row);
      requestAnimationFrame(() => row.classList.add('shown'));
      return row;
    }

    _markDone(row) {
      row.classList.add('done');
      row.querySelector('.boot-icon').innerHTML = '<span class="check">✓</span>';
    }

    async run() {
      const n = this.steps.length;
      for (let i = 0; i < n; i++) {
        const row = this._line(this.steps[i]);
        const stepTime = this.reduced ? 180 : 650 + Math.random() * 550;
        await wait(stepTime);
        this._markDone(row);
        const pct = Math.round(((i + 1) / n) * 100);
        this.barEl.style.width = pct + '%';
        this.pctEl.textContent = pct + '%';
        await wait(this.reduced ? 60 : 180);
      }
      await wait(this.reduced ? 120 : 400);
      return true;
    }

    destroy() {
      if (this.field) this.field.destroy();
      this.overlay.classList.remove('visible');
      setTimeout(() => this.overlay.remove(), 350);
    }
  }

  global.BootSequence = BootSequence;
})(window);
    
