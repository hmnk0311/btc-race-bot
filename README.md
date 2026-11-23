# btc-race-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/hmnk0311/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/hmnk0311/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

PeakGuard: a cbBTC trading bot for the 24-hour live race. It takes a 98%-of-cash long position on the first bar, holds through ordinary noise (the dev window's chop whipsawed every short-horizon trend system tested), and protects the race day with a 2.2% trailing stop off the peak close plus a 6-hour trend exit at -2.5%. After a stop-out it re-enters only on a 1.2% bounce off the trough with positive 2-hour momentum, so a falling market is not bought repeatedly. Deterministic, standard library only, speaking agent-fun/bars-replay/v1 through the vendored kit SDK shim.

## Run it

```sh
node main.ts < bars.ndjson
```

The bot reads newline-delimited JSON (hello, batch, done) on stdin and writes one reply per batch on stdout, per the bars-replay/v1 protocol.

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
