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

  // Hide AUSPEX's own top-left brand element (#hdr .logo) when running as a LOOM deck.
  // Reason: the LOOM shell renders its own wordmark pill in the top-bar (z-index 10, above
  // the iframe). AUSPEX's .logo renders at position fixed inside the iframe's own document,
  // but its visual footprint overlaps the LOOM wordmark region when the iframe is full-bleed.
  // We suppress it here rather than in AUSPEX's CSS to keep upstream AUSPEX untouched.
  (function() {
    var style = document.createElement('style');
    style.textContent = '#hdr .logo { display: none !important; }';
    document.head.appendChild(style);
  })();

  // Inside the LOOM cockpit the deck must boot straight to the globe — suppress
  // AUSPEX's first-run tour overlay (its own SEEN_KEY, see js/tutorial.js:12).
  try { if (!localStorage.getItem('auspex.tour.seen.v1')) localStorage.setItem('auspex.tour.seen.v1', String(Date.now())); } catch (e) { /* ignore */ }

  // Allowed command types (AUSPEX executeCmd verb whitelist)
  const ALLOWED_CMDS = new Set([
    'set_cat', 'toggle_overlay', 'toggle_tool', 'open_page',
    'reset_view', 'set_spin', 'open_meridian', 'fly_to'
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
    // Handle fly_to specially — calls globe.pointOfView directly
    if (cmd.type === 'fly_to') {
      var lat = cmd.lat, lng = cmd.lng;
      if (typeof lat !== 'number' || lat < -90 || lat > 90) {
        console.warn('[loom-adapter] fly_to: invalid lat', lat);
        return;
      }
      if (typeof lng !== 'number' || lng < -180 || lng > 180) {
        console.warn('[loom-adapter] fly_to: invalid lng', lng);
        return;
      }
      var gInst = window._auspexGlobe;
      if (gInst && typeof gInst.pointOfView === 'function') {
        gInst.pointOfView({ lat: lat, lng: lng, altitude: cmd.altitude || 1.6 }, 1200);
      } else {
        console.warn('[loom-adapter] fly_to: globe instance not ready');
      }
      // Ack and return — skip executeCmd
      if (event.source && event.origin) {
        try { event.source.postMessage({ loomDeckAck: true, type: cmd.type }, event.origin); } catch(e) {}
      }
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
