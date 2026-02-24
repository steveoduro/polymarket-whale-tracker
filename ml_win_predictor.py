#!/usr/bin/env python3
"""
ml_win_predictor.py — LightGBM classifier for opportunity win prediction.
Connects directly to PostgreSQL. Read-only analysis — no DB writes.
"""

import os
import sys
import numpy as np
import pandas as pd
import psycopg2
from dotenv import load_dotenv
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import roc_auc_score, log_loss
import lightgbm as lgb

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))
DATABASE_URL = os.environ['DATABASE_URL']

def get_data():
    conn = psycopg2.connect(DATABASE_URL)
    query = """
        SELECT city, platform, range_type, side, ask, bid, spread,
               our_probability, ensemble_std_dev, hours_to_resolution,
               range_width, would_have_won, created_at
        FROM opportunities
        WHERE (model_valid = true OR model_valid IS NULL)
          AND platform = 'polymarket'
          AND would_have_won IS NOT NULL
          AND ask IS NOT NULL AND our_probability IS NOT NULL
    """
    df = pd.read_sql(query, conn)
    conn.close()
    return df

def engineer_features(df):
    df = df.copy()
    df['target'] = df['would_have_won'].astype(int)
    df['range_type_enc'] = (df['range_type'] == 'unbounded').astype(int)
    df['side_enc'] = (df['side'] == 'YES').astype(int)

    le = LabelEncoder()
    df['city_enc'] = le.fit_transform(df['city'])
    city_mapping = dict(zip(le.classes_, le.transform(le.classes_)))

    df['created_at'] = pd.to_datetime(df['created_at'])
    df['month'] = df['created_at'].dt.month
    df['hour_of_day'] = df['created_at'].dt.hour

    df['ask'] = df['ask'].astype(float)
    df['bid'] = df['bid'].astype(float)
    df['spread'] = df['spread'].astype(float)
    df['our_probability'] = df['our_probability'].astype(float)
    df['ensemble_std_dev'] = pd.to_numeric(df['ensemble_std_dev'], errors='coerce')
    df['hours_to_resolution'] = pd.to_numeric(df['hours_to_resolution'], errors='coerce')
    df['range_width'] = pd.to_numeric(df['range_width'], errors='coerce')

    df['ask_x_hours'] = df['ask'] * df['hours_to_resolution']
    df['prob_minus_ask'] = df['our_probability'] - df['ask']

    return df, city_mapping

FEATURES = [
    'ask', 'bid', 'spread', 'our_probability', 'ensemble_std_dev',
    'hours_to_resolution', 'range_width', 'range_type_enc', 'side_enc',
    'city_enc', 'month', 'hour_of_day', 'ask_x_hours', 'prob_minus_ask'
]

