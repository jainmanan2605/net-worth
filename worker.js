// Cloudflare Worker: private price proxy for the net-worth page.
// GET /?symbols=INR=X,MUTHOOTFIN.NS,GC=F  ->  { "INR=X": {price, prevClose, name, currency}, ... }
// Deploy: dash.cloudflare.com -> Workers & Pages -> Create -> "Hello World" worker ->
// Edit code -> paste this file -> Deploy. Copy the *.workers.dev URL into PRICE_PROXY in index.html.

const ALLOWED_ORIGIN = "https://jainmanan2605.github.io";

export default {
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
      const host = Math.random() < 0.5 ? "query1" : "query2";
      const y = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
      try {
        const r = await fetch(y, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
          cf: { cacheTtl: 20, cacheEverything: true }   // 20s edge cache: fresh enough, spares Yahoo
        });
        const j = await r.json();
        const m = j?.chart?.result?.[0]?.meta;
        if (!m) throw new Error(j?.chart?.error?.description || "no result");
        const price = m.regularMarketPrice ?? m.previousClose;
        out[sym] = {
          price,
          prevClose: m.chartPreviousClose ?? m.previousClose ?? price,
          name: m.shortName || m.longName || sym,
          currency: m.currency || "USD"
        };
      } catch (e) {
        out[sym] = { error: String(e.message || e) };
      }
    }));

    return new Response(JSON.stringify(out), {
      headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" }
    });
  }
};
