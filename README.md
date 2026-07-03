# Pump-Short — Live Trade Monitor

A dependency-free, single-page dashboard over the Hyperliquid pump-short paper trader.
Every setup the bot sees — **taken**, **no-capacity** (qualified but unfunded), and
**skipped** (filter-rejected ghost) — with entry/SL/TP, an interactive what-if chart,
live mark-to-market, and a taken-vs-ghost filter-edge verdict.

No build step, no libraries. Pure HTML/CSS/canvas — works offline and behind strict CDNs.

## Files

| File | Role |
|------|------|
| `index.html` | Layout + modal markup |
| `styles.css` | Dark trading-terminal theme |
| `chart.js`   | Candlestick rendering, candle fetch (cached + rate-limited), draggable-level `Interactive`, short what-if simulator |
| `app.js`     | Loads `trades.json`, renders KPIs / funnel / grid / open positions, wires the modal |
| `trades.json`| **Committed data snapshot** — produced by the exporter below |

## Refreshing the data

`trades.json` is a flattened snapshot of the vault's `paper-trade-log.jsonl`
(the bot's source of truth). Open-position **mark-to-market is always live**
(polled from the Hyperliquid API in the browser); the **closed-trade history**
is only as fresh as the last export. To refresh it:

```bash
python scripts/export_dashboard_data.py        # auto-locates the vault log
python scripts/export_dashboard_data.py --log <path>   # explicit log
```

The portfolio / win-rate / PnL math mirrors `lib/portfolio.py` so the dashboard
numbers match the Telegram alerts exactly.

## Keeping the deployed dashboard live (run on the bot's box)

The dashboard only matches the Telegram alerts if it exports from **the same vault log
the live bot writes**. So run the refresh on **the machine running `paper_trader.py`** —
the exporter resolves `VAULT_PATH` from `.env`, the same path the bot writes to:

```powershell
.\refresh_dashboard.ps1          # export trades.json, commit + push if it changed
.\refresh_dashboard.ps1 -NoPush  # export only (local preview)
```

Schedule it (every 15 min shown — tune it; each change is one commit). Push the branch
your Vercel project deploys, and the dashboard mirrors the live bot:

```powershell
schtasks /Create /SC MINUTE /MO 15 /TN "hl-dashboard-refresh" /F `
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File C:\path\to\repo\refresh_dashboard.ps1"
```

Requires `git push` auth on that box (the operator's GitHub access). If the bot moves
machines, the refresh task moves with it — wherever the bot writes the log is where the
dashboard must export from.

## Run locally (one command)

From the repo root, double-click **`run-dashboard.bat`** (Windows) or run:

```bash
python run_dashboard.py
```

It refreshes `trades.json` from a local vault if one is present (otherwise it
serves the committed snapshot), starts a local web server, and opens the
dashboard in your browser. Requires Python 3.7+ — standard library only.

> A web server is required: opening `index.html` directly via `file://` won't
> work, because the browser blocks `fetch("trades.json")` from the filesystem.

Manual equivalent:

```bash
cd dashboard && python -m http.server 8765   # then open http://localhost:8765
```

### Hand-off to a teammate (view-only, no vault)

Zip the **`dashboard/`** folder plus **`run_dashboard.py`** and
**`run-dashboard.bat`**, send it over, and they double-click the `.bat`. They'll
see the snapshot you exported plus **live** open-position prices (pulled from the
Hyperliquid API in their browser). Re-send a fresh zip to update the history.

## Deploy (Vercel)

`vercel.json` at the repo root points Vercel at this `dashboard/` directory as a
static site (no build). `trades.json` is served `no-store` so a redeploy always
surfaces the latest snapshot. Push a refreshed `trades.json` to redeploy the history.
