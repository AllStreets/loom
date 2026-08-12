use crate::error::LoomError;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct OrganFile { pub name: String, pub content: String }

#[derive(Serialize)]
pub struct OrganEntry { pub id: String, pub manifest: String, pub granted: Option<String> }

const ALLOWED: [&str; 3] = ["manifest.json", "organ.js", "test.js"];

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn organ_dir(root: &Path, id: &str) -> Result<std::path::PathBuf, LoomError> {
    if !valid_id(id) { return Err(LoomError::Parse(format!("invalid organ id: {id}"))); }
    Ok(root.join("organs").join(id))
}

pub fn write_organ(root: &Path, id: &str, files: &[OrganFile]) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    for f in files {
        if !ALLOWED.contains(&f.name.as_str()) {
            return Err(LoomError::Parse(format!("file not allowed: {}", f.name)));
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?;
    for f in files {
        std::fs::write(dir.join(&f.name), &f.content).map_err(|e| LoomError::Git(e.to_string()))?;
    }
    Ok(())
}

pub fn list_organs(root: &Path) -> Result<Vec<OrganEntry>, LoomError> {
    let organs = root.join("organs");
    let mut out = vec![];
    if !organs.exists() { return Ok(out); }
    let rd = std::fs::read_dir(&organs).map_err(|e| LoomError::Git(e.to_string()))?;
    for entry in rd.flatten() {
        let id = entry.file_name().to_string_lossy().to_string();
        if !valid_id(&id) { continue; }
        let manifest = match std::fs::read_to_string(entry.path().join("manifest.json")) {
            Ok(m) => m, Err(_) => continue,
        };
        let granted = std::fs::read_to_string(entry.path().join(".granted")).ok();
        out.push(OrganEntry { id, manifest, granted });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub fn read_organ_file(root: &Path, id: &str, name: &str) -> Result<String, LoomError> {
    if !ALLOWED.contains(&name) { return Err(LoomError::Parse(format!("file not allowed: {name}"))); }
    let dir = organ_dir(root, id)?;
    std::fs::read_to_string(dir.join(name)).map_err(|e| LoomError::NotFound(format!("{id}/{name}: {e}")))
}

pub fn grant(root: &Path, id: &str, granted_json: &str) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    if !dir.exists() { return Err(LoomError::NotFound(id.into())); }
    std::fs::write(dir.join(".granted"), granted_json).map_err(|e| LoomError::Git(e.to_string()))
}

pub fn delete_organ(root: &Path, id: &str) -> Result<(), LoomError> {
    let dir = organ_dir(root, id)?;
    if dir.exists() { std::fs::remove_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?; }
    Ok(())
}

use crate::timeline::{self, loom_dir};

#[tauri::command]
pub fn organ_write(app: tauri::AppHandle, id: String, files: Vec<OrganFile>, message: String)
    -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    timeline::ensure_repo(&root)?;
    write_organ(&root, &id, &files)?;
    timeline::commit_all(&root, &message)
}

#[tauri::command]
pub fn organ_list(app: tauri::AppHandle) -> Result<Vec<OrganEntry>, LoomError> {
    list_organs(&loom_dir(&app)?)
}

#[tauri::command]
pub fn organ_read(app: tauri::AppHandle, id: String, name: String) -> Result<String, LoomError> {
    read_organ_file(&loom_dir(&app)?, &id, &name)
}

#[tauri::command]
pub fn organ_grant(app: tauri::AppHandle, id: String, granted_json: String) -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    grant(&root, &id, &granted_json)?;
    timeline::commit_all(&root, &format!("grant: {id}"))
}

#[tauri::command]
pub fn organ_delete(app: tauri::AppHandle, id: String) -> Result<String, LoomError> {
    let root = loom_dir(&app)?;
    delete_organ(&root, &id)?;
    timeline::commit_all(&root, &format!("delete organ: {id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timeline;

    #[test]
    fn id_validation() {
        assert!(valid_id("run-tracker"));
        assert!(valid_id("a1"));
        assert!(!valid_id("Run"));           // uppercase
        assert!(!valid_id("../evil"));       // traversal
        assert!(!valid_id(""));
        assert!(!valid_id(&"x".repeat(33))); // too long
    }

    #[test]
    fn write_list_read_grant_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        timeline::ensure_repo(root).unwrap();
        let files = vec![
            OrganFile { name: "manifest.json".into(), content: r#"{"id":"runs","permissions":["storage"]}"#.into() },
            OrganFile { name: "organ.js".into(), content: "export default {}".into() },
            OrganFile { name: "test.js".into(), content: "export const tests = []".into() },
        ];
        write_organ(root, "runs", &files).unwrap();
        let sha = timeline::commit_all(root, "organ: runs").unwrap();
        assert_ne!(sha, "nochange");

        let listed = list_organs(root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "runs");
        assert!(listed[0].manifest.contains("storage"));
        assert!(listed[0].granted.is_none());

        grant(root, "runs", r#"["storage"]"#).unwrap();
        assert_eq!(list_organs(root).unwrap()[0].granted.as_deref(), Some(r#"["storage"]"#));

        assert_eq!(read_organ_file(root, "runs", "organ.js").unwrap(), "export default {}");
        delete_organ(root, "runs").unwrap();
        assert!(list_organs(root).unwrap().is_empty());
    }

    #[test]
    fn rejects_bad_ids_and_filenames() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        timeline::ensure_repo(root).unwrap();
        let evil_name = vec![OrganFile { name: "../../escape.js".into(), content: "x".into() }];
        assert!(write_organ(root, "ok-id", &evil_name).is_err());
        let ok_files = vec![OrganFile { name: "organ.js".into(), content: "x".into() }];
        assert!(write_organ(root, "../evil", &ok_files).is_err());
        assert!(read_organ_file(root, "ok-id", ".granted").is_err()); // .granted not readable as organ file
    }
}
