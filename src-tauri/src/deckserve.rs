//! deckserve.rs — Custom `deck://` URI scheme protocol handler.
//!
//! In production (Tauri bundled app) the AUSPEX globe deck is served on its
//! own origin via this custom protocol rather than from LOOM's `tauri://localhost`
//! origin.  This makes the iframe cross-origin, isolating its localStorage from
//! LOOM's (closes reviewer I3 from Stage 1).
//!
//! Origin per platform (Tauri v2 docs, tauri-2.x/src/app.rs:2126):
//!   macOS / iOS / Linux  →  `deck://localhost`
//!   Windows / Android    →  `http://deck.localhost`  (we target macOS; documented)
//!
//! Registration (in lib.rs):
//!   `tauri::Builder::default().register_uri_scheme_protocol("deck", deckserve::handler)`
//!
//! Handler signature (Tauri v2 synchronous form):
//!   `fn handler(ctx: UriSchemeContext<'_, R>, request: http::Request<Vec<u8>>) -> http::Response<Vec<u8>>`
//!
//! Resource layout:
//!   The bundled auspex directory (public/decks/auspex/**) is declared in
//!   tauri.conf.json `bundle.resources` and resolved at runtime via
//!   `app_handle.path().resource_dir()`.  The handler appends the URL path
//!   (after stripping the leading `/`) to that directory.

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};
use tauri::http;

/// MIME type for a file extension.  Returns `application/octet-stream` for any
/// unrecognised extension so the browser can still receive the bytes.
pub fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs"   => "text/javascript; charset=utf-8",
        "css"          => "text/css; charset=utf-8",
        "json"         => "application/json; charset=utf-8",
        "svg"          => "image/svg+xml",
        "png"          => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico"          => "image/x-icon",
        "wasm"         => "application/wasm",
        "woff2"        => "font/woff2",
        "txt"          => "text/plain; charset=utf-8",
        "md"           => "text/plain; charset=utf-8",
        _              => "application/octet-stream",
    }
}

/// Resolve the URL path fragment to an absolute file path under `base_dir`,
/// rejecting any path that would escape the base via `..` segments or symlinks.
///
/// Returns `Some(canonical_path)` if the path is safe and the file exists,
/// `None` otherwise (→ 404).
pub fn sanitize_path(base_dir: &Path, url_path: &str) -> Option<PathBuf> {
    // Strip leading '/'
    let rel = url_path.trim_start_matches('/');

    // Reject any `..` component before we even join paths.
    if rel.contains("..") {
        return None;
    }

    let joined = base_dir.join(rel);

    // Canonicalize resolves symlinks and normalises the path.
    // If the file doesn't exist, canonicalize returns Err — map to None.
    let canonical = joined.canonicalize().ok()?;

    // Verify the canonical path is still inside the base directory.
    let canonical_base = base_dir.canonicalize().ok()?;
    if canonical.starts_with(&canonical_base) {
        Some(canonical)
    } else {
        None
    }
}

/// Build the path to the bundled auspex resource directory.
/// Returns None if the resource_dir cannot be determined.
pub fn auspex_resource_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(|d| d.join("decks").join("auspex"))
}

/// Tauri v2 synchronous URI scheme protocol handler for `deck://`.
///
/// Maps `deck://localhost/<path>` → file at `<resource_dir>/decks/auspex/<path>`.
/// Responds with the file bytes + correct MIME type, or 404 on any error.
pub fn handler<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    let app = ctx.app_handle();
    let url_path = request.uri().path().to_string();

    // Default index: deck://localhost/ → index.html
    let effective_path = if url_path == "/" || url_path.is_empty() {
        "/index.html".to_string()
    } else {
        url_path
    };

    let Some(base) = auspex_resource_dir(app) else {
        return not_found();
    };

    let Some(file_path) = sanitize_path(&base, &effective_path) else {
        return not_found();
    };

    match std::fs::read(&file_path) {
        Ok(bytes) => {
            let mime = mime_for(&file_path);
            http::Response::builder()
                .status(200)
                .header(http::header::CONTENT_TYPE, mime)
                .body(bytes)
                .unwrap_or_else(|_| not_found())
        }
        Err(_) => not_found(),
    }
}

