// Cloudflare Worker for the net-worth page. Two jobs:
//
// 1. Price proxy (fetch handler)
//    GET /?symbols=INR=X,MUTHOOTFIN.NS,GC=F -> { "INR=X": {price, prevClose, name, currency}, ... }
//
// 2. Nightly snapshot (scheduled handler, cron "0 18 * * *" = 23:30 IST)
//    Reads holdings.json from your sync gist, prices everything, computes the
//    headline (after-tax) net worth exactly like index.html, and upserts today's
//    row into history.csv in the same gist.
//
// Settings -> Variables and Secrets (never put these in this file; the repo is public):
//    GITHUB_TOKEN  secret  classic token with only the "gist" scope
//    GIST_ID       secret  the same gist ID the page's Sync dialog uses

const ALLOWED_ORIGIN = "https://jainmanan2605.github.io";
const HISTORY_FILE = "history.csv";
const CSV_HEADER = "Date,Net worth (INR),Net worth (Cr),USD/INR,Source,Saved at (IST)";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";

// ---------------------------------------------------------------- prices
async function yahooQuote(sym) {
  const host = Math.random() < 0.5 ? "query1" : "query2";
  const y = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
  const r = await fetch(y, { headers: { "User-Agent": UA }, cf: { cacheTtl: 20, cacheEverything: true } });
  const j = await r.json();
  const m = j?.chart?.result?.[0]?.meta;
  if (!m) throw new Error(j?.chart?.error?.description || "no result");
  const price = m.regularMarketPrice ?? m.previousClose;
  if (price == null) throw new Error("no price");
  return {
    price,
    prevClose: m.chartPreviousClose ?? m.previousClose ?? price,
    name: m.shortName || m.longName || sym,
    currency: m.currency || "USD"
  };
}

async function fundNav(code) {
  const r = await fetch(`https://api.mfapi.in/mf/${encodeURIComponent(code)}`, { headers: { "User-Agent": UA } });
  const j = await r.json();
  if (j.status !== "SUCCESS" || !j.data || !j.data.length) throw new Error("no NAV");
  const price = parseFloat(j.data[0].nav);
  return { price, prevClose: j.data[1] ? parseFloat(j.data[1].nav) : price, currency: "INR" };
}

// Same dispatch as the page: "MF:<code>" -> mfapi.in, everything else -> Yahoo. Retries twice.
async function quote(sym) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { return sym.startsWith("MF:") ? await fundNav(sym.slice(3)) : await yahooQuote(sym); }
    catch (e) { err = e; await new Promise(r => setTimeout(r, 1500)); }
  }
  throw err;
}

// ------------------------------------------------ headline net worth
// MIRRORS render() in index.html ("After-tax NW (the headline number)").
// If you change how the page computes the headline, change this too.
function headlineINR(state, prices, usdInr) {
  const toINR = (amt, ccy) => ccy === "USD" ? amt * usdInr : amt;
  const value = (h) => {
    const p = prices[h.symbol];
    if (!p || p.price == null) throw new Error("missing price for " + h.symbol);
    const ccy = p.currency || "USD";
    const gain = (h.purchasePrice != null && h.purchasePrice > 0)
      ? toINR((p.price - h.purchasePrice) * h.qty, ccy) : null;
    return { valueINR: toINR(p.price * h.qty, ccy), gainINR: gain };
  };

  let stocks = 0, funds = 0, metals = 0, debt = 0, cash = 0, stocksGain = 0;
  (state.stocks || []).forEach(h => {
    const v = value(h);
    stocks += v.valueINR;
    if (v.gainINR != null && !h.noTax) stocksGain += v.gainINR;
  });
  (state.funds || []).forEach(h => { funds += value(h).valueINR; });
  (state.metals || []).forEach(h => { metals += value(h).valueINR; });
  (state.debt || []).forEach(c => { debt += toINR(Number(c.amount) || 0, c.currency || "INR"); });
  (state.cash || []).forEach(c => { cash += toINR(Number(c.amount) || 0, c.currency || "INR"); });

  const gross = stocks + funds + debt + metals + cash;
  const fundsPurchase = Number(state.fundsPurchase) || 0;
  const fundsGain = fundsPurchase > 0 ? (funds - fundsPurchase) : 0;
  const totalGain = stocksGain + fundsGain;
  const taxRate = Math.max(0, Math.min(50, Number(state.taxRate ?? 15) || 0));
  const tax = totalGain > 0 ? totalGain * taxRate / 100 : 0;
  return gross - tax;
}

// ------------------------------------------------------- gist + csv
async function gist(env, method = "GET", body) {
  const r = await fetch(`https://api.github.com/gists/${encodeURIComponent(env.GIST_ID)}`, {
    method,
    headers: {
      "Authorization": `token ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "networth-prices-worker",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`gist ${method} HTTP ${r.status}`);
  return r.json();
}

async function fileContent(file) {
  if (!file) return "";
  if (!file.truncated) return file.content || "";
  return (await fetch(file.raw_url)).text();   // gist API truncates files > 1 MB
}

const istParts = (d = new Date()) => {
  const s = new Date(d.getTime() + 5.5 * 3600e3).toISOString();   // shift to IST, read as UTC
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
};

// Insert or replace one date's row; rows stay sorted by date.
function upsertRow(csv, row) {
  const rows = new Map();
  csv.split(/\r?\n/).slice(1).filter(l => /^\d{4}-\d{2}-\d{2},/.test(l))
    .forEach(l => rows.set(l.slice(0, 10), l));
  rows.set(row.slice(0, 10), row);
  return [CSV_HEADER, ...[...rows.keys()].sort().map(k => rows.get(k))].join("\n") + "\n";
}

async function snapshot(env) {
  if (!env.GITHUB_TOKEN || !env.GIST_ID) throw new Error("GITHUB_TOKEN / GIST_ID not set");
  const g = await gist(env);
  const state = JSON.parse(await fileContent(g.files["holdings.json"]));

  const syms = [...new Set(["INR=X", ...[...(state.stocks || []), ...(state.metals || []), ...(state.funds || [])].map(h => h.symbol)])];
  const prices = {};
  await Promise.all(syms.map(async s => { prices[s] = await quote(s); }));   // any failure aborts: no half-priced rows

  const usdInr = prices["INR=X"].price;
  const nw = headlineINR(state, prices, usdInr);
  const { date, time } = istParts();
  const row = [date, Math.round(nw), (nw / 1e7).toFixed(2), usdInr.toFixed(2), "auto", time].join(",");

  const csv = upsertRow(await fileContent(g.files[HISTORY_FILE]), row);
  await gist(env, "PATCH", { files: { [HISTORY_FILE]: { content: csv } } });   // touches only history.csv
  return row;
}

// ------------------------------------------------------------ entry
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshot(env).then(
      row => console.log("snapshot saved:", row.split(",")[0]),
      e => console.error("snapshot failed:", e.message)
    ));
  },

  async fetch(request) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const symbols = (url.searchParams.get("symbols") || "")
      .split(",").map(s => s.trim()).filter(Boolean).slice(0, 50);
    if (!symbols.length) {
      return new Response('{"error":"pass ?symbols=A,B"}', { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const out = {};
    await Promise.all(symbols.map(async (sym) => {
      try {
        const q = await yahooQuote(sym);
        out[sym] = q;
      } catch (e) {
        out[sym] = { error: String(e.message || e) };
      }
    }));

    return new Response(JSON.stringify(out), {
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
};
