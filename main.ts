// cbBTC minute-bar racer: regime-adaptive trend following with hard risk limits.
//
// Strategy in one paragraph: stay in cash unless the tape is in a confirmed
// uptrend, then ride it with a volatility-scaled position and get out fast
// when the trend breaks. Long only, one position, no leverage. A round trip
// costs roughly 15-26 bps in fees, slippage and price impact, so entries
// demand momentum clearly larger than that cost, exits are decisive, and a
// portfolio-level drawdown brake stops trading after a bad stretch so a
// hostile window can never turn into a deep loss. Every decision is a pure
// function of the bars seen so far (float64 + - * / only, each correctly
// rounded): no clock, no randomness, no files, so two runs match exactly.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Indicator windows (bars = minutes).
const FAST_EMA = 12; // fast trend line
const SLOW_EMA = 48; // slow trend line / regime divider
const MOM_WINDOW = 60; // momentum lookback for the entry filter
const VOL_WINDOW = 60; // realised-volatility lookback
const HISTORY_BARS = 70; // bars of history before the first entry is judged

// Entry / exit thresholds. The house baselines grade the lesson plainly:
// the churners (24-76 trades) all lose to costs, the one-trade holders win.
// So v2 trades rarely and decisively: in on a confirmed trend, out only on
// a real regime break, a hard stop, or a loose trailing stop that arms late.
const MOM_MIN = 0.002; // 60-min return must exceed +0.20% to enter (cost filter)
const REGIME_BUFFER = 0.01; // exit when close falls 1.0% under the slow EMA
const HARD_STOP = 0.025; // exit when the position is worth 2.5% under its cost
const TRAIL_ARM = 0.015; // trailing stop arms once the peak gain passes +1.5%
const TRAIL_STOP = 0.02; // ...and then sells 2.0% under that peak
const EXIT_COOLDOWN = 60; // bars to wait after a sell before re-entering
const DRAWDOWN_BRAKE = 0.05; // equity 5% under its peak: flatten and cool down
const COOLDOWN_BARS = 120; // bars to sit out after the brake fires
const MAX_SLIPPAGE_BPS = 250; // fills rarely move this far in one minute

// Position sizing.
const BASE_FRACTION = 0.99; // share of cash a full-conviction entry deploys
const VOL_REFERENCE = 0.0008; // per-minute volatility the base size is tuned to
const MIN_FRACTION = 0.5; // never deploy less than this share on a signal

class Racer {
  closes: number[] = [];
  returns: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  slowTrail: number[] = []; // last 31 slow-EMA values: the regime's own slope
  lastClose: number | null = null;
  entryBar = -1;
  peakSinceEntry: number | null = null;
  equityPeak: bigint | null = null;
  cooldownUntil = -1;
  reenterAfter = -1;
  barIndex = -1;

  /** Mean absolute 1-minute return over the vol window (robust, cheap). */
  volatility(): number {
    if (this.returns.length < 10) return VOL_REFERENCE;
    let sum = 0;
    for (const r of this.returns) sum += Math.abs(r);
    return sum / this.returns.length;
  }

  /** Return over the momentum window, or null before enough history. */
  momentum(): number | null {
    if (this.closes.length <= MOM_WINDOW) return null;
    const past = this.closes[this.closes.length - 1 - MOM_WINDOW];
    if (past <= 0) return null;
    return this.closes[this.closes.length - 1] / past - 1;
  }

  /** Volatility-scaled share of cash to deploy, bounded both ways. */
  sizeFraction(): number {
    const vol = this.volatility();
    const scale = vol > 0 ? VOL_REFERENCE / vol : 1;
    const frac = BASE_FRACTION * Math.min(1, scale);
    return Math.max(MIN_FRACTION, Math.min(BASE_FRACTION, frac));
  }

