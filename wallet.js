/* One wallet connection for the whole site.
 *
 * Every page carries this, so connecting happens once and every page that
 * needs an address already has one — hiring a desk no longer opens with a
 * connect step, and a returning visitor is simply connected.
 *
 * It brings its own styling rather than borrowing the page's, because the
 * floor is drawn on a light palette and everything else is dark, and a
 * component that reads whichever variables happen to be defined would be
 * illegible on one of them.
 *
 * Reconnecting is silent: eth_accounts asks the wallet what it has already
 * authorised and never prompts. The prompt only ever follows a click.
 */
(() => {
  const LINKED = "ws.wallet.linked";
  const $ = (s, r) => (r || document).querySelector(s);

  let address = null;
  let menuOpen = false;
  let ledgerFor = null;                       // address the panel's figures are for

  /* ---- styling, scoped so it cannot leak into a page ---- */
  const CSS = `
  .wsw { position: relative; display: inline-flex; align-items: center; font-family:
         -apple-system, "Segoe UI", system-ui, sans-serif; }
  .wsw button { font: 500 13px/1 inherit; height: 34px; padding: 0 13px; border-radius: 7px;
                cursor: pointer; border: 1px solid #3d474f; background: #262d35; color: #e8e4dc; }
  .wsw button:hover { border-color: #55616c; }
  .wsw button:disabled { opacity: .5; cursor: not-allowed; }
  .wsw .pill { display: inline-flex; align-items: center; gap: 8px; }
  .wsw .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .wsw .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }

  .wsw .panel { position: absolute; top: 42px; right: 0; width: 292px; z-index: 90;
                background: #232a31; border: 1px solid #3d474f; border-radius: 11px;
                padding: 15px 16px; box-shadow: 0 18px 44px rgba(0,0,0,.45); color: #e8e4dc; }
  .wsw .panel .who { display: flex; align-items: center; gap: 9px; }
  .wsw .panel .full { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px;
                      color: #9aa4ae; word-break: break-all; margin: 9px 0 0; line-height: 1.5; }
  .wsw .panel h4 { font: 500 11px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .08em;
                   text-transform: uppercase; color: #8c96a1; margin: 15px 0 9px; }
  .wsw .fig { display: flex; justify-content: space-between; align-items: baseline; padding: 5px 0;
              font-size: 13.5px; }
  .wsw .fig .v { font-family: ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .wsw .fig.net { border-top: 1px solid #333c45; margin-top: 5px; padding-top: 9px; }
  .wsw .up { color: #5cc07d; } .wsw .down { color: #e0836f; }
  .wsw .quiet { color: #8c96a1; font-size: 12.5px; line-height: 1.5; margin: 4px 0 0; }
  .wsw .links { display: flex; flex-direction: column; gap: 2px; margin-top: 13px;
                border-top: 1px solid #333c45; padding-top: 11px; }
  .wsw .links a, .wsw .links button.plain {
      font-size: 13.5px; color: #e8e4dc; text-decoration: none; padding: 7px 8px; border-radius: 6px;
      background: none; border: 0; text-align: left; height: auto; cursor: pointer; }
  .wsw .links a:hover, .wsw .links button.plain:hover { background: #2b333b; }
  .wsw .links button.plain.off { color: #dd7d6b; }

  .wsw-fixed { position: fixed; top: 16px; right: 18px; z-index: 80; }
  .wsw.wsw-inline { margin-left: 16px; vertical-align: middle; margin-bottom: 10px; }

  /* The bars were sized for exactly what they held. This is the thing that
     made them too wide, so it is the thing that lets them wrap. */
  @media (max-width: 760px) {
    header .wrap, .topbar .in { flex-wrap: wrap; height: auto;
                                padding-top: 11px; padding-bottom: 11px; row-gap: 9px; }
    header nav, .topbar nav { flex-wrap: wrap; gap: 15px; row-gap: 9px; }
  }
  @media (max-width: 620px) {
    .wsw .panel { width: min(292px, calc(100vw - 30px)); right: auto;
                  left: 50%; transform: translateX(-50%); }
  }`;

  /* A colour that is always the same for the same address, so people recognise
     their own account without reading hex. */
  const hue = (a) => parseInt(a.slice(2, 8), 16) % 360;
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);
  const usd = (n) => (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString(undefined,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* ---- loading what the ledger needs, only when it is asked for ---- */
  const script = (src) => new Promise((ok, no) => {
    if ([...document.scripts].some((s) => (s.getAttribute("src") || "") === src)) return ok();
    const el = document.createElement("script");
    el.src = src; el.onload = ok; el.onerror = () => no(new Error("could not load " + src));
    document.head.appendChild(el);
  });
  const needLedger = async () => {
    if (!window.WS) await script("sectors.js");
    if (!window.WSBasis) await script("pnl.js");
    if (!window.WSLedger) await script("ledger.js");
  };

  /* ---- the widget ---- */
  const root = document.createElement("div");
  root.className = "wsw";

  const render = () => {
    root.innerHTML = address
      ? '<button type="button" class="pill" id="wswBtn" aria-haspopup="true">' +
          '<span class="dot" style="background:hsl(' + hue(address) + ' 55% 58%)"></span>' +
          '<span class="mono">' + short(address) + '</span>' +
        '</button>'
      : '<button type="button" id="wswBtn">Connect wallet</button>';
    if (menuOpen && address) root.appendChild(panel());
    $("#wswBtn", root).addEventListener("click", onButton);
  };

  const panel = () => {
    const d = document.createElement("div");
    d.className = "panel";
    d.innerHTML =
      '<div class="who">' +
        '<span class="dot" style="background:hsl(' + hue(address) + ' 55% 58%)"></span>' +
        '<b style="font-weight:600;font-size:14px">Your account</b></div>' +
      '<p class="full">' + address + '</p>' +
      '<h4>Money in and out</h4>' +
      '<div id="wswLedger"><p class="quiet">Reading from chain…</p></div>' +
      '<div class="links">' +
        '<a href="me.html">Your desks</a>' +
        '<a href="mint.html">Hire a desk</a>' +
        '<button type="button" class="plain" id="wswCopy">Copy address</button>' +
        '<button type="button" class="plain off" id="wswOff">Disconnect</button>' +
      '</div>';
    d.addEventListener("click", (e) => e.stopPropagation());
    setTimeout(() => {
      $("#wswCopy", d).addEventListener("click", async (e) => {
        try { await navigator.clipboard.writeText(address); e.target.textContent = "Copied"; }
        catch { e.target.textContent = "Could not copy"; }
      });
      $("#wswOff", d).addEventListener("click", disconnect);
      fillLedger();
    }, 0);
    return d;
  };

  /* The figures are read once per address and kept, because opening and
     closing a menu should not re-scan the chain every time. */
  let cached = null;
  async function fillLedger() {
    const box = $("#wswLedger", root);
    if (!box) return;
    if (cached && ledgerFor === address) return paintLedger(cached);
    try {
      await needLedger();
      const l = await window.WSLedger.forOwner(address);
      cached = l; ledgerFor = address;
      paintLedger(l);
    } catch (e) {
      const b = $("#wswLedger", root);
      if (b) b.innerHTML = '<p class="quiet">Could not read the chain just now.</p>';
    }
  }

  const paintLedger = (l) => {
    const box = $("#wswLedger", root);
    if (!box) return;
    if (!l.vaults.length) {
      box.innerHTML = '<p class="quiet">No desks yet. Hiring one is the first deposit — ' +
                      'the money sits in a vault only you can withdraw from.</p>';
      return;
    }
    const stock = l.rows.filter((r) => r.kind === "distribution");
    box.innerHTML =
      '<div class="fig"><span>Deposited</span><span class="v">' + usd(l.depositsUsd) + '</span></div>' +
      '<div class="fig"><span>Withdrawn</span><span class="v">' + usd(l.withdrawnUsd) + '</span></div>' +
      '<div class="fig net"><span>Net</span><span class="v ' + (l.netUsd >= 0 ? "up" : "down") + '">' +
        usd(l.netUsd) + '</span></div>' +
      (stock.length
        ? '<p class="quiet">Plus ' + stock.length + ' share withdrawal' + (stock.length > 1 ? "s" : "") +
          ' — ' + [...new Set(stock.map((r) => "$" + r.symbol))].join(", ") + '.</p>'
        : "") +
      '<p class="quiet">Across ' + l.vaults.length + ' desk' + (l.vaults.length > 1 ? "s" : "") +
      '. Net is what has come back out minus what went in — open positions are not in it.</p>';
  };

  /* ---- behaviour ---- */
  async function onButton() {
    if (address) { menuOpen = !menuOpen; render(); return; }
    await connect();
  }

  async function connect() {
    if (!window.ethereum) {
      alert("No wallet found in this browser. Install one, then reload this page.");
      return null;
    }
    const btn = $("#wswBtn", root);
    if (btn) { btn.disabled = true; btn.textContent = "Connecting…"; }
    try {
      const [a] = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (a) {
        try { localStorage.setItem(LINKED, "1"); } catch {}
        setAddress(a);
      }
      return a || null;
    } catch (e) {
      render();
      return null;
    }
  }

  function disconnect() {
    /* A wallet cannot be made to forget from a page; what this forgets is that
       the site should reconnect on its own. Say so rather than implying more. */
    try { localStorage.removeItem(LINKED); } catch {}
    menuOpen = false;
    cached = null;
    setAddress(null);
  }

  function setAddress(a) {
    const next = a ? a.toLowerCase() : null;
    if (next !== address) { cached = null; ledgerFor = null; }
    address = next;
    api.address = address;
    render();
    window.dispatchEvent(new CustomEvent("ws:wallet", { detail: { address } }));
  }

  /* ---- mount ---- */
  const mount = () => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const nav = document.querySelector("header nav, .topbar nav, nav");
    const backs = document.querySelectorAll(".back");
    if (nav) nav.appendChild(root);
    else if (backs.length) {
      /* A scene page has no nav, but it does have a row of links. Joining that
         row keeps the widget out of the way of the thing the page is for —
         floating it over the corner covered those links on a narrow screen. */
      const last = backs[backs.length - 1];
      root.classList.add("wsw-inline");
      last.parentNode.insertBefore(root, last.nextSibling);
    } else {
      const holder = document.createElement("div");
      holder.className = "wsw-fixed";
      holder.appendChild(root);
      document.body.appendChild(holder);
    }
    render();

    document.addEventListener("click", () => {
      if (!menuOpen) return;
      menuOpen = false; render();
    });
    root.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menuOpen) { menuOpen = false; render(); }
    });

    if (!window.ethereum) return;
    window.ethereum.on && window.ethereum.on("accountsChanged", (accs) => {
      setAddress(accs && accs[0] ? accs[0] : null);
    });

    /* Silent: eth_accounts returns what is already authorised and never
       prompts, so a returning visitor is simply connected. */
    let linked = false;
    try { linked = localStorage.getItem(LINKED) === "1"; } catch {}
    if (!linked) return;
    window.ethereum.request({ method: "eth_accounts" })
      .then((accs) => { if (accs && accs[0]) setAddress(accs[0]); })
      .catch(() => {});
  };

  const api = {
    address: null,
    connect,
    /** The address, connecting first if that is what it takes. */
    require: async () => address || (await connect()),
    onChange: (fn) => window.addEventListener("ws:wallet", (e) => fn(e.detail.address)),
    short,
  };
  window.WSWallet = api;

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
