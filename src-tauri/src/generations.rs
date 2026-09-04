//! generations — the ledger of bodies (Phase 23 / Rebirth).
//!
//! PROTECTED (kernel.rs `PROTECTED_RUST`): this module decides which woven
//! executables survive on disk. If LOOM could edit it, it could prune the
//! generation the warden needs to heal a bad birth.
//!
//! Layout (spec §Loomhome layout):
//!
//! ```text
//!   generations/<sha>/loom       the executable for that generation
//!   generations/<sha>/meta.json  { sha, wovenAt, sizeBytes, reason }
//!   generations.json             { current, previous, kept, keep, confirmed }
//! ```
//!
//! Invariants:
//! - `kept` is ordered oldest → newest. `record` appends.
//! - `prune` is pure and NEVER removes `current` or `previous`, however old —
//!   the live body and the one the warden would fall back to are not garbage.
//! - The ledger is written atomically (tmp + rename), so a torn write leaves
//!   the previous ledger intact; a torn or absent ledger reads as `Default`.
//!
//! This module never sets `current`/`previous` — the swap (platform.rs /
//! reweave.rs) does. It only records bodies and trims the shelf.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::LoomError;
use crate::loomhome::Home;

// ── Types ─────────────────────────────────────────────────────────────────────

/// `generations.json`.
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    /// The sha of the running body. `None` before the first reweave.
    pub current: Option<String>,
    /// The body before it — what the warden returns to.
    pub previous: Option<String>,
    /// Every generation still on disk, oldest → newest.
    pub kept: Vec<String>,
    /// How many of the newest to keep (current/previous are always kept).
    pub keep: usize,
    /// Whether the current body has confirmed a good boot.
    pub confirmed: bool,
}

impl Default for Ledger {
    fn default() -> Self {
        Ledger { current: None, previous: None, kept: Vec::new(), keep: 3, confirmed: true }
    }
}

/// `generations/<sha>/meta.json`.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub sha: String,
    /// RFC 3339 UTC, second precision.
    pub woven_at: String,
    pub size_bytes: u64,
    pub reason: String,
}

/// One row of `generations_list` — the ledger's view of a body plus the
/// genome's memory of what it was woven from.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GenerationView {
    pub sha: String,
    pub woven_at: String,
    pub size_bytes: u64,
    pub reason: String,
    /// `git log -1 --format=%s <sha>` in the genome, or `"unknown"`.
    pub commit_subject: String,
    pub is_current: bool,
    pub is_previous: bool,
}

// ── Ledger I/O ────────────────────────────────────────────────────────────────

/// The ledger, or `Default` when it is absent or torn — identity must never
/// fail because the shelf is unreadable.
pub fn read(home: &Home) -> Ledger {
    std::fs::read_to_string(home.ledger_json())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Atomic write: `<ledger>.tmp` then rename.
pub fn write(home: &Home, ledger: &Ledger) -> Result<(), LoomError> {
    write_json_atomic(&home.ledger_json(), ledger)
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> LoomError {
    LoomError::Git(format!("{what} {}: {e}", path.display()))
}

/// Serialize to `<path>.tmp`, then rename over `<path>` — a reader sees the
/// old file or the new one, never a torn one. (Task 4's `threads.rs` carries
/// the same helper; the two will be deduped at merge.)
fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), LoomError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io_err("create", parent, e))?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| LoomError::Parse(e.to_string()))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = Path::new(&tmp);
    std::fs::write(tmp, raw).map_err(|e| io_err("write", tmp, e))?;
    std::fs::rename(tmp, path).map_err(|e| io_err("rename", path, e))
}

// ── Prune ─────────────────────────────────────────────────────────────────────

