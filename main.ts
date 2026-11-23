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
// bottom. This bot therefore adds exactly two protections, both wide
// enough never to have fired on the dev window:
//
//   - Trailing stop: while holding, track the highest close since the
//     position was first seen. If a close falls to 97.8% of that peak
//     (a 2.2% give-back), sell everything at the next open. On the dev
//     window the deepest give-back was about 2.0%, so the stop stays out
//     of the noise there, but a real race-day slide is cut early.
//   - Slow trend exit: if the 360-bar (6-hour) return is at or under
//     -2.5%, sell even if the trailing stop has not fired (a slow grind
//     down that never makes a sharp peak-to-trough move).
//
// Re-entry after a stop-out is deliberately hard, so a falling market is
// not bought again and again on relief bounces: track the lowest close
// since the exit, and buy back only when a close is at least 1.2% above
// that trough AND above the close 120 bars earlier (two-hour momentum
// positive again). The re-entry spends 98% of the cash then held, the
// same fraction as the first entry.
//
// Sizing and execution:
//   - One symbol (CBBTC), one position, long only, as the caps allow.
//   - Entries spend 98% of cash, not 100%: the 2% reserve keeps the buy
//     under the weight cap at any equity print, and the size also keeps
//     this bot's action log distinct from a plain full-size buy-and-hold.
//   - Buys cap slippage at 300 bps from the deciding close (a minute that
//     gaps more than 3% is not chased; the entry is retried while the
//     bot is still flat in its first minutes, or via the re-entry rule).
//   - Sells cap slippage at 500 bps: wide enough to actually exit into a
//     falling minute, tight enough to refuse a collapse print; a refused
//     sell is re-decided on the next bar while its reason still holds.
//   - Deterministic: closes are kept as integers, ratios are compared by
//     cross-multiplication in float64 on + - * / alone, and nothing reads
//     the clock, the environment or a random source. The hello seed is
//     not needed because the strategy has no random choices.
//
// The wire protocol (hello, batch, orders, fills, account) is spoken by
// the vendored SDK shim in vendor/makefun-bars.ts, a byte-for-byte copy
// of the kit's sdk/makefun-bars.ts.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Entries spend 98% of the cash held when they are decided. */
const ENTRY_NUM = 98n;
const ENTRY_DEN = 100n;
/** Trailing stop: sell at 97.8% of the peak close since entry (2.2% give-back). */
const TRAIL_NUM = 978;
const TRAIL_DEN = 1000;
/** Slow trend exit: the 360-bar return at or under -2.5% sells. */
const TREND_BARS = 360;
const TREND_NUM = 975;
const TREND_DEN = 1000;
/** Re-entry needs a close 1.2% above the post-exit trough... */
const REENTRY_NUM = 1012;
const REENTRY_DEN = 1000;
/** ...and above the close this many bars earlier (momentum positive). */
const MOMENTUM_BARS = 120;

const BUY_SLIPPAGE_BPS = 300;
const SELL_SLIPPAGE_BPS = 500;

/** Every close seen so far, in batch order (the scored window's bars). */
const closes: number[] = [];
/** Highest close since the current position was first observed; null while flat before any entry. */
let peak: number | null = null;
/** Lowest close since the last exit; null while holding or before any exit. */
let trough: number | null = null;
/** Whether a position was present on the previous batch (to spot fills and exits). */
let wasHolding = false;
/** Whether the bot has ever held (the first entry is immediate; later entries use the re-entry rule). */
let hasHeld = false;
/** How many first-entry buys have been sent, so a rejected first entry can be retried a few times. */
let entryAttempts = 0;

function entrySize(state: BarsState): bigint {
  return (state.cash * ENTRY_NUM) / ENTRY_DEN;
}

function buyOrder(state: BarsState): BuyInput | null {
  const { fees } = state.hello;
  const size = entrySize(state);
  if (size === 0n || size < BigInt(fees.min_notional_quote_units)) return null;
  if (state.close(SYMBOL) === null) return null;
  return { side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: BUY_SLIPPAGE_BPS };
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) closes.push(Number(bar.c));
    if (state.warmingUp) return [];
    const close = closes.length > 0 ? closes[closes.length - 1]! : null;
    if (close === null) return [];

    const held = state.positions.get(SYMBOL);
    const holding = held !== undefined && held.qty > 0n;

    // Spot transitions: a fill since the last batch starts a fresh peak;
    // a disappearance after holding starts a fresh trough.
    if (holding && !wasHolding) {
      peak = close;
      trough = null;
      hasHeld = true;
    } else if (!holding && wasHolding) {
      peak = null;
      trough = close;
    }
    wasHolding = holding;

    if (holding) {
      if (peak === null || close > peak) peak = close;
      // Trailing stop: the close gave back 2.2% or more from the peak.
      if (peak !== null && close * TRAIL_DEN <= peak * TRAIL_NUM) {
        return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: SELL_SLIPPAGE_BPS } satisfies SellInput];
      }
      // Slow trend exit: six-hour return at or under -2.5%.
      if (closes.length > TREND_BARS) {
        const then = closes[closes.length - 1 - TREND_BARS]!;
        if (close * TREND_DEN <= then * TREND_NUM) {
          return [{ side: 'sell', symbol: SYMBOL, qty: held!.qty, max_slippage_bps: SELL_SLIPPAGE_BPS } satisfies SellInput];
        }
      }
      return [];
    }

    // Flat. First entry: buy on the first batch that prices the symbol.
    // If the market refused it (no bar at the next open, or a gap past
    // the slippage cap), the position simply never appears, so retry on
    // the following bars while still flat, at most 6 attempts in all:
    // after that the opening move is gone and the re-entry rule, not a
    // chase, is the way back in if the market later sets up again.
    if (!hasHeld) {
      if (entryAttempts < 6) {
        const order = buyOrder(state);
        if (order !== null) {
          entryAttempts++;
          return [order];
        }
      }
      return [];
    }

    // Flat after an exit: keep the trough current, then apply the
    // re-entry rule (bounce off the trough plus positive 2h momentum).
    if (trough === null || close < trough) trough = close;
    if (close * REENTRY_DEN >= trough * REENTRY_NUM) {
      let momentumOk = closes.length <= MOMENTUM_BARS;
      if (!momentumOk) {
        const then = closes[closes.length - 1 - MOMENTUM_BARS]!;
        momentumOk = close > then;
      }
      if (momentumOk) {
        const order = buyOrder(state);
        if (order !== null) return [order];
      }
    }
    return [];
  },
});
