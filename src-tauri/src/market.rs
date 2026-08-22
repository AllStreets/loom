/// market.rs — LOOM's typed market engine over keyless sources.
///
/// Five typed commands plus the legacy batch `quote_fetch` (folded in from the
/// old quotes.rs — same command name, same output contract, so the existing
/// Terminal poller keeps working):
///
///   market_chart(symbol)          Yahoo /v8/chart (query1, query2 retry on 429/5xx)
///   market_crypto(product)        Coinbase ticker + 24h stats, merged
///   market_book(product, depth)   Coinbase level-2 book, truncated per side
///   market_trades(product)        Coinbase recent trades, capped
///   market_fx(base, symbols)      Frankfurter latest daily rates
///   quote_fetch(symbols)          legacy Yahoo batch → raw JSON array string
///
/// Sovereignty rules (stage-5 law):
///   - Hosts are hardcoded constants — no URL ever comes from the caller.
///   - Every input is validated BEFORE any request (hand-rolled — no regex
///     crate, matching cloud.rs's tag validator pattern).
///   - Every request carries a real browser User-Agent. This is the root-cause
///     fix for the empty Terminal deck: Yahoo's chart endpoint returns 429 for
///     reqwest's default UA and 200 for a browser UA (verified live by curl).
///   - 10s timeout, typed LoomError on every failure path.
///
/// Rate-limit friendliness: Coinbase's public limit is ~10 req/s/IP. The deck
/// poll cadences (book 2s + trades 3s + crypto strip 30s) total < 1 req/s.

use crate::error::LoomError;
use serde::Serialize;
use std::collections::BTreeMap;

// ── Constants ─────────────────────────────────────────────────────────────────

/// The 429 root fix — Yahoo rejects reqwest's default UA; a browser UA gets 200.
const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// query1 first; query2 is the retry host for transient (429/5xx) failures.
const YAHOO_HOSTS: [&str; 2] = [
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
];
const COINBASE: &str = "https://api.exchange.coinbase.com";
const FRANKFURTER: &str = "https://api.frankfurter.dev";

const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Coinbase products LOOM will ever ask for (defense in depth: membership AND
/// shape are both checked).
const PRODUCT_WHITELIST: [&str; 3] = ["BTC-USD", "ETH-USD", "SOL-USD"];

const TRADES_CAP: usize = 30;
const DEPTH_MIN: u32 = 1;
const DEPTH_MAX: u32 = 50;

// ── Validation (pure, hand-rolled — no regex crate) ──────────────────────────

/// Equity/index/future symbol: `^[A-Z0-9.^=-]{1,12}$` (covers ^VIX, GC=F,
/// BTC-USD, BRK.B styles). Uppercase only — the frontend always sends uppercase.
pub fn is_valid_symbol(s: &str) -> bool {
    if s.is_empty() || s.len() > 12 {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '.' | '^' | '=' | '-'))
}

/// Coinbase product: must be in the literal whitelist AND match `^[A-Z]{2,6}-USD$`.
pub fn is_valid_product(p: &str) -> bool {
    if !PRODUCT_WHITELIST.contains(&p) {
        return false;
    }
    match p.strip_suffix("-USD") {
        Some(base) => {
            (2..=6).contains(&base.len()) && base.chars().all(|c| c.is_ascii_uppercase())
        }
        None => false,
    }
}

/// ISO currency code: `^[A-Z]{3}$`.
pub fn is_valid_fx_code(c: &str) -> bool {
    c.len() == 3 && c.chars().all(|ch| ch.is_ascii_uppercase())
}

/// Clamp a requested book depth into [1, 50].
pub fn clamp_depth(depth: u32) -> usize {
    depth.clamp(DEPTH_MIN, DEPTH_MAX) as usize
}

fn invalid(what: &str, got: &str, rule: &str) -> LoomError {
    LoomError::Parse(format!("invalid {what} {got:?}: must match {rule}"))
}

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

/// Shared client: browser UA (the 429 fix) + 10s timeout.
fn market_client() -> Result<reqwest::Client, LoomError> {
    reqwest::Client::builder()
        .user_agent(BROWSER_UA)
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| LoomError::Http(e.to_string()))
}

fn map_reqwest(e: reqwest::Error) -> LoomError {
    if e.is_timeout() {
        LoomError::Timeout
    } else {
        LoomError::Http(e.to_string())
    }
}

