# Architecture of a Systematic Intraday Trading Engine

A systematic intraday trading engine can be divided into seven
independent modules. The first six cover the trading lifecycle; the
seventh closes the feedback loop through post-trade analysis.

## 1. Market Analysis Engine --- What kind of market are we trading?

Understand the overall market environment before selecting stocks.

-   Market regime: trending, ranging, or volatile.
-   Nifty 50 / Bank Nifty direction.
-   Sector strength and weakness.
-   Market breadth.
-   Overall volatility.

**Key question:** What kind of market are we trading today?

## 2. Stock Selection Engine --- What should we trade?

Identify stocks that offer suitable trading opportunities.

-   Liquidity and trading volume.
-   Volatility and Average True Range (ATR).
-   Relative strength and weakness.
-   Sector performance.
-   Gap-up / gap-down.
-   Unusual volume.

**Key question:** Which stocks are worth trading today?

## 3. Strategy and Entry Engine --- When should we trade?

Identify a high-quality entry opportunity and select the appropriate
strategy.

-   Support and resistance.
-   Breakouts and breakdowns.
-   Pullbacks.
-   RSI and EMA.
-   Order-book imbalance.
-   Buying and selling pressure.
-   Entry confirmation.
-   Strategy selection: momentum or mean reversion.

**Key question:** Is this the right moment to enter, and which strategy
fits the current conditions?

## 4. Risk Management Engine --- How much should we risk?

Determine the financial risk before placing an order.

-   Position sizing.
-   Stop-loss calculation.
-   Risk-to-reward ratio.
-   Maximum capital exposure.
-   Maximum daily loss.
-   Correlated positions.

**Key question:** How much can we lose if this trade goes wrong?

## 5. Execution Engine --- How should we execute the trade?

Convert the trading decision into actual market orders.

-   Market vs. limit orders.
-   Bid-ask spread.
-   Slippage.
-   Partial fills.
-   Order-book depth.
-   Execution latency.
-   Broker API failures.
-   Order-state monitoring and reconciliation.

**Key question:** How do we execute this trade efficiently and reliably?

## 6. Exit Engine --- When should we close the position?

Determine when and how to close an open position.

-   Stop-loss execution.
-   Target-based exit.
-   Trailing stop-loss.
-   Momentum weakening.
-   Reversal signals.
-   Time-based exit.
-   End-of-day square-off.

**Key question:** When should we stop holding this position?

## 7. Performance and Analytics Engine --- How do we improve?

Analyze every completed trade and evaluate whether the strategy is
performing as expected.

Record and analyze:

-   Entry price vs. expected entry price.
-   Exit price vs. expected exit price.
-   Slippage and brokerage.
-   Maximum favourable excursion (MFE).
-   Maximum adverse excursion (MAE).
-   Whether the trade followed the strategy rules.
-   Why the trade succeeded or failed.

Use this data to evaluate strategies, identify execution problems, and
improve the system. Avoid changing strategy rules based on a small
number of trades; use sufficiently large samples and out-of-sample
testing.

**Key question:** Is the system performing as designed, and what
evidence supports changing it?

------------------------------------------------------------------------

## System Architecture

``` text
┌──────────────────────────────────────┐
│ 1. Market Analysis Engine            │
│ Regime, volatility, breadth, sectors │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 2. Stock Selection Engine            │
│ Liquidity, volatility, relative      │
│ strength, volume                     │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 3. Strategy & Entry Engine           │
│ Mean reversion / momentum / signals  │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 4. Risk Management Engine            │
│ Position size, stop-loss, exposure   │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 5. Execution Engine                  │
│ Orders, fills, slippage, monitoring  │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 6. Exit Engine                       │
│ Stop, target, trailing, time exit    │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ 7. Performance & Analytics Engine    │
│ Trade journal, metrics, evaluation   │
└──────────────────┬───────────────────┘
                   │
                   └──── Feedback loop ────►
                         Improve selection,
                         strategy and execution
```

## Important Architectural Principle: Risk Management Is a Gatekeeper

Risk management should not operate only as a sequential step. It should
enforce constraints throughout the trading lifecycle.

Examples:

-   **Stock selection:** Reject candidates that would breach exposure or
    concentration limits.
-   **Entry:** Reject trades when the required stop-loss distance makes
    the position unsuitable.
-   **Execution:** Ensure submitted orders do not exceed approved
    position size or risk.
-   **Open positions:** Monitor live exposure, stop-loss status, and
    aggregate daily loss.
-   **Exit:** Enforce protective exits and emergency risk limits even if
    the strategy logic is malfunctioning.

The risk layer should be able to veto a trade and, where necessary,
trigger a protective action independently of the strategy module.

## Recommended Module Boundaries

Treat each module as an independently testable component with explicit
inputs and outputs.

  -----------------------------------------------------------------------
  Module                  Primary responsibility  Example output
  ----------------------- ----------------------- -----------------------
  Market analysis         Classify market         Regime and market-state
                          conditions              signals

  Stock selection         Rank eligible           Candidate watchlist
                          instruments             

  Strategy and entry      Generate trade          Trade signal and entry
                          opportunities           conditions

  Risk management         Approve, size, or       Approved quantity and
                          reject trades           risk limits

  Execution               Place and monitor       Order and fill states
                          orders                  

  Exit                    Decide when to close    Exit instruction
                          positions               

  Performance and         Measure outcomes        Reports and evaluation
  analytics                                       metrics
  -----------------------------------------------------------------------

This modular design makes the engine easier to backtest, simulate,
monitor, optimize, and operate live.

> **Core principle:** A trading signal is not a trade. A trade is the
> result of market context, instrument selection, strategy logic, risk
> approval, reliable execution, and controlled exit working together.
