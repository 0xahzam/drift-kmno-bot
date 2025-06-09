import pandas as pd
import json
import re
import streamlit as st
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def parse_log(file):
    market_data = []
    txn_data = []
    account_data = []

    with open(file) as f:
        for line in f:
            try:
                ts = line[:23]
                json_str = line[line.find("{") : line.rfind("}") + 1]
                json_data = json.loads(json_str)

                if "Market data processed" in line:
                    market_data.append({"timestamp": ts, **json_data})

                elif "Order placed" in line:
                    order_match = re.search(r"Order placed: (\w+) (\d+)", line)
                    if order_match:
                        side = order_match.group(1)
                        size = int(order_match.group(2))
                        txn_data.append(
                            {"timestamp": ts, "side": side, "size": size, **json_data}
                        )

                elif "Account state" in line:
                    account_data.append({"timestamp": ts, **json_data})

            except:
                continue

    return (
        pd.DataFrame(market_data),
        pd.DataFrame(txn_data),
        pd.DataFrame(account_data),
    )


def calculate_stats(account_df):
    if len(account_df) == 0:
        return {}

    pnl_values = account_df["unrealizedPnL"]
    return {
        "Current P&L": f"${pnl_values.iloc[-1]:.4f}",
        "Max P&L": f"${pnl_values.max():.4f}",
        "Min P&L": f"${pnl_values.min():.4f}",
        "P&L Range": f"${pnl_values.max() - pnl_values.min():.4f}",
        "Total Cycles": len(account_df),
        "Runtime (hrs)": f"{(pd.to_datetime(account_df['timestamp'].iloc[-1]) - pd.to_datetime(account_df['timestamp'].iloc[0])).total_seconds() / 3600:.1f}",
    }


def create_dashboard():
    st.set_page_config(layout="wide")
    st.title("Trading Bot Performance Dashboard")

    st.markdown("""
    ### Live Bot Monitoring
    - **Strategy:** DRIFT/KMNO Spread Trading
    - **Markets:** DRIFT-PERP (Index 30), KMNO-PERP (Index 28)
    - **Execution:** Automated position management
    """)

    # Load data
    market_df, txn_df, account_df = parse_log("../bot.log")

    if len(account_df) == 0:
        st.error("No data found in bot.log")
        return

    # Convert timestamps
    market_df["timestamp"] = pd.to_datetime(market_df["timestamp"])
    account_df["timestamp"] = pd.to_datetime(account_df["timestamp"])
    txn_df["timestamp"] = pd.to_datetime(txn_df["timestamp"])

    # Stats
    stats = calculate_stats(account_df)

    st.markdown("### Performance Summary")
    col1, col2, col3, col4, col5, col6 = st.columns(6)

    col1.metric("Current P&L", stats["Current P&L"])
    col2.metric("Max P&L", stats["Max P&L"])
    col3.metric("Min P&L", stats["Min P&L"])
    col4.metric("P&L Range", stats["P&L Range"])
    col5.metric("Total Cycles", stats["Total Cycles"])
    col6.metric("Runtime (hrs)", stats["Runtime (hrs)"])

    st.markdown("---")

    # Main charts
    st.markdown("### P&L & Account State")

    fig = make_subplots(
        rows=2,
        cols=2,
        subplot_titles=(
            "Unrealized P&L Over Time",
            "Collateral Levels",
            "Asset Prices",
            "Spread Analysis",
        ),
        specs=[
            [{"secondary_y": False}, {"secondary_y": False}],
            [{"secondary_y": False}, {"secondary_y": True}],
        ],
    )

    # P&L
    fig.add_trace(
        go.Scatter(
            x=account_df["timestamp"],
            y=account_df["unrealizedPnL"],
            name="P&L",
            line=dict(color="#1f77b4", width=3),
        ),
        row=1,
        col=1,
    )

    # Collateral
    fig.add_trace(
        go.Scatter(
            x=account_df["timestamp"],
            y=account_df["totalCollateral"],
            name="Total Collateral",
            line=dict(color="#2ca02c"),
        ),
        row=1,
        col=2,
    )
    fig.add_trace(
        go.Scatter(
            x=account_df["timestamp"],
            y=account_df["freeCollateral"],
            name="Free Collateral",
            line=dict(color="#ff7f0e"),
        ),
        row=1,
        col=2,
    )

    # Prices
    fig.add_trace(
        go.Scatter(
            x=market_df["timestamp"],
            y=market_df["driftPrice"],
            name="DRIFT",
            line=dict(color="#d62728"),
        ),
        row=2,
        col=1,
    )
    fig.add_trace(
        go.Scatter(
            x=market_df["timestamp"],
            y=market_df["kmnoPrice"],
            name="KMNO",
            line=dict(color="#9467bd"),
        ),
        row=2,
        col=1,
    )

    # Spread
    fig.add_trace(
        go.Scatter(
            x=market_df["timestamp"],
            y=market_df["spread"],
            name="Spread",
            line=dict(color="#e377c2", width=2),
        ),
        row=2,
        col=2,
    )

    fig.update_layout(height=600, showlegend=True)
    st.plotly_chart(fig, use_container_width=True)

    st.markdown("---")

    # Transaction analysis
    st.markdown("### Transaction Analysis")

    col1, col2 = st.columns(2)

    with col1:
        st.markdown("**Recent Transactions**")
        if len(txn_df) > 0:
            recent_txns = txn_df.tail(10)[
                ["timestamp", "side", "size", "marketIndex"]
            ].copy()
            recent_txns["market"] = recent_txns["marketIndex"].map(
                {30: "DRIFT", 28: "KMNO"}
            )
            st.dataframe(
                recent_txns[["timestamp", "side", "size", "market"]],
                use_container_width=True,
            )
        else:
            st.info("No transactions found")

    with col2:
        st.markdown("**Transaction Distribution**")
        if len(txn_df) > 0:
            txn_summary = (
                txn_df.groupby(["side", "marketIndex"]).size().reset_index(name="count")
            )
            txn_summary["market"] = txn_summary["marketIndex"].map(
                {30: "DRIFT", 28: "KMNO"}
            )

            fig_bar = go.Figure()
            for market in ["DRIFT", "KMNO"]:
                market_data = txn_summary[txn_summary["market"] == market]
                if len(market_data) > 0:
                    fig_bar.add_trace(
                        go.Bar(
                            x=market_data["side"], y=market_data["count"], name=market
                        )
                    )

            fig_bar.update_layout(height=300, title="Transactions by Side & Market")
            st.plotly_chart(fig_bar, use_container_width=True)

    st.markdown("---")

    # Raw data tables
    with st.expander("View Raw Data"):
        tab1, tab2, tab3 = st.tabs(["Market Data", "Account Data", "Transactions"])

        with tab1:
            st.dataframe(market_df, use_container_width=True)

        with tab2:
            st.dataframe(account_df, use_container_width=True)

        with tab3:
            st.dataframe(txn_df, use_container_width=True)

    st.markdown("""
    ---
    **Bot Status:** Live Trading
    **Data Source:** bot.log
    **Last Updated:** Real-time
    """)


if __name__ == "__main__":
    create_dashboard()
