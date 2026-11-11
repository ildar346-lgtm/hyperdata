// HyperData for the phone, on its own (the user, 2026-11-11): the phone asks the exchanges itself and counts our
// scheme itself — no Mac, no server. A port of the terminal's own rules (Python → JS), kept apart from the Mac code:
//   estimate      data_layer/cex_estimate.estimate_liquidations (a leverage mix over the candles, levels touched by a
//                 later move dropped, each side scaled back to its share of today's open interest)
//   zones         data_layer/level_break.zones (swing points within 0.35 % → a level, 2+ touches; 0.2-0.5 % wide)
//   blocks        data_layer/order_blocks.find (the last opposite candle before a 1.5× impulse that broke a swing)
//   move / trend / reach / plan   app20's candle move, the day's side, the money within reach, the stop past an
//                 order block (else a strong zone, else two moves) and the 1:1 filter
// Exchanges that answer a phone's browser (CORS, checked 2026-11-11): Binance, Bybit, OKX, Gate, Bitget, Hyperliquid.
"use strict";

const HD = {};

HD.LEVERAGE_MIX = [[5, 0.15], [10, 0.30], [25, 0.25], [50, 0.20], [100, 0.10]];
HD.MAINT = 0.005;

async function getJSON(url, opt) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { ...(opt || {}), signal: ctl.signal, cache: "no-store" });
    if (!r.ok) throw new Error(url.split("/")[2] + " " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
HD.getJSON = getJSON;

// ── candles: [t (s), o, h, l, c, vol, quoteVol] oldest first ──
const TF_BYBIT = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" };
const TF_OKX = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1Dutc", "1w": "1Wutc" };
HD.TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 };

HD.binanceKlines = async (coin, tf, limit = 500, endTime = null) => {
  const q = `symbol=${coin}USDT&interval=${tf}&limit=${limit}` + (endTime ? `&endTime=${endTime * 1000 - 1}` : "");
  const rows = await getJSON(`https://fapi.binance.com/fapi/v1/klines?${q}`);
  return rows.map((k) => [k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]);
};
HD.bybitKlines = async (coin, tf, limit = 200) => {
  const d = await getJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${coin}USDT&interval=${TF_BYBIT[tf]}&limit=${limit}`);
  return (d.result?.list || []).map((k) => [k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5], +k[6]]).reverse();
};
HD.okxKlines = async (coin, tf, limit = 168) => {
  const d = await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${coin}-USDT-SWAP&bar=${TF_OKX[tf]}&limit=${Math.min(limit, 300)}`);
  return (d.data || []).map((k) => [k[0] / 1000, +k[1], +k[2], +k[3], +k[4], +k[5], +k[7]]).reverse();
};

// ── open interest (USD) and the accounts' long share ──
HD.binanceOI = async (coin) => {
  const d = await getJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${coin}USDT&period=15m&limit=17`);
  return d.length ? { oi: +d[d.length - 1].sumOpenInterestValue, hist: d.map((r) => +r.sumOpenInterestValue) } : null;
};
HD.binanceLongShare = async (coin) => {
  const d = await getJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${coin}USDT&period=1h&limit=1`);
  return d.length ? +d[0].longAccount : 0.5;
};
HD.bybitOI = async (coin) => {
  const d = await getJSON(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${coin}USDT`);
  const t = d.result?.list?.[0];
  return t ? { oi: +t.openInterestValue, price: +t.lastPrice, funding: +t.fundingRate } : null;
};
HD.okxOI = async (coin) => {
  const d = await getJSON(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${coin}-USDT-SWAP`);
  const r = d.data?.[0];
  return r ? { oi: +r.oiUsd } : null;
};
HD.binanceFunding = async () => {          // {coin: funding % per 8 h}
  const [rates, info] = await Promise.all([getJSON("https://fapi.binance.com/fapi/v1/premiumIndex"),
    getJSON("https://fapi.binance.com/fapi/v1/fundingInfo").catch(() => [])]);
  const hours = {}; for (const r of info) hours[r.symbol] = +(r.fundingIntervalHours || 8);
  const out = {};
  for (const r of rates) if (r.symbol.endsWith("USDT")) out[r.symbol.slice(0, -4)] = +r.lastFundingRate * 100 * 8 / (hours[r.symbol] || 8);
  return out;
};

