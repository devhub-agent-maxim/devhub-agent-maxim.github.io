/* ============================================================
   app.js — HL Pump-Short Live Trade Monitor
   Loads trades.json (vault-synced snapshot), renders the funnel,
   filter-edge verdict, card grid, live open positions, and the
   interactive what-if chart modal.
   ============================================================ */
(function () {
  "use strict";
  const HL_URL = "https://api.hyperliquid.xyz/info";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let DATA = null;
  let MIDS = {};
  const state = { category: "all", outcome: "all", regime: "all", sort: "newest", search: "", preview: true };
  let miniObserver = null;

  /* ---------- formatting helpers ---------- */
  const fmtPrice = window.HLChart.fmtPrice;
  function fmtUsd(v) { if (v == null || !isFinite(v)) return "—"; return (v >= 0 ? "+$" : "-$") + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtUsdPlain(v) { if (v == null) return "—"; return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtPct(v, d = 2) { if (v == null || !isFinite(v)) return "—"; return (v >= 0 ? "+" : "") + v.toFixed(d) + "%"; }
  function signClass(v) { return v == null ? "" : v > 0 ? "pos" : v < 0 ? "neg" : ""; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function timeAgo(iso) {
    if (!iso) return "—";
    const t = Date.parse(iso); if (isNaN(t)) return "—";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 90) return Math.round(s) + "s ago";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 129600) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  // Absolute timestamp in the VIEWER'S LOCAL timezone (data is stored UTC with +00:00,
  // so new Date() parses it correctly and toLocaleString renders local). tz label removes ambiguity.
  function fmtLocal(iso, opts) {
    if (!iso) return "—";
    const d = new Date(iso); if (isNaN(d)) return "—";
    return d.toLocaleString(undefined, Object.assign(
      { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
        minute: "2-digit", hour12: false, timeZoneName: "short" }, opts || {}));
  }
  const OUTCOME_LABEL = { tp_hit: "WIN", sl_hit: "LOSS", timeout: "TIMEOUT", open: "OPEN" };
  const CAT_LABEL = { taken: "Taken", no_capacity: "No-cap", skip: "Skipped" };

  /* ---------- load + auto-refresh ---------- */
  // Multi-bot: ?bot=<id> switches which bot's export this page renders.
  // Default (no param) stays the legacy live-1h snapshot (trades.json).
  const BOT_ID = new URLSearchParams(location.search).get("bot");
  const DATA_URL = BOT_ID ? `data/${encodeURIComponent(BOT_ID)}.json` : "trades.json";
  async function load() {
    try {
      const res = await fetch(DATA_URL + "?_=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error(DATA_URL + " " + res.status);
      DATA = await res.json();
      if (DATA.bot) {
        const h = document.querySelector(".brand h1");
        if (h) h.innerHTML = `${esc(DATA.bot.name)} <span class="muted">Live Monitor</span>`;
        const sub = $("#subtitle");
        if (sub) sub.textContent = `${DATA.bot.owner} · ${DATA.bot.branch} — every trade this bot sees`;
      }
      renderAll();
      refreshMids();
    } catch (e) {
      $("#updatedLabel").textContent = "failed to load " + DATA_URL;
      $("#grid").innerHTML = `<div class="empty">Could not load <code>${esc(DATA_URL)}</code>.<br><span class="hint">${esc(e.message)}</span></div>`;
      console.error(e);
    }
  }

  function updateFreshness() {
    if (!DATA) return;
    const lbl = $("#updatedLabel"), dot = $("#liveDot");
    // Freshness must track the last actual TRADE (bot_last_event), NOT the last file
    // export (generated_at) — else a rebuild of stale data masquerades as "live".
    const lastTrade = DATA.bot_last_event || DATA.generated_at;
    lbl.textContent = "last trade " + timeAgo(lastTrade) + " · synced " + timeAgo(DATA.generated_at);
    // dot is "live" only if a real trade landed in the last ~2h (pumps are intermittent).
    const tradeAge = (Date.now() - Date.parse(lastTrade)) / 1000;
    dot.className = "dot " + (tradeAge < 7200 ? "live" : "stale");
  }

  /* ---------- top-level render ---------- */
  function renderAll() {
    renderBanner();
    renderKpis();
    renderFunnel();
    renderEvFactors();
    renderOpen();
    populateRegimes();
    renderGrid();
    updateFreshness();
    $("#footMeta").textContent =
      `${DATA.summary.total} setups logged · generated ${fmtLocal(DATA.generated_at, { second: "2-digit" })}`;
    $("#subtitle").innerHTML =
      `Hyperliquid · ${DATA.config.direction} · $${DATA.config.notional_per_trade_usd}/trade × ${DATA.config.max_slots} slots · SL +${DATA.config.sl_pct}% / TP −${DATA.config.tp_pct}%`;
  }

  function renderBanner() {
    const el = $("#botBanner");
    const n = DATA.reconciled_count || 0;
    if (!n) { el.hidden = true; el.innerHTML = ""; return; }
    el.hidden = false;
    const last = DATA.bot_last_event ? timeAgo(DATA.bot_last_event) : "—";
    el.innerHTML =
      `<span class="bb-ico">⚠</span>
       <div><b>${n} position${n > 1 ? "s" : ""} auto-resolved into history.</b>
       Each already hit TP/SL or timed out per the strategy, but the bot hasn't logged the close — its last entry was <b>${last}</b>, so it may be down or lagging.
       They're counted in the stats below and badged <span class="badge recon">↺&nbsp;auto</span>. Restart the bot to confirm.</div>`;
  }

  function kpi(cls, label, big, sub) {
    return `<div class="kpi ${cls}"><div class="label">${label}</div><div class="big">${big}</div><div class="sub">${sub}</div></div>`;
  }
  function renderKpis() {
    const s = DATA.summary, p = s.portfolio;
    const overCap = p.open_slots > p.max_slots;
    $("#kpis").innerHTML = [
      kpi(p.return_pct >= 0 ? "k-green" : "k-red", "Portfolio",
        `<span class="${signClass(p.return_pct)}">${fmtUsdPlain(p.value_usd)}</span>`,
        `${fmtPct(p.return_pct)} · ${fmtUsd(p.realized_usd)} realized`),
      kpi("", "Win rate (funded)", `${s.wr.toFixed(1)}%`,
        `${s.wins}W / ${s.losses}L / ${s.timeouts}T · ${s.closed_taken} closed`),
      kpi(s.avg_pnl_pct >= 0 ? "k-green" : "k-red", "Avg / trade",
        `<span class="${signClass(s.avg_pnl_pct)}">${fmtPct(s.avg_pnl_pct)}</span>`,
        `cum ${fmtPct(s.cum_pnl_pct)} · best ${fmtPct(s.best_pnl_pct)} / worst ${fmtPct(s.worst_pnl_pct)}`),
      kpi(overCap ? "k-amber" : "", "Open positions",
        `${p.open_slots}<span class="muted" style="font-size:16px">/${p.max_slots}</span>`,
        overCap ? `⚠ over cap · ${fmtUsdPlain(p.deployed_usd)} deployed` : `${fmtUsdPlain(p.deployed_usd)} deployed`),
      kpi("k-ghost", "Ghost would-be",
        `<span class="${signClass(s.ghost.would_be_usd)}">${fmtUsd(s.ghost.would_be_usd)}</span>`,
        `${s.ghost.wr.toFixed(0)}% WR · avg ${fmtPct(s.ghost.avg_pnl_pct)} · ${s.ghost.closed} closed`),
    ].join("");
  }

  function renderFunnel() {
    const s = DATA.summary;
    const total = Math.max(1, s.total);
    const bar = (cls, name, n) =>
      `<div class="fbar"><span class="fname">${name}</span>
        <div class="track"><div class="fill t-${cls}" style="width:${(n / total * 100).toFixed(1)}%"></div></div>
        <span class="fval"><b>${n}</b> · ${(n / total * 100).toFixed(0)}%</span></div>`;
    $("#funnel").innerHTML =
      `<h2>📉 Detection funnel — ${s.total} pumps seen</h2>` +
      bar("taken", "Taken", s.taken) +
      bar("no_capacity", "No-capacity", s.no_capacity) +
      bar("skip", "Skipped", s.skip);

    // Edge — de-blended: funded vs cap-dropped (no_capacity) vs filter-rejected (skip).
    const tWr = s.wr, tAvg = s.avg_pnl_pct, tClosed = s.closed_taken;
    const nc = s.no_capacity_stats || { wr: 0, avg_pnl_pct: 0, closed: 0 };
    const sk = s.skip_stats || { wr: 0, avg_pnl_pct: 0, closed: 0 };

    // Capacity cost: do setups dropped because all slots were full beat funded ones?
    let capCls = "neutral", capTxt = "Not enough cap-dropped closes yet to judge the slot cap.";
    if (nc.closed >= 5 && nc.avg_pnl_pct > tAvg + 1.0) { capCls = "warn"; capTxt = "⚠ <b>The slot cap is costing edge</b> — setups dropped when all slots were full out-earn funded ones by &gt;1%/trade. Consider raising the cap."; }
    else if (nc.closed >= 5 && tAvg >= nc.avg_pnl_pct - 0.001) { capCls = "ok"; capTxt = "✓ <b>Cap looks fine</b> — funded setups keep pace with the ones the cap dropped."; }

    // Filter edge: do filter-rejected setups beat funded ones?
    let filCls = "neutral", filTxt = "Not enough filter-rejected closes yet to judge the filters.";
    if (sk.closed >= 5 && sk.avg_pnl_pct > tAvg + 1.0) { filCls = "warn"; filTxt = "⚠ <b>Filters may be costing edge</b> — filter-rejected setups out-earn funded ones by &gt;1%/trade."; }
    else if (sk.closed >= 5 && sk.wr > tWr + 10) { filCls = "warn"; filTxt = "⚠ <b>Filters may be too tight</b> — filter-rejected WR is 10%+ above funded."; }
    else if (tClosed >= 5 && tAvg > 0 && tAvg >= sk.avg_pnl_pct) { filCls = "ok"; filTxt = "✓ <b>Filters look healthy</b> — funded setups are net positive and ahead of filter-rejects."; }
    else if (tClosed >= 5) { filCls = "neutral"; filTxt = "<b>Filters ~neutral</b> — funded and filter-rejected setups are close; the filter isn't clearly adding edge."; }

    const ebox = (cls, label, st) =>
      `<div class="box ${cls}"><div class="t">${label}</div>
        <div class="v ${signClass(st.avg_pnl_pct)}">${(st.wr || 0).toFixed(0)}% WR · ${fmtPct(st.avg_pnl_pct)}</div>
        <div class="bn">${st.closed || 0} closed</div></div>`;
    $("#filterEdge").innerHTML =
      `<h2>🔬 Edge — funded vs cap-dropped vs filtered</h2>
       <div class="verdict ${capCls}">${capTxt}</div>
       <div class="verdict ${filCls}" style="margin-top:8px">${filTxt}</div>
       <div class="cmp cmp3">
         ${ebox("", "Taken (funded)", { wr: tWr, avg_pnl_pct: tAvg, closed: tClosed })}
         ${ebox("hi", "No-cap (cap-dropped)", nc)}
         ${ebox("", "Filter-skip", sk)}
       </div>`;
  }

  /* ---------- EV factors panel (net-of-fees · wick gap · regime) ---------- */
  function renderEvFactors() {
    const s = DATA.summary, cfg = DATA.config || {};
    const f = s.fees || {}, w = s.wick || {}, reg = s.by_regime || {};
    const feeRow =
      `<div class="evf"><div class="evf-k">Net EV <span class="muted">(after ${cfg.fee_pct_roundtrip ?? 0.1}% fees)</span></div>
        <div class="evf-v ${signClass(f.net_avg_pnl_pct)}">${fmtPct(f.net_avg_pnl_pct)}<span class="evf-u">/trade</span></div>
        <div class="evf-s">gross ${fmtPct(s.avg_pnl_pct)} · net portfolio ${fmtUsdPlain(f.net_value_usd)} (${fmtPct(f.net_return_pct)})</div></div>`;
    const wickRow = (w.drag_pct != null)
      ? `<div class="evf"><div class="evf-k">SL-wick gap <span class="muted">(close vs wick fill)</span></div>
          <div class="evf-v ${w.drag_pct > 0.3 ? "neg" : ""}">${fmtPct(w.drag_pct)}<span class="evf-u">/trade</span></div>
          <div class="evf-s">close-fill ${fmtPct(s.avg_pnl_pct)} vs wick-fill ${fmtPct(w.avg_pnl_pct)} · n=${w.n} · 5m candles</div></div>`
      : `<div class="evf"><div class="evf-k">SL-wick gap</div><div class="evf-v muted">—</div>
          <div class="evf-s">run <code>export_dashboard_data.py --wick</code> to compute</div></div>`;
    const rrows = Object.entries(reg)
      .map(([name, d]) => ({ name, n: (d.taken || {}).n || 0, avg: (d.taken || {}).avg }))
      .filter((r) => r.n > 0).sort((a, b) => (b.avg ?? -99) - (a.avg ?? -99));
    const regRow =
      `<div class="evf evf-reg"><div class="evf-k">EV by BTC regime <span class="muted">(funded)</span></div>
        <div class="evf-reglist">` +
        rrows.map((r) => `<span class="evf-rchip"><b>${esc(r.name)}</b> <span class="${signClass(r.avg)}">${fmtPct(r.avg)}</span> <span class="muted">n=${r.n}</span></span>`).join("") +
        `</div></div>`;
    $("#evFactors").innerHTML =
      `<div class="panel-head"><h2>📐 EV factors — the levers that move edge</h2>
        <span class="hint">net-of-fees · SL-wick optimism · regime gradient</span></div>
       <div class="evf-grid">${feeRow}${wickRow}${regRow}</div>`;
  }

  /* ---------- live open positions ---------- */
  function openPositions() {
    return DATA.trades.filter((t) => t.category === "taken" && t.status === "open");
  }
  function renderOpen() {
    const ops = openPositions();
    const wrap = $("#openWrap");
    if (!ops.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $("#openCount").textContent = `(${ops.length})`;
    $("#openGrid").innerHTML = ops.map((t) => {
      const mid = MIDS[t.coin] != null ? +MIDS[t.coin] : null;
      const mtm = (mid != null && t.entry_price) ? (t.entry_price - mid) / t.entry_price * 100 : null; // short
      const mtmUsd = mtm != null ? DATA.config.notional_per_trade_usd * mtm / 100 : null;
      return `<div class="opos" data-id="${t.id}">
        <div class="r1"><span class="sym">${esc(t.coin)} <span class="muted" style="font-size:11px">#${t.id}</span></span>
          <span class="badge cat-taken">TAKEN</span></div>
        <div class="mtm ${signClass(mtm)}">${mtm == null ? "live…" : fmtPct(mtm) + " · " + fmtUsd(mtmUsd)}</div>
        <div class="lv">entry ${fmtPrice(t.entry_price)} → now ${mid == null ? "…" : fmtPrice(mid)}</div>
        <div class="lv">SL ${fmtPrice(t.sl_price)} (${fmtPct(t.sl_pct)}) · TP ${fmtPrice(t.tp_price)} (${fmtPct(t.tp_pct)})</div>
      </div>`;
    }).join("");
    $$("#openGrid .opos").forEach((el) => el.addEventListener("click", () => openModal(+el.dataset.id)));
  }

  async function refreshMids() {
    try {
      const res = await fetch(HL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "allMids" }), cache: "no-store" });
      MIDS = await res.json() || {};
      renderOpen();
    } catch (e) { /* leave MTM as live… */ }
  }

  /* ---------- filters ---------- */
  function populateRegimes() {
    const set = new Set(DATA.trades.map((t) => t.btc_regime || "unknown"));
    const sel = $("#regimeSel");
    const cur = sel.value || "all";
    sel.innerHTML = `<option value="all">All regimes</option>` +
      Array.from(set).sort().map((r) => `<option value="${esc(r)}">BTC: ${esc(r)}</option>`).join("");
    sel.value = cur;
  }

  function applyFilters() {
    let rows = DATA.trades.slice();
    if (state.category !== "all") rows = rows.filter((t) => t.category === state.category);
    if (state.outcome !== "all") {
      rows = state.outcome === "open"
        ? rows.filter((t) => t.status === "open")
        : rows.filter((t) => t.status === "closed" && t.outcome === state.outcome);
    }
    if (state.regime !== "all") rows = rows.filter((t) => (t.btc_regime || "unknown") === state.regime);
    if (state.search) { const q = state.search.toUpperCase(); rows = rows.filter((t) => (t.coin || "").toUpperCase().includes(q)); }
    const by = state.sort;
    const pnl = (t) => (t.pnl_pct == null ? -Infinity : t.pnl_pct);
    rows.sort((a, b) => {
      switch (by) {
        case "oldest": return (a.detected_at || "").localeCompare(b.detected_at || "");
        case "pnl_desc": return pnl(b) - pnl(a);
        case "pnl_asc": return pnl(a) - pnl(b);
        case "pump_desc": return (b.pump_pct || 0) - (a.pump_pct || 0);
        case "vol_desc": return (b.rel_vol || 0) - (a.rel_vol || 0);
        default: return (b.detected_at || "").localeCompare(a.detected_at || "");
      }
    });
    return rows;
  }

  /* ---------- card grid ---------- */
  function statusKey(t) { return t.status === "open" ? "open" : (t.outcome || "timeout"); }
  function cardHtml(t) {
    const sk = statusKey(t);
    const ghost = t.is_ghost ? `<span class="badge ghost">👻</span>` : "";
    const recon = t.reconciled ? `<span class="badge recon" title="Auto-resolved by the dashboard from price data — the bot was down/lagging and hasn't logged this close yet">↺ auto</span>` : "";
    const excl = t.excluded ? `<span class="badge excl" title="${esc(t.exclude_reason || "excluded from stats")}">⊘ excluded</span>` : "";
    const outBadge = `<span class="badge out-${sk}">${OUTCOME_LABEL[sk] || sk}</span>`;
    const pnl = t.status === "closed"
      ? `<span class="${signClass(t.pnl_pct)}">${fmtPct(t.pnl_pct)} · ${fmtUsd(t.pnl_usd)}</span>`
      : `<span class="muted">open · ${t.hold_hours == null ? "" : ""}</span>`;
    const reason = (t.category !== "taken" && t.skip_reason) ? `<span class="reason" title="${esc(t.skip_reason)}">⏭ ${esc(t.skip_reason)}</span>` : `<span></span>`;
    const chart = state.preview
      ? `<div class="card-chart"><canvas data-coin="${esc(t.coin)}" data-id="${t.id}"></canvas><div class="mini-msg">chart…</div></div>`
      : "";
    return `<article class="card c-${sk}${t.excluded ? " excluded" : ""}" data-id="${t.id}">
      <div class="card-top">
        <div class="card-coin"><span class="sym">${esc(t.coin)}</span><span class="id">#${t.id}</span></div>
        <div class="badges"><span class="badge cat-${t.category}">${CAT_LABEL[t.category]}</span>${ghost}${outBadge}${recon}${excl}</div>
      </div>
      ${chart}
      <div class="card-stats">
        <div class="cell"><div class="ck">Pump</div><div class="cv">+${(t.pump_pct ?? 0).toFixed(1)}%</div></div>
        <div class="cell"><div class="ck">Rel-vol</div><div class="cv">${t.rel_vol == null ? "—" : t.rel_vol.toFixed(2) + "×"}</div></div>
        <div class="cell"><div class="ck">BTC regime</div><div class="cv">${esc(t.btc_regime || "—")}</div></div>
        <div class="cell"><div class="ck">Entry</div><div class="cv">${fmtPrice(t.entry_price)}</div></div>
        <div class="cell"><div class="ck">SL</div><div class="cv neg">${t.sl_pct == null ? "—" : fmtPct(t.sl_pct)}</div></div>
        <div class="cell"><div class="ck">TP</div><div class="cv pos">${t.tp_pct == null ? "—" : fmtPct(t.tp_pct)}</div></div>
      </div>
      <div class="card-foot">
        <span>${pnl}</span>
        ${reason}
        <span>${timeAgo(t.detected_at)}</span>
      </div>
    </article>`;
  }

  let modalOrder = [];   // trade ids in current grid order — drives modal prev/next
  function renderGrid() {
    const rows = applyFilters();
    modalOrder = rows.map((r) => r.id);
    $("#resultCount").textContent = `${rows.length} of ${DATA.trades.length}`;
    $("#emptyState").hidden = rows.length > 0;
    const grid = $("#grid");
    grid.innerHTML = rows.map(cardHtml).join("");
    $$(".card", grid).forEach((el) => el.addEventListener("click", () => openModal(+el.dataset.id)));
    setupMiniObserver();
  }

  /* ---------- lazy mini charts ---------- */
  function setupMiniObserver() {
    if (miniObserver) miniObserver.disconnect();
    if (!state.preview) return;
    miniObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cv = e.target;
        miniObserver.unobserve(cv);
        drawMiniFor(cv);
      }
    }, { rootMargin: "200px" });
    $$(".card-chart canvas").forEach((cv) => miniObserver.observe(cv));
  }

  async function drawMiniFor(canvas) {
    const id = +canvas.dataset.id;
    const t = DATA.trades.find((x) => x.id === id);
    if (!t || !t.entry_price) return;
    const msg = canvas.parentElement.querySelector(".mini-msg");
    const entryMs = Date.parse(t.detected_at);
    const closeMs = t.closed_at ? Date.parse(t.closed_at) : null;
    const { startMs, endMs } = window.HLChart.windowFor(entryMs, closeMs, "1h");
    try {
      const candles = await window.HLChart.fetchCandles(t.coin, startMs, endMs, "1h");
      if (!candles.length) { if (msg) msg.textContent = "no candles"; return; }
      if (msg) msg.remove();
      const model = buildModel(t, "1h");
      window.HLChart.drawMini(canvas, candles, model);
    } catch (e) { if (msg) msg.textContent = "chart unavailable"; }
  }

  /* ---------- model builder ---------- */
  function buildModel(t, interval) {
    const entry = t.entry_price;
    const sl = t.sl_price != null ? t.sl_price : (entry != null ? entry * (1 + DATA.config.sl_pct / 100) : null);
    const tp = t.tp_price != null ? t.tp_price : (entry != null ? entry * (1 - DATA.config.tp_pct / 100) : null);
    return {
      entry, sl, tp,
      entryTime: t.detected_at ? Math.floor(Date.parse(t.detected_at) / 1000) : null,
      maxHoldH: DATA.config.max_hold_h,
      actual: t.status === "closed"
        ? { closeTime: t.closed_at ? Math.floor(Date.parse(t.closed_at) / 1000) : null, closePrice: t.close_price, outcome: t.outcome }
        : null,
    };
  }

  /* ---------- modal (interactive what-if) ---------- */
  let modal = { trade: null, interval: "1h", amb: "sl", interactive: null, original: null };

  async function openModal(id) {
    const t = DATA.trades.find((x) => x.id === id);
    if (!t) return;
    modal.trade = t;
    modal.interval = "1h";
    $("#modal").hidden = false;
    document.body.style.overflow = "hidden";
    const sk = statusKey(t);
    $("#modalTitle").innerHTML =
      `${esc(t.coin)} <span class="muted">#${t.id}</span>
       <span class="badge cat-${t.category}">${CAT_LABEL[t.category]}</span>
       <span class="badge out-${sk}">${OUTCOME_LABEL[sk] || sk}</span>
       ${t.is_ghost ? '<span class="badge ghost">👻 ghost</span>' : ""}
       ${t.reconciled ? '<span class="badge recon" title="Auto-resolved from price data — bot hasn\'t logged this close yet">↺ auto-resolved</span>' : ""}`;
    // prev/next position within the current filtered/sorted order
    const navIdx = modalOrder.indexOf(id);
    $("#navPos").textContent = navIdx >= 0 ? `${navIdx + 1} / ${modalOrder.length}` : "—";
    $("#prevTrade").disabled = navIdx <= 0;
    $("#nextTrade").disabled = navIdx < 0 || navIdx >= modalOrder.length - 1;
    $$("#intervalSeg button").forEach((b) => b.classList.toggle("active", b.dataset.iv === modal.interval));
    $$("#ambSeg button").forEach((b) => b.classList.toggle("active", b.dataset.amb === modal.amb));

    if (!modal.interactive) {
      modal.interactive = new window.HLChart.Interactive($("#chartCanvas"), $("#dragLayer"), () => recompute());
    }
    const model = buildModel(t, modal.interval);
    modal.original = { entry: model.entry, sl: model.sl, tp: model.tp };
    modal.interactive.setData([], model); // clear while loading
    await loadModalCandles();
  }

  async function loadModalCandles() {
    const t = modal.trade;
    const loading = $("#chartLoading");
    loading.style.display = "flex"; loading.textContent = "loading candles…";
    const entryMs = Date.parse(t.detected_at);
    const closeMs = t.closed_at ? Date.parse(t.closed_at) : null;
    const { startMs, endMs } = window.HLChart.windowFor(entryMs, closeMs, modal.interval);
    try {
      const candles = await window.HLChart.fetchCandles(t.coin, startMs, endMs, modal.interval);
      modal.candles = candles;
      modal.interactive.candles = candles;
      modal.interactive.scheduleDraw();
      loading.style.display = candles.length ? "none" : "flex";
      if (!candles.length) loading.textContent = "no candles for this window";
      recompute();
    } catch (e) {
      loading.textContent = "candles unavailable (" + esc(e.message) + ")";
    }
  }

  function recompute() {
    const t = modal.trade, m = modal.interactive.model, cfg = DATA.config;
    const sim = window.HLChart.simulateShort(modal.candles, m, { slFirst: modal.amb === "sl" });
    const simUsd = cfg.notional_per_trade_usd * sim.pnlPct / 100;
    const slPct = m.entry ? (m.sl - m.entry) / m.entry * 100 : null;
    const tpPct = m.entry ? (m.tp - m.entry) / m.entry * 100 : null;
    const botMatch = t.status === "closed" && sim.outcome === t.outcome;

    const drow = (k, v, cls = "") => `<div class="drow"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`;
    const actual = t.status === "closed"
      ? `<div class="dgroup"><h3>${t.reconciled ? "Resolved (auto · pending bot)" : "Actual result (bot)"}</h3>
          ${t.reconciled ? `<div class="delta">↺ Derived from price data at ${modal.interval === "5m" ? "5m" : "candle"} resolution because the bot hasn't logged this close yet. TP/SL booked at the level price, exactly as the bot would.</div>` : ""}
          ${drow("Outcome", `<span class="pill ${t.outcome}">${OUTCOME_LABEL[t.outcome]}</span>`)}
          ${drow("Close price", fmtPrice(t.close_price))}
          ${drow("PnL", `${fmtPct(t.pnl_pct)} · ${fmtUsd(t.pnl_usd)}`, signClass(t.pnl_pct))}
          ${drow("Hold", t.hold_hours == null ? "—" : t.hold_hours + " h")}</div>`
      : `<div class="dgroup"><h3>Status</h3>${drow("Position", "OPEN — live")}</div>`;

    const wi = `<div class="dgroup"><h3>What-if (your levels)</h3>
      <div class="whatif">
        <div class="res-line"><span class="pill ${sim.outcome}">${OUTCOME_LABEL[sim.outcome]}</span>
          <span class="${signClass(sim.pnlPct)}" style="font-family:var(--mono)">${fmtPct(sim.pnlPct)} · ${fmtUsd(simUsd)}</span></div>
        ${drow("Your SL", `${fmtPrice(m.sl)} (${fmtPct(slPct)})`, "neg")}
        ${drow("Your TP", `${fmtPrice(m.tp)} (${fmtPct(tpPct)})`, "pos")}
        ${drow("Sim exit", `${fmtPrice(sim.exit)}${sim.exitTime ? " @ " + window.HLChart.fmtClock(sim.exitTime) : ""}`)}
        ${drow("Max adverse", sim.maxAdversePct == null ? "—" : fmtPct(sim.maxAdversePct) + " toward SL", "neg")}
        ${drow("Max favorable", sim.maxFavPct == null ? "—" : fmtPct(sim.maxFavPct) + " toward TP", "pos")}
        ${sim.nCandles ? "" : '<div class="delta">⚠ no candles inside the trade window — try a wider interval</div>'}
        ${t.status === "closed"
          ? `<div class="match ${botMatch ? "same" : "diff"}">${botMatch ? "✓ matches the bot's actual outcome" : "⚠ differs from the bot's actual outcome (" + OUTCOME_LABEL[t.outcome] + ") — your levels would change the result"}</div>`
          : ""}
        <div class="delta">Drag the ENTRY / SL / TP lines on the chart. Resolution: ${modal.interval} · tie-break: ${modal.amb.toUpperCase()} first.</div>
      </div></div>`;

    const setup = `<div class="dgroup"><h3>Setup</h3>
      ${drow("Detected", fmtLocal(t.detected_at, { year: undefined }))}
      ${drow("Pump", "+" + (t.pump_pct ?? 0).toFixed(1) + "%")}
      ${drow("Rel-volume", t.rel_vol == null ? "—" : t.rel_vol.toFixed(2) + "×")}
      ${drow("BTC regime", esc(t.btc_regime || "—"))}
      ${t.funding_annual != null ? drow("Funding (ann)", t.funding_annual.toFixed(1) + "%") : ""}
      ${t.category !== "taken" && t.skip_reason ? drow("Skip reason", esc(t.skip_reason)) : ""}
      ${drow("Bot levels", `entry ${fmtPrice(modal.original.entry)} · SL ${fmtPrice(modal.original.sl)} · TP ${fmtPrice(modal.original.tp)}`)}</div>`;

    $("#detailCol").innerHTML = wi + actual + setup;
  }

  function closeModal() {
    $("#modal").hidden = true;
    document.body.style.overflow = "";
  }

  function navTrade(delta) {
    if (!modal.trade) return;
    const i = modalOrder.indexOf(modal.trade.id);
    if (i < 0) return;
    const nextId = modalOrder[i + delta];
    if (nextId != null) openModal(nextId);
  }

  /* ---------- wiring ---------- */
  function wire() {
    $("#refreshBtn").addEventListener("click", load);
    $("#search").addEventListener("input", (e) => { state.search = e.target.value.trim(); renderGrid(); });
    $("#regimeSel").addEventListener("change", (e) => { state.regime = e.target.value; renderGrid(); });
    $("#sortSel").addEventListener("change", (e) => { state.sort = e.target.value; renderGrid(); });
    $("#previewToggle").addEventListener("change", (e) => { state.preview = e.target.checked; renderGrid(); });
    $$("#catChips .chip").forEach((c) => c.addEventListener("click", () => {
      state.category = c.dataset.val; $$("#catChips .chip").forEach((x) => x.classList.toggle("active", x === c));
      $("#quickView").value = ""; renderGrid();
    }));
    $$("#outChips .chip").forEach((c) => c.addEventListener("click", () => {
      state.outcome = c.dataset.val; $$("#outChips .chip").forEach((x) => x.classList.toggle("active", x === c));
      $("#quickView").value = ""; renderGrid();
    }));
    // Quick-view presets — set category + outcome together for the analytical cohorts
    const QUICK_VIEWS = {
      taken_win:   { category: "taken",       outcome: "tp_hit" },
      taken_loss:  { category: "taken",       outcome: "sl_hit" },
      filter_miss: { category: "skip",        outcome: "tp_hit" },
      filter_save: { category: "skip",        outcome: "sl_hit" },
      cap_miss:    { category: "no_capacity", outcome: "tp_hit" },
      cap_save:    { category: "no_capacity", outcome: "sl_hit" },
    };
    $("#quickView").addEventListener("change", (e) => {
      const p = QUICK_VIEWS[e.target.value];
      if (!p) return;
      state.category = p.category; state.outcome = p.outcome;
      $$("#catChips .chip").forEach((x) => x.classList.toggle("active", x.dataset.val === state.category));
      $$("#outChips .chip").forEach((x) => x.classList.toggle("active", x.dataset.val === state.outcome));
      renderGrid();
    });
    // modal controls
    $("#modalClose").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    $("#prevTrade").addEventListener("click", () => navTrade(-1));
    $("#nextTrade").addEventListener("click", () => navTrade(1));
    document.addEventListener("keydown", (e) => {
      if ($("#modal").hidden) return;
      if (e.key === "Escape") closeModal();
      else if (e.key === "ArrowRight") { e.preventDefault(); navTrade(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); navTrade(-1); }
    });
    $$("#intervalSeg button").forEach((b) => b.addEventListener("click", () => {
      modal.interval = b.dataset.iv; $$("#intervalSeg button").forEach((x) => x.classList.toggle("active", x === b)); loadModalCandles();
    }));
    $$("#ambSeg button").forEach((b) => b.addEventListener("click", () => {
      modal.amb = b.dataset.amb; $$("#ambSeg button").forEach((x) => x.classList.toggle("active", x === b)); recompute();
    }));
    $("#resetLevels").addEventListener("click", () => {
      if (!modal.interactive || !modal.original) return;
      Object.assign(modal.interactive.model, { entry: modal.original.entry, sl: modal.original.sl, tp: modal.original.tp });
      modal.interactive.scheduleDraw(); recompute();
    });
    $("#downloadPng").addEventListener("click", () => {
      const t = modal.trade; if (!t) return;
      const url = $("#chartCanvas").toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url; a.download = `${t.coin}_${t.id}_${modal.interval}.png`; a.click();
    });
    // periodic refresh
    setInterval(() => { if ($("#autoRefresh").checked) load(); }, 60000);
    setInterval(updateFreshness, 15000);
  }

  wire();
  load();
})();
