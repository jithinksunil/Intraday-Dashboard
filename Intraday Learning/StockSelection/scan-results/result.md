# Intraday Stock Selection — Scan Results

**Session:** 2026-11-23, through 15:30 IST (completed session).
**Scanned at:** 25 Nov 2026, 10:09 am IST, market closed.
**Source:** Fyers API v3 (history, quotes, depth); Nifty 100 constituents.
**Nifty 50 over the same window:** -1.75%.

Evaluated **100** of 100 stocks: **13 matches**, 0 with spread checked, 0 data errors.

This describes the stated session. Spread and depth were not checked because the market was closed, so re-check them in live trading before using a candidate.

## Filters

- Average traded value (20 prior sessions): at least ₹20 crore.
- Daily ATR(14) as % of previous close: at least 1%.
- RVOL vs the previous 10 sessions over the same window: at least 1.5×.
- Bid-ask spread: at most 0.1% (only applied when the market is open).

Ranked by score (0–100): RVOL up to 40, relative ATR in the 1.2–2 range 20, relative strength vs Nifty up to 25, tight spread up to 15.

## Matches

| Rank | Symbol | Sector | Score | Bias | Price ₹ | Traded value ₹Cr | ATR% | RVOL | Rel. ATR | Gap % | From open % | Day % | RS vs Nifty | RS vs sector | Spread % |
|---:|---|---|---:|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---|
| 1 | TCS | Information Technology | 65.4 | long | 2460.00 | 860.7 | 2.69 | 2.55× very good | 1.92 high | +1.84 | +1.65 | +3.53 | +5.27 | +2.36 | not checked |
| 2 | TATASTEEL | Metals & Mining | 65.0 | short | 163.00 | 427.3 | 2.74 | 6.74× extreme | 3.58 extreme | -2.42 | -6.16 | -8.43 | -6.68 | -7.37 | not checked |
| 3 | TORNTPHARM | Healthcare | 61.5 | long | 4763.70 | 157.3 | 1.98 | 2.06× very good | 1.75 high | +0.43 | +1.15 | +1.58 | +3.33 | +1.62 | not checked |
| 4 | SHRIRAMFIN | Financial Services | 59.5 | mixed | 995.90 | 585.4 | 2.95 | 1.81× good | 1.29 elevated | +3.90 | -1.39 | +2.46 | +4.21 | +4.90 | not checked |
| 5 | TECHM | Information Technology | 57.7 | long | 1777.50 | 422.5 | 2.58 | 1.59× good | 1.37 elevated | +0.62 | +1.17 | +1.79 | +3.54 | +0.63 | not checked |
| 6 | AMBUJACEM | Construction Materials | 50.1 | short | 391.95 | 171.3 | 2.70 | 3.49× excellent | 1.26 elevated | +0.72 | -2.72 | -2.01 | -0.26 | -0.44 | not checked |
| 7 | ADANIPOWER | Power | 40.5 | short | 207.90 | 331.3 | 2.50 | 2.39× very good | 1.79 high | +0.92 | -2.81 | -1.91 | -0.16 | -0.03 | not checked |
| 8 | JINDALSTEL | Metals & Mining | 36.7 | mixed | 1131.30 | 136.2 | 2.66 | 1.57× good | 1.00 normal | -0.20 | +0.15 | -0.05 | +1.69 | +1.10 | not checked |
| 9 | HDFCBANK | Financial Services | 35.3 | short | 817.80 | 2952.9 | 2.08 | 1.51× good | 2.58 very high | +1.06 | -4.35 | -3.33 | -1.59 | -0.98 | not checked |
| 10 | SOLARINDS | Chemicals | 34.0 | short | 18178.00 | 256.8 | 2.97 | 1.85× good | 1.03 normal | +0.00 | -2.84 | -2.84 | -1.10 | — | not checked |
| 11 | PIDILITIND | Chemicals | 28.3 | mixed | 1594.20 | 139.8 | 2.40 | 2.12× very good | 0.87 normal | +0.25 | -1.83 | -1.59 | +0.16 | — | not checked |
| 12 | ADANIENSOL | Power | 28.2 | mixed | 1470.00 | 215.0 | 2.98 | 1.98× good | 1.18 normal | +1.39 | -2.82 | -1.46 | +0.29 | +0.45 | not checked |
| 13 | JSWSTEEL | Metals & Mining | 24.0 | short | 1311.90 | 293.4 | 2.30 | 1.62× good | 1.07 normal | -0.34 | -1.55 | -1.88 | -0.13 | -0.82 | not checked |

Bias is *long* when the day change, change from open and strength vs Nifty are all positive, *short* when all are negative, otherwise *mixed*.

## Near misses (failed one filter)

| Symbol | Failed | RVOL | ATR% | Traded value ₹Cr | Day % | Spread % |
|---|---|---:|---:|---:|---:|---:|
| HCLTECH | rvol below threshold | 1.35 | 2.71 | 434.0 | +1.48 | — |
| LTM | rvol below threshold | 1.38 | 3.34 | 148.7 | +1.17 | — |
| UNIONBANK | rvol below threshold | 1.20 | 2.38 | 303.2 | -4.87 | — |
| CANBK | rvol below threshold | 0.95 | 2.49 | 363.4 | -3.72 | — |
| IOC | rvol below threshold | 0.97 | 2.23 | 196.3 | -3.65 | — |
| HINDALCO | rvol below threshold | 1.42 | 2.86 | 629.7 | -3.13 | — |
| ICICIBANK | rvol below threshold | 1.17 | 1.87 | 2529.6 | -3.32 | — |
| ADANIGREEN | rvol below threshold | 1.38 | 2.84 | 272.1 | -3.07 | — |
| APOLLOHOSP | rvol below threshold | 1.41 | 2.35 | 489.4 | +0.62 | — |
| TATAPOWER | rvol below threshold | 0.73 | 2.47 | 264.4 | -3.44 | — |

## Limitations

- Market was closed at scan time, so bid-ask spread and order-book depth are not checked. Every match is provisional on that point.
- Average traded value is mean(close x volume) over the 20 prior normal sessions, not exchange-reported turnover.
- RVOL compares volume with the previous 10 sessions over the same window (full day).
- Relative ATR here is this session's true range for that window divided by the average of the same over up to 20 prior sessions.
- Sector relative strength uses the median of same-industry Nifty 100 peers, not a sector index.
- Sessions with under 20% of typical volume (e.g. Muhurat trading) are left out of baselines.
- Volume profile, news/catalysts and broker intraday eligibility are not checked.
- Past dates use today's constituents. Thresholds and score weights are untested starting values, not a return forecast.
