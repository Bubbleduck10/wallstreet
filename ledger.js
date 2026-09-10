/* Money in and money out, for one owner, read from chain.
 *
 * Shared, because the header's profile and the desks page both answer the same
 * question and two implementations would be two answers. It builds on
 * WSBasis (pnl.js) for the windowed log scan and the word/address decoding,
 * so load that first.
 *
 * What counts as what:
 *
 *   In   — the USDG written into a vault when it was hired (the Commissioned
 *          event's `funded`), plus any USDG the owner later sent the vault
 *          directly. There is no deposit function; a top-up is a plain
 *          transfer, so it is read as one. Transfers into the vault from
 *          anywhere else are trading proceeds, not deposits, and are ignored.
 *
 *   Out  — the vault's Withdrawn events. USDG is cash and counts in dollars.
 *          A stock withdrawn is shares handed to the owner: a distribution,
 *          not a sale, so it is reported in shares and kept out of the cash
 *          total rather than being priced at a number nobody agreed to.
 */
(() => {
  const COMMISSIONED = "0xf700cd10a3db75a8f38e71c86dc6946f5f193a0e17bcaa5dab1fef3c11703a43";
  const WITHDRAWN    = "0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5";
  const TRANSFER     = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

  const forOwner = async (owner) => {
    const B = window.WSBasis;
    if (!B) throw new Error("ledger needs pnl.js");
    const W = window.WS;
    const { scan, word, big, addrOf, pad } = B;
    const usdg = (W.usdg || "").toLowerCase();
    const dec = W.usdgDecimals || 6;
    const ownerTopic = "0x" + pad(owner);

    const bySymbol = new Map(
      (window.TOKENS || []).map((t) => [t.address.toLowerCase(), t]));

    const rows = [];
    let depositsUsd = 0, withdrawnUsd = 0;

    /* ---- hires ---- */
    const hires = await scan({ address: W.factory, topics: [COMMISSIONED, null, ownerTopic] });
    const vaults = [];
    /* Commissioning moves the money with a transferFrom, so the hire and its
       funding are the same dollars seen twice — once as the event's `funded`
       and once as a plain owner-to-vault transfer in the same transaction.
       Count the event and skip the transfer, or every desk reads as double
       what it holds. */
    const hireTx = new Set();
    for (const l of hires.logs) {
      const vault = addrOf(l.topics[1]);
      vaults.push(vault);
      hireTx.add((l.transactionHash || "").toLowerCase());
      const usd = Number(big("0x" + word(l.data, 1))) / 10 ** dec;
      depositsUsd += usd;
      rows.push({ kind: "hire", vault, usd, qty: null, symbol: "USDG",
                  block: parseInt(l.blockNumber, 16) || 0, hash: l.transactionHash });
    }

    if (!vaults.length)
      return { vaults, rows, depositsUsd, withdrawnUsd, netUsd: 0, head: hires.head };

    /* ---- later top-ups: USDG the owner sent a vault directly ---- */
    const tops = await scan({ address: W.usdg, topics: [TRANSFER, ownerTopic] });
    const mine = new Set(vaults);
    for (const l of tops.logs) {
      const to = addrOf(l.topics[2]);
      if (!mine.has(to)) continue;
      if (hireTx.has((l.transactionHash || "").toLowerCase())) continue;   // already counted as the hire
      const usd = Number(big("0x" + word(l.data, 0))) / 10 ** dec;
      if (!(usd > 0)) continue;
      depositsUsd += usd;
      rows.push({ kind: "deposit", vault: to, usd, qty: null, symbol: "USDG",
                  block: parseInt(l.blockNumber, 16) || 0, hash: l.transactionHash });
    }

    /* ---- withdrawals ---- */
    const outs = await scan({ address: vaults, topics: [WITHDRAWN] });
    for (const l of outs.logs) {
      const vault = (l.address || "").toLowerCase();
      const token = addrOf(l.topics[1]);
      const raw = big("0x" + word(l.data, 0));
      if (token === usdg) {
        const usd = Number(raw) / 10 ** dec;
        withdrawnUsd += usd;
        rows.push({ kind: "withdrawal", vault, usd, qty: null, symbol: "USDG",
                    block: parseInt(l.blockNumber, 16) || 0, hash: l.transactionHash });
      } else {
        const tok = bySymbol.get(token);
        rows.push({ kind: "distribution", vault, usd: null,
                    qty: Number(raw) / 10 ** ((tok && tok.decimals) || 18),
                    symbol: (tok && tok.symbol) || token.slice(0, 8) + "…",
                    block: parseInt(l.blockNumber, 16) || 0, hash: l.transactionHash });
      }
    }

    rows.sort((a, b) => b.block - a.block);
    return {
      vaults, rows, depositsUsd, withdrawnUsd,
      netUsd: withdrawnUsd - depositsUsd,
      head: hires.head,
    };
  };

  window.WSLedger = { forOwner };
})();
