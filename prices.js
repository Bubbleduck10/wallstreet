/* Live prices for the 43 tokenised stocks, read from each pool's own slot0.
   No API, no key, no third party — the same maths as agent/runner.mjs and
   script/pricecheck.mjs, kept deliberately in step with both.

   The trap here is decimals. USDG is six, the stocks are eighteen, and
   sqrtPriceX96 squared is a raw ratio: doing the adjustment in BigInt floors
   ~2e8 divided by 1e30 straight to zero and prices every stock at $0.00. It
   looks entirely plausible until you check it against a second source. So the
   square is taken in floating point, where fifteen digits is plenty. */
(() => {
  const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  const SLOT0 = "0x3850c7bd";
  const RPC = (window.WS && window.WS.rpc) || "https://rpc.mainnet.chain.robinhood.com";

  const word = (h, i) => (h || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);

  const call = async (to, data) => {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
                             params: [{ to, data }, "latest"] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  const priceFromSlot0 = (s0, stock, stockDec) => {
    const sqrtP = BigInt("0x" + word(s0, 0));
    if (sqrtP === 0n) return null;
    const stockIsToken0 = stock.toLowerCase() < USDG;
    const sp = Number(sqrtP) / 2 ** 96;
    const ratio = sp * sp;
    if (!isFinite(ratio) || ratio === 0) return null;
    return (stockIsToken0 ? ratio : 1 / ratio) * 10 ** (stockDec - 6);
  };

  /* Read them in small batches. Forty-three parallel POSTs to one public RPC
     is a good way to get rate-limited into looking broken. */
  const readAll = async (tokens, onEach) => {
    const out = new Map();
    const SIZE = 6;
    for (let i = 0; i < tokens.length; i += SIZE) {
      await Promise.all(tokens.slice(i, i + SIZE).map(async (t) => {
        try {
          const px = priceFromSlot0(await call(t.pool, SLOT0), t.address, t.decimals);
          if (px && isFinite(px)) { out.set(t.symbol, px); onEach && onEach(t.symbol, px); }
        } catch { /* one dead pool must not take the tape down */ }
      }));
    }
    return out;
  };

  const fmt = (p) =>
    p >= 1000 ? "$" + p.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : p >= 1 ? "$" + p.toFixed(2)
    : "$" + p.toPrecision(3);

  window.WSPrices = { readAll, fmt, priceFromSlot0 };
})();
