# Intraday Trading Engine --- Indicators and Metrics by Phase

A practical checklist of the indicators, market data, and metrics to use
in each phase of the trading engine. This is an initial working
document; thresholds and rules should be defined and tested later.

## 1. Market Analysis

**Status: Good coverage**

Understand the overall market environment and identify whether
conditions are trending, ranging, or unusually volatile.

  -----------------------------------------------------------------------
  Indicator / Metric                  Brief description
  ----------------------------------- -----------------------------------
  ATR (Average True Range)            Measures the magnitude of price
                                      movement and overall volatility.

  Relative ATR                        Compares current ATR with its
                                      historical level to identify
                                      unusually high or low volatility.

  EMA slope (%)                       Measures the direction and rate of
                                      change of an exponential moving
                                      average.

  ROC (Rate of Change)                Measures the percentage change in
                                      price over a selected lookback
                                      period.

  RSI (Relative Strength Index)       Measures the strength of recent
                                      upward price changes relative to
                                      downward changes.

  ADX (Average Directional Index)     Measures trend strength; use +DI
                                      and -DI alongside it to assess
                                      direction.

  Market breadth                      Measures how broadly stocks
                                      participate in a market move, for
                                      example advances versus declines.

  India VIX                           Represents the market's expected
                                      near-term volatility, derived from
                                      Nifty options.

  Sector relative strength            Compares sector performance with a
                                      broad-market benchmark to identify
                                      stronger or weaker sectors.
  -----------------------------------------------------------------------

## 2. Stock Selection

**Status: Good coverage**

Filter and rank stocks based on tradability, liquidity, volatility,
activity, and relative performance.

  -----------------------------------------------------------------------
  Indicator / Metric                  Brief description
  ----------------------------------- -----------------------------------
  RVOL (Relative Volume)              Compares current volume with
                                      historical volume for the same time
                                      of day or period.

  ATR%                                Expresses ATR as a percentage of
                                      stock price, allowing volatility
                                      comparisons across stocks.

  Relative ATR                        Identifies stocks whose current
                                      volatility is elevated or subdued
                                      versus their own history.

  Spread %                            Measures the bid-ask spread
                                      relative to the price; helps
                                      estimate transaction cost.

  Order book depth                    Shows available bid and ask
                                      quantities at different price
                                      levels.

  Average traded value                Measures the monetary value traded
                                      and helps assess liquidity.

  Relative strength vs Nifty          Identifies stocks outperforming or
                                      underperforming the broad market.

  Relative strength vs sector         Compares a stock's performance with
                                      its sector peers or sector index.

  Volume Profile                      Shows traded volume by price level;
                                      useful for locating areas of high
                                      and low historical activity.
  -----------------------------------------------------------------------

## 3. Strategy and Entry Selection

**Status: Good coverage**

Identify a valid setup, select the appropriate strategy, and determine
when entry conditions are satisfied.

  -----------------------------------------------------------------------
  Indicator / Concept                 Brief description
  ----------------------------------- -----------------------------------
  EMA                                 Smooths price data and helps
                                      identify the prevailing trend.

  EMA slope (%)                       Indicates whether the EMA trend is
                                      rising, falling, or flattening.

  ROC                                 Measures price momentum and whether
                                      it is strengthening or weakening.

  RSI                                 Measures recent momentum; should be
                                      interpreted in market context, not
                                      as an automatic buy/sell signal.

  VWAP                                Intraday volume-weighted average
                                      price; a reference for price
                                      relative to session trading
                                      activity.

  Normalized VWAP deviation           Measures distance from VWAP
                                      relative to volatility, such as
                                      distance divided by 5-minute ATR.

  VWAP reclaim / rejection            Identifies whether price regains
                                      VWAP or fails when testing it.

  Support and resistance              Price zones where buying or selling
                                      interest has previously appeared.

  Reaction strength                   Assesses how strongly price
                                      responds when it reaches a support
                                      or resistance zone.

  Pivot points                        Calculates potential intraday
                                      reference support and resistance
                                      levels from prior-period prices.

  Order book imbalance                Compares visible bid and ask
                                      quantities; an indication of
                                      displayed liquidity, not proof of
                                      actual buying or selling.

  RVOL                                Helps determine whether a price
                                      move is accompanied by unusually
                                      high trading activity.

  MACD                                Uses moving-average relationships
                                      and a histogram to help assess
                                      momentum and trend changes.

  Bollinger Bands                     Shows price relative to a moving
                                      average and volatility bands;
                                      useful for volatility
                                      contraction/expansion and some
                                      mean-reversion setups.

  Anchored VWAP                       Calculates VWAP from a selected
                                      event or price point, such as a
                                      significant high, low, or breakout.

  CVD (Cumulative Volume Delta)       Estimates cumulative aggressive
                                      buying volume minus aggressive
                                      selling volume, where trade
                                      classification data is available.

  Volume Profile levels               POC, Value Area High (VAH), and
                                      Value Area Low (VAL) identify
                                      important volume-by-price reference
                                      areas.
  -----------------------------------------------------------------------

