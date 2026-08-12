use crate::error::LoomError;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone)]
pub struct Msg { pub role: String, pub content: String }

pub struct Ollama { base: String }

impl Ollama {
    pub fn new(base: &str) -> Self { Self { base: base.trim_end_matches('/').to_string() } }

    pub async fn tags(&self) -> Result<Vec<String>, LoomError> {
        let url = format!("{}/api/tags", self.base);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(5000))
            .build().map_err(|e| LoomError::Http(e.to_string()))?;
        let res = client.get(&url).send().await
            .map_err(|e| if e.is_timeout() { LoomError::Timeout } else { LoomError::Http(e.to_string()) })?;
        let text = res.text().await.map_err(|e| LoomError::Http(e.to_string()))?;
        parse_tags(&text)
    }

    pub async fn chat(&self, model: &str, messages: Vec<Msg>, keep_alive: i64, timeout_ms: u64)
        -> Result<String, LoomError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build().map_err(|e| LoomError::Http(e.to_string()))?;
        let body = serde_json::json!({
            "model": model, "messages": messages, "stream": false,
            "keep_alive": keep_alive,
        });
        let res = client.post(format!("{}/api/chat", self.base)).json(&body).send().await
            .map_err(|e| if e.is_timeout() { LoomError::Timeout } else { LoomError::Http(e.to_string()) })?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(LoomError::NotFound(model.to_string()));
        }
        let text = res.text().await.map_err(|e| LoomError::Http(e.to_string()))?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| LoomError::Parse(e.to_string()))?;
        Ok(v.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_str()).unwrap_or("").to_string())
    }
}

pub fn parse_tags(json: &str) -> Result<Vec<String>, LoomError> {
    let v: serde_json::Value = serde_json::from_str(json).map_err(|e| LoomError::Parse(e.to_string()))?;
    let models = v.get("models").and_then(|m| m.as_array())
        .ok_or_else(|| LoomError::Parse("no models[]".into()))?;
    Ok(models.iter().filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_model_names() {
        let json = r#"{"models":[{"name":"gpt-oss:20b"},{"name":"qwen3:1.7b"}]}"#;
        let got = parse_tags(json).unwrap();
        assert_eq!(got, vec!["gpt-oss:20b".to_string(), "qwen3:1.7b".to_string()]);
    }
    #[test]
    fn empty_on_no_models() {
        assert_eq!(parse_tags(r#"{"models":[]}"#).unwrap(), Vec::<String>::new());
    }
}
