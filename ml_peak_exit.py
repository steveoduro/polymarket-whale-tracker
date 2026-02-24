#!/usr/bin/env python3
"""
ml_peak_exit.py — Losing trade exit window analysis.
Connects directly to PostgreSQL. Read-only analysis — no DB writes.
"""

import os
import json
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.preprocessing import LabelEncoder
import lightgbm as lgb

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
DATABASE_URL = os.environ['DATABASE_URL']

def get_losing_trades():
    conn = psycopg2.connect(DATABASE_URL)
    query = """
        SELECT id, city, platform, range_name, range_type, range_unit, side,
               entry_ask, entry_bid, entry_spread, entry_probability, entry_edge_pct,
               cost, shares, max_price_seen, pnl, won, status,
               entry_reason, hours_to_resolution, evaluator_log, created_at
        FROM trades
        WHERE status IN ('resolved', 'exited')
          AND won = false
          AND max_price_seen IS NOT NULL
          AND entry_ask IS NOT NULL
          AND pnl IS NOT NULL
    """
    df = pd.read_sql(query, conn)
    conn.close()
    return df

def parse_evaluator_log(log_json):
    """Parse JSONB evaluator_log array into list of {ts, bid, ask} dicts."""
    if log_json is None:
        return []
    if isinstance(log_json, str):
        log_json = json.loads(log_json)
    entries = []
    for entry in log_json:
        ts = entry.get('ts')
        bid = entry.get('bid')
        if ts is not None and bid is not None:
            entries.append({
                'ts': pd.to_datetime(ts),
                'bid': float(bid),
                'ask': float(entry.get('ask', 0)),
            })
    return entries

def compute_window_duration(log_entries, threshold):
    """Compute total span (first to last) in minutes where bid was above threshold."""
    if not log_entries:
        return 0
    above_entries = [e for e in log_entries if e['bid'] >= threshold]
    if not above_entries:
        return 0
    first_ts = above_entries[0]['ts']
    last_ts = above_entries[-1]['ts']
    return (last_ts - first_ts).total_seconds() / 60

