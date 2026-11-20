# Phase 3: indicator calculations

Node.js 22+, no dependencies or API key. From the repository root:

```sh
node StrategyEntry/calculate-indicators.js IRFC "2026-11-11T14:00:00+05:30"
# Equivalent named arguments, with an explicit report path:
node StrategyEntry/calculate-indicators.js --symbol IRFC --at "2026-11-11T14:00:00+05:30" --out StrategyEntry/indicator-results/irfc.md
node --test StrategyEntry/calculate-indicators.test.js
```

Accepts `IRFC`, `IRFC.NS`, or `NSE:IRFC`. Use an ISO timestamp with seconds and an explicit offset (`+05:30` or `Z`). The date is interpreted in IST. At 14:00, the final usable candle is 13:55–14:00; at 14:02 it is still 13:55–14:00. Future timestamps, incomplete target-session data, and dates without a trading session fail with an error. After 15:30, the report uses the completed session and states the lag. Regular 09:15–15:30 sessions only; special sessions are unsupported.

Default output: `StrategyEntry/indicator-results/<SYMBOL>-<IST date>-<IST time>-IST.md`, plus a JSON report and a matching `-raw/` directory containing the actual provider responses. Repeating the same output path replaces those artifacts.

## Calculation choices

All intraday indicators are **session-seeded**, beginning with the 09:15 candle. This is an explicit definition, not a claim that the numbers match a chart using earlier sessions. The IRFC provider response contained missing previous-session intraday candles, so this script does not depend on those incomplete histories. Previous-session daily OHLC is used only for pivots. No missing candles or volumes are filled.

| Indicator | Calculation |
| --- | --- |
| VWAP | Sum of `(high + low + close) / 3 × volume`, divided by cumulative session volume. Candle approximation, not tick VWAP. |
| VWAP deviation | Last completed close minus VWAP, in rupees; also percent relative to VWAP. |
| Normalized VWAP deviation | `(close − VWAP) / ATR(14)` using 5-minute candles. Null if ATR is unavailable or zero. |
| RSI(14) | Wilder-smoothed gains and losses; initial averages use the first 14 close changes. Flat prices map to 50; gains only to 100; losses only to 0. |
| ROC(9) | `(close / close 9 completed bars earlier − 1) × 100`. |
| EMA(20) and slope | SMA of first 20 closes seeds EMA; alpha `2 / 21`. Slope is `(current EMA / previous EMA − 1) × 100`, over one bar. |
| ATR(14) | Wilder smoothing of true ranges starting at the second session candle; no overnight gap. |
| Support/resistance | Strict 5-candle swings, requiring 2 closed candles on both sides within the current session. Cluster confirmed swing prices within a total width of `0.2 × current ATR`. At least 2 swing observations per zone. Below the latest close means support, above means resistance, and overlapping means at price. |
| Pivot points | Traditional P, S1–S3 and R1–R3 from the previous available daily session. `S1 = 2P − previous high`; the division symbol in the handwritten transcription is not used. |
| Order book imbalance | `(sum bid quantity − sum ask quantity) / (sum bid quantity + sum ask quantity)` over equal numbers of nearest levels, up to 5 per side. Range −1 to +1. |

ROC needs 10 completed session bars; RSI/ATR need 15, EMA needs 20, and EMA slope needs 21. Before then, the affected results are `null` / unavailable. Support/resistance may have no qualifying zones even with enough data. Two swing observations are a mechanical clustering rule, not proof that a level will hold.

## Optional historical order book

OHLCV cannot establish order book imbalance. A symbol and historical time alone do not supply historical depth. Record a broker depth snapshot separately, then pass `--book path/to/depth.json`. Do not substitute a current snapshot for a historical timestamp.

The input must contain `symbol`, `timestamp`, `bids`, and `asks`. Each level has a positive numeric `price` and nonnegative integer `quantity`; zero-price broker padding must be removed. The snapshot must match the symbol, must be at or before the requested timestamp, and must be no more than 60 seconds old. The output records its age and the levels used. Locked/crossed books and duplicate price levels are rejected.

This **synthetic schema example is not IRFC market data**:

```json
{
  "symbol": "IRFC",
  "timestamp": "2026-11-11T14:00:00+05:30",
  "source": "Synthetic schema example; replace with a recorded broker snapshot",
  "bids": [{ "price": 99, "quantity": 300 }],
  "asks": [{ "price": 101, "quantity": 100 }]
}
```

Without a snapshot, the report marks imbalance unavailable and still calculates candle-based indicators. The synthetic depth tests verify the formula; the sample IRFC report contains no fabricated depth.

## Offline reproduction

Saved provider responses can reproduce the candle calculations without network access:

```sh
node StrategyEntry/calculate-indicators.js IRFC "2026-11-11T14:00:00+05:30" \
  --intraday-json StrategyEntry/indicator-results/IRFC-2026-11-11-140000-IST-raw/5m.json \
  --daily-json StrategyEntry/indicator-results/IRFC-2026-11-11-140000-IST-raw/1d.json \
  --out /tmp/irfc-replay.md
```

Yahoo's chart API is unofficial; availability and intraday retention are limited. The script fails if the requested candles are unavailable rather than switching dates. Values use data retrieved now, which may include later revisions or corporate-action adjustments. Excluding future candles prevents candle lookahead but does not reconstruct the exact feed originally seen at that time. The report calculates indicators only; it does not implement entry confirmation, risk checks, or execution.

Formula references: [VWAP](https://www.tradingview.com/support/solutions/43000502018-volume-weighted-average-price-vwap/), [RSI](https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/), [ROC](https://www.tradingview.com/support/solutions/43000502343-rate-of-change-roc/), [traditional pivots](https://www.tradingview.com/support/solutions/43000521824-pivot-points-standard/). [Kite market quotes](https://kite.trade/docs/connect/v3/market-quotes/) documents bid/ask depth quantities; its [historical candle API](https://kite.trade/docs/connect/v3/historical/) returns candle fields, not a historical depth snapshot.
