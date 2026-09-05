use crate::error::LoomError;
use git2::{Repository, Signature, ResetType};
use serde::{Serialize, Deserialize};
use std::path::Path;

#[derive(Serialize, Deserialize)]
pub struct Commit { pub sha: String, pub message: String }

fn sig() -> Result<Signature<'static>, LoomError> {
    Signature::now("LOOM", "loom@localhost").map_err(|e| LoomError::Git(e.to_string()))
}

/// What the timeline repo is allowed to stage.
///
/// Load-bearing since Phase 23. This repo's WORK TREE is loomhome itself
/// (`timeline::loom_dir` and `loomhome::Home::from_app` resolve to the same
/// `<app_data>/loom`), and loomhome is where Rebirth puts the genome clone,
/// the vendored crates, the warm cargo target, and every shelved generation
/// binary. Staging `*` there would sweep gigabytes of build output into the
/// organ timeline on the next organ write — and `add_all` is called on every
/// organ write, grant and delete. The timeline is a record of organs; it
/// stages organs.
const TIMELINE_PATHSPEC: &str = "organs";

/// Names loomhome keeps out of the organ timeline even if a pathspec ever
/// widens again. Written beside the repo, never committed (the pathspec above
/// excludes it), so it is purely a second wall.
const LOOMHOME_IGNORE: &str = "\
# LOOM keeps its body here alongside the organ timeline. None of it belongs
# in that timeline — see TIMELINE_PATHSPEC in src-tauri/src/timeline.rs.
source/
vendor/
target/
worktrees/
generations/
voice/
/*.json
";

pub fn ensure_repo(p: &Path) -> Result<(), LoomError> {
    // Best effort, and deliberately unconditional: an install that predates
    // Rebirth has a repo already and still needs the guard.
    let _ = std::fs::write(p.join(".gitignore"), LOOMHOME_IGNORE);
    if Repository::open(p).is_ok() { return Ok(()); }
    Repository::init(p).map_err(|e| LoomError::Git(e.to_string()))?;
    Ok(())
}

pub fn commit_all(p: &Path, message: &str) -> Result<String, LoomError> {
    let repo = Repository::open(p).map_err(|e| LoomError::Git(e.to_string()))?;
    let mut index = repo.index().map_err(|e| LoomError::Git(e.to_string()))?;
    index.add_all([TIMELINE_PATHSPEC].iter(), git2::IndexAddOption::DEFAULT, None)
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

/// Where the organ timeline lives — LOOM'S HOME, resolved the one way.
///
/// It used to compose `app_data_dir()/loom` itself, which is the same path
/// `Home::from_app` returns in an ordinary launch and a DIFFERENT one under a
/// rehearsal. The UI-driven ceremony caught it: a rehearsal app wrote into the
/// owner's real home thirteen seconds after launch, and read the owner's organs.
/// A second composer of a home is how a rehearsal stops being a rehearsal.
pub(crate) fn loom_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, LoomError> {
    Ok(crate::loomhome::Home::from_app(app)?.root)
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

        fs::create_dir_all(p.join("organs/notes")).unwrap();
        fs::write(p.join("organs/notes/organ.js"), "v1").unwrap();
        let sha1 = commit_all(p, "add organ v1").unwrap();
        assert_ne!(sha1, "nochange");

        fs::write(p.join("organs/notes/organ.js"), "v2-broken").unwrap();
        let sha2 = commit_all(p, "organ v2").unwrap();
        assert_eq!(log(p, 10).unwrap().len(), 2);

        // roll back to v1
        rollback(p, &sha1).unwrap();
        assert_eq!(fs::read_to_string(p.join("organs/notes/organ.js")).unwrap(), "v1");
        // last_good tracks HEAD after reset
        assert!(last_good(p).unwrap().starts_with(&sha1[..7]) || last_good(p).unwrap() == sha1);
        let _ = sha2;
    }

    #[test]
    fn nochange_when_nothing_staged() {
        let dir = tempfile::tempdir().unwrap();
        ensure_repo(dir.path()).unwrap();
        fs::create_dir_all(dir.path().join("organs/notes")).unwrap();
        fs::write(dir.path().join("organs/notes/a"), "x").unwrap();
        commit_all(dir.path(), "first").unwrap();
        assert_eq!(commit_all(dir.path(), "again").unwrap(), "nochange");
    }

    /// The timeline shares its work tree with loomhome (Phase 23): the genome
    /// clone, the vendored crates, the warm target and every shelved
    /// generation binary are siblings of `organs/`. None of them may ever be
    /// staged — an organ write must not sweep gigabytes of LOOM's own body
    /// into the organ timeline.
    #[test]
    fn the_timeline_stages_organs_and_nothing_else_in_loomhome() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        ensure_repo(p).unwrap();

        fs::create_dir_all(p.join("organs/notes")).unwrap();
        fs::write(p.join("organs/notes/organ.js"), "v1").unwrap();

        // Everything Rebirth puts in loomhome, plus the voice models that
        // predate it.
        for rel in [
            "source/src/lib/core.ts",
            "vendor/serde/lib.rs",
            "target/release/loom",
            "worktrees/abc/file.ts",
            "generations/deadbeef/loom",
            "voice/ggml-base.en.bin",
        ] {
            let f = p.join(rel);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(&f, "a body, not an organ").unwrap();
        }
        fs::write(p.join("threads.json"), "{}").unwrap();
        fs::write(p.join("generations.json"), "{}").unwrap();

        // Prove the PATHSPEC on its own: remove the ignore file so it cannot be
        // the thing doing the work. Both walls are tested, separately.
        assert!(p.join(".gitignore").is_file(), "ensure_repo must write the guard");
        fs::remove_file(p.join(".gitignore")).unwrap();

        let sha = commit_all(p, "organ: notes").unwrap();
        assert_ne!(sha, "nochange");

        let repo = Repository::open(p).unwrap();
        let tree = repo.find_commit(git2::Oid::from_str(&sha).unwrap()).unwrap().tree().unwrap();
        let mut staged: Vec<String> = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                staged.push(format!("{root}{}", entry.name().unwrap_or("")));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();

        assert_eq!(staged, vec!["organs/notes/organ.js".to_string()]);
    }

    /// The guard must not eat what the timeline is FOR. `*.json` with no
    /// leading slash matches at EVERY depth, so it silently dropped each
    /// organ's `manifest.json` — the file carrying its declared powers — from
    /// the timeline on every fresh install, and a rollback would have restored
    /// an organ's code without it. Anchored to the loomhome root now.
    #[test]
    fn the_guard_does_not_eat_organ_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        ensure_repo(p).unwrap();
        assert!(p.join(".gitignore").is_file(), "the guard must be in place for this test");

        fs::create_dir_all(p.join("organs/notes")).unwrap();
        for (rel, body) in [
            ("organs/notes/manifest.json", "{\"id\":\"notes\"}"),
            ("organs/notes/organ.js", "v1"),
            ("organs/notes/test.js", "t"),
        ] {
            fs::write(p.join(rel), body).unwrap();
        }
        // The loomhome JSON at the ROOT is still ignored — that is what the
        // pattern is for.
        fs::write(p.join("generations.json"), "{}").unwrap();

        let sha = commit_all(p, "organ: notes").unwrap();
        assert_ne!(sha, "nochange");

        let repo = Repository::open(p).unwrap();
        let tree = repo.find_commit(git2::Oid::from_str(&sha).unwrap()).unwrap().tree().unwrap();
        let mut staged: Vec<String> = Vec::new();
        tree.walk(git2::TreeWalkMode::PreOrder, |root, entry| {
            if entry.kind() == Some(git2::ObjectType::Blob) {
                staged.push(format!("{root}{}", entry.name().unwrap_or("")));
            }
            git2::TreeWalkResult::Ok
        })
        .unwrap();
        staged.sort();

        assert_eq!(
            staged,
            vec![
                "organs/notes/manifest.json".to_string(),
                "organs/notes/organ.js".to_string(),
                "organs/notes/test.js".to_string(),
            ],
            "all three of an organ's files belong in the timeline; loomhome's own JSON does not"
        );
    }
}
