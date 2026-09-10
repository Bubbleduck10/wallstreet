/* A short tour for a first visit, told in bubbles pinned to the thing being
 * explained.
 *
 * Rules it keeps to, because a tutorial that ignores them is worse than none:
 *
 *   It runs once. After that it is a "?" in the corner, for anyone who wants
 *   it back.
 *
 *   A step whose element is not on the page is skipped rather than pointed at
 *   nothing — pages differ, and a desk that has never traded has no trades
 *   panel to describe.
 *
 *   It never covers what it is describing: the bubble goes below the element,
 *   or above it when there is no room below.
 *
 *   Escape, the backdrop, and Skip all end it. Nothing here is worth trapping
 *   somebody in.
 */
(() => {
  const STEPS = {
    "index.html": [
      { el: "header nav .wsw", title: "Connect once",
        body: "Your wallet lives up here on every page. Connecting only reads your address — " +
              "there is nothing to sign and no transaction to approve." },
      { el: ".hero", title: "What this is",
        body: "Agents trade tokenised stocks from a vault. Each one has a mandate it cannot " +
              "trade outside of, and no way to pay anybody — including whoever built it." },
      { el: "#sectors, .sectors", title: "Sixteen sectors",
        body: "A desk is hired against a handful of these. The contract enforces it, so an " +
              "agent cannot wander into something you did not pick." },
    ],
    "floor.html": [
      { el: ".stage", title: "The floor",
        body: "Every desk that has been hired, drawn live from chain. Drag to pan, scroll to " +
              "zoom, hover a desk to see whose it is." },
      { el: "#session", title: "The session clock",
        body: "The floor dims outside market hours, and the agents slow down with it." },
    ],
    "mint.html": [
      { el: "#mandate, .sectorpick", title: "Pick a mandate",
        body: "Tick the sectors your agent may trade. This is written into the vault and can " +
              "never be changed — a new mandate means a new desk." },
      { el: "#amt", title: "Fund it",
        body: "The money goes into a vault only you can withdraw from. The agent can trade it " +
              "and nothing else: there is no function that pays anyone." },
      { el: "#gen", title: "Its key",
        body: "One signature makes the agent's key. It is derived from that signature, so it " +
              "is the same every time and there is nothing for you to keep safe." },
    ],
    "desk.html": [
      { el: "#trades, .trades", title: "Every trade, from chain",
        body: "This is read from the chain rather than from your browser, so it is the same " +
              "history whoever is looking." },
      { el: ".opts", title: "How it should trade",
        body: "You set the temperament — how much it risks, how often it looks. The agent " +
              "makes every call itself inside that." },
      { el: "#runBtn", title: "Start it",
        body: "It trades while this tab is open. Close the tab and it stops: nothing runs on a " +
              "server, and nobody else holds your key." },
      { el: ".chat", title: "Ask it why",
        body: "The agent explains its own trades. You can argue with it — you cannot order it " +
              "to trade, and it cannot be talked out of its mandate." },
    ],
    "me.html": [
      { el: "#profile, #connectRow", title: "Everything you own",
        body: "Your desks, what they hold, and what has gone in and come back out — all read " +
              "from chain." },
    ],
    "leaderboard.html": [
      { el: "table, .board", title: "Ranked on realised P&L",
        body: "Every desk on the floor, scored the same way from the same events. Open " +
              "positions are marked but do not count until they are closed." },
    ],
  };

  const page = (location.pathname.split("/").pop() || "index.html") || "index.html";
  const steps = STEPS[page] || STEPS["index.html"];
  const KEY = "ws.tour." + page;

  const CSS = `
  .wst-back { position: fixed; inset: 0; background: rgba(12,15,19,.55); z-index: 900; }
  .wst-ring { position: absolute; border: 2px solid #4ea36a; border-radius: 10px;
              box-shadow: 0 0 0 9999px rgba(12,15,19,.55); pointer-events: none;
              transition: all .22s ease; }
  .wst-bub { position: absolute; z-index: 902; width: 310px; max-width: calc(100vw - 28px);
             background: #232a31; color: #e8e4dc; border: 1px solid #3d474f; border-radius: 11px;
             padding: 15px 17px 14px; box-shadow: 0 20px 46px rgba(0,0,0,.5);
             font: 14px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif; }
  .wst-bub h5 { margin: 0 0 6px; font: 600 15px/1.3 inherit; }
  .wst-bub p { margin: 0; color: #b9c1c9; font-size: 13.5px; }
  .wst-row { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .wst-row .of { font: 11.5px/1 ui-monospace, Menlo, Consolas, monospace; color: #8c96a1;
                 margin-right: auto; }
  .wst-bub button { font: 500 13px/1 inherit; height: 32px; padding: 0 13px; border-radius: 7px;
                    cursor: pointer; border: 1px solid #3d474f; background: #262d35; color: #e8e4dc; }
  .wst-bub button.go { background: #d9cdb8; color: #23282e; border-color: #c3b79f; font-weight: 600; }
  .wst-bub button.skip { border: 0; background: none; color: #8c96a1; padding: 0 4px; }

  .wst-ask { position: fixed; right: 18px; bottom: 18px; z-index: 60; width: 34px; height: 34px;
             border-radius: 50%; border: 1px solid #3d474f; background: #262d35; color: #e8e4dc;
             cursor: pointer; font: 600 15px/1 -apple-system, system-ui, sans-serif; }
  .wst-ask:hover { border-color: #55616c; }
  @media (prefers-reduced-motion: reduce) { .wst-ring { transition: none; } }`;

  let i = 0, back = null, ring = null, bub = null, live = [];

  const seen = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return true; } };
  const remember = () => { try { localStorage.setItem(KEY, "1"); } catch {} };

  const find = (sel) => {
    for (const s of sel.split(",")) {
      const el = document.querySelector(s.trim());
      if (el && el.getBoundingClientRect().width > 0) return el;
    }
    return null;
  };

  const end = () => {
    remember();
    for (const n of [back, ring, bub]) if (n && n.parentNode) n.remove();
    back = ring = bub = null;
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", place, true);
    document.removeEventListener("keydown", onKey);
  };

  const onKey = (e) => { if (e.key === "Escape") end(); };

  function place() {
    if (!bub || !live[i]) return;
    const el = live[i].node;
    const r = el.getBoundingClientRect();
    const pad = 6;
    ring.style.left = (r.left - pad + window.scrollX) + "px";
    ring.style.top = (r.top - pad + window.scrollY) + "px";
    ring.style.width = (r.width + pad * 2) + "px";
    ring.style.height = (r.height + pad * 2) + "px";

    const bh = bub.offsetHeight || 170, bw = bub.offsetWidth || 310;
    const below = window.innerHeight - r.bottom;
    const top = below > bh + 22 ? r.bottom + 14 : Math.max(12, r.top - bh - 14);
    let left = r.left + r.width / 2 - bw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - bw - 12));
    bub.style.top = (top + window.scrollY) + "px";
    bub.style.left = (left + window.scrollX) + "px";
  }

  function show() {
    const step = live[i];
    step.node.scrollIntoView({ block: "center", behavior: "smooth" });
    bub.innerHTML =
      "<h5>" + step.title + "</h5><p>" + step.body + "</p>" +
      '<div class="wst-row"><span class="of">' + (i + 1) + " of " + live.length + "</span>" +
      (live.length > 1 && i > 0 ? '<button type="button" data-a="back">Back</button>' : "") +
      '<button type="button" class="skip" data-a="skip">Skip</button>' +
      '<button type="button" class="go" data-a="next">' +
        (i === live.length - 1 ? "Done" : "Next") + "</button></div>";
    for (const b of bub.querySelectorAll("button")) {
      b.addEventListener("click", () => {
        const a = b.dataset.a;
        if (a === "skip") return end();
        if (a === "back") { i = Math.max(0, i - 1); return show(); }
        if (i >= live.length - 1) return end();
        i += 1; show();
      });
    }
    setTimeout(place, 60);
  }

  function start() {
    live = steps.map((s) => ({ ...s, node: find(s.el) })).filter((s) => s.node);
    if (!live.length) return;
    i = 0;
    back = document.createElement("div");
    back.className = "wst-back";
    back.addEventListener("click", end);
    ring = document.createElement("div");
    ring.className = "wst-ring";
    bub = document.createElement("div");
    bub.className = "wst-bub";
    bub.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(back, ring, bub);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    show();
  }

  const mount = () => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const ask = document.createElement("button");
    ask.className = "wst-ask";
    ask.type = "button";
    ask.textContent = "?";
    ask.title = "Show me around";
    ask.setAttribute("aria-label", "Show me around");
    ask.addEventListener("click", (e) => { e.stopPropagation(); if (!bub) start(); });
    document.body.appendChild(ask);

    /* Late enough that the page has painted what the tour points at. */
    if (!seen()) setTimeout(start, 900);
  };

  window.WSTour = { start, end, reset: () => { try { localStorage.removeItem(KEY); } catch {} } };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