def main():
    print("=" * 70)
    print("ML PEAK EXIT ANALYSIS — Losing Trade Exit Windows")
    print("=" * 70)

    # Load data
    print("\n[1] Loading losing trades from PostgreSQL...")
    df = get_losing_trades()
    print(f"    Loaded {len(df)} losing trades")

    # Convert numeric columns
    for col in ['entry_ask', 'entry_bid', 'entry_spread', 'entry_probability',
                'entry_edge_pct', 'cost', 'shares', 'max_price_seen', 'pnl',
                'hours_to_resolution']:
        df[col] = pd.to_numeric(df[col], errors='coerce')

    # Compute peak metrics
    df['peak_multiple'] = df['max_price_seen'] / df['entry_ask']
    df['had_exit_15x'] = df['peak_multiple'] >= 1.5
    df['had_exit_2x'] = df['peak_multiple'] >= 2.0

    # ════════════════════════════════════════════════════
    # PART A — Descriptive Stats
    # ════════════════════════════════════════════════════
    print("\n" + "=" * 70)
    print("PART A — DESCRIPTIVE STATS")
    print("=" * 70)

    total = len(df)
    pct_15x = df['had_exit_15x'].sum() / total * 100
    pct_2x = df['had_exit_2x'].sum() / total * 100

    print(f"\n  Total losing trades: {total}")
    print(f"  Hit 1.5x+:  {df['had_exit_15x'].sum()} ({pct_15x:.0f}%)")
    print(f"  Hit 2x+:    {df['had_exit_2x'].sum()} ({pct_2x:.0f}%)")

    # P&L analysis for exit window trades
    window_trades = df[df['had_exit_15x']]
    total_pnl_lost = df['pnl'].sum()
    if len(window_trades) > 0:
        # TP at 1.5x: profit = shares * (entry_ask * 1.5 - entry_ask) = shares * entry_ask * 0.5
        tp_15x_recovery = (window_trades['shares'] * window_trades['entry_ask'] * 0.5).sum()
        # What they actually lost
        window_pnl_lost = window_trades['pnl'].sum()
        print(f"\n  Total P&L lost (all losers): ${total_pnl_lost:.2f}")
        print(f"  P&L lost by trades with 1.5x window: ${window_pnl_lost:.2f}")
        print(f"  TP at 1.5x would have recovered: +${tp_15x_recovery:.2f}")
        print(f"  Net if TP at 1.5x on those trades: ${window_pnl_lost + tp_15x_recovery:.2f}")
    else:
        print(f"\n  Total P&L lost: ${total_pnl_lost:.2f}")
        print(f"  No trades hit 1.5x exit window.")

    window_2x = df[df['had_exit_2x']]
    if len(window_2x) > 0:
        tp_2x_recovery = (window_2x['shares'] * window_2x['entry_ask'] * 1.0).sum()
        window_2x_pnl = window_2x['pnl'].sum()
        print(f"  TP at 2.0x would have recovered: +${tp_2x_recovery:.2f}")
        print(f"  Net if TP at 2.0x on those trades: ${window_2x_pnl + tp_2x_recovery:.2f}")

    # By entry_reason
    print(f"\n  Exit windows by entry_reason:")
    print(f"  {'Reason':<18} {'Total':>6} {'1.5x+':>6} {'%':>6} {'Avg Peak':>10}")
    print("  " + "-" * 48)
    for reason, group in df.groupby('entry_reason'):
        n = len(group)
        n15 = group['had_exit_15x'].sum()
        pct = n15 / n * 100 if n > 0 else 0
        avg_peak = group['peak_multiple'].mean()
        print(f"  {reason:<18} {n:>6} {n15:>6} {pct:>5.0f}% {avg_peak:>10.2f}")

    # By range_type + side
    print(f"\n  Exit windows by range_type + side:")
    print(f"  {'Type':<12} {'Side':<5} {'Total':>6} {'1.5x+':>6} {'%':>6} {'Avg Peak':>10}")
    print("  " + "-" * 47)
    for (rt, side), group in df.groupby(['range_type', 'side']):
        n = len(group)
        n15 = group['had_exit_15x'].sum()
        pct = n15 / n * 100 if n > 0 else 0
        avg_peak = group['peak_multiple'].mean()
        print(f"  {rt:<12} {side:<5} {n:>6} {n15:>6} {pct:>5.0f}% {avg_peak:>10.2f}")

    # Parse evaluator logs for window duration
    print(f"\n  Window duration analysis (trades with 1.5x+ peak):")
    durations = []
    for _, row in window_trades.iterrows():
        log_entries = parse_evaluator_log(row['evaluator_log'])
        threshold = float(row['entry_ask']) * 1.5
        dur = compute_window_duration(log_entries, threshold)
        durations.append({
            'id': row['id'],
            'city': row['city'],
            'range_name': row['range_name'],
            'entry_ask': row['entry_ask'],
            'peak_multiple': row['peak_multiple'],
            'window_minutes': dur,
            'pnl': row['pnl'],
        })
    dur_df = pd.DataFrame(durations)

    if len(dur_df) > 0:
        print(f"  Trades with 1.5x+ window: {len(dur_df)}")
        d = dur_df['window_minutes']
        print(f"  Window duration (minutes):")
        print(f"    p25: {d.quantile(0.25):.0f}")
        print(f"    p50: {d.quantile(0.50):.0f}")
        print(f"    p75: {d.quantile(0.75):.0f}")
        print(f"    p90: {d.quantile(0.90):.0f}")
        print(f"    max: {d.max():.0f}")
    else:
        print("  No trades had 1.5x+ exit window — skipping duration analysis.")

    # Full detail for all losing trades
    print(f"\n  All losing trades detail:")
    print(f"  {'City':<14} {'Range':<14} {'Side':<5} {'Entry':>6} {'Peak':>6} {'PeakX':>6} {'P&L':>8} {'Reason':<14}")
    print("  " + "-" * 75)
    for _, row in df.sort_values('peak_multiple', ascending=False).iterrows():
        print(f"  {row['city']:<14} {row['range_name']:<14} {row['side']:<5} "
              f"{row['entry_ask']:>6.2f} {row['max_price_seen']:>6.2f} "
              f"{row['peak_multiple']:>6.2f} {row['pnl']:>8.2f} {str(row['entry_reason']):<14}")

    # ════════════════════════════════════════════════════
    # PART B — Exit Window Predictor
    # ════════════════════════════════════════════════════
    print("\n" + "=" * 70)
    print("PART B — EXIT WINDOW PREDICTOR (LightGBM)")
    print("=" * 70)

    # Features available at entry time
    feat_cols = ['entry_ask', 'entry_probability', 'entry_edge_pct',
                 'entry_spread', 'cost', 'range_type_enc', 'side_enc',
                 'city_enc', 'hours_to_resolution']

    df_model = df.copy()
    df_model['range_type_enc'] = (df_model['range_type'] == 'unbounded').astype(int)
    df_model['side_enc'] = (df_model['side'] == 'YES').astype(int)
    le = LabelEncoder()
    df_model['city_enc'] = le.fit_transform(df_model['city'])
    df_model['target'] = df_model['had_exit_15x'].astype(int)

    df_model = df_model.dropna(subset=feat_cols)
    X = df_model[feat_cols]
    y = df_model['target']

    print(f"\n  Training set: {len(X)} losing trades")
    print(f"  Target distribution: {y.sum()} had exit window, {len(y) - y.sum()} did not")

    if len(X) < 5:
        print("  Too few samples for meaningful ML — skipping model training.")
    else:
        params = {
            'n_estimators': 100,
            'learning_rate': 0.1,
            'num_leaves': 7,
            'min_child_samples': 2,
            'class_weight': 'balanced',
            'random_state': 42,
            'verbosity': -1,
        }
        model = lgb.LGBMClassifier(**params)
        model.fit(X, y)

        print(f"\n  Feature Importance (by gain):")
        importances = model.feature_importances_
        feat_imp = sorted(zip(feat_cols, importances), key=lambda x: -x[1])
        print(f"  {'Feature':<25} {'Gain':>10}")
        print("  " + "-" * 36)
        for feat, imp in feat_imp:
            print(f"  {feat:<25} {imp:>10.0f}")

        # Predictions on training data (no holdout with 17 samples)
        preds = model.predict_proba(X)[:, 1]
        df_model['pred_exit_prob'] = preds

    # 5 biggest missed exit windows
    print(f"\n  5 Biggest Missed Exit Windows:")
    print(f"  {'City':<14} {'Range':<14} {'Side':<5} {'Entry':>6} {'Peak':>6} {'PeakX':>6} "
          f"{'Window':>7} {'P&L':>8}")
    print("  " + "-" * 68)

    if len(dur_df) > 0:
        biggest = dur_df.nlargest(5, 'peak_multiple')
    else:
        biggest = df.nlargest(5, 'peak_multiple')

    for _, row in biggest.iterrows():
        window_min = row.get('window_minutes', '—')
        w_str = f"{window_min:>5.0f}m" if isinstance(window_min, (int, float)) else f"{'—':>6}"
        print(f"  {row['city']:<14} {row['range_name']:<14} {'':5} "
              f"{row['entry_ask']:>6.2f} {'':6} {row['peak_multiple']:>6.2f} "
              f"{w_str} {row['pnl']:>8.2f}")

    print("\n" + "=" * 70)
    print("DONE")
    print("=" * 70)

if __name__ == '__main__':
    main()