// ── the liquidation estimate (cex_estimate.estimate_liquidations) ──
HD.estimate = (candles, oiUsd, longShare, mix = HD.LEVERAGE_MIX, maint = HD.MAINT) => {
  const rows = candles.filter((c) => c[2] > 0 && c[3] > 0 && c[4] > 0 && c[6] > 0)
    .map((c) => [(c[2] + c[3] + c[4]) / 3, c[2], c[3], c[6], c[0]]);
  const tq = rows.reduce((a, r) => a + r[3], 0);
  if (!rows.length || tq <= 0 || !(oiUsd > 0)) return [];
  longShare = Math.min(1, Math.max(0, longShare));
  const mt = mix.reduce((a, m) => a + m[1], 0) || 1, n = rows.length;
  const laterLow = new Array(n).fill(Infinity), laterHigh = new Array(n).fill(0);
  let lo = Infinity, hi = 0;
  for (let i = n - 1; i >= 0; i--) { laterLow[i] = lo; laterHigh[i] = hi; lo = Math.min(lo, rows[i][2]); hi = Math.max(hi, rows[i][1]); }
  const out = [];
  rows.forEach(([entry, , , qv, t], i) => {
    const notional = oiUsd * qv / tq;
    for (const [lev, w] of mix) {
      const part = notional * w / mt, ll = entry * (1 - 1 / lev + maint), sl = entry * (1 + 1 / lev - maint);
      if (longShare > 0 && ll > 0 && laterLow[i] > ll) out.push({ side: "long", price: ll, usd: part * longShare, lev, entry, t });
      if (longShare < 1 && laterHigh[i] < sl) out.push({ side: "short", price: sl, usd: part * (1 - longShare), lev, entry, t });
    }
  });
  for (const [side, target] of [["long", oiUsd * longShare], ["short", oiUsd * (1 - longShare)]]) {
    const kept = out.filter((l) => l.side === side).reduce((a, l) => a + l.usd, 0);
    if (kept > 0 && target > 0) for (const l of out) if (l.side === side) l.usd *= target / kept;
  }
  return out;
};

// ── support / resistance zones (level_break.zones), on closed 1 h candles ──
HD.zones = (kl1h) => {
  const PIVOT = 2, TOL = 0.35, ZMIN = 0.2, ZMAX = 0.5, out = [];
  for (const [kind, ix] of [["сопр", 2], ["подд", 3]]) {
    const piv = [];
    for (let i = PIVOT; i < kl1h.length - PIVOT; i++) {
      const v = kl1h[i][ix], left = kl1h.slice(i - PIVOT, i).map((r) => r[ix]), right = kl1h.slice(i + 1, i + PIVOT + 1).map((r) => r[ix]);
      if ((kind === "сопр" && v > Math.max(...left) && v >= Math.max(...right))
          || (kind === "подд" && v < Math.min(...left) && v <= Math.min(...right))) piv.push(i);
    }
    const groups = [];
    for (const i of piv.sort((a, b) => kl1h[a][ix] - kl1h[b][ix])) {
      const g = groups[groups.length - 1];
      if (g && Math.abs(kl1h[i][ix] / kl1h[g[0]][ix] - 1) * 100 <= TOL) g.push(i); else groups.push([i]);
    }
    const med = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    for (const g of groups) {
      if (g.length < 2) continue;
      let hi, lo;
      if (kind === "сопр") { hi = Math.max(...g.map((i) => kl1h[i][2])); lo = med(g.map((i) => Math.max(kl1h[i][1], kl1h[i][4]))); }
      else { lo = Math.min(...g.map((i) => kl1h[i][3])); hi = med(g.map((i) => Math.min(kl1h[i][1], kl1h[i][4]))); }
      const mid = (hi + lo) / 2, w = mid ? (hi - lo) / mid * 100 : 0;
      if (w < ZMIN) { if (kind === "сопр") lo = hi * (1 - ZMIN / 100); else hi = lo * (1 + ZMIN / 100); }
      else if (w > ZMAX) { if (kind === "сопр") lo = hi * (1 - ZMAX / 100); else hi = lo * (1 + ZMAX / 100); }
      out.push({ kind, lo, hi, touches: g.length, t0: kl1h[Math.min(...g)][0] });
    }
  }
  return out;
};

