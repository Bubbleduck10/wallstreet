/* Reads the floor from chain.
 *
 * Everything the floor draws comes from here: which desks exist, who runs them,
 * what they may trade, what they are holding and when they last did anything.
 * Nothing is invented — if the factory has no desks, the caller is told that
 * rather than handed something that looks like activity.
 */
(() => {
  const SEL = {
    deskCount: "0x47d0a311",
    desks: "0xeef5e258",
    owner: "0x8da5cb5b",
    agent: "0xf5ff5c76",
    mandate: "0x39b1b96d",
    balanceOf: "0x70a08231",
    slot0: "0x3850c7bd",
  };
  const TOPIC_TRADED = "0x7052911c5aef4de26c5fa67840c861bc4ce10fc26d46132b6ad21c9b164465e8";

  /* How long a desk may sit without trading before the floor calls it stale.
     A placeholder until the clock is settled: it is a display threshold only,
     nothing on chain depends on it, and no position is touched because of it. */
  const STALE_HOURS = 24;

  const rpc = async (method, params, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(window.WS.rpc, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        if (r.status === 429 || r.status >= 500) throw new Error("transient");
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((s) => setTimeout(s, 350 * (i + 1)));
      }
    }
  };
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const padN = (n) => BigInt(n).toString(16).padStart(64, "0");
  const big = (h) => BigInt(h && h !== "0x" ? h : "0x0");
  const word = (h, i) => (h || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
  const addrOf = (w) => "0x" + w.slice(24);

  /* Same maths as the runner, and wrong in the same way if it is ever changed
     in one place only: the decimal adjustment must happen in floating point,
     because in BigInt it floors the whole thing to zero. */
  const priceFromSlot0 = (s0, stock, quote, stockDec, quoteDec) => {
    const sqrtP = big("0x" + word(s0, 0));
    if (sqrtP === 0n) return 0;
    const sp = Number(sqrtP) / 2 ** 96;
    const ratio = sp * sp;
    if (!isFinite(ratio) || ratio === 0) return 0;
    const stockIsToken0 = stock.toLowerCase() < quote.toLowerCase();
    return (stockIsToken0 ? ratio : 1 / ratio) * 10 ** (stockDec - quoteDec);
  };

  /** Every listed stock, priced once and shared across all desks — the pools do
      not care who is asking, and a floor of 200 desks should not make 200
      identical calls per stock. */
  async function priceUniverse(tokens) {
    const out = new Map();
    await Promise.all(tokens.map(async (t) => {
      try {
        const s0 = await call(t.pool, SEL.slot0);
        out.set(t.address.toLowerCase(),
          priceFromSlot0(s0, t.address, window.WS.usdg, t.decimals, window.WS.usdgDecimals));
      } catch { out.set(t.address.toLowerCase(), 0); }
    }));
    return out;
  }

  /** When each vault last traded, from its own Traded events. */
  async function lastTradeTimes(vaults) {
    const seen = new Map();
    try {
      const head = parseInt(await rpc("eth_blockNumber", []), 16);
      const logs = await rpc("eth_getLogs", [{
        fromBlock: "0x" + Math.max(0, head - 400000).toString(16),
        toBlock: "0x" + (head - 5).toString(16),
        topics: [TOPIC_TRADED],
      }]);
      for (const l of logs) {
        const v = l.address.toLowerCase();
        const b = parseInt(l.blockNumber, 16);
        if (!seen.has(v) || seen.get(v) < b) seen.set(v, b);
      }
      // Robinhood Chain blocks are sub-second; measured against the head this
      // is close enough to say "hours ago" without a timestamp lookup per desk.
      return { seen, head, secondsPerBlock: 0.25 };
    } catch {
      return { seen, head: 0, secondsPerBlock: 0.25 };
    }
  }

  /**
   * @returns {Promise<{configured:boolean, desks:Array, note:string}>}
   */
  window.loadDesks = async function loadDesks() {
    if (!window.WS.factory) {
      return { configured: false, desks: [], note: "The floor has not been deployed yet." };
    }

    const tokens = window.TOKENS || [];
    const n = Number(big(await call(window.WS.factory, SEL.deskCount)));
    if (!n) return { configured: true, desks: [], note: "No desks have been hired yet." };

    const prices = await priceUniverse(tokens);
    const addrs = [];
    for (let i = 0; i < Math.min(n, 252); i++) {
      addrs.push(addrOf(word(await call(window.WS.factory, SEL.desks + padN(i)), 0)));
    }
    const { seen, head, secondsPerBlock } = await lastTradeTimes(addrs);

    const desks = [];
    for (const vault of addrs) {
      try {
        const [ownerRaw, agentRaw, mandateRaw, cashRaw] = await Promise.all([
          call(vault, SEL.owner), call(vault, SEL.agent),
          call(vault, SEL.mandate), call(window.WS.usdg, SEL.balanceOf + pad(vault)),
        ]);
        const mandate = Number(big(mandateRaw));
        const allowed = tokens.filter((t) => mandate & (1 << t.sector));

        let bookUsd = Number(big(cashRaw)) / 10 ** window.WS.usdgDecimals;
        const positions = [];
        for (const t of allowed) {
          const bal = big(await call(t.address, SEL.balanceOf + pad(vault)));
          if (bal === 0n) continue;
          const px = prices.get(t.address.toLowerCase()) || 0;
          const usd = (Number(bal) / 10 ** t.decimals) * px;
          bookUsd += usd;
          positions.push({ symbol: t.symbol, sector: t.sector, usd, price: px });
        }

        const lastBlock = seen.get(vault.toLowerCase());
        const hoursIdle = lastBlock && head
          ? ((head - lastBlock) * secondsPerBlock) / 3600
          : null;

        // A desk is stale when it holds something and has not acted in a day.
        // Flat and idle is not stale, it is just flat.
        const st = positions.length
          ? (hoursIdle !== null && hoursIdle > STALE_HOURS ? "stale" : "pos")
          : (hoursIdle !== null && hoursIdle < 1 ? "research" : "flat");

        desks.push({
          vault, owner: addrOf(word(ownerRaw, 0)), agent: addrOf(word(agentRaw, 0)),
          mandate, sectors: [...new Set(allowed.map((t) => t.sector))],
          bookUsd, positions, st, hoursIdle,
        });
      } catch { /* a desk we cannot read is left off rather than shown as empty */ }
    }
    return { configured: true, desks, note: "" };
  };
})();
