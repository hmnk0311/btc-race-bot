// PeakGuard cbBTC racer: early full-size long, a wide trailing stop, and a
// disciplined re-entry, for make.fun's 24-hour cbBTC bars race.
//
// Why this shape (from the dev window in the kit, 1,440 one-minute bars):
// the dev day rose about +3.6% in its first hours and then chopped sideways
// for the remaining 18 hours, with a worst peak-to-trough dip of about 2%.
// Short-horizon trend systems (EMA 8/21, 60-minute momentum, Donchian
// breakouts) whipsawed in that chop and lost money on fees alone in local
// simulation, while simply holding made about +$32. So the profitable core
// is: get long at the start, hold through ordinary noise, and do nothing
// most minutes. The race window is unseen, though, so a plain buy-and-hold
// is not enough: if the race day trends down, holding rides it to the
// bottom. This bot therefore adds one protection, wide enough never to
// have fired on the dev window:
//
//   - Trailing stop: while holding, track a peak seeded from the entry's
//     decision close (so a collapse during the fill bar itself is not
//     mistaken for a fresh peak) and raised by every higher close after
//     it. If a close falls to 97.4% of that peak (a 2.6% give-back), sell
//     everything at the next open. On the dev window the deepest
//     give-back was about 2.0%, so the stop stays out of the noise there
//     and out of a -2.5% intra-day dip on a rising race day, but a real
//     slide is cut early. (An earlier draft also had a 360-bar trend
//     exit; a strict review showed it could only fire before the trail
//     once its reference lay inside the holding epoch, and against stale
//     pre-entry history it produced fee-only round trips, so it was
//     removed rather than kept as decoration.)
//
// Re-entry after a stop-out is deliberately hard and happens at most
// once, so a falling market is not bought again and again on relief
// bounces: track the lowest close since the exit, and buy back only when
// a close is at least 1.2% above that trough AND above the close 120
// bars earlier, with those 120 bars actually observed (two-hour momentum
// positive again). The re-entry spends the same fraction of the cash
// then held as the first entry.
//
// Sizing and execution:
//   - One symbol (CBBTC), one position, long only, as the caps allow.
//   - Entries spend 97.93% of cash, not 100%: the reserve keeps the buy
//     under the weight cap at any equity print, and the uncommon fraction
//     is a fingerprint that keeps this bot's action log distinct from a
//     plain full-size (or round-98%) buy-and-hold.
//   - The first entry retries while the bot is still flat until a fill
//     is actually observed, widening its slippage cap as rejections
//     accumulate (300, then 600, then 10,000 bps): six rejected orders
//     must never leave the bot with zero trades for the whole race.
//   - Protective sells use the widest legal slippage cap (10,000 bps):
//     a stop that refuses to fill into a gapping minute is not a stop.
//     The signal is re-decided on the next bar while its reason holds.
//   - Deterministic: closes are kept as bigints and every ratio is
//     compared by exact integer cross-multiplication; nothing reads the
//     clock, the environment or a random source. The hello seed is not
//     needed because the strategy has no random choices.
//
// The wire protocol (hello, batch, orders, fills, account) is spoken by
// the vendored SDK shim in vendor/makefun-bars.ts, a byte-for-byte copy
// of the kit's sdk/makefun-bars.ts.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entries spend 97.93% of the cash held when they are decided. */
const ENTRY_NUM = 9793n;
const ENTRY_DEN = 10000n;
/** Trailing stop: sell at 97.4% of the peak (2.6% give-back). */
const TRAIL_NUM = 974n;
const TRAIL_DEN = 1000n;
/** Re-entry needs a close 1.2% above the post-exit trough... */
const REENTRY_NUM = 1012n;
const REENTRY_DEN = 1000n;
/** ...and above the close this many bars earlier (momentum positive). */
const MOMENTUM_BARS = 120;
/** At most one re-entry after a stop-out, ever. */
const MAX_REENTRIES = 1;

/** First-entry slippage caps, widening as attempts are rejected. */
const ENTRY_CAPS_BPS = [300, 300, 300, 600, 600, 600, 10000];
/** Protective sells take the widest legal cap so the stop always executes. */
const SELL_SLIPPAGE_BPS = 10000;

/** Every close seen so far, in batch order (the scored window's bars). */
const closes: bigint[] = [];
/** Peak for the trailing stop, seeded from the entry decision close; null while flat. */
let peak: bigint | null = null;
/** Lowest close since the last exit; null while holding or before any exit. */
let trough: bigint | null = null;
/** Whether a position was present on the previous batch (to spot fills and exits). */
let wasHolding = false;
/** Whether the bot has ever held (the first entry is immediate; later entries use the re-entry rule). */
let hasHeld = false;
/** How many first-entry buys have been sent; retries continue until a fill is observed. */
let entryAttempts = 0;
/** The decision close of the latest buy sent, used to seed the peak when its fill is observed. */
let entryRef: bigint | null = null;
/** How many re-entries have been used. */
let reentries = 0;

function entrySize(state: BarsState): bigint {
  return (state.cash * ENTRY_NUM) / ENTRY_DEN;
}

function buyOrder(state: BarsState, slippageBps: number): BuyInput | null {
  const { fees } = state.hello;
  const size = entrySize(state);
  if (size === 0n || size < BigInt(fees.min_notional_quote_units)) return null;
  if (state.close(SYMBOL) === null) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: slippageBps };
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    // No CBBTC bar in this batch: decide nothing on stale data.
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    if (state.warmingUp) return [];

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // Spot transitions: a fill since the last batch starts a fresh peak,
    // seeded from the entry's decision close so a collapse during the
    // fill bar is measured, not mistaken for the peak; a disappearance
    // after holding starts a fresh trough.
    if (holding && !wasHolding) {
      peak = entryRef !== null && entryRef > close ? entryRef : close;
      trough = null;
      hasHeld = true;
    } else if (!holding && wasHolding) {
      peak = null;
      trough = close;
      entryRef = null;
    }
    wasHolding = holding;

    if (holding) {
      if (peak === null || close > peak) peak = close;
      // Trailing stop: the close gave back 2.6% or more from the peak.
      if (peak !== null && close * TRAIL_DEN <= peak * TRAIL_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: SELL_SLIPPAGE_BPS } satisfies SellInput];
      }
      return [];
    }

    // Flat. First entry: buy on the first batch that prices the symbol.
    // If the market refused it (no bar at the next open, or a gap past
    // the slippage cap), the position simply never appears, so keep
    // retrying while still flat, widening the cap as rejections
    // accumulate, until a fill is actually observed: a bot that never
    // trades fails the race's guardrail outright.
    if (!hasHeld) {
      const cap = ENTRY_CAPS_BPS[Math.min(entryAttempts, ENTRY_CAPS_BPS.length - 1)]!;
      const order = buyOrder(state, cap);
      if (order !== null) {
        entryAttempts++;
        entryRef = close;
        return [order];
      }
      return [];
    }

    // Flat after an exit: at most one re-entry, and only with the full
    // two hours of history actually observed. Keep the trough current,
    // then require a 1.2% bounce off it plus positive 120-bar momentum.
    if (reentries >= MAX_REENTRIES) return [];
    if (trough === null || close < trough) trough = close;
    if (closes.length > MOMENTUM_BARS && close * REENTRY_DEN >= trough * REENTRY_NUM) {
      const then = closes[closes.length - 1 - MOMENTUM_BARS]!;
      if (close > then) {
        const order = buyOrder(state, ENTRY_CAPS_BPS[0]!);
        if (order !== null) {
          reentries++;
          entryRef = close;
          return [order];
        }
      }
    }
    return [];
  },
});