// ── order blocks (order_blocks.find), active ones, newest first ──
HD.blocks = (kl) => {
  const PIVOT = 2, LOOK = 6, IMP = 1.5, n = kl.length, out = [];
  if (n < 30) return out;
  const rng = kl.map((x) => x[2] - x[3]);
  let lastHi = null, lastLo = null, usedHi = -1, usedLo = -1;
  for (let i = 0; i < n; i++) {
    const p = i - PIVOT;
    if (p >= PIVOT) {
      let isHi = true, isLo = true;
      for (let k = p - PIVOT; k <= p + PIVOT; k++) { if (k === p) continue; if (!(kl[p][2] > kl[k][2])) isHi = false; if (!(kl[p][3] < kl[k][3])) isLo = false; }
      if (isHi) lastHi = p; if (isLo) lastLo = p;
    }
    const m = Math.min(20, i), avg = i ? rng.slice(Math.max(0, i - 20), i).reduce((a, b) => a + b, 0) / Math.max(1, m) : 0;
    for (const up of [true, false]) {
      const sw = up ? lastHi : lastLo;
      if (sw === null || sw === (up ? usedHi : usedLo)) continue;
      if (!(up ? kl[i][4] > kl[sw][2] : kl[i][4] < kl[sw][3])) continue;
      if (up) usedHi = sw; else usedLo = sw;
      let j = null;
      for (let k = i - 1; k > Math.max(-1, i - 1 - LOOK); k--) if (up ? kl[k][4] < kl[k][1] : kl[k][4] > kl[k][1]) { j = k; break; }
      if (j === null || avg <= 0) continue;
      const move = up ? kl[i][4] - kl[j][3] : kl[j][2] - kl[i][4];
      if (move < IMP * avg) continue;
      const lo = kl[j][3], hi = kl[j][2];
      const spent = kl.slice(i + 1).some((x) => up ? x[3] <= hi : x[2] >= lo);
      if (!spent) out.push({ up, lo, hi, t: kl[j][0] });
    }
  }
  return out.sort((a, b) => b.t - a.t);
};

