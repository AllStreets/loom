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
//!   generations/<sha>/meta.json  { sha, wovenAt, sizeBytes, reason,
//!                                  failedAt?, failedReason? }
//!   generations.json             { current, previous, kept, keep, confirmed }
//! ```
//!
//! Invariants:
//! - `kept` is ordered oldest → newest. `record` appends.
//! - `prune` is pure and NEVER removes `current` or `previous`, however old —
//!   the live body and the one the warden would fall back to are not garbage.
//! - The ledger is written through `threads::write_json_atomic` — staged,
//!   `sync_all`ed, renamed — the one helper every json LOOM's recovery leans
//!   on, so a torn or half-flushed write leaves the previous ledger intact; a
//!   torn or absent ledger reads as `Default`.
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
    /// When a healer decided this generation failed to be BORN — it crashed
    /// or never confirmed its boot, and LOOM came home from it (round-4
    /// review, findings 3 and 4). `None` for every generation that has not
    /// failed, including every meta written before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_at: Option<String>,
    /// The healer's reason — one of `warden::REASON_*`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_reason: Option<String>,
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
    /// This generation was woven, swapped in, and did not boot: a healer put
    /// the previous body back. The shell reads this before it offers the
    /// generation as the way home, and before it offers to weave that sha
    /// again (round-4 review, findings 3 and 4).
    pub failed_to_boot: bool,
    /// Why, in the healer's words — `"crashed"`, `"never confirmed"`.
    pub failed_reason: Option<String>,
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

/// Atomic write: staged, flushed with `sync_all`, then renamed. One helper
/// for every json LOOM's recovery depends on (round-2 review, Finding 6):
/// this module used to carry a second, weaker copy that never reached the
/// platter and left its staging file behind when the rename failed.
pub fn write(home: &Home, ledger: &Ledger) -> Result<(), LoomError> {
    crate::threads::write_json_atomic(&home.ledger_json(), ledger)
}

fn io_err(what: &str, path: &Path, e: std::io::Error) -> LoomError {
    LoomError::Git(format!("{what} {}: {e}", path.display()))
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

// ── Keep ──────────────────────────────────────────────────────────────────────

/// Name a body that is already on the shelf in the ledger, then trim the
/// shelf. Round-2 review, Finding 5: the swap's `EnsureCurrentKept` copies
/// the running body to `generations/<sha>/loom`, but `generations_list` reads
/// the LEDGER, so until `kept` names the sha the body is invisible — Settings
/// cannot offer RETURN to it, and on a first weave it is the only body there
/// is to come home to.
///
/// Idempotent, and it leaves the order alone when the sha is already named:
/// `kept` is the order the owner sees, and the running body is not news.
pub fn keep(home: &Home, sha: &str) -> Result<(), LoomError> {
    let mut ledger = read(home);
    if ledger.kept.iter().any(|s| s == sha) {
        return Ok(());
    }
    ledger.kept.push(sha.to_string());
    let (ledger, gone) = prune(&ledger);
    remove_gone(home, &gone)?;
    write(home, &ledger)
}

/// Delete the directories of generations the prune dropped. Already gone is
/// done, not an error.
fn remove_gone(home: &Home, gone: &[String]) -> Result<(), LoomError> {
    for old in gone {
        let d = home.generations_dir().join(old);
        match std::fs::remove_dir_all(&d) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(io_err("remove", &d, e)),
        }
    }
    Ok(())
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
        // A fresh birth: whatever the last one under this sha did, this body
        // has not failed yet.
        failed_at: None,
        failed_reason: None,
    };
    crate::threads::write_json_atomic(&home.generation_meta(sha), &meta)?;

    let mut ledger = read(home);
    // Re-recording a sha moves it to the newest slot rather than duplicating it.
    ledger.kept.retain(|s| s != sha);
    ledger.kept.push(sha.to_string());
    let (ledger, gone) = prune(&ledger);
    remove_gone(home, &gone)?;
    write(home, &ledger)?;
    Ok(meta)
}

