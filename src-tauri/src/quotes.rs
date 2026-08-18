/// quotes.rs — LOOM-owned Yahoo /v8/chart proxy
///
/// Validates symbols, fetches Yahoo chart data concurrently, returns a raw JSON
/// array string so the JS normalizer can do exactly what it does today.
/// No regex crate — validation is hand-rolled (matching the pattern of
/// cloud.rs's tag validator).

use crate::error::LoomError;

const YAHOO_CHART: &str = "https://query1.finance.yahoo.com/v8/finance/chart";
const REQUEST_TIMEOUT_SECS: u64 = 10;

// ── Symbol validation ─────────────────────────────────────────────────────────

/// Validate a single symbol against `^[A-Za-z0-9^.=\-]{1,12}$`.
/// Hand-rolled — no regex crate.
pub fn is_valid_symbol(s: &str) -> bool {
    if s.is_empty() || s.len() > 12 {
        return false;
    }
    s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '^' | '.' | '=' | '-'))
}

// ── URL builder (pure, testable) ──────────────────────────────────────────────

/// Build the Yahoo /v8/chart URL for a symbol.
/// Uses percent-encoding for URL-special characters in the symbol.
pub fn yahoo_chart_url(symbol: &str) -> String {
    // Symbols like ^VIX, GC=F, BTC-USD, BRK.B need URL encoding.
    let encoded: String = symbol
        .chars()
        .map(|c| match c {
            '^' => "%5E".to_string(),
            '=' => "%3D".to_string(),
            _ => c.to_string(),
        })
        .collect();
    format!("{}/{encoded}?interval=15m&range=1d", YAHOO_CHART)
}

// ── Per-symbol fetch ──────────────────────────────────────────────────────────

/// Fetch one symbol; returns raw JSON body string or None on any failure.
async fn fetch_one(client: &reqwest::Client, symbol: &str) -> Option<serde_json::Value> {
    let url = yahoo_chart_url(symbol);
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

// ── Tauri command ─────────────────────────────────────────────────────────────

/// Validate all symbols (reject-all on any invalid), fetch Yahoo chart data for
/// each concurrently, return a JSON array string:
///   `[{"symbol":"SPY","body":<raw JSON or null>},...]`
///
/// Individual fetch failures produce a null body (partial success). A bad
/// symbol in the list aborts the whole batch with Err.
#[tauri::command]
pub async fn quote_fetch(symbols: Vec<String>) -> Result<String, LoomError> {
    // Validate — reject all on any invalid symbol
    for sym in &symbols {
        if !is_valid_symbol(sym) {
            return Err(LoomError::Parse(format!(
                "invalid symbol {:?}: must match ^[A-Za-z0-9^.=\\-]{{1,12}}$",
                sym
            )));
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| LoomError::Http(e.to_string()))?;

    // Fetch all symbols concurrently with futures
    let handles: Vec<_> = symbols
        .iter()
        .map(|sym| {
            let client = client.clone();
            let sym = sym.clone();
            async move {
                let body = fetch_one(&client, &sym).await;
                (sym, body)
            }
        })
        .collect();

    let results = futures_util::future::join_all(handles).await;

    // Build the response array
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

// ── Unit tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── Symbol validation matrix ──────────────────────────────────────────────

    #[test]
    fn valid_symbols_accepted() {
        for sym in &["SPY", "^VIX", "GC=F", "BTC-USD", "BRK.B"] {
            assert!(is_valid_symbol(sym), "{sym} should be valid");
        }
    }

    #[test]
    fn invalid_space_in_symbol() {
        assert!(!is_valid_symbol("bad sym"), "space → invalid");
    }

    #[test]
    fn invalid_13_char_symbol() {
        assert!(!is_valid_symbol("ABCDEFGHIJKLM"), "13-char → invalid");
    }

    #[test]
    fn invalid_empty_symbol() {
        assert!(!is_valid_symbol(""), "empty → invalid");
    }

    #[test]
    fn invalid_dollar_sign() {
        assert!(!is_valid_symbol("$PY"), "$ → invalid");
    }

    #[test]
    fn invalid_path_traversal() {
        assert!(!is_valid_symbol("../x"), "path-traversal → invalid");
    }

    #[test]
    fn exactly_12_chars_valid() {
        assert!(is_valid_symbol("ABCDEFGHIJKL"), "12-char → valid");
    }

    #[test]
    fn single_char_valid() {
        assert!(is_valid_symbol("A"), "single char → valid");
    }

    // ── URL builder ───────────────────────────────────────────────────────────

    #[test]
    fn url_builder_plain_symbol() {
        let url = yahoo_chart_url("SPY");
        assert!(url.starts_with("https://query1.finance.yahoo.com/v8/finance/chart/SPY"));
        assert!(url.contains("interval=15m"));
        assert!(url.contains("range=1d"));
    }

    #[test]
    fn url_builder_encodes_caret() {
        let url = yahoo_chart_url("^VIX");
        assert!(url.contains("%5EVIX"), "^ must be encoded as %5E, got: {url}");
    }

    #[test]
    fn url_builder_encodes_equals() {
        let url = yahoo_chart_url("GC=F");
        assert!(url.contains("GC%3DF"), "= must be encoded as %3D, got: {url}");
    }

    #[test]
    fn url_builder_dash_and_dot_unencoded() {
        // Dashes and dots are safe in URL paths
        let url_dash = yahoo_chart_url("BTC-USD");
        assert!(url_dash.contains("BTC-USD"));
        let url_dot = yahoo_chart_url("BRK.B");
        assert!(url_dot.contains("BRK.B"));
    }

    // ── Response assembly ─────────────────────────────────────────────────────

    #[test]
    fn response_assembly_shape() {
        // Simulate what quote_fetch returns for a mix of success+null
        let results = vec![
            ("SPY".to_string(), Some(serde_json::json!({"chart": {"result": [{"meta": {"regularMarketPrice": 450.0}}]}}))),
            ("^VIX".to_string(), None),
        ];
        let mut arr = Vec::new();
        for (symbol, body) in results {
            let entry = match body {
                Some(v) => serde_json::json!({ "symbol": symbol, "body": v }),
                None => serde_json::json!({ "symbol": symbol, "body": null }),
            };
            arr.push(entry);
        }
        let s = serde_json::to_string(&arr).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&s).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["symbol"].as_str().unwrap(), "SPY");
        assert!(parsed[0]["body"].is_object());
        assert_eq!(parsed[1]["symbol"].as_str().unwrap(), "^VIX");
        assert!(parsed[1]["body"].is_null());
    }

    #[test]
    fn response_assembly_empty_input() {
        let arr: Vec<serde_json::Value> = vec![];
        let s = serde_json::to_string(&arr).unwrap();
        assert_eq!(s, "[]");
    }
}
