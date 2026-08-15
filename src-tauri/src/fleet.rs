use crate::error::LoomError;
use crate::ollama::{ChatOpts, Msg, Ollama};
use serde::{Deserialize, Serialize};

pub struct FleetConfig { pub builder: String, pub companion: String, pub rewriter: String }
impl Default for FleetConfig {
    fn default() -> Self {
        Self {
            builder: "qwen3-coder:30b-a3b-q4_K_M".into(),
            companion: "gpt-oss:20b".into(),
            rewriter: "qwen3:1.7b".into(),
        }
    }
}

/// Hand-rolled Ollama model-tag validator (no regex crate).
/// Regex: ^[A-Za-z0-9][A-Za-z0-9._\-\/]*(:[A-Za-z0-9._\-]+)?$, max 128 chars.
pub fn is_valid_model_tag(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 128 {
        return false;
    }
    let bytes = tag.as_bytes();
    // First char: alphanumeric only
    if !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    // Split on ':' — at most one colon allowed
    let colon_count = tag.bytes().filter(|&b| b == b':').count();
    if colon_count > 1 {
        return false;
    }
    if let Some(colon_pos) = tag.find(':') {
        // validate prefix (before colon): [A-Za-z0-9._\-\/]*
        let prefix = &tag[1..colon_pos];
        if !prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' || b == b'/') {
            return false;
        }
        // suffix (after colon): [A-Za-z0-9._\-]+ (non-empty)
        let suffix = &tag[colon_pos + 1..];
        if suffix.is_empty() {
            return false;
        }
        if !suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-') {
            return false;
        }
    } else {
        // No colon — rest of string: [A-Za-z0-9._\-\/]*
        let rest = &tag[1..];
        if !rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-' || b == b'/') {
            return false;
        }
    }
    true
}

#[derive(Deserialize, Default)]
pub struct FleetOverrides {
    pub builder: Option<String>,
    pub companion: Option<String>,
    pub rewriter: Option<String>,
}

/// Merge non-empty, regex-valid overrides over FleetConfig::default().
/// Invalid or empty overrides are silently ignored — the default is kept.
pub fn effective_config(overrides: &FleetOverrides) -> FleetConfig {
    let mut cfg = FleetConfig::default();
    if let Some(ref v) = overrides.builder {
        if !v.is_empty() && is_valid_model_tag(v) { cfg.builder = v.clone(); }
    }
    if let Some(ref v) = overrides.companion {
        if !v.is_empty() && is_valid_model_tag(v) { cfg.companion = v.clone(); }
    }
    if let Some(ref v) = overrides.rewriter {
        if !v.is_empty() && is_valid_model_tag(v) { cfg.rewriter = v.clone(); }
    }
    cfg
}

pub fn role_model(c: &FleetConfig, r: &str) -> Option<String> {
    match r {
        "builder" => Some(c.builder.clone()),
        "companion" => Some(c.companion.clone()),
        "rewriter" => Some(c.rewriter.clone()),
        _ => None,
    }
}

pub fn best_coder(installed: &[String]) -> Option<String> {
    fn params(tag: &str) -> f32 {
        let lower = tag.to_lowercase();
        let bytes = lower.as_bytes();
        let mut best = 0.0f32;
        for (i, _) in lower.match_indices('b') {
            let mut j = i;
            while j > 0 && (bytes[j - 1].is_ascii_digit() || bytes[j - 1] == b'.') { j -= 1; }
            if j < i {
                if let Ok(v) = lower[j..i].parse::<f32>() { if v > best { best = v; } }
            }
        }
        best
    }
    installed.iter()
        .filter(|m| m.to_lowercase().contains("coder"))
        .max_by(|a, b| params(a).partial_cmp(&params(b)).unwrap_or(std::cmp::Ordering::Equal))
        .cloned()
}

pub fn fallback_for(c: &FleetConfig, role: &str, installed: &[String]) -> String {
    if role == "builder" {
        if let Some(m) = best_coder(installed) { return m; }
    }
    c.rewriter.clone()
}

