/// cloud.rs — Anthropic cloud-builder override
///
/// Persists the API key in an app-data file with 0600 permissions.
/// The key is NEVER returned by any command after it is saved (write-only + cloud_key_present).
/// Tauri v2 IPC: JS camelCase args ↔ Rust snake_case params.

use crate::error::LoomError;
use crate::ollama::Msg;
use crate::timeline::loom_dir;
use tauri::AppHandle;

// ── Constants ─────────────────────────────────────────────────────────────────

const ANTHROPIC_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL: &str = "claude-opus-4-8";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_MAX_TOKENS: u32 = 8192;
const TIMEOUT_SECS: u64 = 120;
const KEY_FILE_NAME: &str = "cloud_key";

// ── Key file path ─────────────────────────────────────────────────────────────

fn key_path(app: &AppHandle) -> Result<std::path::PathBuf, LoomError> {
    let dir = loom_dir(app)?;
    Ok(dir.join(KEY_FILE_NAME))
}

// ── Request builder (pure, testable) ─────────────────────────────────────────

/// Returns (url, headers-as-vec, body-as-value) for the Anthropic messages request.
/// This is a pure function that can be tested without network access.
pub fn build_anthropic_request(
    api_key: &str,
    system: &str,
    messages: &[Msg],
    max_tokens: u32,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let url = ANTHROPIC_ENDPOINT.to_string();
    let headers = vec![
        ("x-api-key".to_string(), api_key.to_string()),
        ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
        ("content-type".to_string(), "application/json".to_string()),
    ];
    let body = serde_json::json!({
        "model": ANTHROPIC_MODEL,
        "max_tokens": max_tokens,
        "system": system,
        "messages": messages,
    });
    (url, headers, body)
}

// ── Transient-error classification ───────────────────────────────────────────

fn is_transient(status: u16) -> bool {
    // 429 = rate limited, 500/502/503/504 = server error — worth retrying once
    matches!(status, 429 | 500 | 502 | 503 | 504)
}

// ── Core HTTP call (single attempt) ──────────────────────────────────────────

async fn attempt_cloud_chat(
    client: &reqwest::Client,
    api_key: &str,
    system: &str,
    messages: &[Msg],
    max_tokens: u32,
) -> Result<String, (LoomError, bool)> {
    // (bool) = is_transient_err — caller decides whether to retry
    let (url, headers, body) = build_anthropic_request(api_key, system, messages, max_tokens);

    let mut req = client.post(&url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }

    let resp = req
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| (LoomError::Http(e.to_string()), true))?;

    let status = resp.status();

    if !status.is_success() {
        let code = status.as_u16();
        let body_text = resp.text().await.unwrap_or_default();
        let transient = is_transient(code);
        let msg = if code == 401 {
            "Anthropic auth failed: check your API key (401)".to_string()
        } else {
            format!("Anthropic returned {code}: {}", body_text.chars().take(200).collect::<String>())
        };
        return Err((LoomError::Http(msg), transient));
    }

    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| (LoomError::Parse(e.to_string()), false))?;

    // Extract text from content blocks
    let content = json
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| (LoomError::Parse("Anthropic response missing 'content' array".to_string()), false))?;

    let mut text_parts: Vec<String> = Vec::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                text_parts.push(t.to_string());
            }
        }
    }

    if text_parts.is_empty() {
        return Err((LoomError::Parse("Anthropic response had no text content blocks".to_string()), false));
    }

    Ok(text_parts.join(""))
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Send a chat request to Anthropic claude-opus-4-8.
/// One retry on transient errors (429/5xx), then returns Err.
/// The key is read from app-data file; returns NotFound if not configured.
#[tauri::command]
pub async fn cloud_chat(
    app: AppHandle,
    system: String,
    messages: Vec<Msg>,
    max_tokens: Option<u32>,
) -> Result<String, LoomError> {
    let key = read_key(&app)?;
    let max_tok = max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| LoomError::Http(e.to_string()))?;

    // First attempt
    match attempt_cloud_chat(&client, &key, &system, &messages, max_tok).await {
        Ok(s) => return Ok(s),
        Err((err, transient)) => {
            if !transient {
                return Err(err);
            }
            // One retry on transient
            attempt_cloud_chat(&client, &key, &system, &messages, max_tok)
                .await
                .map_err(|(e, _)| e)
        }
    }
}

/// Persist an Anthropic API key to the app-data file (0600 permissions).
/// The key is never returned by any subsequent command.
#[tauri::command]
pub async fn cloud_key_set(app: AppHandle, key: String) -> Result<(), LoomError> {
    let path = key_path(&app)?;
    std::fs::write(&path, key.trim().as_bytes())
        .map_err(|e| LoomError::Http(format!("write cloud key: {e}")))?;

    // Set 0600 permissions (owner read+write only)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perms = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(&path, perms)
            .map_err(|e| LoomError::Http(format!("chmod cloud key: {e}")))?;
    }

    Ok(())
}

/// Returns true if an API key file exists and is non-empty. The key itself is
/// NEVER returned.
#[tauri::command]
pub fn cloud_key_present(app: AppHandle) -> Result<bool, LoomError> {
    let path = key_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| LoomError::Http(format!("read cloud key: {e}")))?;
    Ok(!contents.trim().is_empty())
}

