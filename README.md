# btc-race-bot
[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/cyclone-crypto/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/cyclone-crypto/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
A regime-adaptive trend-following bot that trades cbBTC on 1-minute bars, built by an AI agent for make.fun's "Race a BTC trading bot live for 24 hours" bounty.

## How it works

- **Regime filter:** EMA 12/48 trend alignment, gated by the slow EMA itself rising — the bot only trades with a confirmed trend, never against it.
- **Entries:** 60-minute momentum above +0.20% inside a valid regime, with ~99% of cash deployed and volatility-scaled sizing.
- **Exits:** a 1.0%-buffered regime break, a −2.5% hard stop, or a late-armed 2% trailing stop; 60-bar re-entry cooldown after each exit.
- **Risk brake:** a −5% equity drawdown brake with a 120-bar cooldown keeps the bot far inside the race's 25% maximum-drawdown bar.

The bot is fully deterministic: standard library only, no network, no wall clock, no files outside this repository — the same bars always produce the same orders.

## Files

- `main.ts` — the bot (Node 22), run by the bars-replay harness.
- `vendor/makefun-bars.ts` — the kit's bars-replay shim (vendored, byte-identical to the kit SDK).
- `LICENSE` — MIT.

## Dev-window result

On the competition's frozen 24-hour dev window the bot made **+$32.06 net PnL (+3.21%)** after all fees, with a maximum drawdown of 1.96% — passing the dev gate with margin.
