# Phase 2: Stock selection scanner (Fyers API)

Finds the Nifty 100 stocks worth watching for intraday trading, using the rules in `../Strategy`.
It answers the Stock Selection Engine's question, "which stocks are worth trading today?". It
does not produce entry signals; those belong to Phase 3.

## Run it

```sh
npm run login            # once a day, from the repo root: Fyers tokens last one day
npm run scan             # from the repo root
node scan-intraday.js    # or from this folder
node --test scan-intraday.test.js
```

With no arguments:

- **Market open (from 09:30 IST):** scans today up to the last completed 5-minute bar, and also
  checks live bid-ask spread and order-book depth.
- **Otherwise:** scans the latest completed session. Today's daily candle is final from 15:45 IST.

```sh
node scan-intraday.js --date 2026-11-20              # a past session, full day
node scan-intraday.js --date 2026-11-20 --at 10:00   # that session as it stood at 10:00
node scan-intraday.js --at 11:15                     # today, up to 11:15
node scan-intraday.js --min-turnover 100 --min-rvol 2 --max-spread 0.05 --top 15
node scan-intraday.js --refresh                      # discard cached candles and refetch
```

`npm run scan -- --at 10:00` passes options through npm.

## Selection logic

A stock must pass every gate. The matches are then ranked by score.

| Gate | Default | From the notes |
|---|---|---|
| Average traded value, 20 prior sessions | ≥ ₹20 crore | "Average traded value greater than 20 Cr" |
| Daily ATR(14) as % of previous close | ≥ 1% | ATR% makes volatility comparable across stocks |
| RVOL, same time window, previous 10 sessions | ≥ 1.5 | "A good RVOL value will be usually > 1.5" |
| Bid-ask spread % (market open only) | ≤ 0.10% | 0–0.05% excellent, 0.05–0.10% very good |

Score, 0–100:

| Part | Points | Rule |
|---|---:|---|
| RVOL | up to 40 | proportional, capped at RVOL 5 |
| Relative ATR | 20 / 10 / 0 | 20 in the 1.2–2 "consider this" range; 10 for 0.8–1.2 or 2–3; otherwise 0 |
| Relative strength vs Nifty 50 | up to 25 | size of the out- or under-performance, capped at 3 points |
| Spread | 15 / 10 / 0 | ≤ 0.05% / ≤ 0.10% / wider or not checked |

Also reported for each stock, without affecting the gates: gap %, change from open, relative
strength vs same-industry peers, and a **bias** (*long* when the day change, change from open and
strength vs Nifty are all positive; *short* when all negative; otherwise *mixed*). For the top
matches in a live scan the order book is summarised: top-5 bid and ask value, total buy and sell
quantity, and imbalance.

Definitions:

- **RVOL** = volume from 09:15 to the cutoff ÷ average volume over the same window on the previous
  10 sessions. A full-day scan compares full-day volumes.
- **Relative ATR** = this session's true range for that window (including the gap from the previous
  close) ÷ the average of the same over up to 20 prior sessions.
- **Traded value** = mean of close × volume. Fyers candles do not carry rupee turnover.
- Sessions with under 20% of typical volume, such as Muhurat trading, are left out of baselines.

The thresholds and score weights are starting values and have not been backtested.

## Output

Written to `scan-results/`, overwritten by each run:

- `result.md`: the readable report, with matches, near misses and limitations.
- `scan.csv`: every evaluated stock, with all metrics and the reason for any rejection.
- `scan.json`: the same in full, plus settings and individual data errors.
- `nifty100.csv`: the constituent list used.

A copy of each run is kept in `scan-results/runs/<date>_<HHMM>/`. Candles are cached in
`scan-results/cache/`, separate from the recorder's `data/candles`, so reruns only fetch what is new.

## Fyers limits

The Standard plan allows 50 requests a minute, and repeated overages can block the account for the
day. The scanner paces itself at 40 a minute and remembers its recent requests between runs. The
first full-day scan makes about 100 requests (roughly 3 minutes); the first intraday scan of a day
makes about 200 (roughly 5 minutes). Cached reruns of a completed session take seconds. Avoid running
`npm run history` at the same moment, since both draw on the same allowance.

## What it does not check

- Spread and depth outside market hours. Matches from a closed-market scan are provisional on both.
- Volume profile, news or catalysts, and broker intraday eligibility.
- Sector strength against a sector index; it uses Nifty 100 industry peers instead.
- Past dates use today's Nifty 100 list, so this is not a survivorship-free backtest.
