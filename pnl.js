/* Cost basis and P&L for one vault, rebuilt from its own events.

   The vault stores no cost basis — it only holds balances — so the basis has
   to be replayed from `Traded(tokenIn, tokenOut, amountIn, amountOut)` and
   `Withdrawn(token, amount)`. Weighted average cost, which is the only method
   that works without an ordering guarantee across lots.

   The distinction that matters: a Withdrawn of a *stock* is not a sale. It
   moves shares to the owner at no price, so it must reduce the position and
   its basis proportionally and book no gain. Treating it as a sale at zero
   would invent a 100% loss; ignoring it would leave basis attached to shares
   the vault no longer holds. */
(() => {
  const RPC = (window.WS && window.WS.rpc) || "https://rpc.mainnet.chain.robinhood.com";
  const USDG = (window.WS && window.WS.usdg || "").toLowerCase();
  const USDG_DEC = (window.WS && window.WS.usdgDecimals) || 6;

  // keccak256 of the event signatures, hashed with cast rather than recalled —
  // the first draft of this file had the Withdrawn topic wrong, which matches
  // nothing and fails silently.
  const TRADED    = "0x7052911c5aef4de26c5fa67840c861bc4ce10fc26d46132b6ad21c9b164465e8";
  const WITHDRAWN = "0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5";
  const TRANSFER  = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  const word = (h, i) => (h || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
  const big  = (h) => BigInt(h && h !== "0x" ? h : "0x0");
  const addrOf = (w) => "0x" + (w || "").replace(/^0x/, "").slice(24).toLowerCase();
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

  const rpc = async (method, params) => {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  };

  /* Public RPCs cap the block span, and the cap is not advertised. Walk back in
     windows and stop once a whole window comes back empty, which is as close to
     "we have reached the beginning" as this can get without an indexer. */
  const WINDOW = 200000, MAX_WINDOWS = 12;

  const collect = async (filterFor) => {
    const head = parseInt(await rpc("eth_blockNumber", []), 16);
    const logs = [];
    let quiet = 0, earliest = head;
    for (let i = 0; i < MAX_WINDOWS; i++) {
      const to = head - i * WINDOW;
      const from = Math.max(0, to - WINDOW);
      if (to <= 0) break;
      let batch = [];
      try {
        batch = await rpc("eth_getLogs", [{
          ...filterFor,
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        }]);
      } catch { /* window refused; treat as empty and keep walking */ }
      earliest = from;
      if (batch && batch.length) { logs.push(...batch); quiet = 0; }
      else if (++quiet >= 2) break;              // two empty windows in a row
      if (from === 0) break;
    }
    logs.sort((a, b) =>
      parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) ||
      parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));
    return { logs, head, earliest, complete: earliest === 0 || quiet >= 2 };
  };

  /**
   * Replay one vault's logs into lots. Pure — no network, no DOM — so both the
   * desk page and the leaderboard can share it and cannot drift apart.
   *
   * @param {Array} logs      Traded and Withdrawn logs for a single vault
   * @param {Map} byAddr      lowercase token address -> {decimals}
   * @returns {{lots:Map, realised:number, cashOut:number, trades:number, lastBlock:number}}
   */
  const replay = (logs, byAddr) => {
    const lots = new Map();
    const lotOf = (a) => {
      if (!lots.has(a)) lots.set(a, { shares: 0, cost: 0, realised: 0 });
      return lots.get(a);
    };
    let realised = 0, cashOut = 0, trades = 0, lastBlock = 0;

    for (const l of logs) {
      const t0 = (l.topics[0] || "").toLowerCase();

      if (t0 === TRADED) {
        trades += 1;
        lastBlock = Math.max(lastBlock, parseInt(l.blockNumber, 16) || 0);
        const tIn = addrOf(l.topics[1]), tOut = addrOf(l.topics[2]);
        const aIn = big("0x" + word(l.data, 0)), aOut = big("0x" + word(l.data, 1));

        if (tIn === USDG) {                                   // a buy
          const tok = byAddr.get(tOut); if (!tok) continue;
          const lot = lotOf(tOut);
          lot.cost += Number(aIn) / 10 ** USDG_DEC;
          lot.shares += Number(aOut) / 10 ** tok.decimals;
        } else if (tOut === USDG) {                           // a sell
          const tok = byAddr.get(tIn); if (!tok) continue;
          const lot = lotOf(tIn);
          const sold = Number(aIn) / 10 ** tok.decimals;
          const proceeds = Number(aOut) / 10 ** USDG_DEC;
          const avg = lot.shares > 0 ? lot.cost / lot.shares : 0;
          const basis = avg * Math.min(sold, lot.shares);
          lot.realised += proceeds - basis;
          realised += proceeds - basis;
          lot.shares = Math.max(0, lot.shares - sold);
          lot.cost = Math.max(0, lot.cost - basis);
        }
      }

      if (t0 === WITHDRAWN) {
        const token = addrOf(l.topics[1]);
        const amt = big("0x" + word(l.data, 0));
        if (token === USDG) { cashOut += Number(amt) / 10 ** USDG_DEC; continue; }
        const tok = byAddr.get(token); if (!tok) continue;
        /* Shares left at no price: reduce the position and its basis together
           so the average is unchanged. A distribution, not a disposal. */
        const out = Number(amt) / 10 ** tok.decimals;
        const lot = lotOf(token);
        const frac = lot.shares > 0 ? Math.min(1, out / lot.shares) : 0;
        lot.cost = Math.max(0, lot.cost - lot.cost * frac);
        lot.shares = Math.max(0, lot.shares - out);
      }
    }
    return { lots, realised, cashOut, trades, lastBlock };
  };
  window.WSBasis = { replay, scan: collect, addrOf, word, big, pad };

  /**
   * @param {string} vault
   * @param {Map<string,number>} marks  lowercase token address -> USD price
   * @returns {Promise<object>} lots, realised, unrealised, funding, coverage
   */
  window.loadPnl = async function loadPnl(vault, marks) {
    const v = vault.toLowerCase();
    const byAddr = new Map((window.TOKENS || []).map((t) => [t.address.toLowerCase(), t]));

    const [vaultLogs, funding] = await Promise.all([
      collect({ address: vault }),
      collect({ address: window.WS.usdg, topics: [TRANSFER, null, "0x" + pad(vault)] }),
    ]);

    const { lots, realised, cashOut: feesSeen, trades } = replay(vaultLogs.logs, byAddr);

    /* Mark the open lots. */
    const rows = [];
    let unrealised = 0, valueNow = 0, basisNow = 0;
    for (const [addr, lot] of lots) {
      if (lot.shares <= 1e-12) continue;
      const tok = byAddr.get(addr);
      const mark = marks.get(addr) || 0;
      const value = lot.shares * mark;
      const avg = lot.cost / lot.shares;
      const pl = value - lot.cost;
      unrealised += pl; valueNow += value; basisNow += lot.cost;
      rows.push({
        symbol: tok.symbol, address: addr, sector: tok.sector,
        shares: lot.shares, avg, mark, value, cost: lot.cost,
        pl, plPct: lot.cost > 0 ? (pl / lot.cost) * 100 : 0,
      });
    }
    rows.sort((a, b) => b.value - a.value);

    /* What was put in: USDG transferred to the vault, less USDG taken out. */
    let fundedIn = 0;
    for (const l of funding.logs) {
      if ((l.topics[0] || "").toLowerCase() !== TRANSFER) continue;
      fundedIn += Number(big(l.data)) / 10 ** USDG_DEC;
    }

    return {
      rows, realised, unrealised, total: realised + unrealised,
      valueNow, basisNow,
      fundedIn, cashOut: feesSeen, netFunded: fundedIn - feesSeen,
      trades,
      coverage: {
        complete: vaultLogs.complete,
        fromBlock: vaultLogs.earliest,
        head: vaultLogs.head,
      },
    };
  };
})();