## 4. Risk Management

**Status: Good starting point --- add the missing controls below**

Calculate position size and define risk limits before orders are sent.
Risk controls should remain active throughout the trade lifecycle.

  -----------------------------------------------------------------------
  Indicator / Metric                  Brief description
  ----------------------------------- -----------------------------------
  ATR                                 Provides a volatility measure that
                                      can inform stop distance.

  ATR-based stop distance             Uses a multiple of ATR as one
                                      possible way to estimate a stop
                                      distance; the multiplier must be
                                      tested.

  Structural stop                     Places a stop beyond a meaningful
                                      price-structure level, such as a
                                      swing low or support zone for a
                                      long trade.

  Position sizing                     Calculates quantity from the
                                      permitted monetary risk and the
                                      distance between entry and stop.

  Risk-to-reward ratio                Compares potential reward with the
                                      amount at risk if the stop is hit.

  Maximum risk per trade              Caps the amount of capital that may
                                      be lost on one trade.

  Maximum daily loss                  Stops new trading, or triggers
                                      defined protective actions, after a
                                      daily loss limit is reached.

  Maximum exposure                    Limits total capital or notional
                                      exposure across open positions.

  Correlation / concentration limits  Prevents several highly correlated
                                      positions from creating excessive
                                      exposure to the same market move.

  Volatility-adjusted position sizing Reduces quantity when volatility or
                                      stop distance is larger, while
                                      keeping planned risk within limits.

  Gap and liquidity risk buffer       Accounts for the possibility that a
                                      stop may execute worse than its
                                      trigger price, especially during
                                      gaps or thin liquidity.

  Risk of ruin / drawdown limits      Evaluates the impact of losing
                                      streaks and sets limits to protect
                                      trading capital.

  Expected value (EV)                 Estimates average expected profit
                                      or loss per trade using win
                                      probability and average net win/loss.
                                      EV = (Win% × Avg net win) -
                                      (Loss% × Avg net loss).

  Risk per trade (%)                  Expresses planned monetary risk as
                                      a percentage of current account
                                      equity. Risk amount = Equity ×
                                      Risk%.

  Net risk-to-reward ratio            Compares expected reward with risk
                                      after estimated spread, slippage,
                                      brokerage, taxes, and other costs.
                                      Net R:R = Net potential reward /
                                      Net potential loss.

  Break-even win rate                 Minimum winning-trade percentage
                                      required to avoid losses for a
                                      given average win/loss ratio.
                                      BE% = Avg loss / (Avg win + Avg loss).

  Portfolio heat                      Total initial risk across all open
                                      positions, expressed as a percentage
                                      of account equity. Heat% = Sum of
                                      open-position risk amounts / Equity
                                      × 100.
  -----------------------------------------------------------------------

## 5. Execution

**Status: Needs more study**