// ── the candle move, the day's side, the money within reach, the plan ──
HD.REACH_N = 24;
HD.move = (cs) => {                        // median (high − low) / close of the last 50 closed candles, %
  const r = cs.slice(-51, -1).filter((c) => c[4] > 0).map((c) => (c[2] - c[3]) / c[4] * 100).sort((a, b) => a - b);
  return r.length >= 10 ? r[r.length >> 1] : 0;
};
HD.trend = (cs15, price, move) => {        // the last 24 h of 15 m candles
  const day = cs15.slice(-96); if (!day.length || !move) return null;
  const o = day[0][1], hi = Math.max(...day.map((c) => c[2])), lo = Math.min(...day.map((c) => c[3]));
  const ch = (price / o - 1) * 100, pos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  return { side: ch >= move && pos >= 0.5 ? "bull" : ch <= -move && pos <= 0.5 ? "bear" : "flat", ch, pos };
};
HD.rows = (levels, price, stepPct, rangePct) => {   // the money per price row: {price, long, short}
  const lo = price * (1 - rangePct / 100), step = price * stepPct / 100, m = new Map();
  for (const l of levels) {
    if (Math.abs(l.price / price - 1) * 100 > rangePct) continue;
    const k = Math.floor((l.price - lo) / step), b = m.get(k) || { price: lo + (k + 0.5) * step, long: 0, short: 0 };
    b[l.side] += l.usd; m.set(k, b);
  }
  return [...m.values()].sort((a, b) => a.price - b.price);
};
HD.star = (levels, price) => {             // ★: the row with the most money within ±8 % (rows 0.25 %)
  const rows = HD.rows(levels, price, 0.25, 8);
  if (!rows.length) return null;
  const b = rows.reduce((a, r) => (r.long + r.short > a.long + a.short ? r : a));
  return { price: b.price, usd: b.long + b.short, side: Math.abs(b.price / price - 1) * 100 <= 0.1 ? null : b.price > price ? "long" : "short" };
};
HD.reach = (levels, price, move) => {      // the biggest money each way within move × √24
  if (!move) return null;
  const lim = move * Math.sqrt(HD.REACH_N), rows = HD.rows(levels, price, 0.15, lim + 0.2), out = { lim };
  for (const up of [true, false]) {
    let best = null;
    for (const r of rows) {
      const d = (r.price / price - 1) * 100 * (up ? 1 : -1), usd = up ? r.short : r.long;
      if (d <= 0.2 || d > lim || !(usd > 0)) continue;
      if (!best || usd > best.usd) best = { price: r.price, usd, d, n: Math.max(1, Math.round((d / move) ** 2)) };
    }
    out[up ? "up" : "down"] = best;
  }
  return out;
};
HD.plan = (side, price, move, target, zones, blocks) => {   // the stop past an OB, else a strong zone, else 2 moves; 1:1
  if (!target || !move) return null;
  const up = side === "long", reach = move * Math.sqrt(HD.REACH_N) / 100, PAD = 0.001;
  let stop = null, by = "2 свечи";
  const obs = blocks.filter((b) => up ? b.up && b.lo < price : !b.up && b.hi > price);
  if (obs.length) {
    const b = up ? obs.reduce((a, x) => (x.lo > a.lo ? x : a)) : obs.reduce((a, x) => (x.hi < a.hi ? x : a));
    const c = up ? b.lo * (1 - PAD) : b.hi * (1 + PAD);
    if (Math.abs(price - c) / price <= reach) { stop = c; by = "за ОБ"; }
  }
  if (stop === null) {
    const zs = zones.filter((z) => z.touches >= 3 && (up ? z.kind === "подд" && z.hi < price : z.kind === "сопр" && z.lo > price));
    if (zs.length) {
      const z = up ? zs.reduce((a, x) => (x.hi > a.hi ? x : a)) : zs.reduce((a, x) => (x.lo < a.lo ? x : a));
      const c = up ? z.lo * (1 - PAD) : z.hi * (1 + PAD);
      if (Math.abs(price - c) / price <= reach) { stop = c; by = "за зоной"; }
    }
  }
  if (stop === null) stop = up ? price * (1 - 2 * move / 100) : price * (1 + 2 * move / 100);
  const rr = Math.abs(target.price - price) / Math.abs(price - stop);
  return { side, stop, by, target: target.price, rr, ok: rr >= 1 };
};

// ── one coin, everything the chart draws (the exchanges asked in parallel; any of them may fail) ──
HD.load = async (coin, tf) => {
  coin = coin.toUpperCase();
  const [cs, cs15, h1, bOI, share, byb, okx, by1h, ok1h] = await Promise.all([
    HD.binanceKlines(coin, tf, 500), tf === "15m" ? null : HD.binanceKlines(coin, "15m", 200).catch(() => null),
    HD.binanceKlines(coin, "1h", 169).catch(() => []), HD.binanceOI(coin).catch(() => null),
    HD.binanceLongShare(coin).catch(() => 0.5), HD.bybitOI(coin).catch(() => null), HD.okxOI(coin).catch(() => null),
    HD.bybitKlines(coin, "1h", 168).catch(() => []), HD.okxKlines(coin, "1h", 168).catch(() => [])]);
  const c15 = tf === "15m" ? cs : (cs15 || cs);
  const closed1h = h1.slice(0, -1), price = cs[cs.length - 1][4];
  const levels = [], venues = [];
  if (bOI) { levels.push(...HD.estimate(closed1h, bOI.oi, share)); venues.push("Binance"); }
  if (byb && by1h.length) { levels.push(...HD.estimate(by1h.slice(0, -1), byb.oi, share)); venues.push("Bybit"); }
  if (okx && ok1h.length) { levels.push(...HD.estimate(ok1h.slice(0, -1), okx.oi, share)); venues.push("OKX"); }
  const move = HD.move(c15), zones = HD.zones(closed1h), blocks = HD.blocks(closed1h);
  const trend = HD.trend(c15, price, move), reach = HD.reach(levels, price, move), star = HD.star(levels, price);
  const want = trend && trend.side === "bull" ? "long" : trend && trend.side === "bear" ? "short" : null;
  const plans = [];
  for (const side of want ? [want] : ["long", "short"]) {
    const t = reach && (side === "long" ? reach.up : reach.down);
    const p = HD.plan(side, price, move, t, zones, blocks); if (p) plans.push(p);
  }
  return { coin, tf, candles: cs, price, levels, venues, share, move, zones, blocks, trend, reach, star, plans,
           moveTf: HD.move(cs), at: Date.now() };
};

