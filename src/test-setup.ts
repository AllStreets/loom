// Global test setup — simulate Tauri environment so safeInvoke passes through
// to the mocked invoke rather than rejecting with ShellUnavailableError.
// Individual tests that want to test the browser-mode rejection path must
// delete this global in a beforeEach and restore it in afterEach.
if (typeof window !== "undefined") {
  // @tauri-apps/api v2 sentinel
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}