  sellAll(qty: bigint): SellInput {
    this.peakSinceEntry = null;
    this.reenterAfter = this.barIndex + EXIT_COOLDOWN;
    return { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
  }

  managePosition(state: BarsState, close: number, qty: bigint, cost: bigint): (SellInput | BuyInput)[] {
    if (this.peakSinceEntry === null || close > this.peakSinceEntry) this.peakSinceEntry = close;
    const value = state.value(SYMBOL, qty);
    // Hard stop: the entry thesis was simply wrong; cut it at -2.5%.
    if (value * 1000n <= cost * 975n) return [this.sellAll(qty)];
    // Regime break: the close gives back the slow trend line, with a buffer
    // so one noisy minute cannot shake the position out.
    if (this.emaSlow !== null && close < this.emaSlow * (1 - REGIME_BUFFER)) return [this.sellAll(qty)];
    // Trailing stop: armed only after a real gain, wide enough to breathe.
    if (this.peakGainArmed(state, qty, cost) && close < this.peakSinceEntry * (1 - TRAIL_STOP)) {
      return [this.sellAll(qty)];
    }
    return [];
  }

  /** True once the position's peak value passed cost by TRAIL_ARM. */
  peakGainArmed(state: BarsState, qty: bigint, cost: bigint): boolean {
    if (this.peakSinceEntry === null) return false;
    const peakValue = state.value(SYMBOL, qty, BigInt(Math.round(this.peakSinceEntry)));
    return peakValue * 1000n >= cost * BigInt(Math.round((1 + TRAIL_ARM) * 1000));
  }

  maybeEnter(state: BarsState, close: number): (SellInput | BuyInput)[] {
    if (this.closes.length <= HISTORY_BARS) return []; // not enough history yet
    if (this.barIndex < this.reenterAfter) return []; // post-exit cooldown
    const mom = this.momentum();
    if (mom === null) return [];
    const trendUp = this.emaFast !== null && this.emaSlow !== null && this.emaFast > this.emaSlow && close > this.emaSlow;
    // Regime quality: the slow line itself must be rising over the last
    // 30 bars. Counter-rallies inside a downtrend lift the fast line and
    // momentum, but rarely the slow line's slope; this one check cut the
    // loss on a mirrored downtrend window by more than half in testing.
    const regimeRising = this.slowTrail.length >= 31 && this.emaSlow !== null && this.emaSlow > this.slowTrail[0];
    if (!(trendUp && regimeRising && mom > MOM_MIN)) return [];
    let notional = BigInt(Math.floor(Number(state.cash) * this.sizeFraction()));
    const room = state.weightRoom(SYMBOL);
    if (notional > room) notional = room;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const floor = minNotional > 1_000_000n ? minNotional : 1_000_000n;
    if (notional < floor) return [];
    this.entryBar = this.barIndex;
    this.peakSinceEntry = close;
    const order: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [order];
  }

  onBatch(state: BarsState, batch: Batch): (SellInput | BuyInput)[] {
    // Fold this batch's bar into the indicators first (warm-up bars included,
    // like the house baselines do): history must be complete before any call.
    let close: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== SYMBOL) continue;
      close = Number(bar.c);
    }
    if (close === null) return [];
    this.barIndex += 1;
    if (this.lastClose !== null && this.lastClose > 0) {
      this.returns.push(close / this.lastClose - 1);
      if (this.returns.length > VOL_WINDOW) this.returns.shift();
    }
    this.lastClose = close;
    this.closes.push(close);
    if (this.closes.length > HISTORY_BARS + 2) this.closes.shift();
    const kf = 2 / (FAST_EMA + 1);
    const ks = 2 / (SLOW_EMA + 1);
    this.emaFast = this.emaFast === null ? close : this.emaFast + kf * (close - this.emaFast);
    this.emaSlow = this.emaSlow === null ? close : this.emaSlow + ks * (close - this.emaSlow);
    this.slowTrail.push(this.emaSlow);
    if (this.slowTrail.length > 31) this.slowTrail.shift();

    if (state.warmingUp) return [];

    // Portfolio drawdown brake: track the equity peak every bar.
    if (this.equityPeak === null || state.equity > this.equityPeak) this.equityPeak = state.equity;
    let inCooldown = this.barIndex < this.cooldownUntil;
    if (!inCooldown && this.equityPeak !== null && Number(state.equity) < Number(this.equityPeak) * (1 - DRAWDOWN_BRAKE)) {
      this.cooldownUntil = this.barIndex + COOLDOWN_BARS;
      inCooldown = true;
      const heldNow = state.positions.get(SYMBOL);
      if (heldNow !== undefined && heldNow.qty > 0n) return [this.sellAll(heldNow.qty)];
      return [];
    }

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) return this.managePosition(state, close, held.qty, held.cost);
    if (inCooldown) return [];
    return this.maybeEnter(state, close);
  }
}

const racer = new Racer();

await runBars({
  onBatch(state, batch) {
    return racer.onBatch(state, batch);
  },
});