Convert an approved trade into orders and monitor the actual fills,
costs, and order state.

  -----------------------------------------------------------------------
  Indicator / Metric / Concept        Brief description
  ----------------------------------- -----------------------------------
  Bid-ask spread                      Difference between best ask and
                                      best bid; an immediate component of
                                      transaction cost.

  Spread %                            Expresses the spread relative to
                                      the midpoint or another defined
                                      reference price.

  Order book depth                    Shows displayed liquidity at
                                      multiple price levels and helps
                                      estimate whether an order may move
                                      the market.

  Order book imbalance                Measures the difference between
                                      displayed bid and ask quantities;
                                      can change or disappear as orders
                                      are modified.

  Slippage                            Difference between the
                                      expected/reference execution price
                                      and the actual fill price.

  Market impact                       Price movement caused by the
                                      execution of the trading order
                                      itself.

  Fill ratio                          Percentage of submitted order
                                      quantity that has been executed.

  Partial fills                       Occur when only part of an order
                                      executes; the remaining quantity
                                      may stay open or be cancelled.

  Order types                         Understand market, limit, stop-loss
                                      market, and stop-loss limit orders
                                      and their trade-offs.

  Implementation shortfall            Measures the difference between the
                                      decision/reference price and the
                                      achieved execution outcome,
                                      including relevant costs.

  Time and sales (trade tape)         Displays executed trades, their
                                      prices, quantities, and timestamps.

  Aggressive buy/sell volume          Estimates trades executed by buyers
                                      lifting the ask or sellers hitting
                                      the bid.

  CVD (Cumulative Volume Delta)       Tracks the cumulative difference
                                      between estimated aggressive buying
                                      and selling volume.

  Order lifecycle and reconciliation  Tracks submitted, open, partially
                                      filled, filled, cancelled,
                                      rejected, and modified orders
                                      against broker updates.

  Latency and API reliability         Measures delays, missed updates,
                                      disconnections, rate limits, and
                                      broker API failures.

  Effective spread                     Measures execution cost relative
                                      to the midpoint at the time of the
                                      trade. For a buy, effective spread
                                      = 2 × (Fill price - Midpoint); use
                                      the sign-adjusted equivalent for
                                      sells.

  Queue position                       Estimates the order's place among
                                      resting orders at the same price.
                                      Helps assess the likelihood and
                                      timing of a limit-order fill.

  VWAP execution benchmark             Compares the average execution
                                      price with market VWAP over the
                                      chosen execution interval to assess
                                      execution quality.

  Arrival price                        Records the market price when the
                                      trade decision or order is released.
                                      Use it as a reference for measuring
                                      implementation shortfall.

  Adverse selection                    Measures whether price moves
                                      against the trade shortly after a
                                      fill. Track signed mid-price
                                      movement at defined intervals
                                      (for example, 1, 5, and 15 seconds).
  -----------------------------------------------------------------------

## 6. Exit

**Status: Needs more study**

Define when to close a position, how to protect open profit, and what to
do when the expected move does not occur.

  -----------------------------------------------------------------------
  Indicator / Metric / Concept        Brief description
  ----------------------------------- -----------------------------------
  ATR-based trailing stop             Adjusts a protective stop using
                                      volatility as the position moves
                                      favourably.

  Chandelier Exit                     ATR-based trailing exit using the
                                      highest high for long positions or
                                      lowest low for short positions over
                                      a lookback period.

  EMA slope                           Helps identify when the prevailing
                                      trend is flattening or changing
                                      direction.

  ROC                                 Helps detect weakening or reversing
                                      momentum.

  RSI                                 Provides momentum context and can
                                      help identify divergence; not a
                                      standalone exit trigger.

  VWAP                                Can act as an intraday reference,
                                      target, or condition for exiting,
                                      depending on the strategy.

  Support and resistance              Provides potential exit zones and
                                      areas where price may stall or
                                      reverse.

  Volume / RVOL                       Helps assess whether participation
                                      is increasing or fading during a
                                      move.

  Order flow / CVD                    Can help identify changes in
                                      aggressive buying or selling while
                                      a position is open.

  Time-based exit                     Closes a trade if the expected
                                      movement does not happen within a
                                      defined time.

  Partial profit booking              Closes a defined portion of the
                                      position while the remainder
                                      follows a separate exit rule.

  MFE (Maximum Favorable Excursion)   Largest unrealized favourable price
                                      movement during a trade. Useful for
                                      evaluating targets and trailing
                                      rules.

  MAE (Maximum Adverse Excursion)     Largest unrealized adverse price
                                      movement during a trade. Useful for
                                      evaluating stop placement.

  End-of-day square-off               Closes intraday positions before
                                      the applicable market or broker
                                      deadline.
  -----------------------------------------------------------------------