pub fn health(installed: &[String], c: &FleetConfig) -> Vec<(String, String, bool)> {
    ["builder", "companion", "rewriter"].iter().map(|role| {
        let m = role_model(c, role).unwrap();
        let present = installed.iter().any(|i| i == &m);
        (role.to_string(), m, present)
    }).collect()
}

#[derive(Serialize)]
pub struct RoleStatus { pub role: String, pub model: String, pub present: bool }

const OLLAMA: &str = "http://localhost:11434";
const KEEP_ALIVE: i64 = -1;         // pin resident
const TIMEOUT_MS: u64 = 45_000;

#[tauri::command]
pub async fn fleet_status(overrides: Option<FleetOverrides>) -> Result<Vec<RoleStatus>, LoomError> {
    let cfg = effective_config(&overrides.unwrap_or_default());
    let installed = Ollama::new(OLLAMA).tags().await.unwrap_or_default();
    Ok(health(&installed, &cfg).into_iter()
        .map(|(role, model, present)| RoleStatus { role, model, present }).collect())
}

#[tauri::command]
pub async fn fleet_chat(role: String, messages: Vec<Msg>, opts: Option<ChatOpts>, overrides: Option<FleetOverrides>) -> Result<String, LoomError> {
    let cfg = effective_config(&overrides.unwrap_or_default());
    let opts = opts.unwrap_or_default();
    let primary = role_model(&cfg, &role).ok_or(LoomError::NotFound(role.clone()))?;
    let o = Ollama::new(OLLAMA);
    // one retry on primary, then fall back
    for attempt in 0..2 {
        match o.chat(&primary, messages.clone(), KEEP_ALIVE, TIMEOUT_MS, &opts).await {
            Ok(s) => return Ok(s),
            Err(LoomError::NotFound(_)) => break,               // pulling won't help this call; fall back
            Err(LoomError::Timeout) => break,                   // timeout = model stuck; go straight to fallback
            Err(_) if attempt == 0 => continue,                  // transient: retry once
            Err(_) => break,
        }
    }
    let installed = o.tags().await.unwrap_or_default();
    let fb = fallback_for(&cfg, &role, &installed);
    o.chat(&fb, messages, KEEP_ALIVE, TIMEOUT_MS, &opts).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_roles_to_models() {
        let c = FleetConfig::default();
        assert_eq!(role_model(&c, "builder").unwrap(), "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(role_model(&c, "companion").unwrap(), "gpt-oss:20b");
        assert_eq!(role_model(&c, "rewriter").unwrap(), "qwen3:1.7b");
        assert!(role_model(&c, "bogus").is_none());
    }
    #[test]
    fn falls_back_to_rewriter() {
        let c = FleetConfig::default();
        assert_eq!(fallback_for(&c, "builder", &[]), "qwen3:1.7b");
        assert_eq!(fallback_for(&c, "companion", &[]), "qwen3:1.7b");
    }
    #[test]
    fn best_coder_prefers_largest_coder() {
        let installed = vec![
            "llama3.1:8b".to_string(),
            "qwen2.5-coder:7b".to_string(),
            "qwen3-coder:30b-a3b-q4_K_M".to_string(),
        ];
        assert_eq!(best_coder(&installed).unwrap(), "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(best_coder(&["llama3.1:8b".to_string()]), None);
    }
    #[test]
    fn builder_falls_back_to_installed_coder_then_rewriter() {
        let c = FleetConfig::default();
        let with_coder = vec!["qwen2.5-coder:7b".to_string()];
        assert_eq!(fallback_for(&c, "builder", &with_coder), "qwen2.5-coder:7b");
        let none: Vec<String> = vec![];
        assert_eq!(fallback_for(&c, "builder", &none), "qwen3:1.7b");
        assert_eq!(fallback_for(&c, "companion", &with_coder), "qwen3:1.7b");
    }
    #[test]
    fn health_flags_present_models() {
        let c = FleetConfig::default();
        let installed = vec!["gpt-oss:20b".to_string()];
        let h = health(&installed, &c);
        let companion = h.iter().find(|(r,_,_)| r=="companion").unwrap();
        let builder = h.iter().find(|(r,_,_)| r=="builder").unwrap();
        assert!(companion.2);   // present
        assert!(!builder.2);    // absent
    }

    // ── effective_config / FleetOverrides tests ─────────────────────────────────

    #[test]
    fn effective_config_no_overrides_returns_defaults() {
        let cfg = effective_config(&FleetOverrides::default());
        assert_eq!(cfg.builder, "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(cfg.companion, "gpt-oss:20b");
        assert_eq!(cfg.rewriter, "qwen3:1.7b");
    }

    #[test]
    fn effective_config_valid_override_wins() {
        let ov = FleetOverrides {
            builder: Some("llama3.2:8b".to_string()),
            companion: None,
            rewriter: None,
        };
        let cfg = effective_config(&ov);
        assert_eq!(cfg.builder, "llama3.2:8b");
        assert_eq!(cfg.companion, "gpt-oss:20b");   // default kept
        assert_eq!(cfg.rewriter, "qwen3:1.7b");     // default kept
    }

    #[test]
    fn effective_config_empty_string_ignored() {
        let ov = FleetOverrides {
            builder: Some("".to_string()),
            companion: Some("".to_string()),
            rewriter: Some("".to_string()),
        };
        let cfg = effective_config(&ov);
        assert_eq!(cfg.builder, "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(cfg.companion, "gpt-oss:20b");
        assert_eq!(cfg.rewriter, "qwen3:1.7b");
    }

    #[test]
    fn effective_config_invalid_tag_ignored() {
        let ov = FleetOverrides {
            builder: Some("bad tag!".to_string()),
            companion: Some("-leading".to_string()),
            rewriter: Some("a:b:c".to_string()),
        };
        let cfg = effective_config(&ov);
        // All invalid — defaults kept
        assert_eq!(cfg.builder, "qwen3-coder:30b-a3b-q4_K_M");
        assert_eq!(cfg.companion, "gpt-oss:20b");
        assert_eq!(cfg.rewriter, "qwen3:1.7b");
    }

    #[test]
    fn effective_config_overridden_rewriter_is_fallback() {
        let ov = FleetOverrides {
            rewriter: Some("phi3:3.8b".to_string()),
            builder: None,
            companion: None,
        };
        let cfg = effective_config(&ov);
        assert_eq!(cfg.rewriter, "phi3:3.8b");
        // fallback_for companion with no installed coder returns the effective rewriter
        assert_eq!(fallback_for(&cfg, "companion", &[]), "phi3:3.8b");
    }

    #[test]
    fn effective_config_all_three_overrides() {
        let ov = FleetOverrides {
            builder: Some("qwen2.5-coder:14b".to_string()),
            companion: Some("mistral:7b".to_string()),
            rewriter: Some("qwen3:0.6b".to_string()),
        };
        let cfg = effective_config(&ov);
        assert_eq!(cfg.builder, "qwen2.5-coder:14b");
        assert_eq!(cfg.companion, "mistral:7b");
        assert_eq!(cfg.rewriter, "qwen3:0.6b");
    }

    // ── is_valid_model_tag tests ────────────────────────────────────────────────

    #[test]
    fn valid_tags_accepted() {
        assert!(is_valid_model_tag("llama3.2"));
        assert!(is_valid_model_tag("qwen3-coder:30b-a3b-q4_K_M"));
        assert!(is_valid_model_tag("hf.co/user/model:Q4"));
        assert!(is_valid_model_tag("gpt-oss:20b"));
        assert!(is_valid_model_tag("phi3:3.8b"));
        assert!(is_valid_model_tag("a")); // single char is valid
    }

    #[test]
    fn invalid_tags_rejected() {
        assert!(!is_valid_model_tag("bad tag!"));   // space + special char
        assert!(!is_valid_model_tag("-leading"));   // leading hyphen
        assert!(!is_valid_model_tag("a:b:c"));      // two colons
        assert!(!is_valid_model_tag(""));            // empty
        // 129-char string
        let long = "a".repeat(129);
        assert!(!is_valid_model_tag(&long));
        // colon with empty suffix
        assert!(!is_valid_model_tag("model:"));
    }
}