/// 429 = rate limited, 5xx = server side — worth the query2 retry.
fn is_transient(status: u16) -> bool {
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

/// GET a hardcoded-host URL, expect JSON. Typed errors for network/status/parse.
async fn get_json(client: &reqwest::Client, url: &str) -> Result<serde_json::Value, LoomError> {
    let resp = client.get(url).send().await.map_err(map_reqwest)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(LoomError::Http(format!("GET {url} returned {}", status.as_u16())));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| LoomError::Parse(e.to_string()))
}

// ── Yahoo chart ───────────────────────────────────────────────────────────────

/// Build the Yahoo /v8/chart URL for a symbol on a given host.
/// Percent-encodes the URL-special symbol characters (^VIX, GC=F).
pub fn yahoo_chart_url(host: &str, symbol: &str) -> String {
    let encoded: String = symbol
        .chars()
        .map(|c| match c {
            '^' => "%5E".to_string(),
            '=' => "%3D".to_string(),
            _ => c.to_string(),
        })
        .collect();
    format!("{host}/v8/finance/chart/{encoded}?interval=15m&range=1d")
}

/// Fetch one symbol's chart JSON: query1 first, query2 retry on 429/5xx or a
/// network-level failure. Non-transient HTTP errors (404 etc.) fail fast.
async fn yahoo_get(client: &reqwest::Client, symbol: &str) -> Result<serde_json::Value, LoomError> {
    let last = YAHOO_HOSTS.len() - 1;
    for (i, host) in YAHOO_HOSTS.iter().enumerate() {
        let url = yahoo_chart_url(host, symbol);
        match client.get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp
                        .json::<serde_json::Value>()
                        .await
                        .map_err(|e| LoomError::Parse(e.to_string()));
                }
                let code = status.as_u16();
                if i < last && is_transient(code) {
                    continue; // → query2
                }
                return Err(LoomError::Http(format!("yahoo returned {code} for {symbol}")));
            }
            Err(e) => {
                if i < last {
                    continue; // network hiccup → query2
                }
                return Err(map_reqwest(e));
            }
        }
    }
    unreachable!("YAHOO_HOSTS is non-empty");
}

