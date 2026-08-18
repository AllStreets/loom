/**
 * loom-adapter.js — LOOM Cockpit bridge adapter for AUSPEX globe deck.
 * Injected into the BUNDLED index.html only (see <!-- LOOM adapter --> tag).
 *
 * Listens for postMessage {loomDeck: true, cmd: {type, ...payload}} from the LOOM shell.
 * Whitelists cmd.type against AUSPEX's real bridge vocabulary (executeCmd verbs).
 * Executes via AUSPEX's own executeCmd function (defined in js/main.js).
 * Replies {loomDeckAck: true, type} to event.origin.
 *
 * IMPORTANT: Does NOT set localStorage.auspex_bridge — the AgentZeus remote poller
 * is left at its default (runs but hits remote HTTPS, silently fails when offline).
 */
(function() {
  'use strict';
  // Allowed command types (AUSPEX executeCmd verb whitelist)
  const ALLOWED_CMDS = new Set([
    'set_cat', 'toggle_overlay', 'toggle_tool', 'open_page',
    'reset_view', 'set_spin', 'open_meridian'
  ]);

  window.addEventListener('message', function(event) {
    var data = event.data;
    if (!data || data.loomDeck !== true) return;
    var cmd = data.cmd;
    if (!cmd || !cmd.type) return;
    if (!ALLOWED_CMDS.has(cmd.type)) {
      console.warn('[loom-adapter] Unknown cmd type:', cmd.type);
      return;
    }
    // Execute via AUSPEX's own dispatch function
    if (typeof executeCmd === 'function') {
      var payload = Object.assign({}, cmd);
      delete payload.type;
      executeCmd(cmd.type, payload);
    }
    // Ack back to parent shell
    if (event.source && event.origin) {
      try {
        event.source.postMessage({ loomDeckAck: true, type: cmd.type }, event.origin);
      } catch(e) { /* cross-origin guard */ }
    }
  });
})();
