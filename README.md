# Market data recorder (Fyers free API)

Records live NSE market data to disk so that spread, imbalance and depth rules can later be
backtested against real order-book history. No broker gives you that history retroactively.
It also downloads historical candles, which most indicators (ATR, EMA, RSI, ADX, ...) are
computed from.

| Stream | Source | Contents |
|---|---|---|
| `quotes` | data socket | LTP, last qty, volume, session VWAP, total buy/sell qty, best bid/ask, OHLC; index values |
| `depth5` | data socket | 5 bid + 5 ask levels: price, qty, order count |
| `depth50` | tick-by-tick socket | 50 bid + 50 ask levels, rebuilt from snapshot + diffs, with exchange timestamp and sequence no. |
| `events` | recorder | connects, errors, subscribe acks, one health line per minute |

Free (Standard) plan limits: **100 symbols** on the data socket and **1 symbol** on the
tick-by-tick socket. The default [watchlist](config/watchlist.json) uses 15 + 1.

## One-time setup

1. You need a Fyers trading account (API access is for clients only).
2. Create an API app at <https://myapi.fyers.in/dashboard>. Set any redirect URL, e.g.
   `https://127.0.0.1/`; nothing has to be listening there.
3. `cp .env.example .env` and fill in the app ID, secret key and the same redirect URL.
4. `npm install`

## Each trading day

Fyers access tokens last one day, so log in each morning before 09:15 IST:

```bash
npm run login
```

It prints a Fyers login URL. Open it, log in yourself, then paste back the URL your browser
was redirected to. The token is saved to `.secrets/fyers-token.json` (owner-read-only, gitignored).

```bash
npm run record
```

Stops on its own at 15:35 IST. Options: `--until 15:30`, `--until none`, `--no-tbt`,
`--watchlist path.json`, `--data dir`. It prints a per-minute health line and names any
symbol that has gone silent for more than 2 minutes during market hours.

If the data socket stays silent for 3 minutes in market hours, the recorder exits with code 2
instead of hanging. To restart it automatically:

```bash
until npm run record; do sleep 5; done
```

## Historical candles

```bash
npm run history
```

Downloads 1-minute and daily candles for every watchlist symbol into
`data/candles/<resolution>/<symbol>.csv` (columns `t,ist,open,high,low,close,volume,oi`;
`t` is the candle start in epoch seconds). The first run fetches as far back as the free plan
allows, 1 year intraday and 5 years daily: about 150 requests, 4 minutes for the default
watchlist. Later runs only fetch what is new since the last stored candle, so run it once a
day, any time after 15:45 IST.

Options: `--res 1m,5m,15m,D`, `--days 30` (lookback when nothing is stored yet),
`--symbols NSE:SBIN-EQ,NSE:TCS-EQ`, `--dry-run` (shows the request count and time, no login needed).

It only stores completed candles. A candle still forming when you run it is fetched on the next run.

**Rate limits.** Fyers' free plan allows 50 history requests a minute and 5,000 a day, and
**blocks your account for the rest of the day if you exceed the per-minute limit more than 3
times**. The fetcher stays at 40 a minute. If Fyers rate-limits it anyway, it waits once, and
on a second hit it stops rather than risk the block. Stored candles are kept, and rerunning it
later picks up where it stopped. Runs that would need more than 4,500 requests are refused
up front.

Compute indicators from these candles, not from the live recording: once-a-second snapshots
miss highs and lows between snapshots, which makes ATR and Bollinger Bands read low.

## Live dashboard

```bash
npm run dashboard
```

Then open <http://localhost:4000>. It lists the stocks in
[config/dashboard.json](config/dashboard.json); pick one to see its real-time RVOL (relative
volume), the volume so far against the usual volume by this time of day, and a chart of both
through the session. Values update on every quote from the Fyers WebSocket.

On start it brings each stock's 1-minute candles up to date (one request per stock once history
is stored) and builds the baseline: the average cumulative volume at each minute over the last
20 full sessions. RVOL = today's volume so far / that average at the current time.

- Needs a valid token (`npm run login`), like the recorder. Running it at the same time as the
  recorder has not been tried yet; both together stay well under the 100-symbol limit.
- Outside market hours it shows the last session's final values and says so.
- Live volume comes from the feed's day total, which includes pre-open and post-close trades
  that the 1-minute candles leave out. That makes RVOL read a little high: about 2% at the end
  of the day, more in the first minutes after the open.
- The server listens on localhost only. `--port 4001` changes the port.

### Order flow and pressure (estimated)

The dashboard's "Order Flow & Pressure" section shows sell and buy volume share, how each has
changed over the last two 15-minute windows, and CVD with its trend.

**These are estimates.** Fyers has no trade-by-trade feed, so there is no record of which side
started each trade. The data socket sends a snapshot when something changes (measured live:
0.3 to 2.3 a second per stock), and nearly all volume arrives as several trades per snapshot.
The volume between two snapshots therefore gets one label ([src/lib/orderFlow.js](src/lib/orderFlow.js)):

- last price at or above the previous ask, or above the midpoint: buying;
- at or below the previous bid, or below the midpoint: selling;
- exactly at the midpoint, or no usable quote: the direction of the price change (tick rule);
- otherwise unclassified, which is counted and shown but never assigned to a side.

Candle colour is never used. Volume across a reconnect, a restart, or the session open is
left unclassified, and a window that includes such a break is withheld rather than shown.

