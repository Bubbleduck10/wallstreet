/* The agent, in the browser.
 *
 * The premise is that the owner sets criteria and the desk trades itself. So
 * this is not a strategy file anyone has to write — it is a small decision
 * engine driven by four choices, running on a timer in the page, signing with
 * the key derived from the owner's signature.
 *
 * What it cannot do is the same as what the CLI runner cannot do, because the
 * limit is the vault and not the client: no transfer, no withdraw, no spender
 * of its choosing, nothing outside the mandate. A bug in here loses money at
 * worst. It cannot take any.
 *
 * Price history is built as it goes and kept per vault in localStorage. A desk
 * that has just started has no history, so it says so and waits rather than
 * pretending a single sample is a trend.
 */
(() => {
  const RPC = window.WS.rpc;
  const USDG = window.WS.usdg.toLowerCase();
  const UD = window.WS.usdgDecimals;

  const SEL = {
    mandate: "0x39b1b96d", agent: "0xf5ff5c76", owner: "0x8da5cb5b",
    balanceOf: "0x70a08231", slot0: "0x3850c7bd",
    open: "0x497cd0b0", close: "0x5d97ce1d",
    positionLimit: "0xb0caa891", openPositions: "0xcc35b490",
  };

  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const padN = (n) => BigInt(n).toString(16).padStart(64, "0");
  const big = (h) => BigInt(h && h !== "0x" ? h : "0x0");
  const word = (h, i) => (h || "").replace(/^0x/, "").slice(i * 64, (i + 1) * 64);
  const addrOf = (w) => "0x" + (w || "").replace(/^0x/, "").slice(24);

  const rpc = async (method, params, tries = 3) => {
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(RPC, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const t = await r.text();
        if (t.trimStart().startsWith("<")) throw new Error("RPC returned a challenge page");
        const j = JSON.parse(t);
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) {
        if (i === tries - 1) throw e;
        await new Promise((s) => setTimeout(s, 500 * (i + 1)));
      }
    }
  };
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);

  /* ---- sessions -------------------------------------------------------
     Same rule the floor and the clock use. Size is cut and the slippage
     guard widened outside regular hours, because the same order moves a
     thin book much further. */
  const SESSIONS = {
    pre:       { name: "Pre-market",   size: 0.50, slippageBps: 200n },
    regular:   { name: "Open",         size: 1.00, slippageBps: 100n },
    after:     { name: "After hours",  size: 0.40, slippageBps: 250n },
    overnight: { name: "Overnight",    size: 0.25, slippageBps: 300n },
    weekend:   { name: "Weekend",      size: 0.20, slippageBps: 400n },
  };
  const sessionNow = () => {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const d = et.getDay(), m = et.getHours() * 60 + et.getMinutes();
    if (d === 0 || d === 6) return SESSIONS.weekend;
    if (m >= 240 && m < 570) return SESSIONS.pre;
    if (m >= 570 && m < 960) return SESSIONS.regular;
    if (m >= 960 && m < 1200) return SESSIONS.after;
    return SESSIONS.overnight;
  };

  /* ---- the criteria ---------------------------------------------------
     Four choices, each one a number the engine actually uses rather than a
     label. Anything not listed here the agent does not consider. */
  const RISK = {
    careful:  { slice: 0.15, stop: -0.04, take: 0.06, minEdge: 0.020 },
    balanced: { slice: 0.25, stop: -0.06, take: 0.10, minEdge: 0.015 },
    bold:     { slice: 0.40, stop: -0.10, take: 0.18, minEdge: 0.010 },
  };
  const PACE = { slow: 30 * 60e3, steady: 10 * 60e3, quick: 3 * 60e3 };

  const DEFAULTS = { risk: "balanced", style: "momentum", pace: "steady", maxNames: 3 };

  const cfgKey = (v) => "ws.cfg." + v.toLowerCase();
  const histKey = (v) => "ws.hist." + v.toLowerCase();
  const logKey = (v) => "ws.log." + v.toLowerCase();

  const loadCfg = (v) => {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(cfgKey(v)) || "{}") }; }
    catch { return { ...DEFAULTS }; }
  };
  const saveCfg = (v, c) => { try { localStorage.setItem(cfgKey(v), JSON.stringify(c)); } catch {} };

  const loadHist = (v) => {
    try { return JSON.parse(localStorage.getItem(histKey(v)) || "{}"); } catch { return {}; }
  };
  const saveHist = (v, h) => { try { localStorage.setItem(histKey(v), JSON.stringify(h)); } catch {} };

  const readLog = (v) => {
    try { return JSON.parse(localStorage.getItem(logKey(v)) || "[]"); } catch { return []; }
  };
  const appendLog = (v, entry) => {
    const l = readLog(v);
    l.push({ t: Date.now(), ...entry });
    while (l.length > 200) l.shift();
    try { localStorage.setItem(logKey(v), JSON.stringify(l)); } catch {}
    return l;
  };

  const priceFromSlot0 = (s0, stock, dec) => {
    const sq = big("0x" + word(s0, 0));
    if (sq === 0n) return 0;
    const sp = Number(sq) / 2 ** 96, ratio = sp * sp;
    if (!isFinite(ratio) || ratio === 0) return 0;
    return (stock.toLowerCase() < USDG ? ratio : 1 / ratio) * 10 ** (dec - UD);
  };

  /** Read everything the decision needs. */
  async function readDesk(vault) {
    const [mandateRaw, cashRaw, agentRaw] = await Promise.all([
      call(vault, SEL.mandate), call(window.WS.usdg, SEL.balanceOf + pad(vault)),
      call(vault, SEL.agent),
    ]);
    const mandate = Number(big(mandateRaw));
    const allowed = window.TOKENS.filter((t) => mandate & (1 << t.sector));
    const universe = [];
    for (let i = 0; i < allowed.length; i += 5) {
      await Promise.all(allowed.slice(i, i + 5).map(async (t) => {
        let price = 0, held = 0n;
        try { price = priceFromSlot0(await call(t.pool, SEL.slot0), t.address, t.decimals); } catch {}
        try { held = big(await call(t.address, SEL.balanceOf + pad(vault))); } catch {}
        universe.push({ ...t, price, held, qty: Number(held) / 10 ** t.decimals });
      }));
    }
    universe.sort((a, b) => b.depthUsd - a.depthUsd);
    const cash = Number(big(cashRaw)) / 10 ** UD;
    const positions = universe.filter((t) => t.held > 0n);
    const book = cash + positions.reduce((s, p) => s + p.qty * p.price, 0);
    return { mandate, agent: addrOf(word(agentRaw, 0)), cash, book, universe, positions };
  }

  /** Fold this reading into the price history, and return what it can see. */
  function observe(vault, universe) {
    const h = loadHist(vault);
    const now = Date.now();
    for (const t of universe) {
      if (!t.price) continue;
      const k = t.symbol;
      h[k] = (h[k] || []).filter((p) => now - p[0] < 6 * 3600e3);
      h[k].push([now, t.price]);
      while (h[k].length > 240) h[k].shift();
    }
    saveHist(vault, h);
    return h;
  }

  /* How often prices are read, as distinct from how often the desk trades.
     Four readings a minute apart is an opinion in four minutes; four readings
     a pace apart is an opinion in forty. */
  const SAMPLE_MS = 60e3;

  /** Read the desk and fold the prices into its history. No decision, no key. */
  async function sample(vault) {
    const desk = await readDesk(vault);
    desk.vault = vault;
    return { desk, hist: observe(vault, desk.universe) };
  }

  /** How close this desk is to being able to judge anything. */
  function readiness(vault, hist) {
    const h = hist || loadHist(vault);
    const counts = Object.values(h).map((s) => s.length);
    if (!counts.length) return { ready: 0, of: 0, need: 4, enough: false };
    const ready = counts.filter((n) => n >= 4).length;
    return {
      ready, of: counts.length, need: 4, enough: ready > 0,
      most: Math.max(0, ...counts),
    };
  }

  /* A move over roughly the last half hour, and how many samples that rests
     on. Two points is not a trend, and the engine says so rather than acting
     on noise. */
  function trend(hist, symbol, windowMs = 30 * 60e3) {
    const s = hist[symbol] || [];
    if (s.length < 4) return { move: 0, samples: s.length, ready: false };
    const now = Date.now();
    const old = s.find((p) => now - p[0] <= windowMs) || s[0];
    const last = s[s.length - 1];
    if (!old || !old[1]) return { move: 0, samples: s.length, ready: false };
    return { move: (last[1] - old[1]) / old[1], samples: s.length, ready: true };
  }

  /**
   * The decision. Criteria in, one action out — or null, which is a real
   * answer and usually the right one.
   */
  function decideLocally(desk, hist, cfg, limit) {
    const r = RISK[cfg.risk] || RISK.balanced;
    const session = sessionNow();
    const reasons = [];

    // Exits first: a position that has hit its stop or its target is the most
    // urgent thing on the desk.
    for (const p of desk.positions) {
      const t = trend(hist, p.symbol, 3 * 3600e3);
      const entry = (loadCfg(desk.vault).entries || {})[p.symbol];
      const move = entry ? (p.price - entry) / entry : t.move;
      if (entry && move <= r.stop)
        return { action: "close", symbol: p.symbol, why:
          `${p.symbol} is ${(move * 100).toFixed(1)}% below where it was bought, past the ${(r.stop * 100).toFixed(0)}% stop for ${cfg.risk}.` };
      if (entry && move >= r.take)
        return { action: "close", symbol: p.symbol, why:
          `${p.symbol} is up ${(move * 100).toFixed(1)}%, at the ${(r.take * 100).toFixed(0)}% target for ${cfg.risk}.` };
    }

    const names = desk.positions.length;
    if (names >= Math.min(cfg.maxNames, limit))
      return { action: null, why: `Holding ${names} names, which is the limit set for this desk.` };
    if (desk.cash < 5)
      return { action: null, why: `Only $${desk.cash.toFixed(2)} in cash — too little to open anything worth the fee.` };

    // Entries: rank the mandate by whichever style the owner picked.
    const candidates = desk.universe
      .filter((t) => t.held === 0n && t.price > 0)
      .map((t) => ({ ...t, t: trend(hist, t.symbol) }))
      .filter((t) => t.t.ready);

    if (!candidates.length)
      return { action: null, why: "Still building price history — no name has the four readings a " +
        "trend needs yet. Prices are read every minute, so this clears in a few minutes." };

    let pick = null;
    if (cfg.style === "momentum") {
      const up = candidates.filter((c) => c.t.move >= r.minEdge).sort((a, b) => b.t.move - a.t.move);
      pick = up[0];
      if (!pick) {
        const best = candidates.slice().sort((a, b) => b.t.move - a.t.move)[0];
        reasons.push(`nothing on the mandate is up more than ${(r.minEdge * 100).toFixed(1)}% over the last half hour` +
          (best ? ` — the strongest is ${best.symbol} at ${(best.t.move * 100).toFixed(2)}%` : ""));
      }
    } else if (cfg.style === "reversion") {
      const down = candidates.filter((c) => c.t.move <= -r.minEdge).sort((a, b) => a.t.move - b.t.move);
      pick = down[0];
      if (!pick) {
        const best = candidates.slice().sort((a, b) => a.t.move - b.t.move)[0];
        reasons.push(`nothing on the mandate is down more than ${(r.minEdge * 100).toFixed(1)}% over the last half hour` +
          (best ? ` — the furthest off is ${best.symbol} at ${(best.t.move * 100).toFixed(2)}%` : ""));
      }
    } else {
      // spread: hold the deepest names the desk does not already own
      pick = candidates.sort((a, b) => b.depthUsd - a.depthUsd)[0];
    }
    if (!pick) return { action: null, why: `Nothing to do — ${reasons.join(", ")}.` };

    const usd = Math.min(desk.cash, desk.book * r.slice * session.size);
    if (usd < 5)
      return { action: null, why: `A ${cfg.risk} slice in the ${session.name.toLowerCase()} session works out at $${usd.toFixed(2)}, which is too small to be worth the fee.` };

    const why = cfg.style === "momentum"
      ? `${pick.symbol} is up ${(pick.t.move * 100).toFixed(1)}% over the last half hour, the strongest on this mandate.`
      : cfg.style === "reversion"
      ? `${pick.symbol} is down ${(pick.t.move * 100).toFixed(1)}% over the last half hour, the furthest off on this mandate.`
      : `${pick.symbol} is the deepest name on this mandate the desk does not already hold.`;

    return { action: "open", symbol: pick.symbol, usd, why:
      `${why} Buying $${usd.toFixed(2)} — a ${cfg.risk} slice, cut to ${Math.round(session.size * 100)}% for the ${session.name.toLowerCase()} session.` };
  }


  /* ---- the brain -------------------------------------------------------
     The model decides. The browser then checks the answer against the same
     facts it was given, because a model can name a ticker that is not on the
     mandate, or a size larger than the cash, and both of those should die
     here rather than at the contract. The vault would reject them anyway;
     this is the layer that explains why instead of just reverting. */
  const BRAIN = (window.WS && window.WS.brain) || "";

  const snapshot = (desk, hist, cfg, limit, session) => ({
    session: session.name,
    cash: desk.cash,
    book: desk.book,
    limit,
    criteria: { risk: cfg.risk, style: cfg.style, maxNames: cfg.maxNames },
    maxSpend: Math.min(desk.cash, desk.book * (RISK[cfg.risk] || RISK.balanced).slice * session.size),
    positions: desk.positions.map((p) => ({
      symbol: p.symbol, qty: p.qty, price: p.price, value: p.qty * p.price,
      entry: (cfg.entries || {})[p.symbol] || null,
    })),
    universe: desk.universe.filter((t) => t.price > 0).map((t) => {
      const tr = trend(hist, t.symbol);
      return {
        symbol: t.symbol, price: t.price, sectorName: window.SECTORS[t.sector].name,
        depthUsd: t.depthUsd, move: tr.move, samples: tr.samples, trendReady: tr.ready,
        held: t.qty,
      };
    }),
  });

  /** Whatever the brain says, it has to survive this. */
  const validate = (d, desk, cfg, limit) => {
    if (!d || d.action === "none" || !d.action)
      return { action: null, why: (d && d.why) || "Nothing to do this cycle." };

    const tok = desk.universe.find((t) => t.symbol === d.symbol);
    if (!tok)
      return { action: null, why: "Ignored a decision naming " + (d.symbol || "nothing") +
        ", which is not on this desk's mandate.", rejected: true };

    if (d.action === "close") {
      if (tok.held <= 0n)
        return { action: null, why: "Ignored a sell of " + d.symbol + ", which this desk does not hold.", rejected: true };
      return { action: "close", symbol: d.symbol, why: d.why, confidence: d.confidence };
    }

    if (d.action === "open") {
      if (desk.positions.length >= Math.min(cfg.maxNames, limit) && tok.held <= 0n)
        return { action: null, why: "Ignored a new position — the desk is at its limit of " +
          Math.min(cfg.maxNames, limit) + " names.", rejected: true };
      const usd = Math.min(Number(d.usdToSpend) || 0, desk.cash);
      if (!(usd > 0))
        return { action: null, why: d.why || "Nothing to do this cycle." };
      if (usd < 5)
        return { action: null, why: "A $" + usd.toFixed(2) + " position is too small to be worth the pool fee." };
      return { action: "open", symbol: d.symbol, usd, why: d.why, confidence: d.confidence };
    }
    return { action: null, why: "Ignored an unrecognised decision." };
  };

  async function decide(desk, hist, cfg, limit) {
    const session = sessionNow();
    if (!BRAIN) {
      const local = decideLocally(desk, hist, cfg, limit);
      return { ...local, source: "rules" };
    }
    try {
      const r = await fetch(BRAIN + "/decide", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ vault: desk.vault, desk: snapshot(desk, hist, cfg, limit, session) }),
      });
      const j = await r.json();
      if (j.rateLimited) return { action: null, why: j.why, source: "limit" };
      /* An error is a JSON body with a 4xx or 5xx, not a thrown exception, so
         it would otherwise reach validate() as a decision with no action and
         be reported as "nothing to do this cycle" — a desk sitting silent
         forever while something is plainly broken. */
      if (!r.ok || j.error) {
        const local = decideLocally(desk, hist, cfg, limit);
        return { ...local, source: "rules",
          why: local.why + " (The brain answered “" + (j.error || r.status) +
               "”, so this was decided locally.)" };
      }
      const checked = validate(j, desk, cfg, limit);
      return { ...checked, source: "brain", confidence: j.confidence };
    } catch (e) {
      /* A desk should keep working when the brain is unreachable. The rules
         engine is duller and it says so. */
      const local = decideLocally(desk, hist, cfg, limit);
      return { ...local, why: local.why + " (deciding locally — the brain is unreachable.)", source: "rules" };
    }
  }

  /** Ask the agent something about its own desk. */
  async function ask(vault, question, history) {
    if (!BRAIN) throw new Error("No brain is configured for this site.");
    const cfg = loadCfg(vault);
    const desk = await readDesk(vault);
    desk.vault = vault;
    const hist = loadHist(vault);
    let limit = cfg.maxNames;
    const r = await fetch(BRAIN + "/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vault,
        desk: snapshot(desk, hist, cfg, limit, sessionNow()),
        log: readLog(vault),
        history: [...(history || []), { role: "you", text: question }],
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    return j.text;
  }

  /* ---- sending --------------------------------------------------------
     The key never leaves the page, and the transaction is built and signed
     here rather than handed to a wallet: the agent is not the owner, and the
     owner's wallet must never be asked to sign a trade. */
  async function send(vault, priv, data, signer) {
    const from = signer.addressOf(priv);
    const [nonceHex, chainHex, gasPriceHex] = await Promise.all([
      rpc("eth_getTransactionCount", [from, "pending"]),
      rpc("eth_chainId", []),
      rpc("eth_gasPrice", []),
    ]);
    let gas;
    try {
      gas = big(await rpc("eth_estimateGas", [{ from, to: vault, data }]));
      gas = (gas * 13n) / 10n;
    } catch (e) {
      throw new Error("the trade would revert — " + (e.message || "estimateGas failed"));
    }
    const tip = 1n;
    const maxFee = big(gasPriceHex) * 2n + tip;
    const raw = signer.signTx({
      chainId: big(chainHex), nonce: big(nonceHex), maxPriorityFeePerGas: tip,
      maxFeePerGas: maxFee, gasLimit: gas, to: vault, value: 0n, data,
    }, priv);
    return rpc("eth_sendRawTransaction", [raw]);
  }

  const openData = (token, amountIn, minOut, fee) =>
    SEL.open + pad(token) + padN(amountIn) + padN(minOut) + padN(fee);
  const closeData = (token, amountIn, minOut, fee) =>
    SEL.close + pad(token) + padN(amountIn) + padN(minOut) + padN(fee);

  /** One cycle: look, decide, and act if there is something to do. */
  async function tick(vault, priv, signer, onEvent) {
    const cfg = loadCfg(vault);
    const desk = await readDesk(vault);
    desk.vault = vault;
    const hist = observe(vault, desk.universe);

    let limit = 3;
    try { limit = Number(big(await call(window.WS.factory, SEL.positionLimit + pad(vault)))); } catch {}
    try { limit = Math.max(limit, Number(big(await call(vault, SEL.openPositions)))); } catch {}

    const d = await decide(desk, hist, cfg, cfg.maxNames);
    onEvent({ kind: "think", why: d.why, desk, session: sessionNow().name });

    if (!d.action) { appendLog(vault, { kind: "hold", why: d.why }); return { desk, decision: d }; }

    const tok = desk.universe.find((t) => t.symbol === d.symbol);
    const session = sessionNow();
    let data, human;

    if (d.action === "open") {
      const amountIn = BigInt(Math.floor(d.usd * 10 ** UD));
      const expect = (d.usd / tok.price) * 10 ** tok.decimals;
      const minOut = BigInt(Math.floor(expect * (1 - Number(session.slippageBps) / 10000)));
      data = openData(tok.address, amountIn, minOut, tok.fee);
      human = `buy $${d.usd.toFixed(2)} of ${tok.symbol}`;
    } else {
      const amountIn = tok.held;
      const expect = tok.qty * tok.price * 10 ** UD;
      const minOut = BigInt(Math.floor(expect * (1 - Number(session.slippageBps) / 10000)));
      data = closeData(tok.address, amountIn, minOut, tok.fee);
      human = `sell all ${tok.symbol}`;
    }

    onEvent({ kind: "acting", human, why: d.why });
    const hash = await send(vault, priv, data, signer);

    // remember the entry price so the stop and target mean something
    if (d.action === "open") {
      const c = loadCfg(vault);
      c.entries = { ...(c.entries || {}), [tok.symbol]: tok.price };
      saveCfg(vault, c);
    } else {
      const c = loadCfg(vault);
      if (c.entries) { delete c.entries[tok.symbol]; saveCfg(vault, c); }
    }
    appendLog(vault, { kind: d.action, symbol: tok.symbol, human, why: d.why, hash });
    onEvent({ kind: "sent", hash, human });
    return { desk, decision: d, hash };
  }

  window.WSAgent = {
    RISK, PACE, DEFAULTS,
    loadCfg, saveCfg, readLog, appendLog, loadHist,
    readDesk, decide, decideLocally, trend, observe, sample, readiness, tick, sessionNow, ask,
    SAMPLE_MS,
  };
})();