/// Pure: the ledger trimmed to its `keep` newest entries, plus the shas to
/// delete from disk. `current` and `previous` are never dropped.
pub fn prune(ledger: &Ledger) -> (Ledger, Vec<String>) {
    let n = ledger.kept.len();
    let newest_start = n.saturating_sub(ledger.keep);
    let live = |s: &String| {
        ledger.current.as_deref() == Some(s.as_str())
            || ledger.previous.as_deref() == Some(s.as_str())
    };
    let mut kept = Vec::with_capacity(n);
    let mut gone = Vec::new();
    for (i, sha) in ledger.kept.iter().enumerate() {
        if i >= newest_start || live(sha) {
            kept.push(sha.clone());
        } else {
            gone.push(sha.clone());
        }
    }
    (Ledger { kept, ..ledger.clone() }, gone)
}

// ── Record ────────────────────────────────────────────────────────────────────

/// Shelve a freshly woven body: copy the exe to `generations/<sha>/loom`,
/// write its meta, append it to `kept`, prune (removing pruned dirs), and
/// write the ledger. Does NOT set `current` — the swap does.
pub fn record(home: &Home, sha: &str, exe_src: &Path, reason: &str) -> Result<Meta, LoomError> {
    if !exe_src.is_file() {
        return Err(LoomError::NotFound(format!("woven executable: {}", exe_src.display())));
    }
    let dest = home.generation_exe(sha);
    let dir = dest.parent().ok_or_else(|| LoomError::NotFound("generation dir".into()))?;
    std::fs::create_dir_all(dir).map_err(|e| io_err("create", dir, e))?;
    // The same atomic copy the swap uses (round-1 review, Finding 8): a
    // staging file, then a rename, so the shelf path is only ever the old
    // body or the whole new one — never a write in progress. The mode bits
    // ride along, so the shelved body stays executable.
    crate::platform::copy_atomic(exe_src, &dest)?;
    let size_bytes = std::fs::metadata(&dest).map_err(|e| io_err("stat", &dest, e))?.len();
    let src_bytes = std::fs::metadata(exe_src).map_err(|e| io_err("stat", exe_src, e))?.len();
    if size_bytes != src_bytes {
        return Err(LoomError::Git(format!(
            "the shelved body is {size_bytes} bytes of {src_bytes} — the copy was cut short: {}",
            dest.display()
        )));
    }
    let meta = Meta {
        sha: sha.to_string(),
        woven_at: now_rfc3339(),
        size_bytes,
        reason: reason.to_string(),
    };
    write_json_atomic(&home.generation_meta(sha), &meta)?;

    let mut ledger = read(home);
    // Re-recording a sha moves it to the newest slot rather than duplicating it.
    ledger.kept.retain(|s| s != sha);
    ledger.kept.push(sha.to_string());
    let (ledger, gone) = prune(&ledger);
    for old in &gone {
        let d = home.generations_dir().join(old);
        match std::fs::remove_dir_all(&d) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("remove", &d, e)),
        }
    }
    write(home, &ledger)?;
    Ok(meta)
}

/// `YYYY-MM-DDTHH:MM:SSZ` from the system clock, no chrono. Civil-date
/// conversion per Howard Hinnant's `civil_from_days`.
pub(crate) fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// Is the body shelved for `sha` one a healer can trust? (Round-1 review,
/// Finding 8.) `is_file()` cannot tell a whole body from one a crash cut
/// short; the size `meta.json` recorded at `record` can. A body with no meta
/// — the one the swap's `EnsureCurrentKept` shelves — is judged on its
/// presence, because there is nothing to compare it against.
pub fn shelved_whole(home: &Home, sha: &str) -> bool {
    let Ok(md) = std::fs::metadata(home.generation_exe(sha)) else { return false };
    if !md.is_file() {
        return false;
    }
    let recorded = read_meta(home, sha).size_bytes;
    recorded == 0 || recorded == md.len()
}

// ── List ──────────────────────────────────────────────────────────────────────