## 7. Performance and Analytics

**Status: Not covered yet --- build this measurement layer**

Evaluate whether each strategy has a measurable edge after costs. Track
results by strategy, instrument, market regime, time of day, and
execution type.

  -----------------------------------------------------------------------
  Metric                              Brief description
  ----------------------------------- -----------------------------------
  Win rate                            Percentage of closed trades that
                                      are profitable.

  Average win                         Average profit across winning
                                      trades.

  Average loss                        Average loss across losing trades.

  Expectancy                          Average expected profit or loss per
                                      trade, based on win probability and
                                      average win/loss.

  Profit factor                       Gross profits divided by gross
                                      losses over a defined period.

  Maximum drawdown                    Largest peak-to-trough decline in
                                      account equity over a period.

  Sharpe ratio                        Measures return relative to overall
                                      return variability.

  Sortino ratio                       Measures return relative to
                                      downside variability.

  MFE                                 Shows how much unrealized profit
                                      each trade reached before exit.

  MAE                                 Shows how much unrealized loss each
                                      trade experienced before exit.

  Slippage                            Measures execution price
                                      deterioration against the chosen
                                      reference price.

  Brokerage and transaction costs     Captures brokerage, exchange
                                      charges, taxes, and other
                                      applicable trading costs.

  Net P&L                             Profit or loss after all applicable
                                      costs.

  Trade frequency                     Number of trades taken over a
                                      defined period.

  Average holding time                Average duration positions remain
                                      open.

  R-multiple                          Trade outcome expressed as a
                                      multiple of the initial amount
                                      risked.

  Consecutive wins / losses           Helps examine streaks and the
                                      behaviour of the strategy during
                                      difficult periods.

  Performance by regime               Compares results in trending,
                                      ranging, high-volatility, and
                                      low-volatility conditions.

  Performance by time of day          Identifies whether strategy results
                                      vary across market sessions.

  Out-of-sample performance           Evaluates the strategy on data not
                                      used to develop or tune it.

  Paper-trading vs live performance   Compares simulated results with
                                      actual execution outcomes.
  -----------------------------------------------------------------------

## Cross-Phase Notes

-   **Avoid indicator duplication:** RSI, ROC, MACD, and EMA-derived
    measures overlap because they use price history. More indicators do
    not automatically mean more independent confirmation.
-   **Use time-of-day comparisons:** Intraday volume and volatility vary
    throughout the session. Compare RVOL and volatility with equivalent
    historical times where possible.
-   **Treat order-book data cautiously:** Displayed orders can be
    cancelled or changed. Confirm interpretations with executed trades
    and actual fills.
-   **Include costs in testing:** Backtests should account for
    brokerage, taxes, spread, slippage, market impact, and realistic
    order execution.
-   **Separate signal from execution:** A strategy signal does not
    guarantee a fill at the assumed price.
-   **Keep risk controls independent:** Risk limits should be able to
    reject orders and trigger protective actions even if strategy logic
    fails.

## Initial Build Checklist

-   [ ] Define market-state features and regime labels.
-   [ ] Define stock-selection filters and ranking.
-   [ ] Specify separate momentum and mean-reversion entry rules.
-   [ ] Define stop placement and position-sizing rules.
-   [ ] Define order handling, fill tracking, and failure recovery.
-   [ ] Specify full, partial, trailing, and time-based exits.
-   [ ] Build a trade journal and performance report.
-   [ ] Backtest with realistic costs and out-of-sample data.
-   [ ] Paper trade and compare simulated fills with live market
    conditions.
