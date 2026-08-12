use crate::error::LoomError;
use git2::{Repository, Signature, ResetType};
use serde::{Serialize, Deserialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
pub struct Commit { pub sha: String, pub message: String }

fn sig() -> Result<Signature<'static>, LoomError> {
    Signature::now("LOOM", "loom@localhost").map_err(|e| LoomError::Git(e.to_string()))
}

pub fn ensure_repo(p: &Path) -> Result<(), LoomError> {
    if Repository::open(p).is_ok() { return Ok(()); }
    Repository::init(p).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

pub fn commit_all(p: &Path, message: &str) -> Result<String, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let mut index = repo.index().map_err(|e| LoomError::Git(e.to_string()))?;
    index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    index.write().map_err(|e| LoomError::Git(e.to_string()))?;
    let tree_id = index.write_tree().map_err(|e| LoomError::Git(e.to_string()))?;
    let tree = repo.find_tree(tree_id).map_err(|e| LoomError::Git(e.to_string()))?;
    let sig = sig()?;
    let parent = repo.head().ok().and_then(|h| h.target()).and_then(|oid| repo.find_commit(oid).ok());
    if let Some(ref pc) = parent {
        if pc.tree_id() == tree_id { return Ok("nochange".into()); } // nothing changed
    }
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(oid.to_string())
}

pub fn log(p: &Path, limit: usize) -> Result<Vec<Commit>, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let mut walk = repo.revwalk().map_err(|e| LoomError::Git(e.to_string()))?;
    if walk.push_head().is_err() { return Ok(vec![]); }
    let mut out = vec![];
    for oid in walk.take(limit) {
        let oid = oid.map_err(|e| LoomError::Git(e.to_string()))?;
        let c = repo.find_commit(oid).map_err(|e| LoomError::Git(e.to_string()))?;
        out.push(Commit { sha: oid.to_string(), message: c.summary().unwrap_or("").to_string() });
    }
    Ok(out)
}

pub fn rollback(p: &Path, sha: &str) -> Result<(), LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let oid = git2::Oid::from_str(sha).map_err(|e| LoomError::Git(e.to_string()))?;
    let obj = repo.find_object(oid, None).map_err(|e| LoomError::Git(e.to_string()))?;
    repo.reset(&obj, ResetType::Hard, None).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

#[allow(dead_code)]
pub fn last_good(p: &Path) -> Result<String, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let head = repo.head().map_err(|e| LoomError::Git(e.to_string()))?;
    head.target().map(|o| o.to_string()).ok_or(LoomError::Git("no HEAD".into()))
}

fn loom_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, LoomError> {
    use tauri::Manager;
    let dir = app.path().app_data_dir()
        .map_err(|e| LoomError::Git(e.to_string()))?.join("loom");
    std::fs::create_dir_all(&dir).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(dir)
}

#[tauri::command]
pub fn timeline_init(app: tauri::AppHandle) -> Result<(), LoomError> { ensure_repo(&loom_dir(&app)?) }

#[tauri::command]
pub fn timeline_commit(app: tauri::AppHandle, message: String) -> Result<String, LoomError> {
    commit_all(&loom_dir(&app)?, &message)
}

#[tauri::command]
pub fn timeline_log(app: tauri::AppHandle, limit: usize) -> Result<Vec<Commit>, LoomError> {
    log(&loom_dir(&app)?, limit)
}

#[tauri::command]
pub fn timeline_rollback(app: tauri::AppHandle, sha: String) -> Result<(), LoomError> {
    rollback(&loom_dir(&app)?, &sha)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn commit_rollback_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        ensure_repo(p).unwrap();

        fs::write(p.join("organ.js"), "v1").unwrap();
        let sha1 = commit_all(p, "add organ v1").unwrap();
        assert_ne!(sha1, "nochange");

        fs::write(p.join("organ.js"), "v2-broken").unwrap();
        let sha2 = commit_all(p, "organ v2").unwrap();
        assert_eq!(log(p, 10).unwrap().len(), 2);

        // roll back to v1
        rollback(p, &sha1).unwrap();
        assert_eq!(fs::read_to_string(p.join("organ.js")).unwrap(), "v1");
        // last_good tracks HEAD after reset
        assert!(last_good(p).unwrap().starts_with(&sha1[..7]) || last_good(p).unwrap() == sha1);
        let _ = sha2;
    }

    #[test]
    fn nochange_when_nothing_staged() {
        let dir = tempfile::tempdir().unwrap();
        ensure_repo(dir.path()).unwrap();
        fs::write(dir.path().join("a"), "x").unwrap();
        commit_all(dir.path(), "first").unwrap();
        assert_eq!(commit_all(dir.path(), "again").unwrap(), "nochange");
    }
}