fn not_found() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(404)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(b"404 not found".to_vec())
        .unwrap()
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── mime_for ──────────────────────────────────────────────────────────────

    #[test]
    fn mime_html() {
        assert_eq!(mime_for(Path::new("index.html")), "text/html; charset=utf-8");
    }

    #[test]
    fn mime_js() {
        assert_eq!(mime_for(Path::new("main.js")), "text/javascript; charset=utf-8");
    }

    #[test]
    fn mime_mjs() {
        assert_eq!(mime_for(Path::new("mod.mjs")), "text/javascript; charset=utf-8");
    }

    #[test]
    fn mime_css() {
        assert_eq!(mime_for(Path::new("auspex.css")), "text/css; charset=utf-8");
    }

    #[test]
    fn mime_json() {
        assert_eq!(mime_for(Path::new("snapshot.json")), "application/json; charset=utf-8");
    }

    #[test]
    fn mime_svg() {
        assert_eq!(mime_for(Path::new("favicon.svg")), "image/svg+xml");
    }

    #[test]
    fn mime_png() {
        assert_eq!(mime_for(Path::new("icon.png")), "image/png");
    }

    #[test]
    fn mime_jpg() {
        assert_eq!(mime_for(Path::new("photo.jpg")), "image/jpeg");
    }

    #[test]
    fn mime_jpeg() {
        assert_eq!(mime_for(Path::new("photo.jpeg")), "image/jpeg");
    }

    #[test]
    fn mime_ico() {
        assert_eq!(mime_for(Path::new("favicon.ico")), "image/x-icon");
    }

    #[test]
    fn mime_wasm() {
        assert_eq!(mime_for(Path::new("module.wasm")), "application/wasm");
    }

    #[test]
    fn mime_woff2() {
        assert_eq!(mime_for(Path::new("font.woff2")), "font/woff2");
    }

    #[test]
    fn mime_txt() {
        assert_eq!(mime_for(Path::new("notes.txt")), "text/plain; charset=utf-8");
    }

    #[test]
    fn mime_md() {
        assert_eq!(mime_for(Path::new("README.md")), "text/plain; charset=utf-8");
    }

    #[test]
    fn mime_unknown_falls_back_to_octet_stream() {
        assert_eq!(mime_for(Path::new("data.bin")), "application/octet-stream");
    }

    #[test]
    fn mime_no_extension_falls_back() {
        assert_eq!(mime_for(Path::new("Makefile")), "application/octet-stream");
    }

    #[test]
    fn mime_uppercase_extension() {
        // Extension matching is case-insensitive.
        assert_eq!(mime_for(Path::new("IMAGE.PNG")), "image/png");
        assert_eq!(mime_for(Path::new("PAGE.HTML")), "text/html; charset=utf-8");
    }

    // ── sanitize_path ─────────────────────────────────────────────────────────

    fn make_tmp_file(dir: &TempDir, name: &str, content: &[u8]) -> PathBuf {
        let p = dir.path().join(name);
        fs::write(&p, content).unwrap();
        p
    }

    #[test]
    fn sanitize_valid_file() {
        let tmp = TempDir::new().unwrap();
        make_tmp_file(&tmp, "index.html", b"hello");
        let result = sanitize_path(tmp.path(), "/index.html");
        assert!(result.is_some(), "valid file should resolve");
        assert!(result.unwrap().ends_with("index.html"));
    }

    #[test]
    fn sanitize_valid_file_subdir() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("js")).unwrap();
        make_tmp_file(&tmp, "js/main.js", b"let x=1");
        let result = sanitize_path(tmp.path(), "/js/main.js");
        assert!(result.is_some(), "nested valid file should resolve");
    }

    #[test]
    fn sanitize_dotdot_rejected() {
        let tmp = TempDir::new().unwrap();
        // Even if the file exists one level up, .. must be rejected.
        make_tmp_file(&tmp, "secret.txt", b"secret");
        let result = sanitize_path(tmp.path(), "/../secret.txt");
        assert!(result.is_none(), "path traversal with .. must be rejected");
    }

    #[test]
    fn sanitize_dotdot_in_middle_rejected() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("js")).unwrap();
        make_tmp_file(&tmp, "js/main.js", b"let x=1");
        let result = sanitize_path(tmp.path(), "/js/../../../etc/passwd");
        assert!(result.is_none(), "traversal via middle .. must be rejected");
    }

    #[test]
    fn sanitize_nonexistent_file_returns_none() {
        let tmp = TempDir::new().unwrap();
        let result = sanitize_path(tmp.path(), "/does-not-exist.html");
        assert!(result.is_none(), "missing file should return None");
    }

    #[test]
    fn sanitize_empty_path_safe() {
        let tmp = TempDir::new().unwrap();
        // Empty path after stripping '/' → joins to the base dir itself, not a file.
        // base dir is a directory, canonicalize will succeed, starts_with check passes,
        // but we return Some(base_dir). The handler layer would then fail to read it as
        // a file (it's a dir) → 404. sanitize_path's job is just the guard, not the read.
        // We verify it doesn't panic.
        let result = sanitize_path(tmp.path(), "/");
        // Base dir itself canonicalizes fine and starts_with itself — Some.
        // The handler uses effective_path = "/index.html" before calling sanitize_path
        // so this case is reached only with the direct sanitize_path call.
        let _ = result; // May be Some or None depending on whether base dir is a file.
    }

    #[test]
    fn sanitize_root_slash_resolves_without_panic() {
        let tmp = TempDir::new().unwrap();
        // Should not panic regardless of result.
        let _ = sanitize_path(tmp.path(), "/");
        let _ = sanitize_path(tmp.path(), "");
    }
}