// ── Typed shapes (serialized camelCase for the JS side) ──────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketChart {
    pub symbol: String,
    pub name: Option<String>,
    pub price: f64,
    pub prev_close: f64,
    /// Day OHLC/volume derived from the intraday series (None when absent).
    pub open: Option<f64>,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub volume: Option<f64>,
    /// Intraday closes with their epoch-second timestamps, same length,
    /// nulls dropped pairwise.
    pub closes: Vec<f64>,
    pub timestamps: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketCrypto {
    pub product: String,
    pub price: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub open_24h: Option<f64>,
    pub high_24h: Option<f64>,
    pub low_24h: Option<f64>,
    pub volume_24h: Option<f64>,
    /// (price − open24h) / open24h × 100, when open is present and non-zero.
    pub change_pct_24h: Option<f64>,
    pub time: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BookLevel {
    pub price: f64,
    pub size: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBook {
    pub product: String,
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketTrade {
    pub trade_id: u64,
    pub time: String,
    pub price: f64,
    pub size: f64,
    /// Coinbase maker side, passed through raw ("buy" = down-tick).
    pub side: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketFx {
    pub base: String,
    pub date: String,
    pub rates: BTreeMap<String, f64>,
}

// ── Pure parse helpers (fixture-tested, no network) ──────────────────────────

/// Coinbase serializes numbers as strings; Yahoo as numbers. Accept both.
fn as_num(v: Option<&serde_json::Value>) -> Option<f64> {
    let v = v?;
    let n = match v {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => s.parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// Pull one intraday series (open/high/low/close/volume) as finite-or-None.
fn series(quote: Option<&serde_json::Value>, key: &str) -> Vec<Option<f64>> {
    quote
        .and_then(|q| q.get(key))
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(|v| as_num(Some(v))).collect())
        .unwrap_or_default()
}

/// Normalize one Yahoo /v8/chart body into a MarketChart.
pub fn parse_chart(symbol: &str, body: &serde_json::Value) -> Result<MarketChart, LoomError> {
    let result = body
        .pointer("/chart/result/0")
        .ok_or_else(|| LoomError::Parse(format!("yahoo chart: no result for {symbol}")))?;
    let meta = result
        .get("meta")
        .ok_or_else(|| LoomError::Parse(format!("yahoo chart: no meta for {symbol}")))?;

    let price = as_num(meta.get("regularMarketPrice"))
        .ok_or_else(|| LoomError::Parse(format!("yahoo chart: no price for {symbol}")))?;
    // Mirror the JS normalizer: chartPreviousClose → previousClose → price; 0 → price.
    let prev_close = as_num(meta.get("chartPreviousClose"))
        .or_else(|| as_num(meta.get("previousClose")))
        .filter(|p| *p != 0.0)
        .unwrap_or(price);
    let name = meta
        .get("shortName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from);

    let quote = result.pointer("/indicators/quote/0");
    let raw_closes = series(quote, "close");
    let raw_ts: Vec<Option<i64>> = result
        .get("timestamp")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(|v| v.as_i64()).collect())
        .unwrap_or_default();

    // Pairwise: keep only slots where close is finite AND a timestamp exists.
    let mut closes = Vec::new();
    let mut timestamps = Vec::new();
    for (i, c) in raw_closes.iter().enumerate() {
        if let (Some(c), Some(Some(t))) = (c, raw_ts.get(i)) {
            closes.push(*c);
            timestamps.push(*t);
        }
    }

    let opens = series(quote, "open");
    let highs = series(quote, "high");
    let lows = series(quote, "low");
    let volumes = series(quote, "volume");
    let open = opens.iter().flatten().next().copied();
    let high = highs.iter().flatten().copied().fold(None, |m: Option<f64>, v| {
        Some(m.map_or(v, |m| m.max(v)))
    });
    let low = lows.iter().flatten().copied().fold(None, |m: Option<f64>, v| {
        Some(m.map_or(v, |m| m.min(v)))
    });
    let volume = if volumes.iter().any(|v| v.is_some()) {
        Some(volumes.iter().flatten().sum())
    } else {
        None
    };

    Ok(MarketChart {
        symbol: symbol.to_string(),
        name,
        price,
        prev_close,
        open,
        high,
        low,
        volume,
        closes,
        timestamps,
    })
}

/// Merge Coinbase /ticker + /stats into a MarketCrypto. The ticker (price) is
/// required; stats fields degrade to None (a stats failure must not kill spot).
pub fn parse_crypto(
    product: &str,
    ticker: &serde_json::Value,
    stats: &serde_json::Value,
) -> Result<MarketCrypto, LoomError> {
    let price = as_num(ticker.get("price"))
        .ok_or_else(|| LoomError::Parse(format!("coinbase ticker: no price for {product}")))?;
    let open_24h = as_num(stats.get("open"));
    let change_pct_24h = open_24h
        .filter(|o| *o != 0.0)
        .map(|o| (price - o) / o * 100.0);
    Ok(MarketCrypto {
        product: product.to_string(),
        price,
        bid: as_num(ticker.get("bid")),
        ask: as_num(ticker.get("ask")),
        open_24h,
        high_24h: as_num(stats.get("high")),
        low_24h: as_num(stats.get("low")),
        volume_24h: as_num(stats.get("volume")),
        change_pct_24h,
        time: ticker.get("time").and_then(|v| v.as_str()).map(String::from),
    })
}

/// One level-2 row: ["price", "size", num_orders]. Malformed rows are skipped.
fn parse_level(row: &serde_json::Value) -> Option<BookLevel> {
    let arr = row.as_array()?;
    Some(BookLevel {
        price: as_num(arr.first())?,
        size: as_num(arr.get(1))?,
    })
}

/// Truncate a Coinbase level-2 book to `depth` rows per side.
pub fn parse_book(
    product: &str,
    body: &serde_json::Value,
    depth: usize,
) -> Result<MarketBook, LoomError> {
    let side = |key: &str| -> Option<Vec<BookLevel>> {
        body.get(key)
            .and_then(|v| v.as_array())
            .map(|rows| rows.iter().filter_map(parse_level).take(depth).collect())
    };
    let bids = side("bids");
    let asks = side("asks");
    if bids.is_none() && asks.is_none() {
        return Err(LoomError::Parse(format!("coinbase book: no sides for {product}")));
    }
    Ok(MarketBook {
        product: product.to_string(),
        bids: bids.unwrap_or_default(),
        asks: asks.unwrap_or_default(),
    })
}

/// Cap Coinbase recent trades at `cap`; malformed rows are skipped.
pub fn parse_trades(body: &serde_json::Value, cap: usize) -> Result<Vec<MarketTrade>, LoomError> {
    let rows = body
        .as_array()
        .ok_or_else(|| LoomError::Parse("coinbase trades: not an array".to_string()))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            Some(MarketTrade {
                trade_id: r.get("trade_id").and_then(|v| v.as_u64())?,
                time: r.get("time").and_then(|v| v.as_str())?.to_string(),
                price: as_num(r.get("price"))?,
                size: as_num(r.get("size"))?,
                side: r.get("side").and_then(|v| v.as_str())?.to_string(),
            })
        })
        .take(cap)
        .collect())
}

/// Normalize a Frankfurter /v1/latest body.
pub fn parse_fx(body: &serde_json::Value) -> Result<MarketFx, LoomError> {
    let base = body
        .get("base")
        .and_then(|v| v.as_str())
        .ok_or_else(|| LoomError::Parse("frankfurter: no base".to_string()))?;
    let date = body
        .get("date")
        .and_then(|v| v.as_str())
        .ok_or_else(|| LoomError::Parse("frankfurter: no date".to_string()))?;
    let rates_obj = body
        .get("rates")
        .and_then(|v| v.as_object())
        .ok_or_else(|| LoomError::Parse("frankfurter: no rates".to_string()))?;
    let mut rates = BTreeMap::new();
    for (code, v) in rates_obj {
        if let Some(n) = as_num(Some(v)) {
            rates.insert(code.clone(), n);
        }
    }
    Ok(MarketFx {
        base: base.to_string(),
        date: date.to_string(),
        rates,
    })
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Yahoo intraday chart for one symbol (query2 retry on 429/5xx).
#[tauri::command]
pub async fn market_chart(symbol: String) -> Result<MarketChart, LoomError> {
    if !is_valid_symbol(&symbol) {
        return Err(invalid("symbol", &symbol, "^[A-Z0-9.^=-]{1,12}$"));
    }
    let client = market_client()?;
    let body = yahoo_get(&client, &symbol).await?;
    parse_chart(&symbol, &body)
}

/// Coinbase spot + 24h stats, merged. Stats failure degrades to None fields.
#[tauri::command]
pub async fn market_crypto(product: String) -> Result<MarketCrypto, LoomError> {
    if !is_valid_product(&product) {
        return Err(invalid("product", &product, "the product whitelist"));
    }
    let client = market_client()?;
    let ticker_url = format!("{COINBASE}/products/{product}/ticker");
    let stats_url = format!("{COINBASE}/products/{product}/stats");
    let (ticker, stats) = tokio::join!(
        get_json(&client, &ticker_url),
        get_json(&client, &stats_url),
    );
    let ticker = ticker?;
    let stats = stats.unwrap_or(serde_json::Value::Null);
    parse_crypto(&product, &ticker, &stats)
}

/// Coinbase level-2 order book, truncated to `depth` (clamped 1–50) per side.
#[tauri::command]
pub async fn market_book(product: String, depth: u32) -> Result<MarketBook, LoomError> {
    if !is_valid_product(&product) {
        return Err(invalid("product", &product, "the product whitelist"));
    }
    let depth = clamp_depth(depth);
    let client = market_client()?;
    let body = get_json(&client, &format!("{COINBASE}/products/{product}/book?level=2")).await?;
    parse_book(&product, &body, depth)
}

/// Coinbase recent trades, newest first, capped at 30.
#[tauri::command]
pub async fn market_trades(product: String) -> Result<Vec<MarketTrade>, LoomError> {
    if !is_valid_product(&product) {
        return Err(invalid("product", &product, "the product whitelist"));
    }
    let client = market_client()?;
    let body = get_json(&client, &format!("{COINBASE}/products/{product}/trades")).await?;
    parse_trades(&body, TRADES_CAP)
}

/// Frankfurter latest daily FX rates for `base` against `symbols`.
#[tauri::command]
pub async fn market_fx(base: String, symbols: Vec<String>) -> Result<MarketFx, LoomError> {
    if !is_valid_fx_code(&base) {
        return Err(invalid("fx base", &base, "^[A-Z]{3}$"));
    }
    if symbols.is_empty() {
        return Err(LoomError::Parse("fx symbols: empty list".to_string()));
    }
    for code in &symbols {
        if !is_valid_fx_code(code) {
            return Err(invalid("fx code", code, "^[A-Z]{3}$"));
        }
    }
    let client = market_client()?;
    let url = format!("{FRANKFURTER}/v1/latest?base={base}&symbols={}", symbols.join(","));
    let body = get_json(&client, &url).await?;
    parse_fx(&body)
}

/// Legacy batch chart fetch (folded in from quotes.rs — command name and output
/// contract unchanged). Validates all symbols (reject-all on any invalid),
/// fetches concurrently, returns a JSON array string:
///   `[{"symbol":"SPY","body":<raw JSON or null>},...]`
/// Individual fetch failures produce a null body (partial success). Now carries
/// the browser UA + query2 retry, which is what un-blanks the Terminal deck.
#[tauri::command]
pub async fn quote_fetch(symbols: Vec<String>) -> Result<String, LoomError> {
    for sym in &symbols {
        if !is_valid_symbol(sym) {
            return Err(invalid("symbol", sym, "^[A-Z0-9.^=-]{1,12}$"));
        }
    }

    let client = market_client()?;

    let handles: Vec<_> = symbols
        .iter()
        .map(|sym| {
            let client = client.clone();
            let sym = sym.clone();
            async move {
                let body = yahoo_get(&client, &sym).await.ok();
                (sym, body)
            }
        })
        .collect();

    let results = futures_util::future::join_all(handles).await;

    let mut arr = Vec::with_capacity(results.len());
    for (symbol, body) in results {
        let entry = match body {
            Some(v) => serde_json::json!({ "symbol": symbol, "body": v }),
            None => serde_json::json!({ "symbol": symbol, "body": null }),
        };
        arr.push(entry);
    }

    serde_json::to_string(&arr).map_err(|e| LoomError::Parse(e.to_string()))
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Symbol validation ─────────────────────────────────────────────────────

    #[test]
    fn valid_symbols_accepted() {
        for sym in &["SPY", "^VIX", "^TNX", "GC=F", "CL=F", "BTC-USD", "BRK.B", "A", "ABCDEFGHIJKL"] {
            assert!(is_valid_symbol(sym), "{sym} should be valid");
        }
    }

    #[test]
    fn invalid_symbols_rejected() {
        for sym in &["", "bad sym", "ABCDEFGHIJKLM", "$PY", "../x", "spy", "S;Y", "A/B", "A?B"] {
            assert!(!is_valid_symbol(sym), "{sym:?} should be invalid");
        }
    }

    // ── Product validation ────────────────────────────────────────────────────

    #[test]
    fn whitelisted_products_accepted() {
        for p in &["BTC-USD", "ETH-USD", "SOL-USD"] {
            assert!(is_valid_product(p), "{p} should be valid");
        }
    }

    #[test]
    fn non_whitelisted_products_rejected() {
        // Shape-valid but not whitelisted, plus outright garbage.
        for p in &["DOGE-USD", "XRP-USD", "btc-usd", "BTC-EUR", "BTC", "", "BTC-USD/../x"] {
            assert!(!is_valid_product(p), "{p:?} should be invalid");
        }
    }

    // ── FX code validation ────────────────────────────────────────────────────

    #[test]
    fn valid_fx_codes_accepted() {
        for c in &["USD", "EUR", "GBP", "JPY"] {
            assert!(is_valid_fx_code(c), "{c} should be valid");
        }
    }

    #[test]
    fn invalid_fx_codes_rejected() {
        for c in &["", "US", "USDX", "usd", "U$D", "1SD"] {
            assert!(!is_valid_fx_code(c), "{c:?} should be invalid");
        }
    }

    // ── Depth clamp ───────────────────────────────────────────────────────────

    #[test]
    fn depth_clamped_to_1_50() {
        assert_eq!(clamp_depth(0), 1);
        assert_eq!(clamp_depth(1), 1);
        assert_eq!(clamp_depth(12), 12);
        assert_eq!(clamp_depth(50), 50);
        assert_eq!(clamp_depth(51), 50);
        assert_eq!(clamp_depth(u32::MAX), 50);
    }

    // ── Transient classification ──────────────────────────────────────────────

    #[test]
    fn transient_statuses() {
        for s in [429u16, 500, 502, 503, 504] {
            assert!(is_transient(s), "{s} is transient");
        }
        for s in [200u16, 400, 401, 404] {
            assert!(!is_transient(s), "{s} is not transient");
        }
    }

    // ── URL builder ───────────────────────────────────────────────────────────

    #[test]
    fn yahoo_url_plain_symbol() {
        let url = yahoo_chart_url(YAHOO_HOSTS[0], "SPY");
        assert!(url.starts_with("https://query1.finance.yahoo.com/v8/finance/chart/SPY"));
        assert!(url.contains("interval=15m") && url.contains("range=1d"));
    }

    #[test]
    fn yahoo_url_encodes_specials_and_query2_host() {
        assert!(yahoo_chart_url(YAHOO_HOSTS[1], "^VIX").contains("query2.finance.yahoo.com"));
        assert!(yahoo_chart_url(YAHOO_HOSTS[0], "^VIX").contains("%5EVIX"));
        assert!(yahoo_chart_url(YAHOO_HOSTS[0], "GC=F").contains("GC%3DF"));
        assert!(yahoo_chart_url(YAHOO_HOSTS[0], "BTC-USD").contains("BTC-USD"));
        assert!(yahoo_chart_url(YAHOO_HOSTS[0], "BRK.B").contains("BRK.B"));
    }

    // ── parse_chart ───────────────────────────────────────────────────────────

    fn chart_fixture() -> serde_json::Value {
        serde_json::json!({
            "chart": {
                "result": [{
                    "meta": {
                        "symbol": "SPY",
                        "shortName": "SPDR S&P 500",
                        "regularMarketPrice": 450.5,
                        "chartPreviousClose": 445.0
                    },
                    "timestamp": [1000, 1060, 1120, 1180],
                    "indicators": { "quote": [{
                        "close":  [448.0, null, 450.5, 451.0],
                        "open":   [447.5, null, 450.0, 450.6],
                        "high":   [448.5, null, 451.2, 451.5],
                        "low":    [447.0, null, 449.8, 450.2],
                        "volume": [1000,  null, 2000,  1500]
                    }]}
                }],
                "error": null
            }
        })
    }

    #[test]
    fn parse_chart_full_fixture() {
        let c = parse_chart("SPY", &chart_fixture()).unwrap();
        assert_eq!(c.symbol, "SPY");
        assert_eq!(c.name.as_deref(), Some("SPDR S&P 500"));
        assert_eq!(c.price, 450.5);
        assert_eq!(c.prev_close, 445.0);
        // Nulls dropped pairwise, timestamps stay aligned.
        assert_eq!(c.closes, vec![448.0, 450.5, 451.0]);
        assert_eq!(c.timestamps, vec![1000, 1120, 1180]);
        // Day OHLC/volume derived from the series.
        assert_eq!(c.open, Some(447.5));
        assert_eq!(c.high, Some(451.5));
        assert_eq!(c.low, Some(447.0));
        assert_eq!(c.volume, Some(4500.0));
    }

    #[test]
    fn parse_chart_missing_price_is_err() {
        let body = serde_json::json!({"chart":{"result":[{"meta":{"shortName":"X"}}]}});
        assert!(parse_chart("X", &body).is_err());
    }

    #[test]
    fn parse_chart_no_result_is_err() {
        let body = serde_json::json!({"chart":{"result":[], "error": {"code": "Not Found"}}});
        assert!(parse_chart("NOPE", &body).is_err());
    }

    #[test]
    fn parse_chart_prev_close_fallback_chain() {
        // No chartPreviousClose → previousClose; zero → price itself.
        let body = serde_json::json!({"chart":{"result":[{"meta":{
            "regularMarketPrice": 10.0, "previousClose": 8.0}}]}});
        assert_eq!(parse_chart("A", &body).unwrap().prev_close, 8.0);
        let body = serde_json::json!({"chart":{"result":[{"meta":{
            "regularMarketPrice": 10.0, "chartPreviousClose": 0.0}}]}});
        assert_eq!(parse_chart("A", &body).unwrap().prev_close, 10.0);
        let body = serde_json::json!({"chart":{"result":[{"meta":{
            "regularMarketPrice": 10.0}}]}});
        let c = parse_chart("A", &body).unwrap();
        assert_eq!(c.prev_close, 10.0);
        // No series → empty arrays, None OHLC.
        assert!(c.closes.is_empty() && c.timestamps.is_empty());
        assert!(c.open.is_none() && c.volume.is_none());
    }

    // ── parse_crypto ──────────────────────────────────────────────────────────

    fn ticker_fixture() -> serde_json::Value {
        serde_json::json!({
            "ask": "77361.43", "bid": "77361.42", "volume": "8236.076",
            "trade_id": 1077999263u64, "price": "77361.43", "size": "0.00021692",
            "time": "2026-08-22T17:51:35.388253286Z"
        })
    }

    fn stats_fixture() -> serde_json::Value {
        serde_json::json!({
            "open": "77376.05", "high": "78828.37", "low": "76471.7",
            "last": "77353.5", "volume": "8236.076", "volume_30day": "191406.87"
        })
    }

    #[test]
    fn parse_crypto_merges_ticker_and_stats() {
        let c = parse_crypto("BTC-USD", &ticker_fixture(), &stats_fixture()).unwrap();
        assert_eq!(c.product, "BTC-USD");
        assert_eq!(c.price, 77361.43); // string number parsed
        assert_eq!(c.bid, Some(77361.42));
        assert_eq!(c.ask, Some(77361.43));
        assert_eq!(c.open_24h, Some(77376.05));
        assert_eq!(c.high_24h, Some(78828.37));
        assert_eq!(c.low_24h, Some(76471.7));
        assert_eq!(c.volume_24h, Some(8236.076));
        let pct = c.change_pct_24h.unwrap();
        assert!((pct - ((77361.43 - 77376.05) / 77376.05 * 100.0)).abs() < 1e-9);
        assert_eq!(c.time.as_deref(), Some("2026-08-22T17:51:35.388253286Z"));
    }

    #[test]
    fn parse_crypto_null_stats_degrades_to_none() {
        let c = parse_crypto("ETH-USD", &ticker_fixture(), &serde_json::Value::Null).unwrap();
        assert_eq!(c.price, 77361.43);
        assert!(c.open_24h.is_none() && c.change_pct_24h.is_none() && c.volume_24h.is_none());
    }

    #[test]
    fn parse_crypto_missing_price_is_err() {
        let t = serde_json::json!({"bid": "1.0"});
        assert!(parse_crypto("BTC-USD", &t, &stats_fixture()).is_err());
    }

    // ── parse_book ────────────────────────────────────────────────────────────

    fn book_fixture() -> serde_json::Value {
        serde_json::json!({
            "sequence": 123,
            "bids": [
                ["77361.42", "0.061", 4], ["77360.41", "0.02", 1],
                ["77360.16", "0.00007", 1], ["bogus"],
                ["77359.90", "0.001", 1]
            ],
            "asks": [
                ["77361.43", "0.5", 2], ["77362.00", "1.25", 1]
            ]
        })
    }

    #[test]
    fn parse_book_truncates_per_side_and_skips_malformed() {
        let b = parse_book("BTC-USD", &book_fixture(), 2).unwrap();
        assert_eq!(b.product, "BTC-USD");
        assert_eq!(b.bids.len(), 2);
        assert_eq!(b.asks.len(), 2);
        assert_eq!(b.bids[0].price, 77361.42);
        assert_eq!(b.bids[0].size, 0.061);
        assert_eq!(b.asks[1].price, 77362.00);
    }

    #[test]
    fn parse_book_depth_beyond_rows_takes_all_valid() {
        let b = parse_book("BTC-USD", &book_fixture(), 50).unwrap();
        assert_eq!(b.bids.len(), 4, "malformed row skipped, 4 valid bids remain");
        assert_eq!(b.asks.len(), 2);
    }

    #[test]
    fn parse_book_no_sides_is_err() {
        assert!(parse_book("BTC-USD", &serde_json::json!({"sequence": 1}), 10).is_err());
    }

    // ── parse_trades ──────────────────────────────────────────────────────────

    fn trades_fixture(n: usize) -> serde_json::Value {
        let rows: Vec<serde_json::Value> = (0..n)
            .map(|i| {
                serde_json::json!({
                    "trade_id": 1000 + i as u64,
                    "side": if i % 2 == 0 { "buy" } else { "sell" },
                    "size": "0.0024",
                    "price": "77367.82",
                    "time": "2026-08-22T17:51:34.074499Z"
                })
            })
            .collect();
        serde_json::Value::Array(rows)
    }

    #[test]
    fn parse_trades_caps_at_limit() {
        let t = parse_trades(&trades_fixture(45), TRADES_CAP).unwrap();
        assert_eq!(t.len(), 30);
        assert_eq!(t[0].trade_id, 1000);
        assert_eq!(t[0].side, "buy");
        assert_eq!(t[1].side, "sell");
        assert_eq!(t[0].price, 77367.82);
        assert_eq!(t[0].size, 0.0024);
        assert_eq!(t[0].time, "2026-08-22T17:51:34.074499Z");
    }

    #[test]
    fn parse_trades_under_cap_and_skips_malformed() {
        let mut rows = trades_fixture(3);
        rows.as_array_mut().unwrap().push(serde_json::json!({"garbage": true}));
        let t = parse_trades(&rows, TRADES_CAP).unwrap();
        assert_eq!(t.len(), 3);
    }

    #[test]
    fn parse_trades_non_array_is_err() {
        assert!(parse_trades(&serde_json::json!({"message": "NotFound"}), 30).is_err());
    }

    // ── parse_fx ──────────────────────────────────────────────────────────────

    #[test]
    fn parse_fx_fixture() {
        let body = serde_json::json!({
            "amount": 1.0, "base": "USD", "date": "2026-08-21",
            "rates": {"EUR": 0.85477, "GBP": 0.73228, "JPY": 158.7}
        });
        let fx = parse_fx(&body).unwrap();
        assert_eq!(fx.base, "USD");
        assert_eq!(fx.date, "2026-08-21");
        assert_eq!(fx.rates.len(), 3);
        assert_eq!(fx.rates["EUR"], 0.85477);
        assert_eq!(fx.rates["JPY"], 158.7);
    }

    #[test]
    fn parse_fx_missing_rates_is_err() {
        assert!(parse_fx(&serde_json::json!({"base": "USD", "date": "2026-08-21"})).is_err());
    }

    // ── as_num ────────────────────────────────────────────────────────────────

    #[test]
    fn as_num_accepts_strings_and_numbers_rejects_junk() {
        assert_eq!(as_num(Some(&serde_json::json!(1.5))), Some(1.5));
        assert_eq!(as_num(Some(&serde_json::json!("1.5"))), Some(1.5));
        assert_eq!(as_num(Some(&serde_json::json!("nope"))), None);
        assert_eq!(as_num(Some(&serde_json::json!(null))), None);
        assert_eq!(as_num(Some(&serde_json::json!("NaN"))), None, "NaN is not finite");
        assert_eq!(as_num(None), None);
    }

    // ── quote_fetch response assembly (contract carried over from quotes.rs) ─

    #[test]
    fn quote_fetch_response_assembly_shape() {
        let results = vec![
            ("SPY".to_string(), Some(serde_json::json!({"chart": {}}))),
            ("^VIX".to_string(), None),
        ];
        let mut arr = Vec::new();
        for (symbol, body) in results {
            arr.push(match body {
                Some(v) => serde_json::json!({ "symbol": symbol, "body": v }),
                None => serde_json::json!({ "symbol": symbol, "body": null }),
            });
        }
        let s = serde_json::to_string(&arr).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["symbol"].as_str().unwrap(), "SPY");
        assert!(parsed[0]["body"].is_object());
        assert!(parsed[1]["body"].is_null());
    }

    // ── Serialized field names (the TS contract) ──────────────────────────────

    #[test]
    fn serialized_shapes_are_camel_case() {
        let c = parse_chart("SPY", &chart_fixture()).unwrap();
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("prevClose").is_some(), "prev_close → prevClose");
        assert!(v.get("prev_close").is_none());

        let cr = parse_crypto("BTC-USD", &ticker_fixture(), &stats_fixture()).unwrap();
        let v = serde_json::to_value(&cr).unwrap();
        assert!(v.get("open24h").is_some(), "open_24h → open24h");
        assert!(v.get("changePct24h").is_some(), "change_pct_24h → changePct24h");

        let t = parse_trades(&trades_fixture(1), 30).unwrap();
        let v = serde_json::to_value(&t[0]).unwrap();
        assert!(v.get("tradeId").is_some(), "trade_id → tradeId");
    }

    // ── Live integration (network — run manually) ─────────────────────────────
    //
    //   cd src-tauri && cargo test -- --ignored market_live
    //
    // Verifies the load-bearing repair: Yahoo's chart endpoint returns 200 for
    // the browser UA this module sends (and 429 for reqwest's default UA).

    #[tokio::test]
    #[ignore = "network: run manually with `cargo test -- --ignored market_live`"]
    async fn market_live_yahoo_ua_returns_200() {
        let client = market_client().expect("client builds");
        let url = yahoo_chart_url(YAHOO_HOSTS[0], "SPY");
        let resp = client.get(&url).send().await.expect("network reachable");
        assert_eq!(
            resp.status().as_u16(),
            200,
            "yahoo must return 200 with the browser UA (429 = the old bug)"
        );
        let body: serde_json::Value = resp.json().await.expect("json body");
        assert!(parse_chart("SPY", &body).is_ok(), "live body parses into MarketChart");
    }
}
