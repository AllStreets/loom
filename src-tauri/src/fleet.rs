use crate::error::LoomError;
use crate::ollama::{Msg, Ollama};
use serde::Serialize;

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

pub fn role_model(c: &FleetConfig, r: &str) -> Option<String> {
    match r {
        "builder" => Some(c.builder.clone()),
        "companion" => Some(c.companion.clone()),
        "rewriter" => Some(c.rewriter.clone()),
        _ => None,
    }
}

pub fn fallback_for(c: &FleetConfig, _r: &str) -> String { c.rewriter.clone() }

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
const TIMEOUT_MS: u64 = 90_000;

#[tauri::command]
pub async fn fleet_status() -> Result<Vec<RoleStatus>, LoomError> {
    let cfg = FleetConfig::default();
    let installed = Ollama::new(OLLAMA).tags().await.unwrap_or_default();
    Ok(health(&installed, &cfg).into_iter()
        .map(|(role, model, present)| RoleStatus { role, model, present }).collect())
}

#[tauri::command]
pub async fn fleet_chat(role: String, messages: Vec<Msg>) -> Result<String, LoomError> {
    let cfg = FleetConfig::default();
    let primary = role_model(&cfg, &role).ok_or(LoomError::NotFound(role.clone()))?;
    let o = Ollama::new(OLLAMA);
    // one retry on primary, then fall back
    for attempt in 0..2 {
        match o.chat(&primary, messages.clone(), KEEP_ALIVE, TIMEOUT_MS).await {
            Ok(s) => return Ok(s),
            Err(LoomError::NotFound(_)) => break,               // pulling won't help this call; fall back
            Err(_) if attempt == 0 => continue,                  // transient: retry once
            Err(_) => break,
        }
    }
    let fb = fallback_for(&cfg, &role);
    o.chat(&fb, messages, KEEP_ALIVE, TIMEOUT_MS).await
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
        assert_eq!(fallback_for(&c, "builder"), "qwen3:1.7b");
        assert_eq!(fallback_for(&c, "companion"), "qwen3:1.7b");
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
}