- Windows are completed 5-minute candles: the last three against the three before.
- CVD resets each session and only covers the time the server was running. The per-minute
  totals are saved to `data/flow/<date>/` every minute, so a restart keeps the day's CVD. The whole-book ask / bid quantity
  samples are saved in the same files, so those trends also continue after a restart.
- The first share needs 15 minutes of live data; changes and the CVD trend need 30.
- Window lengths and thresholds are in `DEFAULT_FLOW_CONFIG`.

Two exact companions sit beside it: **recent RVOL** (the last 15 minutes of volume against the
usual for those minutes, from candles) and the **ask / bid quantity trend** (whole-book
quantity, last 15 minutes against the 15 before).

Nothing in this section places or suggests a trade.

## Calculating the metrics

```bash
npm run metrics
```

Prints the Phase 1-3 metrics for every watchlist symbol and writes all values to
`data/metrics/latest.json`. Indicators run on 5-minute candles built from the stored 1-minute
candles (`--tf 15` for another timeframe) and use completed candles only.

- **Market (Phase 1):** ATR, relative ATR, EMA slope %, ROC, RSI, ADX with +DI/-DI, India VIX,
  sector strength vs Nifty, a regime label, and breadth across the watchlist stocks.
- **Stock selection (Phase 2):** RVOL by time of day, ATR %, relative ATR, average traded value,
  strength vs Nifty and vs sector, correlation with Nifty, spread %, order-book imbalance.
- **Entry and levels (Phase 3, 6):** EMA, RSI, ROC, MACD, VWAP and deviation in ATRs, Bollinger
  Bands, pivots, swing support/resistance, volume profile (POC/VAH/VAL), Chandelier exit levels.

Spread and order-book columns come from the latest recording and stay empty unless it was made
during market hours. Stock-to-sector mapping is in [config/sectors.json](config/sectors.json).

The maths lives in two libraries you can import from your own strategy code:

- [src/lib/indicators.js](src/lib/indicators.js): every indicator above, plus anchored VWAP.
- [src/lib/risk.js](src/lib/risk.js): position sizing, ATR stops, reward:risk, R-multiple,
  MFE/MAE, and a trade-list summary (win rate, expectancy, profit factor, max drawdown,
  Sharpe/Sortino per trade, streaks). These need trades, so nothing prints them yet.

All periods (EMA 20, RSI 14, ATR 14, ...) and the regime thresholds (ADX 25, relative ATR
0.7/1.3) are conventional defaults, not tested settings. Volume profile is an approximation
from candles, and breadth covers only the watchlist, not the whole market.

## Looking at the data

```bash
npm run peek -- depth5 --sym NSE:SBIN-EQ --n 3
```

Prints per-symbol counts, first/last time, and the last few records for today (or `--date YYYY-MM-DD`).

Files are `data/<IST date>/<stream>-<HHMMSS>.ndjson.gz`, one JSON object per line. A new
part starts each time the recorder starts, so a crash can only cut short the part that was
open, and that part stays readable up to its last flush (every 3 seconds).

### Record fields

All times are epoch milliseconds. `recv` is when this machine received the message; `exch` is
the exchange/feed timestamp where Fyers provides one.

- `q` stock quote: `sym recv exch ltt ltp ltq vol vwap tbq tsq bid ask bq aq o h l pc`
- `i` index: `sym recv exch ltp o h l pc` (indices have no order book)
- `d5`: `sym recv bids asks`, each level `[price, qty, orders]`, best first. No exchange
  timestamp: Fyers doesn't send one with 5-level depth.
- `d50`: `sym recv exch sent seq tbq tsq bids asks`, plus `snap: true` on full snapshots and
  `seqJump: true` when the sequence number is not previous + 1.

Empty levels at the far end of a thin book are trimmed, so `bids`/`asks` can be shorter than 5 or 50.

The record shapes don't depend on Fyers. A Kite or Upstox adapter that emits the same records
would leave everything downstream unchanged.

## Not yet verified against the live feed

The parsing logic is unit-tested (`npm test`), including 50-level packets encoded with Fyers'
own protobuf definitions, the TBT client against a local WebSocket server, and the history
fetcher (chunking, resume, completed-candle cut-off, rate-limit and error handling) against a
fake Fyers API. These were not
testable offline and should be checked on the first market day:

- **The end-to-end run.** Check that `npm run peek -- quotes` shows every watchlist symbol,
  and that `npm run history` fills `data/candles/` without skipped ranges.
- **Whether depth subscriptions count separately** toward the 100-symbol limit. Fyers' docs
  say a subscription over the limit stops the connection from being established, so keep
  quote + depth entries together at 100 or fewer until you've checked. The default uses 25.
- **What a `seqJump` means.** It may be lost data or just how Fyers numbers packets. Count
  them for a day before relying on them.
- **Exchange holidays** are not known to the recorder. On a holiday it records nothing, and
  the stale-data exit stays off because no market-hours data ever arrives.

## Notes

- SDK file logging is turned off everywhere. With it on, `fyers-api-v3` writes your secret key,
  auth code and access token to a plain-text log in the working directory.
- The SDK's own tick-by-tick client applies depth diffs by array position rather than by level
  number, and does not resubscribe after reconnecting. This recorder uses the SDK's protobuf
  decoder but its own client ([src/feeds/tbtClient.js](src/feeds/tbtClient.js)) for both reasons.