/// Every kept generation, newest first, with its commit subject from the
/// genome (`"unknown"` when the genome or the commit is missing).
pub fn list(home: &Home) -> Result<Vec<GenerationView>, LoomError> {
    let ledger = read(home);
    // Read-only lookup: git2 opens the genome without spawning anything.
    let repo = git2::Repository::open(home.source()).ok();
    let subject = |sha: &str| -> String {
        repo.as_ref()
            .and_then(|r| {
                let oid = git2::Oid::from_str(sha).ok()?;
                let c = r.find_commit(oid).ok()?;
                c.summary().map(str::to_string)
            })
            .unwrap_or_else(|| "unknown".to_string())
    };
    let mut rows = Vec::with_capacity(ledger.kept.len());
    for sha in ledger.kept.iter().rev() {
        let meta = read_meta(home, sha);
        rows.push(GenerationView {
            sha: sha.clone(),
            woven_at: meta.woven_at,
            size_bytes: meta.size_bytes,
            reason: meta.reason,
            commit_subject: subject(sha),
            is_current: ledger.current.as_deref() == Some(sha.as_str()),
            is_previous: ledger.previous.as_deref() == Some(sha.as_str()),
        });
    }
    Ok(rows)
}

/// A generation's meta, or a blank one if the file is absent or torn — the
/// ledger, not the meta, decides whether a body is on the shelf.
fn read_meta(home: &Home, sha: &str) -> Meta {
    std::fs::read_to_string(home.generation_meta(sha))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Meta {
            sha: sha.to_string(),
            woven_at: String::new(),
            size_bytes: 0,
            reason: String::new(),
        })
}