def main():
    print("=" * 70)
    print("ML WIN PREDICTOR — LightGBM Opportunity-Level Classifier")
    print("=" * 70)

    # Load data
    print("\n[1] Loading data from PostgreSQL...")
    df = get_data()
    print(f"    Loaded {len(df):,} resolved polymarket opportunities")

    # Feature engineering
    df, city_mapping = engineer_features(df)
    print(f"    Cities: {city_mapping}")

    # Train/test split by date
    split_date = pd.Timestamp('2026-02-20', tz='UTC')
    train = df[df['created_at'] < split_date].copy()
    test = df[df['created_at'] >= split_date].copy()
    print(f"    Train: {len(train):,} rows (before Feb 20)")
    print(f"    Test:  {len(test):,} rows (Feb 20+)")
    print(f"    Train win rate: {train['target'].mean():.3f}")
    print(f"    Test  win rate: {test['target'].mean():.3f}")

    # Drop rows with NaN features
    train_clean = train.dropna(subset=FEATURES)
    test_clean = test.dropna(subset=FEATURES)
    print(f"    Train after NaN drop: {len(train_clean):,}")
    print(f"    Test  after NaN drop: {len(test_clean):,}")

    X_train = train_clean[FEATURES]
    y_train = train_clean['target']
    X_test = test_clean[FEATURES]
    y_test = test_clean['target']

    # Train model
    print("\n[2] Training LightGBM...")
    params = {
        'n_estimators': 500,
        'learning_rate': 0.05,
        'num_leaves': 63,
        'min_child_samples': 50,
        'class_weight': 'balanced',
        'random_state': 42,
        'verbosity': -1,
    }
    model = lgb.LGBMClassifier(**params)
    model.fit(X_train, y_train)

    preds = model.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(y_test, preds)
    ll = log_loss(y_test, preds)
    print(f"    Test AUC: {auc:.4f}")
    print(f"    Test Log Loss: {ll:.4f}")

    # ── Feature Importance ──
    print("\n" + "=" * 70)
    print("[3] FEATURE IMPORTANCE (top 15 by gain)")
    print("=" * 70)
    importances = model.feature_importances_
    feat_imp = sorted(zip(FEATURES, importances), key=lambda x: -x[1])
    print(f"{'Feature':<25} {'Gain':>10}")
    print("-" * 36)
    for feat, imp in feat_imp[:15]:
        print(f"{feat:<25} {imp:>10.0f}")

    # ── Seoul Isolation ──
    print("\n" + "=" * 70)
    print("[4] SEOUL ISOLATION ANALYSIS (test set)")
    print("=" * 70)
    test_clean = test_clean.copy()
    test_clean['pred_prob'] = preds

    seoul_code = city_mapping.get('seoul')
    if seoul_code is not None:
        is_seoul = test_clean['city'] == 'seoul'

        def ask_bucket(a):
            if a < 0.20: return '<20c'
            if a < 0.40: return '20-40c'
            if a < 0.60: return '40-60c'
            return '60c+'

        test_clean['ask_bucket'] = test_clean['ask'].apply(ask_bucket)

        print(f"\n  Average predicted win prob — Seoul vs Others:")
        print(f"  {'Range Type':<12} {'Ask Bucket':<10} {'Seoul Pred':>10} {'Seoul N':>8} {'Others Pred':>11} {'Others N':>9}")
        print("  " + "-" * 62)
        for rt in ['bounded', 'unbounded']:
            for bucket in ['<20c', '20-40c', '40-60c', '60c+']:
                mask_rt = test_clean['range_type'] == rt
                mask_bkt = test_clean['ask_bucket'] == bucket
                seoul_rows = test_clean[is_seoul & mask_rt & mask_bkt]
                other_rows = test_clean[~is_seoul & mask_rt & mask_bkt]
                s_pred = f"{seoul_rows['pred_prob'].mean():.3f}" if len(seoul_rows) > 0 else "—"
                s_n = len(seoul_rows)
                o_pred = f"{other_rows['pred_prob'].mean():.3f}" if len(other_rows) > 0 else "—"
                o_n = len(other_rows)
                print(f"  {rt:<12} {bucket:<10} {s_pred:>10} {s_n:>8} {o_pred:>11} {o_n:>9}")

        # Also show actual win rates for comparison
        print(f"\n  Actual win rate — Seoul vs Others:")
        print(f"  {'Range Type':<12} {'Ask Bucket':<10} {'Seoul Win%':>10} {'Seoul N':>8} {'Others Win%':>11} {'Others N':>9}")
        print("  " + "-" * 62)
        for rt in ['bounded', 'unbounded']:
            for bucket in ['<20c', '20-40c', '40-60c', '60c+']:
                mask_rt = test_clean['range_type'] == rt
                mask_bkt = test_clean['ask_bucket'] == bucket
                seoul_rows = test_clean[is_seoul & mask_rt & mask_bkt]
                other_rows = test_clean[~is_seoul & mask_rt & mask_bkt]
                s_win = f"{seoul_rows['target'].mean() * 100:.1f}%" if len(seoul_rows) > 0 else "—"
                s_n = len(seoul_rows)
                o_win = f"{other_rows['target'].mean() * 100:.1f}%" if len(other_rows) > 0 else "—"
                o_n = len(other_rows)
                print(f"  {rt:<12} {bucket:<10} {s_win:>10} {s_n:>8} {o_win:>11} {o_n:>9}")
    else:
        print("  Seoul not found in test set.")

    # ── Calibration Comparison ──
    print("\n" + "=" * 70)
    print("[5] CALIBRATION COMPARISON (test set, 10 equal-width bins)")
    print("=" * 70)

    # ML model calibration
    print("\n  ML Model Calibration:")
    print(f"  {'Bucket':<15} {'Mean Pred':>10} {'Actual Win%':>12} {'Count':>8}")
    print("  " + "-" * 47)
    bins = np.linspace(0, 1, 11)
    test_clean['pred_bin'] = pd.cut(test_clean['pred_prob'], bins=bins, include_lowest=True)
    for interval, group in test_clean.groupby('pred_bin', observed=True):
        if len(group) > 0:
            mean_pred = group['pred_prob'].mean()
            actual_wr = group['target'].mean()
            print(f"  {str(interval):<15} {mean_pred:>10.3f} {actual_wr * 100:>11.1f}% {len(group):>8,}")

    # Baseline (our_probability) calibration
    print("\n  Baseline (our_probability) Calibration:")
    print(f"  {'Bucket':<15} {'Mean Prob':>10} {'Actual Win%':>12} {'Count':>8}")
    print("  " + "-" * 47)
    test_clean['prob_bin'] = pd.cut(test_clean['our_probability'], bins=bins, include_lowest=True)
    for interval, group in test_clean.groupby('prob_bin', observed=True):
        if len(group) > 0:
            mean_prob = group['our_probability'].mean()
            actual_wr = group['target'].mean()
            print(f"  {str(interval):<15} {mean_prob:>10.3f} {actual_wr * 100:>11.1f}% {len(group):>8,}")

    # ── Worst Misses ──
    print("\n" + "=" * 70)
    print("[6] WORST MODEL MISSES (20 rows, largest |pred - actual|)")
    print("=" * 70)
    test_clean['miss'] = (test_clean['pred_prob'] - test_clean['target']).abs()
    worst = test_clean.nlargest(20, 'miss')
    print(f"  {'City':<14} {'Type':<10} {'Side':<5} {'Ask':>5} {'Hrs':>6} {'OurProb':>8} {'Pred':>6} {'Won':>4}")
    print("  " + "-" * 60)
    for _, row in worst.iterrows():
        print(f"  {row['city']:<14} {row['range_type']:<10} {row['side']:<5} "
              f"{row['ask']:>5.2f} {row['hours_to_resolution']:>6.0f} "
              f"{row['our_probability']:>8.3f} {row['pred_prob']:>6.3f} "
              f"{int(row['target']):>4}")

    # ── Save Predictions ──
    out_path = os.path.join(os.path.dirname(__file__), 'ml_predictions_test.csv')
    save_cols = FEATURES + ['city', 'range_type', 'side', 'pred_prob', 'would_have_won', 'created_at']
    test_clean[save_cols].to_csv(out_path, index=False)
    print(f"\n  Saved {len(test_clean):,} test predictions to {out_path}")

    print("\n" + "=" * 70)
    print("DONE")
    print("=" * 70)

if __name__ == '__main__':
    main()