// ── the screener both ways (data_layer/screener: metrics, score, verdict; the mirror for a squeeze down) ──
HD.SCR_WINDOW = 16;                         // 15 m candles: 4 h
const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
HD.scrMetrics = (kl, oi, funding) => {      // kl: raw Binance 15 m rows (closed), oi: openInterestHist rows
  const ch = kl.slice(-HD.SCR_WINDOW).map((k) => [+k[1], +k[4], +k[5], +k[9]]);
  const oh = oi.slice(-(HD.SCR_WINDOW + 1)).map((r) => +r.sumOpenInterestValue);
  if (ch.length < 4 || oh.length < 4 || ch[0][0] <= 0 || oh[0] <= 0) return null;
  const tot = ch.reduce((a, c) => a + c[2], 0), buy = ch.reduce((a, c) => a + c[3], 0), price = ch[ch.length - 1][1];
  return { funding, oi_chg: (oh[oh.length - 1] / oh[0] - 1) * 100, price_chg: (price / ch[0][0] - 1) * 100,
           cvd_ratio: tot ? (2 * buy - tot) / tot : 0, price };
};
HD.scoreUp = (m) => Math.round(clamp(-m.funding / 0.05) * 35 + clamp(m.oi_chg / 20) * 30 + clamp(m.cvd_ratio / 0.15) * 20
  + (1 - clamp(Math.abs(m.price_chg) / 3)) * 15);
HD.scoreDown = (m) => Math.round(clamp(m.funding / 0.05) * 35 + clamp(m.oi_chg / 20) * 30 + clamp(-m.cvd_ratio / 0.15) * 20
  + (1 - clamp(Math.abs(m.price_chg) / 3)) * 15);
HD.verdict = (m, up, down) => {
  if (up >= down) {
    if (up >= 75 && m.funding < -0.02 && m.oi_chg > 10) return ["сквиз ↑", "long"];
    if (up >= 60 && m.funding < 0) return ["накопление ↑", "long"];
  } else {
    if (down >= 75 && m.funding > 0.02 && m.oi_chg > 10) return ["сквиз ↓", "short"];
    if (down >= 60 && m.funding > 0) return ["раздача ↓", "short"];
  }
  return [Math.max(up, down) >= 45 ? "ждать" : "слабый", null];
};
HD.marketCoins = async (minVol = 50e6, n = 40) => {   // the most traded crypto perpetuals on Binance
  const [info, tick] = await Promise.all([getJSON("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    getJSON("https://fapi.binance.com/fapi/v1/ticker/24hr")]);
  const ok = new Set(info.symbols.filter((s) => s.contractType === "PERPETUAL" && s.underlyingType === "COIN"
    && s.symbol.endsWith("USDT")).map((s) => s.symbol));
  return tick.filter((t) => ok.has(t.symbol) && +t.quoteVolume >= minVol).sort((a, b) => b.quoteVolume - a.quoteVolume)
    .map((t) => t.symbol.slice(0, -4)).filter((c) => !["PAXG", "XAUT"].includes(c)).slice(0, n);
};
HD.scan = async (coins, onRow, parallel = 4) => {   // 2 calls a coin, a few at a time
  const fund = await HD.binanceFunding(), out = [];
  let i = 0;
  async function worker() {
    while (i < coins.length) {
      const c = coins[i++];
      if (!(c in fund)) continue;
      try {
        const [kl, oi] = await Promise.all([
          getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${c}USDT&interval=15m&limit=${HD.SCR_WINDOW + 1}`),
          getJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${c}USDT&period=15m&limit=${HD.SCR_WINDOW + 1}`)]);
        const m = HD.scrMetrics(kl.slice(0, -1), oi, fund[c]);
        if (!m) continue;
        const up = HD.scoreUp(m), down = HD.scoreDown(m), [v, side] = HD.verdict(m, up, down);
        const row = { coin: c, up, down, verdict: v, side, ...m };
        out.push(row); if (onRow) onRow(row);
      } catch (e) { /* this coin next time */ }
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker));
  return out;
};

if (typeof module !== "undefined") module.exports = HD;