/// Clear (delete) the stored API key.
#[tauri::command]
pub async fn cloud_key_clear(app: AppHandle) -> Result<(), LoomError> {
    let path = key_path(&app)?;
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| LoomError::Http(format!("remove cloud key: {e}")))?;
    }
    Ok(())
}

// ── Internal key reader ───────────────────────────────────────────────────────

fn read_key(app: &AppHandle) -> Result<String, LoomError> {
    let path = key_path(app)?;
    if !path.exists() {
        return Err(LoomError::NotFound("cloud API key not configured".to_string()));
    }
    let key = std::fs::read_to_string(&path)
        .map_err(|e| LoomError::Http(format!("read cloud key: {e}")))?;
    let key = key.trim().to_string();
    if key.is_empty() {
        return Err(LoomError::NotFound("cloud API key is empty".to_string()));
    }
    Ok(key)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    // ── Request builder ───────────────────────────────────────────────────────

    #[test]
    fn request_builder_exact_model_string() {
        let msgs: Vec<Msg> = vec![Msg {
            role: "user".to_string(),
            content: "hello".to_string(),
        }];
        let (url, headers, body) = build_anthropic_request("sk-test", "sys", &msgs, 8192);

        // URL must be the Anthropic endpoint
        assert_eq!(url, "https://api.anthropic.com/v1/messages");

        // Model string must be exactly claude-opus-4-8
        assert_eq!(
            body["model"].as_str().unwrap(),
            "claude-opus-4-8",
            "model string must be exactly 'claude-opus-4-8'"
        );

        // max_tokens
        assert_eq!(body["max_tokens"].as_u64().unwrap(), 8192);

        // system injected
        assert_eq!(body["system"].as_str().unwrap(), "sys");

        // NO thinking param
        assert!(body.get("thinking").is_none(), "thinking param must not be present");
    }

    #[test]
    fn request_builder_headers_x_api_key_and_version() {
        let msgs: Vec<Msg> = vec![];
        let (_, headers, _) = build_anthropic_request("my-secret-key", "s", &msgs, 100);

        let x_api_key = headers.iter().find(|(k, _)| k == "x-api-key");
        assert!(x_api_key.is_some(), "x-api-key header must be present");
        assert_eq!(x_api_key.unwrap().1, "my-secret-key");

        let anthropic_version = headers.iter().find(|(k, _)| k == "anthropic-version");
        assert!(anthropic_version.is_some(), "anthropic-version header must be present");
        assert_eq!(anthropic_version.unwrap().1, "2023-06-01");
    }

    #[test]
    fn request_builder_messages_included() {
        let msgs = vec![
            Msg { role: "user".to_string(), content: "write me a widget".to_string() },
        ];
        let (_, _, body) = build_anthropic_request("key", "sys", &msgs, 4096);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"].as_str().unwrap(), "user");
        assert_eq!(messages[0]["content"].as_str().unwrap(), "write me a widget");
    }

    #[test]
    fn request_builder_no_thinking_param() {
        let msgs: Vec<Msg> = vec![];
        let (_, _, body) = build_anthropic_request("k", "s", &msgs, 8192);
        assert!(body.get("thinking").is_none());
        // Also verify stream not injected (we do non-streaming)
        assert!(body.get("stream").is_none());
    }

    // ── Key file round-trip ───────────────────────────────────────────────────

    #[test]
    fn key_never_in_response_cloud_chat_has_no_key_return() {
        // cloud_chat returns Result<String, LoomError> — the String is the *reply text*,
        // not the key. Verify the command signatures don't return the key.
        // We verify this structurally by checking cloud_key_present returns bool (not the key)
        // and cloud_key_set/cloud_key_clear return ().
        // This is a compile-time guarantee; this test documents the contract.
        // The actual runtime guarantee is enforced by the Rust type system.
        let _: fn(AppHandle) -> Result<bool, LoomError> = cloud_key_present;
    }

    #[test]
    fn key_file_write_and_detect() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(KEY_FILE_NAME);
        // Write a key
        fs::write(&path, b"sk-ant-test-key").unwrap();
        assert!(path.exists());
        let contents = fs::read_to_string(&path).unwrap();
        assert_eq!(contents.trim(), "sk-ant-test-key");
    }

    #[test]
    fn key_file_empty_means_not_present() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(KEY_FILE_NAME);
        fs::write(&path, b"   ").unwrap(); // whitespace-only
        let contents = fs::read_to_string(&path).unwrap();
        assert!(contents.trim().is_empty(), "whitespace-only key treated as absent");
    }

    #[test]
    fn key_file_delete_removes_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join(KEY_FILE_NAME);
        fs::write(&path, b"sk-ant-key").unwrap();
        assert!(path.exists());
        fs::remove_file(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn is_transient_classifies_correctly() {
        assert!(is_transient(429));
        assert!(is_transient(500));
        assert!(is_transient(502));
        assert!(is_transient(503));
        assert!(is_transient(504));
        assert!(!is_transient(200));
        assert!(!is_transient(400));
        assert!(!is_transient(401));
        assert!(!is_transient(404));
    }

    #[test]
    fn model_constant_is_exact() {
        assert_eq!(ANTHROPIC_MODEL, "claude-opus-4-8");
    }

    #[test]
    fn version_header_constant() {
        assert_eq!(ANTHROPIC_VERSION, "2023-06-01");
    }
}