#[tauri::command]
pub fn generations_list(app: tauri::AppHandle) -> Result<Vec<GenerationView>, LoomError> {
    let home = Home::from_app(&app)?;
    list(&home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn home() -> (tempfile::TempDir, Home) {
        let d = tempfile::tempdir().unwrap();
        let h = Home::at(d.path().to_path_buf());
        (d, h)
    }

    fn ledger(current: Option<&str>, previous: Option<&str>, kept: &[&str], keep: usize) -> Ledger {
        Ledger {
            current: current.map(str::to_string),
            previous: previous.map(str::to_string),
            kept: kept.iter().map(|s| s.to_string()).collect(),
            keep,
            confirmed: true,
        }
    }

    /// Round-1 review, Finding 8. A body shelved by a crashed copy is present
    /// but cut short; `is_file()` cannot tell the difference, `meta.json`'s
    /// recorded size can.
    #[test]
    fn a_body_cut_short_is_not_a_body_to_come_home_to() {
        let (_d, h) = home();
        let src = h.root.join("built-loom");
        std::fs::write(&src, "a whole body").unwrap();
        record(&h, "aaa111", &src, "reweave").unwrap();
        assert!(shelved_whole(&h, "aaa111"), "a freshly shelved body is whole");

        // The crash: the copy stopped half way.
        std::fs::write(h.generation_exe("aaa111"), "a whole").unwrap();
        assert!(
            !shelved_whole(&h, "aaa111"),
            "a body shorter than its meta records must not be trusted"
        );
        // Nothing on the shelf at all is not whole either.
        assert!(!shelved_whole(&h, "nope"));
        // A body with no meta (shelved by the swap's EnsureCurrentKept, which
        // writes no meta) is trusted on its presence — there is nothing to
        // compare it against.
        let bare = h.generation_exe("bbb222");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        std::fs::write(&bare, "kept by the swap").unwrap();
        assert!(shelved_whole(&h, "bbb222"));
    }

    /// The shelf copies a body exactly the way the swap does: onto a staging
    /// file, then a rename. The shelf path is only ever the old body or the
    /// new one — never the write in progress. Pinned by the one observable
    /// difference: the rename needs the directory, not the old file.
    #[test]
    fn record_lands_the_body_by_rename() {
        let (_d, h) = home();
        let src = h.root.join("built-loom");
        std::fs::write(&src, "new body").unwrap();
        std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
        record(&h, "aaa111", &src, "reweave").unwrap();
        let dest = h.generation_exe("aaa111");
        // The body on the shelf cannot be opened for writing; the rename can
        // still land the new one, because it needs only the directory.
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o444)).unwrap();

        std::fs::write(&src, "newer body").unwrap();
        std::fs::set_permissions(&src, std::fs::Permissions::from_mode(0o755)).unwrap();
        let meta = record(&h, "aaa111", &src, "reweave").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "newer body");
        assert_eq!(meta.size_bytes, "newer body".len() as u64);
        assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o111, 0o111);
        let mut names: Vec<String> = std::fs::read_dir(dest.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["loom".to_string(), "meta.json".to_string()], "no staging file remains");
    }

    #[test]
    fn ledger_default_and_camel_case() {
        let l = Ledger::default();
        assert_eq!(l.keep, 3);
        assert!(l.confirmed);
        assert!(l.current.is_none() && l.previous.is_none() && l.kept.is_empty());
        let v = serde_json::to_value(&l).unwrap();
        assert!(v.get("keep").is_some() && v.get("confirmed").is_some());
        let m = Meta { sha: "a".into(), woven_at: "t".into(), size_bytes: 1, reason: "r".into() };
        let v = serde_json::to_value(&m).unwrap();
        assert!(v.get("wovenAt").is_some() && v.get("sizeBytes").is_some());
        assert!(v.get("woven_at").is_none(), "snake_case must not leak");
    }

    #[test]
    fn prune_keeps_newest_n() {
        // kept is oldest → newest; keep 3 → the three newest survive, in order.
        let l = ledger(Some("e"), Some("d"), &["a", "b", "c", "d", "e"], 3);
        let (trimmed, gone) = prune(&l);
        assert_eq!(trimmed.kept, vec!["c", "d", "e"]);
        assert_eq!(gone, vec!["a", "b"]);
        assert_eq!(trimmed.current.as_deref(), Some("e"));
        assert_eq!(trimmed.previous.as_deref(), Some("d"));
        assert_eq!(trimmed.keep, 3);
        // Nothing to prune → identical ledger, nothing gone.
        let small = ledger(Some("b"), None, &["a", "b"], 3);
        assert_eq!(prune(&small), (small.clone(), vec![]));
    }

    #[test]
    fn prune_never_drops_current_or_previous_even_if_old() {
        // current and previous are the OLDEST entries; keep 2 would drop them.
        let l = ledger(Some("a"), Some("b"), &["a", "b", "c", "d", "e"], 2);
        let (trimmed, gone) = prune(&l);
        assert_eq!(trimmed.kept, vec!["a", "b", "d", "e"]);
        assert_eq!(gone, vec!["c"]);
        // keep 0 → only the live bodies survive.
        let (trimmed, gone) = prune(&ledger(Some("a"), Some("b"), &["a", "b", "c"], 0));
        assert_eq!(trimmed.kept, vec!["a", "b"]);
        assert_eq!(gone, vec!["c"]);
        // Order is preserved (oldest → newest), never re-sorted.
        let (trimmed, _) = prune(&ledger(Some("c"), Some("a"), &["a", "b", "c", "d", "e", "f"], 1));
        assert_eq!(trimmed.kept, vec!["a", "c", "f"]);
    }

    #[test]
    fn record_copies_exe_and_writes_meta() {
        let (d, h) = home();
        let src = d.path().join("built-loom");
        std::fs::write(&src, b"#!/bin/sh\necho loom\n").unwrap();
        let meta = record(&h, "aaa111", &src, "reweave").unwrap();
        assert_eq!(meta.sha, "aaa111");
        assert_eq!(meta.size_bytes, 20);
        assert_eq!(meta.reason, "reweave");
        assert!(meta.woven_at.ends_with('Z') && meta.woven_at.contains('T'), "{}", meta.woven_at);
        // The exe is where loomhome says it is, byte-identical.
        assert_eq!(std::fs::read(h.generation_exe("aaa111")).unwrap(), b"#!/bin/sh\necho loom\n");
        // Meta on disk round-trips in camelCase.
        let raw = std::fs::read_to_string(h.generation_meta("aaa111")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["sha"], "aaa111");
        assert_eq!(v["sizeBytes"], 20);
        assert_eq!(v["reason"], "reweave");
        // The ledger has it in kept, and current is untouched (the swap sets it).
        let l = read(&h);
        assert_eq!(l.kept, vec!["aaa111"]);
        assert!(l.current.is_none());
        assert_eq!(l.keep, 3);

        // Recording past `keep` prunes the oldest and removes its directory.
        record(&h, "bbb222", &src, "reweave").unwrap();
        record(&h, "ccc333", &src, "reweave").unwrap();
        record(&h, "ddd444", &src, "reweave").unwrap();
        let l = read(&h);
        assert_eq!(l.kept, vec!["bbb222", "ccc333", "ddd444"]);
        assert!(!h.generations_dir().join("aaa111").exists(), "pruned generation dir must be deleted");
        assert!(h.generation_exe("ddd444").exists());

        // A missing source exe is a typed error, not a panic.
        assert!(record(&h, "eee555", &d.path().join("nope"), "x").is_err());
    }

    #[test]
    fn read_returns_default_on_corrupt_json() {
        let (_d, h) = home();
        assert_eq!(read(&h), Ledger::default(), "absent → default");
        std::fs::write(h.ledger_json(), "{ not json").unwrap();
        assert_eq!(read(&h), Ledger::default(), "torn → default");
        // write is atomic: the real file appears, no .tmp lingers, round-trips.
        let l = ledger(Some("c0ffee"), Some("beef"), &["beef", "c0ffee"], 2);
        write(&h, &l).unwrap();
        assert!(!h.root.join("generations.json.tmp").exists());
        assert_eq!(read(&h), l);
        let raw = std::fs::read_to_string(h.ledger_json()).unwrap();
        assert!(raw.contains("\"current\"") && raw.contains("\"confirmed\""));
    }

    #[test]
    fn list_marks_current_and_previous() {
        let (d, h) = home();
        // No genome, no ledger → empty, not an error.
        assert!(list(&h).unwrap().is_empty());

        let src = d.path().join("exe");
        std::fs::write(&src, b"body").unwrap();
        // A genome with one real commit so one row can find its subject.
        let repo = git2::Repository::init(h.source()).unwrap();
        let sha = {
            let mut idx = repo.index().unwrap();
            let tree = idx.write_tree().unwrap();
            let tree = repo.find_tree(tree).unwrap();
            let sig = git2::Signature::now("loom", "loom@local").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "feat: the first weave\n\nbody", &tree, &[])
                .unwrap()
                .to_string()
        };
        record(&h, &sha, &src, "reweave").unwrap();
        record(&h, "1111111111111111111111111111111111111111", &src, "reweave").unwrap();
        record(&h, "not-a-sha", &src, "return").unwrap();
        let mut l = read(&h);
        l.current = Some("1111111111111111111111111111111111111111".into());
        l.previous = Some(sha.clone());
        write(&h, &l).unwrap();

        let rows = list(&h).unwrap();
        assert_eq!(rows.len(), 3);
        // Newest first.
        assert_eq!(rows[0].sha, "not-a-sha");
        assert_eq!(rows[1].sha, "1111111111111111111111111111111111111111");
        assert_eq!(rows[2].sha, sha);
        assert!(rows[1].is_current && !rows[1].is_previous);
        assert!(rows[2].is_previous && !rows[2].is_current);
        assert!(!rows[0].is_current && !rows[0].is_previous);
        // Subject from the genome; "unknown" when the commit is missing or unparsable.
        assert_eq!(rows[2].commit_subject, "feat: the first weave");
        assert_eq!(rows[1].commit_subject, "unknown");
        assert_eq!(rows[0].commit_subject, "unknown");
        assert_eq!(rows[0].reason, "return");
        assert_eq!(rows[0].size_bytes, 4);
        // camelCase on the wire.
        let v = serde_json::to_value(&rows[1]).unwrap();
        assert_eq!(v["isCurrent"], true);
        assert!(v.get("commitSubject").is_some() && v.get("wovenAt").is_some());
    }
}
