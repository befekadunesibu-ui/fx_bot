import json
import os
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None

SYMBOLS = {
    "XAUUSD": os.getenv("MT5_SYMBOL_XAUUSD", "XAUUSD"),
    "EURUSD": os.getenv("MT5_SYMBOL_EURUSD", "EURUSD"),
    "GBPUSD": os.getenv("MT5_SYMBOL_GBPUSD", "GBPUSD"),
    "USDJPY": os.getenv("MT5_SYMBOL_USDJPY", "USDJPY"),
}
TIMEFRAMES = {
    "M1": "TIMEFRAME_M1", "M5": "TIMEFRAME_M5", "M15": "TIMEFRAME_M15",
    "M30": "TIMEFRAME_M30", "H1": "TIMEFRAME_H1", "H2": "TIMEFRAME_H2",
    "H4": "TIMEFRAME_H4", "H8": "TIMEFRAME_H8", "D1": "TIMEFRAME_D1",
    "W1": "TIMEFRAME_W1", "MN1": "TIMEFRAME_MN1",
}


def mt5_timestamp_to_utc(raw_seconds):
    """Convert broker-server epoch seconds to UTC using the observed server offset.

    Some brokers return epoch-shaped values representing broker server time rather
    than UTC. Infer only a stable whole-hour offset from the host UTC clock; small
    or non-hour future values remain untouched and are rejected by the backend.
    """
    now = time.time()
    delta = raw_seconds - now
    rounded_offset = round(delta / 3600) * 3600
    offset = rounded_offset if delta > 1800 and abs(delta - rounded_offset) <= 300 else 0
    corrected = raw_seconds - offset
    return datetime.fromtimestamp(corrected, timezone.utc), offset


def initialize():
    if mt5 is None:
        return False, "MetaTrader5 Python package is not installed"
    kwargs = {}
    for key, name in (("MT5_LOGIN", "login"), ("MT5_PASSWORD", "password"), ("MT5_SERVER", "server")):
        value = os.getenv(key)
        if value:
            kwargs[name] = int(value) if key == "MT5_LOGIN" else value
    path = os.getenv("MT5_TERMINAL_PATH")
    if path:
        kwargs["path"] = path
    if not mt5.initialize(**kwargs):
        return False, str(mt5.last_error())
    return True, None


def health():
    connected, error = initialize()
    if not connected:
        return {"connected": False, "symbols": [], "lastError": error}
    available = []
    for symbol in SYMBOLS.values():
        info = mt5.symbol_info(symbol)
        if info and (info.visible or mt5.symbol_select(symbol, True)):
            available.append(symbol)
    return {"connected": True, "symbols": available, "lastError": None}


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query)
        if self.path.startswith("/health"):
            self.send_json(200, health())
            return
        connected, error = initialize()
        if not connected:
            self.send_json(503, {"error": error})
            return
        broker_symbol = query.get("symbol", [None])[0]
        if not broker_symbol or broker_symbol not in SYMBOLS.values():
            self.send_json(400, {"error": "Unsupported or missing symbol"})
            return
        info = mt5.symbol_info(broker_symbol)
        if not info or not mt5.symbol_select(broker_symbol, True):
            self.send_json(404, {"error": "Symbol is unavailable in the terminal"})
            return
        if self.path.startswith("/quote"):
            tick = mt5.symbol_info_tick(broker_symbol)
            if tick is None:
                self.send_json(503, {"error": str(mt5.last_error())})
                return
            raw_seconds = tick.time_msc / 1000 if tick.time_msc else tick.time
            observed, offset = mt5_timestamp_to_utc(raw_seconds)
            self.send_json(200, {
                "symbol": broker_symbol, "bid": tick.bid, "ask": tick.ask,
                "time": observed.isoformat(), "rawTime": raw_seconds,
                "timestampOffsetSeconds": offset,
            })
            return
        if self.path.startswith("/candles"):
            timeframe_name = query.get("timeframe", ["H1"])[0]
            count = min(max(int(query.get("count", ["100"])[0]), 1), 500)
            timeframe = getattr(mt5, TIMEFRAMES.get(timeframe_name, "TIMEFRAME_H1"))
            rates = mt5.copy_rates_from_pos(broker_symbol, timeframe, 0, count)
            if rates is None:
                self.send_json(503, {"error": str(mt5.last_error())})
                return
            candles = [
                {"time": mt5_timestamp_to_utc(int(row["time"]))[0].isoformat(),
                 "open": float(row["open"]), "high": float(row["high"]),
                 "low": float(row["low"]), "close": float(row["close"]),
                 "volume": float(row["tick_volume"])}
                for row in rates
            ]
            self.send_json(200, {"candles": candles})
            return
        self.send_json(404, {"error": "Not found"})

    def log_message(self, *_args):
        return


if __name__ == "__main__":
    host = os.getenv("MT5_BRIDGE_HOST", "127.0.0.1")
    port = int(os.getenv("MT5_BRIDGE_PORT", "8765"))
    ThreadingHTTPServer((host, port), Handler).serve_forever()
