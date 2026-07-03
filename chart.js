/* ============================================================
   chart.js — dependency-free candlestick charts for the monitor.
   - fetchCandles(): Hyperliquid candle API, cached + concurrency-limited
   - render():       draws candles + entry/SL/TP lines on a <canvas>
   - drawMini():     compact static preview for cards
   - Interactive:    modal chart with DRAGGABLE entry/SL/TP levels
   - simulateShort():what-if outcome for a short given current levels
   No external libraries — works offline / behind strict CDNs / on Vercel.
   ============================================================ */
(function () {
  "use strict";

  const HL_URL = "https://api.hyperliquid.xyz/info";
  const COL = {
    up: "#2ecc71", down: "#ff5566",
    gridLine: "#18202e", axis: "#5c6b7e",
    entry: "#4d9fff", sl: "#ff5566", tp: "#2ecc71",
    text: "#8b98a9", marker: "#f5b942",
  };

  /* ---- candle fetch: cache + concurrency limiter -------------------- */
  const _cache = new Map();
  const _queue = [];
  let _active = 0;
  const MAX_CONCURRENT = 4;

  function _drain() {
    while (_active < MAX_CONCURRENT && _queue.length) {
      const job = _queue.shift();
      _active++;
      job().finally(() => { _active--; _drain(); });
    }
  }
  function _enqueue(fn) {
    return new Promise((resolve, reject) => {
      _queue.push(() => fn().then(resolve, reject));
      _drain();
    });
  }

  async function fetchCandles(coin, startMs, endMs, interval) {
    const key = `${coin}|${interval}|${startMs}|${endMs}`;
    if (_cache.has(key)) return _cache.get(key);
    const p = _enqueue(async () => {
      const res = await fetch(HL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "candleSnapshot",
          req: { coin, interval, startTime: Math.round(startMs), endTime: Math.round(endMs) },
        }),
      });
      if (!res.ok) throw new Error("HL " + res.status);
      const arr = await res.json();
      return (arr || []).map((c) => ({
        time: Math.floor(c.t / 1000),
        open: +c.o, high: +c.h, low: +c.l, close: +c.c, volume: +c.v,
      }));
    });
    _cache.set(key, p);
    p.catch(() => _cache.delete(key)); // allow retry on failure
    return p;
  }

  // Candle window padding (hours) per interval — context without blowing the candle cap.
  const PAD_H = { "1m": 2, "5m": 6, "15m": 12, "1h": 24 };
  function windowFor(entryMs, closeMs, interval) {
    const pad = (PAD_H[interval] || 12) * 3600e3;
    const end = (closeMs || Date.now()) + pad;
    return { startMs: entryMs - pad, endMs: end };
  }

  /* ---- number formatting ------------------------------------------- */
  function fmtPrice(p) {
    if (p == null || !isFinite(p)) return "—";
    const a = Math.abs(p);
    if (a >= 1000) return p.toFixed(1);
    if (a >= 1) return p.toFixed(3);
    if (a >= 0.01) return p.toFixed(5);
    return p.toPrecision(4);
  }
  // Higher-precision price string for the hover readout — exact reads on small-cap alts.
  function fmtPriceExact(p) {
    if (p == null || !isFinite(p)) return "—";
    const a = Math.abs(p);
    if (a >= 1000) return p.toFixed(2);
    if (a >= 1) return p.toFixed(4);
    if (a >= 0.01) return p.toFixed(6);
    if (a >= 0.0001) return p.toFixed(8);
    return p.toExponential(4);
  }
  function fmtClock(sec) {
    const d = new Date(sec * 1000);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  function fmtDay(sec) {
    const d = new Date(sec * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  /* ---- canvas setup (DPR-aware) ------------------------------------ */
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  /* ---- core renderer ----------------------------------------------
     model: { entry, sl, tp, entryTime(sec), maxHoldH, actual:{closeTime,closePrice,outcome} }
     opts:  { showAxes, drawLevels }
     returns a coordinate map for hit-testing / grip placement.
  ------------------------------------------------------------------- */
  function render(canvas, candles, model, opts) {
    opts = opts || {};
    const showAxes = opts.showAxes !== false;
    const drawLevels = opts.drawLevels !== false;
    const { ctx, w, h } = setupCanvas(canvas);
    ctx.fillStyle = "#0e131c"; ctx.fillRect(0, 0, w, h); // solid bg so PNG export isn't transparent

    const padL = showAxes ? 52 : 4;
    const padR = showAxes ? 10 : 4;
    const padT = 8;
    const padB = showAxes ? 20 : 4;
    const plot = { x: padL, y: padT, w: w - padL - padR, h: h - padT - padB };
    if (plot.w < 8 || plot.h < 8) return null;
    if (!candles || !candles.length) {
      ctx.fillStyle = COL.text; ctx.font = "12px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("no candle data", w / 2, h / 2);
      return null;
    }

    // ranges
    let pMin = Infinity, pMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (const c of candles) {
      if (c.low < pMin) pMin = c.low;
      if (c.high > pMax) pMax = c.high;
      if (c.time < tMin) tMin = c.time;
      if (c.time > tMax) tMax = c.time;
    }
    for (const lv of [model.entry, model.sl, model.tp]) if (lv != null) { pMin = Math.min(pMin, lv); pMax = Math.max(pMax, lv); }
    if (model.actual && model.actual.closePrice != null) { pMin = Math.min(pMin, model.actual.closePrice); pMax = Math.max(pMax, model.actual.closePrice); }
    const span = pMax - pMin;
    const pPad = span > 0 ? span * 0.08 : (pMax || 1) * 0.02;
    pMin -= pPad; pMax += pPad;

    const n = candles.length;
    const cw = plot.w / Math.max(1, n);
    const denomT = Math.max(1, tMax - tMin);
    const xOf = (t) => plot.x + ((t - tMin) / denomT) * (plot.w - cw) + cw / 2;
    const yOf = (p) => plot.y + (1 - (p - pMin) / Math.max(1e-12, pMax - pMin)) * plot.h;
    const tOf = (x) => tMin + ((x - plot.x - cw / 2) / Math.max(1, plot.w - cw)) * denomT;
    const pOf = (y) => pMin + (1 - (y - plot.y) / plot.h) * (pMax - pMin);
    const multiDay = (tMax - tMin) > 36 * 3600;

    // grid + price axis
    if (showAxes) {
      ctx.font = "10px ui-monospace, monospace";
      ctx.fillStyle = COL.axis; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const rows = 7;
      for (let i = 0; i <= rows; i++) {
        const p = pMin + (i / rows) * (pMax - pMin);
        const y = yOf(p);
        ctx.strokeStyle = COL.gridLine; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
        ctx.fillText(fmtPrice(p), plot.x - 6, y);
      }
      // time axis
      ctx.textAlign = "center"; ctx.textBaseline = "top";
      const ticks = Math.min(6, n);
      for (let i = 0; i < ticks; i++) {
        const t = tMin + (i / Math.max(1, ticks - 1)) * (tMax - tMin);
        const x = xOf(t);
        ctx.fillStyle = COL.axis;
        ctx.fillText(multiDay ? fmtDay(t) : fmtClock(t), x, plot.y + plot.h + 5);
      }
    }

    // entry-time vertical marker
    if (model.entryTime != null) {
      const x = xOf(model.entryTime);
      ctx.save();
      ctx.strokeStyle = "#4d9fff44"; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      ctx.restore();
    }

    // candles
    const bodyW = Math.max(1, Math.min(cw * 0.68, 16));
    for (const c of candles) {
      const x = xOf(c.time);
      const up = c.close >= c.open;
      const col = up ? COL.up : COL.down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, yOf(c.high)); ctx.lineTo(x, yOf(c.low)); ctx.stroke();
      const yo = yOf(c.open), yc = yOf(c.close);
      const top = Math.min(yo, yc); const bh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
    }

    // level lines (entry/sl/tp) + left-edge price tags
    if (drawLevels) {
      const hline = (p, color) => {
        if (p == null || !isFinite(p)) return;
        const y = yOf(p);
        ctx.save();
        ctx.strokeStyle = color; ctx.globalAlpha = 0.92; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
        ctx.restore();
        if (showAxes) {
          ctx.fillStyle = color; ctx.globalAlpha = 1;
          ctx.fillRect(0, y - 7, plot.x - 2, 14);
          ctx.fillStyle = "#04121f"; ctx.font = "10px ui-monospace, monospace";
          ctx.textAlign = "right"; ctx.textBaseline = "middle";
          ctx.fillText(fmtPrice(p), plot.x - 5, y);
        }
      };
      hline(model.tp, COL.tp);
      hline(model.entry, COL.entry);
      hline(model.sl, COL.sl);
    }

    // actual close marker
    if (model.actual && model.actual.closePrice != null && model.actual.closeTime != null) {
      const x = xOf(model.actual.closeTime), y = yOf(model.actual.closePrice);
      ctx.fillStyle = COL.marker; ctx.strokeStyle = "#04121f"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }

    // entry-point marker — a distinct diamond at (entry time x entry price)
    if (model.entryTime != null && model.entry != null && isFinite(model.entry)) {
      const ex = xOf(model.entryTime), ey = yOf(model.entry);
      const r = showAxes ? 6 : 4;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ex, ey - r); ctx.lineTo(ex + r, ey); ctx.lineTo(ex, ey + r); ctx.lineTo(ex - r, ey); ctx.closePath();
      ctx.fillStyle = COL.entry; ctx.strokeStyle = "#04121f"; ctx.lineWidth = 1.5;
      ctx.fill(); ctx.stroke();
      if (showAxes) {
        ctx.fillStyle = COL.entry; ctx.font = "bold 9px ui-monospace, monospace";
        ctx.textAlign = "center"; ctx.textBaseline = "bottom";
        ctx.fillText("ENTRY", ex, ey - r - 2);
      }
      ctx.restore();
    }

    // hover crosshair + exact price / OHLC readout
    if (opts.cursor) {
      const cy = Math.max(plot.y, Math.min(plot.y + plot.h, opts.cursor.y));
      const cxRaw = Math.max(plot.x, Math.min(plot.x + plot.w, opts.cursor.x));
      let near = null, best = Infinity; const tc = tOf(cxRaw);
      for (const c of candles) { const dx = Math.abs(c.time - tc); if (dx < best) { best = dx; near = c; } }
      const vx = near ? xOf(near.time) : cxRaw;
      ctx.save();
      ctx.strokeStyle = "#9fb0c4"; ctx.globalAlpha = 0.5; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(plot.x, cy); ctx.lineTo(plot.x + plot.w, cy);          // horizontal at cursor
      ctx.moveTo(vx, plot.y); ctx.lineTo(vx, plot.y + plot.h);          // vertical, snapped to candle
      ctx.stroke();
      ctx.restore();
      // exact price tag at the cursor height (right edge)
      ctx.save();
      ctx.setLineDash([]);
      const priceStr = fmtPriceExact(pOf(cy));
      ctx.font = "10px ui-monospace, monospace"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      const tagW = Math.max(54, ctx.measureText(priceStr).width + 12);
      ctx.fillStyle = COL.marker; ctx.fillRect(plot.x + plot.w - tagW, cy - 8, tagW, 16);
      ctx.fillStyle = "#04121f"; ctx.fillText(priceStr, plot.x + plot.w - 6, cy);
      // OHLC readout box for the candle under the cursor (top-left of plot)
      if (near) {
        const head = (multiDay ? fmtDay(near.time) + " " : "") + fmtClock(near.time) + " UTC";
        const r2 = [
          head,
          "O " + fmtPriceExact(near.open) + "   C " + fmtPriceExact(near.close),
          "H " + fmtPriceExact(near.high) + "   L " + fmtPriceExact(near.low),
        ];
        ctx.textAlign = "left"; ctx.textBaseline = "top";
        let bw = 0; for (const s of r2) bw = Math.max(bw, ctx.measureText(s).width);
        bw += 16; const bh = r2.length * 13 + 9;
        ctx.globalAlpha = 0.92; ctx.fillStyle = "#0b1118"; ctx.fillRect(plot.x + 5, plot.y + 5, bw, bh);
        ctx.globalAlpha = 1; ctx.strokeStyle = "#2a3548"; ctx.lineWidth = 1; ctx.strokeRect(plot.x + 5, plot.y + 5, bw, bh);
        ctx.fillStyle = near.close >= near.open ? COL.up : COL.down; ctx.fillText(r2[0], plot.x + 11, plot.y + 10);
        ctx.fillStyle = "#cdd9ea";
        ctx.fillText(r2[1], plot.x + 11, plot.y + 23);
        ctx.fillText(r2[2], plot.x + 11, plot.y + 36);
      }
      ctx.restore();
    }

    return { xOf, yOf, tOf, pOf, plot, pMin, pMax, tMin, tMax, cw };
  }

  /* ---- compact static preview for cards ---------------------------- */
  function drawMini(canvas, candles, model) {
    return render(canvas, candles, model, { showAxes: false, drawLevels: true });
  }

  /* ---- what-if simulator (SHORT) ----------------------------------- */
  function simulateShort(candles, model, opts) {
    opts = opts || {};
    const slFirst = opts.slFirst !== false;
    const entry = model.entry, sl = model.sl, tp = model.tp;
    const e = model.entryTime;
    const end = e + (model.maxHoldH || 24) * 3600;
    let maxHigh = -Infinity, minLow = Infinity;
    let exit = null, exitTime = null, outcome = "timeout";
    let lastClose = null, lastTime = null, nUsed = 0;

    for (const c of candles) {
      if (c.time < e) continue;
      if (c.time > end) break;
      nUsed++;
      if (c.high > maxHigh) maxHigh = c.high;
      if (c.low < minLow) minLow = c.low;
      lastClose = c.close; lastTime = c.time;
      const hitSL = sl != null && c.high >= sl;
      const hitTP = tp != null && c.low <= tp;
      if (hitSL && hitTP) {
        if (slFirst) { outcome = "sl_hit"; exit = sl; } else { outcome = "tp_hit"; exit = tp; }
        exitTime = c.time; break;
      } else if (hitSL) { outcome = "sl_hit"; exit = sl; exitTime = c.time; break; }
      else if (hitTP) { outcome = "tp_hit"; exit = tp; exitTime = c.time; break; }
    }
    if (exit == null) { outcome = "timeout"; exit = lastClose != null ? lastClose : entry; exitTime = lastTime; }
    const pnlPct = entry ? ((entry - exit) / entry) * 100 : 0; // short: profit when price falls
    return {
      outcome, exit, exitTime, pnlPct,
      maxAdversePct: (maxHigh > -Infinity && entry) ? ((maxHigh - entry) / entry) * 100 : null,
      maxFavPct: (minLow < Infinity && entry) ? ((entry - minLow) / entry) * 100 : null,
      maxHigh: maxHigh > -Infinity ? maxHigh : null,
      minLow: minLow < Infinity ? minLow : null,
      nCandles: nUsed,
    };
  }

  /* ---- interactive modal chart with draggable levels --------------- */
  class Interactive {
    constructor(canvas, dragLayer, onChange) {
      this.canvas = canvas;
      this.layer = dragLayer;
      this.onChange = onChange || (() => {});
      this.map = null;
      this.candles = [];
      this.model = null;
      this.grips = {};
      this.dragging = null;
      this.cursor = null;
      this._raf = null;
      this._build();
      this._onResize = () => this.scheduleDraw();
      window.addEventListener("resize", this._onResize);
      // hover crosshair: listen on the chart host so moves over the drag-layer bubble up
      this._host = canvas.parentElement;
      this._hover = (e) => {
        if (this.dragging) return;
        const r = this.canvas.getBoundingClientRect();
        this.cursor = { x: e.clientX - r.left, y: e.clientY - r.top };
        this.scheduleDraw();
      };
      this._leave = () => { if (this.cursor) { this.cursor = null; this.scheduleDraw(); } };
      if (this._host) {
        this._host.addEventListener("pointermove", this._hover);
        this._host.addEventListener("pointerleave", this._leave);
      }
    }

    _build() {
      this.layer.innerHTML = "";
      const defs = [
        { key: "entry", cls: "lvl-entry", label: "ENTRY" },
        { key: "sl", cls: "lvl-sl", label: "SL" },
        { key: "tp", cls: "lvl-tp", label: "TP" },
      ];
      for (const d of defs) {
        const wrap = document.createElement("div");
        wrap.className = "lvl " + d.cls;
        const line = document.createElement("div");
        line.className = "lvl-line";
        const grip = document.createElement("div");
        grip.className = "lvl-grip";
        grip.dataset.key = d.key;
        grip.textContent = d.label;
        wrap.appendChild(line); wrap.appendChild(grip);
        this.layer.appendChild(wrap);
        this.grips[d.key] = { wrap, line, grip, baseLabel: d.label };
        grip.addEventListener("pointerdown", (e) => this._startDrag(d.key, e));
      }
      // pointer handlers on document so dragging continues outside the grip
      this._move = (e) => this._onMove(e);
      this._up = () => this._endDrag();
      document.addEventListener("pointermove", this._move);
      document.addEventListener("pointerup", this._up);
    }

    setData(candles, model) {
      this.candles = candles || [];
      this.model = model;
      this.scheduleDraw();
    }

    scheduleDraw() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = null; this.draw(); });
    }

    draw() {
      if (!this.model) return;
      this.map = render(this.canvas, this.candles, this.model, { showAxes: true, drawLevels: true, cursor: this.cursor });
      this._positionGrips();
    }

    _positionGrips() {
      if (!this.map) return;
      for (const key of ["entry", "sl", "tp"]) {
        const g = this.grips[key];
        const val = this.model[key];
        if (val == null || !isFinite(val)) { g.wrap.style.display = "none"; continue; }
        g.wrap.style.display = "";
        const y = this.map.yOf(val);
        const entry = this.model.entry;
        const pct = entry ? ((val - entry) / entry) * 100 : 0;
        const tag = key === "entry" ? g.baseLabel : `${g.baseLabel} ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
        g.grip.textContent = tag;
        g.line.style.top = y + "px";
        g.line.style.width = this.map.plot.x + this.map.plot.w + "px";
        g.grip.style.top = y + "px";
      }
    }

    _startDrag(key, e) {
      this.dragging = key;
      this.cursor = null;   // hide the hover crosshair while dragging a level
      try { e.target.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    }

    _onMove(e) {
      if (!this.dragging || !this.map) return;
      const rect = this.canvas.getBoundingClientRect();
      let y = e.clientY - rect.top;
      y = Math.max(this.map.plot.y, Math.min(this.map.plot.y + this.map.plot.h, y));
      let price = this.map.pOf(y);
      if (price < 0) price = 0;
      this.model[this.dragging] = price;
      this.scheduleDraw();
      this.onChange();
    }

    _endDrag() {
      if (this.dragging) { this.dragging = null; this.onChange(); }
    }

    destroy() {
      window.removeEventListener("resize", this._onResize);
      document.removeEventListener("pointermove", this._move);
      document.removeEventListener("pointerup", this._up);
      if (this._host) {
        this._host.removeEventListener("pointermove", this._hover);
        this._host.removeEventListener("pointerleave", this._leave);
      }
      if (this._raf) cancelAnimationFrame(this._raf);
    }
  }

  window.HLChart = {
    fetchCandles, windowFor, render, drawMini, simulateShort, Interactive,
    fmtPrice, fmtPriceExact, fmtClock, COL,
  };
})();