/// Write on a generation's shelf that it failed to be born.
///
/// Round-4 review, findings 3 and 4. After a heal the ledger names the failed
/// generation as `previous` — the thing "return to the previous generation"
/// takes — and the genome's HEAD is still that sha, so both readiness gates
/// went on offering the weave that had just failed. The one durable statement
/// about the failure, `recovery.json`, is surfaced once and deleted, so
/// nothing outlived the notice and the owner's only way out was a new commit.
///
/// The mark lives in the generation's own `meta.json` because that is the
/// file that exists exactly as long as the body it describes: prune takes it
/// away with the shelf entry, and `record` replaces it when that sha is woven
/// AGAIN — a new birth that has not failed yet, and one the healer will mark
/// again if it fails again.
///
/// The ledger is deliberately left alone: `previous` is also what keeps the
/// failed body out of `prune`, and the spec wants the failed weave kept. What
/// changes is what the SHELL does with a row that carries this mark.
pub fn mark_failed(home: &Home, sha: &str, reason: &str) -> Result<(), LoomError> {
    let mut meta = read_meta(home, sha);
    meta.failed_at = Some(now_rfc3339());
    meta.failed_reason = Some(reason.to_string());
    crate::threads::write_json_atomic(&home.generation_meta(sha), &meta)
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
/// NOT a comparison against the live executable, and it must never become one.
/// The body on the shelf and the body in the bundle legitimately DIVERGE: the
/// swap and the heal both ad-hoc re-sign the bundle afterwards, which rewrites
/// the Mach-O, so the live file is a few bytes different from the copy it came
/// from every single time (observed end to end: 15,019,536 shelved against
/// 14,950,336 live after a heal and re-sign). A byte or size check between the
/// two would re-shelve on every swap, and would read a healthy shelf as short.
/// What is checked here is the shelf entry against ITS OWN recorded size.
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
        // A generation is failed when a healer stamped the time; the reason
        // travels with it so the shell can say which kind of failure.
        let meta_failed = meta
            .failed_at
            .as_ref()
            .map(|_| meta.failed_reason.clone().unwrap_or_default());
        rows.push(GenerationView {
            sha: sha.clone(),
            woven_at: meta.woven_at,
            size_bytes: meta.size_bytes,
            reason: meta.reason,
            commit_subject: subject(sha),
            is_current: ledger.current.as_deref() == Some(sha.as_str()),
            is_previous: ledger.previous.as_deref() == Some(sha.as_str()),
            failed_to_boot: meta_failed.is_some(),
            failed_reason: meta_failed,
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
            failed_at: None,
            failed_reason: None,
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

    /// Round-2 review, Finding 6. Two atomic-write helpers lived in the tree
    /// and the ledger had the weaker one: it never `sync_all`ed the staging
    /// file before the rename, and it left that file behind when the rename
    /// failed. The ledger goes through the same helper the sentinel does.
    #[test]
    fn a_failed_ledger_write_leaves_nothing_behind() {
        let (_d, h) = home();
        // The rename cannot land: a directory stands where the ledger goes.
        std::fs::create_dir_all(h.ledger_json()).unwrap();
        assert!(write(&h, &Ledger::default()).is_err(), "the write cannot have succeeded");
        let litter: Vec<String> = std::fs::read_dir(&h.root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(litter.is_empty(), "a failed write left {litter:?} beside the ledger");
    }

    #[test]
    fn ledger_default_and_camel_case() {
        let l = Ledger::default();
        assert_eq!(l.keep, 3);
        assert!(l.confirmed);
        assert!(l.current.is_none() && l.previous.is_none() && l.kept.is_empty());
        let v = serde_json::to_value(&l).unwrap();
        assert!(v.get("keep").is_some() && v.get("confirmed").is_some());
        let m = Meta {
            sha: "a".into(),
            woven_at: "t".into(),
            size_bytes: 1,
            reason: "r".into(),
            failed_at: None,
            failed_reason: None,
        };
        let v = serde_json::to_value(&m).unwrap();
        assert!(v.get("wovenAt").is_some() && v.get("sizeBytes").is_some());
        assert!(v.get("woven_at").is_none(), "snake_case must not leak");
    }

    /// Round-2 review, Finding 5. The swap's `EnsureCurrentKept` copies the
    /// running body to the shelf; `keep` is what names it in the ledger.
    /// `generations_list` reads the ledger, not the directory, so a body the
    /// ledger does not name is invisible to Settings — and on a first weave
    /// it is the only body to come home to.
    #[test]
    fn keep_names_a_shelved_body_in_the_ledger() {
        let (d, h) = home();
        let src = d.path().join("built-loom");
        std::fs::write(&src, b"a body").unwrap();

        // Generation 0: the running body, copied to the shelf by the swap,
        // with nothing in `kept` to say it is there.
        let dest = h.generation_exe("aaa111");
        std::fs::create_dir_all(dest.parent().unwrap()).unwrap();
        std::fs::copy(&src, &dest).unwrap();
        write(&h, &ledger(Some("aaa111"), None, &[], 3)).unwrap();
        assert!(list(&h).unwrap().is_empty(), "invisible until the ledger names it");

        keep(&h, "aaa111").unwrap();
        assert_eq!(read(&h).kept, vec!["aaa111"]);
        assert_eq!(list(&h).unwrap()[0].sha, "aaa111", "Settings can now offer the way back");

        // Idempotent, and it does not reshuffle the order the owner sees.
        record(&h, "bbb222", &src, "reweave").unwrap();
        keep(&h, "aaa111").unwrap();
        assert_eq!(read(&h).kept, vec!["aaa111", "bbb222"]);

        // It trims the shelf like `record` does, and never drops the live
        // bodies: `keep` past the limit removes the oldest and its directory.
        let mut l = read(&h);
        l.kept = vec!["old111".into(), "old222".into(), "aaa111".into()];
        l.keep = 3;
        write(&h, &l).unwrap();
        std::fs::create_dir_all(h.generations_dir().join("old111")).unwrap();
        keep(&h, "ccc333").unwrap();
        assert_eq!(read(&h).kept, vec!["old222", "aaa111", "ccc333"]);
        assert!(!h.generations_dir().join("old111").exists(), "a pruned body's directory goes with it");
    }

    /// Round-4 review, findings 3 and 4. After a heal the ledger names the
    /// body that just failed to boot as `previous` — the thing "return to the
    /// previous generation" takes — and the genome's HEAD is still that sha,
    /// so both gates went on offering the weave that did not hold. Nothing
    /// anywhere remembered the failure: the recovery record is surfaced once
    /// and deleted. The shelved `meta.json` is the durable place to say it,
    /// because it belongs to the generation itself and lives exactly as long
    /// as the body it describes.
    #[test]
    fn a_generation_that_did_not_boot_is_marked_on_its_own_shelf() {
        let (_d, h) = home();
        let src = h.root.join("built-loom");
        std::fs::write(&src, "a body").unwrap();
        record(&h, "aaa111", &src, "reweave").unwrap();
        record(&h, "bbb222", &src, "reweave").unwrap();
        // The ledger a heal leaves: the good body current, the failed one
        // `previous` — which is what keeps it on the shelf and out of prune.
        let mut l = read(&h);
        l.current = Some("aaa111".into());
        l.previous = Some("bbb222".into());
        write(&h, &l).unwrap();
        assert!(list(&h).unwrap().iter().all(|r| !r.failed_to_boot), "nothing has failed yet");

        mark_failed(&h, "bbb222", "crashed").unwrap();

        let rows = list(&h).unwrap();
        let failed = rows.iter().find(|r| r.sha == "bbb222").unwrap();
        assert!(failed.failed_to_boot);
        assert_eq!(failed.failed_reason.as_deref(), Some("crashed"));
        assert!(failed.is_previous, "the ledger still says so — the shell decides what to do with it");
        assert!(!rows.iter().find(|r| r.sha == "aaa111").unwrap().failed_to_boot);
        // The mark is a note ON the generation, not a replacement of it: the
        // body stays whole on the shelf, so a deliberate RETURN to it is still
        // possible, and what the meta already recorded is untouched.
        assert!(shelved_whole(&h, "bbb222"));
        assert_eq!(failed.reason, "reweave");
        assert_ne!(failed.woven_at, "");
        let v = serde_json::to_value(failed).unwrap();
        assert_eq!(v["failedToBoot"], true);
        assert_eq!(v["failedReason"], "crashed");
        // Durable — the next process reads it off the disk, not out of a
        // one-shot record.
        let raw = std::fs::read_to_string(h.generation_meta("bbb222")).unwrap();
        let m: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(m["failedReason"], "crashed");
        assert!(m["failedAt"].as_str().unwrap().ends_with('Z'));

        // A meta written before this field existed is a generation that has
        // not failed, not an unreadable one.
        std::fs::write(
            h.generation_meta("aaa111"),
            r#"{"sha":"aaa111","wovenAt":"2026-09-02T00:00:00Z","sizeBytes":6,"reason":"reweave"}"#,
        )
        .unwrap();
        let rows = list(&h).unwrap();
        let old = rows.iter().find(|r| r.sha == "aaa111").unwrap();
        assert!(!old.failed_to_boot && old.failed_reason.is_none());
        assert_eq!(old.woven_at, "2026-09-02T00:00:00Z");

        // Weaving that sha again clears the mark: `record` writes the meta of
        // a NEW birth, and this one has not failed yet. If it fails again the
        // healer marks it again.
        record(&h, "bbb222", &src, "reweave").unwrap();
        assert!(!list(&h).unwrap().iter().find(|r| r.sha == "bbb222").unwrap().failed_to_boot);

        // A body with no meta at all (shelved by the swap's EnsureCurrentKept)
        // can still be marked — the mark must never depend on a file the swap
        // does not write.
        let bare = h.generation_exe("ccc333");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        std::fs::write(&bare, "kept by the swap").unwrap();
        keep(&h, "ccc333").unwrap();
        mark_failed(&h, "ccc333", "never confirmed").unwrap();
        let rows = list(&h).unwrap();
        let bare_row = rows.iter().find(|r| r.sha == "ccc333").unwrap();
        assert!(bare_row.failed_to_boot);
        assert_eq!(bare_row.failed_reason.as_deref(), Some("never confirmed"));
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
