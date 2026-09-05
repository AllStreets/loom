import type { OrganFile } from "../../lib/core";
import { version as LOOM_VERSION } from "../../../package.json";

const MANIFEST = JSON.stringify({
  id: "settings",
  name: "Settings",
  description: "Voice, appearance, and building preferences.",
  version: 1,
  permissions: ["settings"],
  powers: ["self"],
});

const ORGAN_JS = `export default {
  id: "settings",
  render: async function(el, loom) {
    var ui = loom.ui;
    var settings = loom.settings;

    // -- Root layout: sidebar + content ------------------------------------------
    var root = document.createElement("div");
    root.style.display = "flex";
    root.style.height = "100%";
    root.style.minHeight = "0";
    root.style.gap = "0";

    // -- Sidebar ------------------------------------------------------------------
    var sidebar = document.createElement("div");
    sidebar.style.width = "140px";
    sidebar.style.flexShrink = "0";
    sidebar.style.display = "flex";
    sidebar.style.flexDirection = "column";
    sidebar.style.gap = "2px";
    sidebar.style.padding = "8px 8px 8px 0";
    sidebar.style.borderRight = "1px solid rgba(255,255,255,.08)";

    var NAV_ITEMS = [
      { label: "LOOM", page: "loom", action: "page-loom" },
      { label: "Voice", page: "voice", action: "page-voice" },
      { label: "Models", page: "models", action: "page-models" },
      { label: "Appearance", page: "appearance", action: "page-appearance" },
      { label: "Building", page: "building", action: "page-building" },
      { label: "System", page: "system", action: "page-system" },
    ];

    var activePage = "voice";
    var navBtns = {};

    function refreshNavBtns() {
      for (var ni = 0; ni < NAV_ITEMS.length; ni++) {
        var item = NAV_ITEMS[ni];
        var nb = navBtns[item.page];
        if (!nb) continue;
        var isActive = item.page === activePage;
        nb.style.background = isActive ? "rgba(34,211,238,.12)" : "transparent";
        nb.style.color = isActive ? ui.tokens.accent : ui.tokens.t2;
        nb.style.fontWeight = isActive ? "700" : "500";
      }
    }

    function showPage(page) {
      activePage = page;
      refreshNavBtns();
      for (var pi = 0; pi < NAV_ITEMS.length; pi++) {
        var pitem = NAV_ITEMS[pi];
        var pageEl = pages[pitem.page];
        if (pageEl) {
          pageEl.style.display = pitem.page === page ? "block" : "none";
        }
      }
      if (page === "models") {
        refreshModelsPage();
      }
    }

    for (var ni = 0; ni < NAV_ITEMS.length; ni++) {
      (function(item) {
        var nb = document.createElement("button");
        nb.className = "lui-btn";
        nb.style.textAlign = "left";
        nb.style.padding = "8px 12px";
        nb.style.borderRadius = "8px";
        nb.style.fontSize = "13.5px";
        nb.style.fontFamily = "inherit";
        nb.style.cursor = "pointer";
        nb.style.border = "none";
        nb.style.transition = "background .15s, color .15s";
        nb.dataset.action = item.action;
        nb.textContent = item.label;
        nb.addEventListener("click", function() { showPage(item.page); });
        navBtns[item.page] = nb;
        sidebar.appendChild(nb);
      })(NAV_ITEMS[ni]);
    }

    // -- ABOUT strip — glyph, name, story, version (bottom of the sidebar) --------
    // Version is interpolated from package.json at seed-build time.
    var about = document.createElement("div");
    about.dataset.testid = "settings-about";
    about.style.marginTop = "auto";
    about.style.paddingTop = "10px";
    about.style.paddingRight = "12px";
    about.style.borderTop = "1px solid rgba(255,255,255,.08)";

    var aboutRow = document.createElement("div");
    aboutRow.style.display = "flex";
    aboutRow.style.alignItems = "center";
    aboutRow.style.gap = "7px";

    // The LOOM glyph — same geometry as public/brand/loom-glyph.svg, colors
    // mapped to tokens (warp = t3, weft = accent).
    var aboutGlyph = document.createElement("span");
    aboutGlyph.style.display = "inline-flex";
    aboutGlyph.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 32 32" fill="none" aria-hidden="true">' +
      '<path d="M10 7v18M16 7v18M22 7v18" stroke="' + ui.tokens.t3 + '" stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M4 20 C6 13 8 12 10 15.5 C12 19 14 20 16 16.5 C18 13 20 12 22 15.5 C24 18.5 26 13 28 8" stroke="' + ui.tokens.accent + '" stroke-width="2.4" stroke-linecap="round"/>' +
      '<path d="M16 13.5v6" stroke="' + ui.tokens.t3 + '" stroke-width="2" stroke-linecap="round"/>' +
      '</svg>';

    var aboutName = document.createElement("b");
    aboutName.style.fontSize = "12px";
    aboutName.style.letterSpacing = ".3em";
    aboutName.style.color = ui.tokens.t1;
    aboutName.textContent = "LOOM";

    aboutRow.appendChild(aboutGlyph);
    aboutRow.appendChild(aboutName);

    var aboutStory = document.createElement("div");
    aboutStory.style.fontSize = "10.5px";
    aboutStory.style.color = ui.tokens.t3;
    aboutStory.style.marginTop = "5px";
    aboutStory.style.lineHeight = "1.4";
    aboutStory.textContent = "a computer that weaves itself";

    var aboutVersion = document.createElement("div");
    aboutVersion.style.fontSize = "10px";
    aboutVersion.style.color = ui.tokens.t3;
    aboutVersion.style.marginTop = "2px";
    aboutVersion.textContent = "v${LOOM_VERSION}";

    about.appendChild(aboutRow);
    about.appendChild(aboutStory);
    about.appendChild(aboutVersion);
    sidebar.appendChild(about);

    // -- Content area -------------------------------------------------------------
    var content = document.createElement("div");
    content.style.flex = "1";
    content.style.overflowY = "auto";
    content.style.padding = "12px 16px";

    var pages = {};

    // ========================================================================
    // PAGE: LOOM — the body, the genome, the tools (Rebirth)
    // ========================================================================
    var self = loom.self;
    var loomPage = document.createElement("div");
    loomPage.dataset.testid = "loom-page";
    pages["loom"] = loomPage;

    loomPage.appendChild(ui.heading("LOOM", "the body, the genome, and the tools that weave them."));

    function sha7(s) { return s ? String(s).slice(0, 7) : "none"; }
    // The same rule the core keeps (reweave.rs is_sha): 7-40 lowercase hex.
    // A body built outside the genome bakes "unknown", threading shelves it
    // under that name, and generations_return can never accept it — so the
    // row is listed (it is on the shelf) and its RETURN is not offered.
    function isSha(s) { return typeof s === "string" && /^[0-9a-f]{7,40}$/.test(s); }
    function gbOf(bytes) { return (Number(bytes || 0) / 1e9).toFixed(1); }
    function relTime(iso) {
      var then = Date.parse(iso);
      if (isNaN(then)) return "at an unknown time";
      var ms = Date.now() - then;
      if (ms < 60000) return "just now";
      if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
      if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
      return Math.floor(ms / 86400000) + "d ago";
    }
    function monoLabel(text, color) {
      var s = document.createElement("span");
      s.style.fontFamily = "monospace";
      s.style.fontSize = "11px";
      s.style.letterSpacing = ".08em";
      s.style.textTransform = "uppercase";
      s.style.color = color || ui.tokens.t3;
      s.textContent = text;
      return s;
    }
    function quiet(text, color) {
      var d = document.createElement("div");
      d.style.fontSize = "12px";
      d.style.lineHeight = "1.5";
      d.style.color = color || ui.tokens.t3;
      d.textContent = text;
      return d;
    }
    function selfReason(err) {
      var m = String(err && err.message || err);
      if (m.indexOf('permission "self"') !== -1 || !self) return "the self power isn't granted — approve it in the organ's POWERS row";
      if (m.indexOf("desktop shell") !== -1) return "this surface needs the desktop shell";
      return m.replace(/^(http|timeout|parse|git|not found|unsupported): */i, "");
    }
    // The owner pressing NOT NOW is an answer, not a fault: it is said in the
    // quiet token, never in warn (round-2 review).
    var DECLINE_LINE = "you said not now — the body stays as it is";
    function selfColor(err) {
      return String(err && err.message || err) === DECLINE_LINE ? ui.tokens.t2 : ui.tokens.warn;
    }
    // What this body can actually do, read from the core — the same fact the
    // consent cards read. Null until the first identity comes back.
    var bodyId = null;
    function canSwapNow() { return !!(bodyId && bodyId.mode === "packaged" && bodyId.canSwap); }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    // -- identity -----------------------------------------------------------------
    var identityBlock = document.createElement("div");
    identityBlock.dataset.testid = "loom-identity";
    identityBlock.style.marginTop = "10px";
    identityBlock.style.marginBottom = "12px";
    identityBlock.appendChild(quiet("reading the body."));
    loomPage.appendChild(identityBlock);

    // -- reweave (shown when threaded and the genome is ahead of the body) --------
    // Settings ASKS; the shell consent card is where the owner agrees. This
    // organ used to carry a confirm strip of its own, which — now that every
    // path to the body ends at that one card — would have asked the same
    // question twice in the same words. One question, one place.
    var reweaveWrap = document.createElement("div");
    reweaveWrap.style.marginBottom = "18px";
    var reweaveBtn = ui.button("REWEAVE", { variant: "primary", action: "self-reweave" });
    var reweaveNote = quiet("");
    reweaveNote.dataset.testid = "loom-reweave-note";
    reweaveNote.style.marginTop = "6px";
    reweaveWrap.appendChild(reweaveNote);
    loomPage.appendChild(reweaveWrap);

    reweaveBtn.addEventListener("click", function() {
      reweaveBtn.disabled = true;
      reweaveNote.textContent = "";
      Promise.resolve().then(function() { return self.reweave(); }).then(function(result) {
        reweaveBtn.disabled = false;
        if (result && result.ok) {
          reweaveNote.style.color = ui.tokens.t2;
          reweaveNote.textContent = "the weave has started — the reweave card carries the rail.";
        } else {
          reweaveNote.style.color = ui.tokens.warn;
          reweaveNote.textContent = (result && result.reason) || "the weave could not start — try again from Settings";
        }
      }).catch(function(err) {
        reweaveBtn.disabled = false;
        reweaveNote.style.color = selfColor(err);
        reweaveNote.textContent = selfReason(err);
      });
    });

    // -- threads: the tool table + THREAD THE LOOM --------------------------------
    loomPage.appendChild(ui.section("Threads"));

    var toolsWrap = document.createElement("div");
    toolsWrap.dataset.testid = "loom-tools";
    toolsWrap.style.marginBottom = "12px";
    toolsWrap.appendChild(quiet("looking for the tools."));
    loomPage.appendChild(toolsWrap);

    var threadWrap = document.createElement("div");
    threadWrap.style.display = "none";
    threadWrap.style.marginBottom = "18px";
    var threadBtn = ui.button("THREAD THE LOOM", { variant: "primary", action: "self-thread" });
    var threadNet = quiet("threading needs the network once — after that LOOM weaves offline.");
    threadNet.style.marginTop = "6px";
    var threadLog = document.createElement("div");
    threadLog.dataset.testid = "loom-thread-log";
    threadLog.style.display = "none";
    threadLog.style.marginTop = "10px";
    threadLog.style.padding = "8px 10px";
    threadLog.style.borderRadius = "8px";
    threadLog.style.border = "1px solid rgba(255,255,255,.08)";
    threadLog.style.fontFamily = "monospace";
    threadLog.style.fontSize = "11px";
    threadLog.style.lineHeight = "1.6";
    threadLog.style.maxHeight = "180px";
    threadLog.style.overflowY = "auto";
    threadWrap.appendChild(threadNet);
    threadWrap.appendChild(threadLog);
    loomPage.appendChild(threadWrap);

    function logLine(text, color) {
      threadLog.style.display = "block";
      var line = document.createElement("div");
      line.style.color = color || ui.tokens.t2;
      line.textContent = text;
      threadLog.appendChild(line);
      threadLog.scrollTop = threadLog.scrollHeight;
    }
    function onThreadEvent(e) {
      var step = String(e && e.step || "").toUpperCase();
      var detail = String(e && e.detail || "");
      var color = e && e.step === "failed" ? ui.tokens.warn : e && e.step === "done" ? ui.tokens.go : ui.tokens.t2;
      logLine(step + " · " + detail, color);
      var tail = (e && e.tail) || [];
      for (var i = 0; i < tail.length; i++) logLine("  " + tail[i], ui.tokens.t3);
    }

    threadBtn.addEventListener("click", function() {
      threadBtn.disabled = true;
      clear(threadLog);
      Promise.resolve().then(function() { return self.thread(onThreadEvent); }).then(function() {
        threadBtn.disabled = false;
        refreshLoomPage();
      }).catch(function(err) {
        threadBtn.disabled = false;
        logLine(selfReason(err), selfColor(err));
      });
    });

    function renderTools(status) {
      clear(toolsWrap);
      var tools = (status && status.tools) || [];
      var drifted = (status && status.drifted) || [];
      var grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.marginTop = "8px";
      grid.style.gridTemplateColumns = "88px minmax(90px, 1fr) minmax(0, 2fr)";
      grid.style.columnGap = "12px";
      grid.style.rowGap = "5px";
      grid.style.alignItems = "baseline";
      grid.appendChild(monoLabel("tool"));
      grid.appendChild(monoLabel("version"));
      grid.appendChild(monoLabel("path"));
      for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        var present = !!t.path;
        var row = document.createElement("div");
        row.style.display = "contents";
        row.dataset.testid = "loom-tool-" + t.name;
        var nameEl = document.createElement("span");
        nameEl.style.fontFamily = "monospace";
        nameEl.style.fontSize = "12.5px";
        nameEl.style.color = present ? ui.tokens.t1 : ui.tokens.warn;
        nameEl.textContent = t.name;
        var verEl = document.createElement("span");
        verEl.style.fontSize = "12.5px";
        verEl.style.color = present ? ui.tokens.t2 : ui.tokens.warn;
        verEl.textContent = present ? (t.version || "present") : "missing";
        // A recorded tool that moved or changed version is reported, not
        // refused: a weave runs against the one found now. Say so plainly.
        if (present && drifted.indexOf(t.name) !== -1) verEl.textContent += " · changed since threading — a weave uses this one, not the recorded one";
        var pathEl = document.createElement("span");
        pathEl.style.fontSize = "12px";
        pathEl.style.fontFamily = "monospace";
        pathEl.style.wordBreak = "break-all";
        if (present) {
          pathEl.style.color = ui.tokens.t3;
          pathEl.textContent = t.path;
        } else {
          pathEl.dataset.testid = "loom-tool-install";
          pathEl.style.color = ui.tokens.warn;
          pathEl.textContent = t.install || "install it, then thread again";
        }
        row.appendChild(nameEl);
        row.appendChild(verEl);
        row.appendChild(pathEl);
        grid.appendChild(row);
      }
      // Not every drift names a tool. "sherpa cache" is the voice engine's
      // prebuilt archive: it came down over HTTP at threading and cannot come
      // down again offline, so its absence stops a weave before it starts.
      // Matched against tool names only, the row never rendered at all.
      for (var d = 0; d < drifted.length; d++) {
        (function(name) {
          for (var k = 0; k < tools.length; k++) if (tools[k].name === name) return;
          var row = document.createElement("div");
          row.style.display = "contents";
          row.dataset.testid = "loom-drift-" + name.replace(/\s+/g, "-");
          var nameEl = document.createElement("span");
          nameEl.style.fontFamily = "monospace";
          nameEl.style.fontSize = "12.5px";
          nameEl.style.color = ui.tokens.warn;
          nameEl.textContent = name;
          var verEl = document.createElement("span");
          verEl.style.fontSize = "12.5px";
          verEl.style.color = ui.tokens.warn;
          verEl.textContent = "gone since threading";
          var whereEl = document.createElement("span");
          whereEl.style.fontSize = "12px";
          whereEl.style.color = ui.tokens.warn;
          whereEl.style.wordBreak = "break-all";
          whereEl.textContent = "no weave can fetch it offline — thread the loom again while the network is there";
          row.appendChild(nameEl);
          row.appendChild(verEl);
          row.appendChild(whereEl);
          grid.appendChild(row);
        })(String(drifted[d]));
      }
      toolsWrap.appendChild(grid);
      if (tools.length === 0) toolsWrap.appendChild(quiet("no tools reported yet."));
    }

    // -- generations --------------------------------------------------------------
    loomPage.appendChild(ui.section("Generations"));
    var gensWrap = document.createElement("div");
    gensWrap.dataset.testid = "loom-generations";
    gensWrap.style.marginTop = "4px";
    gensWrap.style.marginBottom = "18px";
    gensWrap.appendChild(quiet("reading the shelf."));
    loomPage.appendChild(gensWrap);

    function renderGenerations(list) {
      clear(gensWrap);
      if (!list || list.length === 0) {
        gensWrap.appendChild(quiet("no generations yet — the first reweave weaves one."));
        return;
      }
      for (var i = 0; i < list.length; i++) {
        (function(g) {
          var short = sha7(g.sha);
          var row = document.createElement("div");
          row.dataset.testid = "loom-generation-" + short;
          row.style.padding = "7px 0";
          row.style.borderBottom = "1px solid rgba(255,255,255,.06)";
          var line = document.createElement("div");
          line.style.display = "flex";
          line.style.alignItems = "center";
          line.style.gap = "10px";
          line.style.flexWrap = "wrap";
          var shaEl = document.createElement("span");
          shaEl.style.fontFamily = "monospace";
          shaEl.style.fontSize = "12.5px";
          shaEl.style.color = g.isCurrent ? ui.tokens.accent : ui.tokens.t1;
          shaEl.textContent = short;
          line.appendChild(shaEl);
          if (g.isCurrent) line.appendChild(ui.badge("CURRENT", "accent"));
          else if (g.isPrevious) line.appendChild(ui.badge("PREVIOUS", "go"));
          var desc = document.createElement("span");
          desc.style.fontSize = "12px";
          desc.style.color = ui.tokens.t2;
          desc.style.flex = "1";
          desc.style.minWidth = "0";
          desc.textContent = "woven " + relTime(g.wovenAt) + " · " + (g.reason || "reweave") + " · " + (g.commitSubject || "unknown");
          line.appendChild(desc);
          row.appendChild(line);
          // A row whose name is not a sha ("unknown", shelved by threading
          // for a body built outside the genome) is a dead end: the core
          // refuses it before it can become a path component. Listing it is
          // honest; offering a button that can only ever fail is not.
          if (!g.isCurrent && !isSha(g.sha)) {
            var dead = quiet("no way back — this body was built outside the genome, so it has no name to return to.");
            dead.dataset.testid = "loom-return-nameless-" + short;
            dead.style.marginTop = "4px";
            row.appendChild(dead);
          } else if (!g.isCurrent) {
            var ret = ui.button("RETURN", { variant: "ghost", action: "self-return-" + short });
            ret.style.padding = "4px 10px";
            ret.style.fontSize = "12px";
            line.appendChild(ret);
            var note = quiet("");
            note.dataset.testid = "loom-return-note-" + short;
            note.style.marginTop = "4px";
            row.appendChild(note);
            // RETURN asks; the shell consent card carries the sentence and
            // the answer. One question, one place.
            ret.addEventListener("click", function() {
              ret.disabled = true;
              note.textContent = "";
              Promise.resolve().then(function() { return self.returnTo(g.sha); }).then(function() {
                ret.disabled = false;
                note.style.color = ui.tokens.t2;
                // Only a body that can swap gets a rail to watch; everywhere
                // else the card just said the body stays, and so does this.
                note.textContent = canSwapNow()
                  ? "returning to " + short + " — the reweave card carries the rail."
                  : "returned to " + short + " — the genome moved; the body stays.";
              }).catch(function(err) {
                ret.disabled = false;
                note.style.color = selfColor(err);
                note.textContent = selfReason(err);
              });
            });
          }
          gensWrap.appendChild(row);
        })(list[i]);
      }
    }

    // -- reweave preference + storage ---------------------------------------------
    loomPage.appendChild(ui.section("Reweave"));

    var AUTO_KEY = "kernel.autoReweave";
    function readAuto() {
      try {
        var v = settings.get(AUTO_KEY);
        return v === "on" || v === "true" || v === "1";
      } catch (e) {
        return false;
      }
    }
    var autoNote = quiet("");
    autoNote.dataset.testid = "loom-autoreweave-note";
    autoNote.style.marginTop = "6px";
    // The preference is the body's, not a plain setting: kernel.autoReweave
    // arms a weave with no card, so it is written through the self power (the
    // grant whose card says this organ may ask about LOOM's body).
    function writeAuto(on) {
      autoNote.textContent = "";
      Promise.resolve().then(function() {
        if (!self) throw new Error('permission "self" not granted');
        return self.setAutoReweave(on);
      }).catch(function(err) {
        autoNote.style.color = selfColor(err);
        autoNote.textContent = "the preference could not be kept — " + selfReason(err);
      });
    }
    // The same three truths the consent lines tell, read from the core rather
    // than promised blind: a dev body does not swap, and off macOS neither does
    // a packaged one (round-2 review).
    var AUTO_HEAD = "reweave automatically after an approved core edit";
    function autoLabel() {
      if (!bodyId) return AUTO_HEAD;
      if (bodyId.mode === "dev") return AUTO_HEAD + " — in dev the body stays; restart tauri dev to become it";
      if (!bodyId.canSwap) return AUTO_HEAD + " — the swap is macOS-only in this generation; the build and the ledger still work, the body stays";
      return AUTO_HEAD + " — LOOM will close and return each time";
    }
    var autoToggle = ui.toggle(autoLabel(), readAuto(), writeAuto);
    autoToggle.dataset.action = "self-autoreweave";
    autoToggle.style.marginTop = "8px";
    var autoLabelEl = autoToggle.querySelector("span");
    function refreshAutoLabel() {
      if (autoLabelEl) autoLabelEl.textContent = autoLabel();
    }
    loomPage.appendChild(autoToggle);
    loomPage.appendChild(autoNote);

    var storageLine = quiet("measuring loomhome.");
    storageLine.dataset.testid = "loom-storage";
    storageLine.style.marginTop = "12px";
    loomPage.appendChild(storageLine);

    // -- fill ---------------------------------------------------------------------
    function renderIdentity(id) {
      // Everything that describes what a body change will DO reads this.
      bodyId = id;
      refreshAutoLabel();
      clear(identityBlock);
      identityBlock.appendChild(ui.keyval([
        ["mode", id.mode],
        // Three different facts that the round-3 review found conflated:
        // the binary executing (baked at compile time), what the ledger says
        // is current, and where the genome's HEAD is right now. Only the last
        // one moves when LOOM edits itself.
        ["body", sha7(id.genomeSha)],
        ["generation", sha7(id.generation)],
        ["genome head", sha7(id.genomeHead)],
        ["threaded", id.threaded ? "yes" : "no"],
      ]));
      // The actions exist only when they mean something: no REWEAVE button to
      // press when there is nothing to weave, no THREAD button once threaded.
      //
      // Round-3 review, Finding 1: this compared generation with
      // genomeSha — the sha the RUNNING BINARY was compiled from. Threading
      // sets ledger.current = genome_sha() and every weave re-establishes
      // it, so the two are always equal in the steady state and the button
      // was hidden forever after the first weave. It is the genome's HEAD
      // that moves, and the same comparison reweaveReadiness makes.
      var ahead = id.threaded && (id.genomeHead === null || id.genomeHead !== id.generation);
      if (ahead && !reweaveBtn.parentNode) reweaveWrap.insertBefore(reweaveBtn, reweaveNote);
      if (!ahead && reweaveBtn.parentNode) reweaveWrap.removeChild(reweaveBtn);
      reweaveBtn.style.display = "";
      reweaveBtn.disabled = false;
      reweaveNote.style.color = ui.tokens.t3;
      reweaveNote.textContent = ahead ? "" : id.threaded
        ? "the body matches the genome — nothing new to weave."
        : "thread the loom before the first weave.";
      if (!id.threaded && !threadBtn.parentNode) threadWrap.insertBefore(threadBtn, threadNet);
      if (id.threaded && threadBtn.parentNode) threadWrap.removeChild(threadBtn);
      threadWrap.style.display = id.threaded ? "none" : "block";
      storageLine.textContent = "loomhome uses " + gbOf(id.loomhomeBytes) + " GB (vendor + warm build)";
    }

    function refreshLoomPage() {
      if (!self) {
        clear(identityBlock);
        identityBlock.appendChild(quiet(selfReason(null), ui.tokens.warn));
        return;
      }
      Promise.resolve().then(function() { return self.identity(); }).then(function(id) {
        renderIdentity(id);
      }).catch(function(err) {
        clear(identityBlock);
        identityBlock.appendChild(quiet(selfReason(err), ui.tokens.warn));
      });
      Promise.resolve().then(function() { return self.threads(); }).then(renderTools).catch(function(err) {
        clear(toolsWrap);
        toolsWrap.appendChild(quiet(selfReason(err), ui.tokens.warn));
      });
      Promise.resolve().then(function() { return self.generations(); }).then(renderGenerations).catch(function(err) {
        clear(gensWrap);
        gensWrap.appendChild(quiet(selfReason(err), ui.tokens.warn));
      });
    }

    // ========================================================================
    // PAGE: Voice
    // ========================================================================
    var voicePage = document.createElement("div");
    pages["voice"] = voicePage;

    voicePage.appendChild(ui.heading("Voice", "Choose a voice, audition it, and set when LOOM speaks."));

    // Status row with dot
    var voiceStatusDot = ui.dot("warn");
    var statusText = document.createElement("span");
    statusText.style.fontSize = "13px";
    statusText.style.color = ui.tokens.t2;
    statusText.textContent = "Checking voice status...";
    var statusRow = ui.row(voiceStatusDot, statusText);
    voicePage.appendChild(statusRow);

    var downloadRow = document.createElement("div");
    downloadRow.style.display = "none";
    var downloadBtn = ui.button("Download models", { variant: "primary", action: "voice-setup" });
    var progressBar = ui.progress(0);
    progressBar.style.marginTop = "4px";
    progressBar.style.display = "none";
    downloadRow.appendChild(downloadBtn);
    downloadRow.appendChild(progressBar);
    voicePage.appendChild(downloadRow);

    downloadBtn.addEventListener("click", function() {
      downloadBtn.disabled = true;
      downloadBtn.textContent = "Downloading... 0%";
      progressBar.style.display = "block";
      settings.setup(function(pct) {
        progressBar.set(pct);
        downloadBtn.textContent = "Downloading... " + Math.round(pct) + "%";
      }).then(function() {
        downloadBtn.textContent = "Download models";
        downloadBtn.disabled = false;
        refreshStatus();
      }).catch(function(err) {
        downloadBtn.textContent = "Download failed -- retry";
        downloadBtn.disabled = false;
        statusText.textContent = String(err);
      });
    });

    // Voices section
    voicePage.appendChild(ui.section("Voices"));

    var voiceList = ui.list();
    voicePage.appendChild(voiceList.root);

    function refreshVoiceList(voices, currentDefault) {
      voiceList.clear();
      for (var i = 0; i < voices.length; i++) {
        (function(v) {
          var isDefault = v.id === currentDefault;
          var presenceDot = ui.dot(v.present ? "go" : "muted");
          var labelEl = document.createElement("span");
          labelEl.style.fontSize = "14px";
          labelEl.style.color = ui.tokens.t1;
          labelEl.style.flex = "1";
          labelEl.textContent = v.label;

          var auditionBtn = ui.button("Audition", { variant: "ghost", action: "audition-" + v.id });
          auditionBtn.addEventListener("click", function() {
            auditionBtn.disabled = true;
            auditionBtn.textContent = "Playing...";
            settings.audition(v.id).then(function() {
              auditionBtn.textContent = "Audition";
              auditionBtn.disabled = false;
            }).catch(function() {
              auditionBtn.textContent = "Audition";
              auditionBtn.disabled = false;
            });
          });

          var useBtn;
          if (isDefault) {
            useBtn = ui.badge("Current", "accent");
            useBtn.dataset = useBtn.dataset || {};
            useBtn.dataset.action = "choose-" + v.id;
          } else {
            useBtn = ui.button("Use", { variant: "primary", action: "choose-" + v.id });
            useBtn.addEventListener("click", function() {
              settings.set("voice.default", v.id);
              refreshVoiceList(voices, v.id);
            });
          }

          var row = ui.row(presenceDot, labelEl, auditionBtn, useBtn);
          row.style.flexWrap = "wrap";
          voiceList.add(row);
        })(voices[i]);
      }
    }

    // Speak-replies section
    voicePage.appendChild(ui.section("Speak replies"));

    var speakOptions = [
      { label: "Always", value: "always", action: "speak-always" },
      { label: "When spoken", value: "whenSpoken", action: "speak-whenSpoken" },
      { label: "Never", value: "never", action: "speak-never" },
    ];

    var speakBtns = [];
    var speakRow = document.createElement("div");
    speakRow.style.display = "flex";
    speakRow.style.gap = "6px";

    function refreshSpeakBtns(current) {
      for (var i = 0; i < speakBtns.length; i++) {
        var b = speakBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var si = 0; si < speakOptions.length; si++) {
      (function(opt) {
        var btn = document.createElement("button");
        btn.className = "lui-btn";
        btn.style.borderRadius = "8px";
        btn.style.padding = "7px 14px";
        btn.style.fontWeight = "600";
        btn.style.fontSize = "14px";
        btn.style.cursor = "pointer";
        btn.style.fontFamily = "inherit";
        btn.style.transition = "filter .15s, background .15s, border-color .15s";
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.color = ui.tokens.t1;
        btn.dataset.action = opt.action;
        btn._value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener("click", function() {
          settings.set("voice.speakReplies", opt.value);
          refreshSpeakBtns(opt.value);
        });
        speakBtns.push(btn);
        speakRow.appendChild(btn);
      })(speakOptions[si]);
    }
    voicePage.appendChild(speakRow);

    // Mic test section
    voicePage.appendChild(ui.section("Microphone"));

    var micTestBtn = ui.button("Test microphone", { variant: "ghost", action: "mic-test" });
    var micResult = document.createElement("span");
    micResult.style.fontSize = "12.5px";
    micResult.style.color = ui.tokens.t3;
    micTestBtn.addEventListener("click", function() {
      micTestBtn.disabled = true;
      micTestBtn.textContent = "Recording 2s...";
      micResult.textContent = "";
      settings.micTest().then(function(text) {
        micResult.textContent = text ? "Heard: " + text : "No speech detected.";
        micTestBtn.textContent = "Test microphone";
        micTestBtn.disabled = false;
      });
    });
    voicePage.appendChild(ui.row(micTestBtn, micResult));

    // ========================================================================
    // PAGE: Models
    // ========================================================================
    var modelsPage = document.createElement("div");
    pages["models"] = modelsPage;

    var modelsHeading = ui.heading("Models", "Override which local model each role uses. Leave blank to use the fleet default.");
    modelsPage.appendChild(modelsHeading);

    var modelsNote = document.createElement("div");
    modelsNote.style.fontSize = "12px";
    modelsNote.style.color = ui.tokens.t3;
    modelsNote.style.marginTop = "4px";
    modelsNote.textContent = "Absent models fall back automatically to the next available option.";
    modelsPage.appendChild(modelsNote);

    var modelRoleCards = {};

    var ROLES = ["builder", "companion", "rewriter"];

    for (var ri = 0; ri < ROLES.length; ri++) {
      (function(role) {
        var card = ui.card({ title: role.charAt(0).toUpperCase() + role.slice(1) });
        modelRoleCards[role] = card;
        modelsPage.appendChild(card.root);
        card.root.style.marginTop = "10px";
      })(ROLES[ri]);
    }

    function refreshModelsPage() {
      settings.models().then(function(entries) {
        for (var ei = 0; ei < entries.length; ei++) {
          (function(entry) {
            var role = entry.role;
            var card = modelRoleCards[role];
            if (!card) return;
            // Clear and rebuild card body
            card.body.innerHTML = "";

            // Effective model keyval
            card.body.appendChild(ui.keyval([
              ["Effective model", entry.model],
              ["Default", entry["default"]],
            ]));

            // Status dot row
            var statusDot = ui.dot(entry.present ? "go" : "muted");
            var statusLabel = document.createElement("span");
            statusLabel.style.fontSize = "12.5px";
            statusLabel.style.color = ui.tokens.t3;
            statusLabel.textContent = entry.present ? "installed" : "not installed";
            card.body.appendChild(ui.row(statusDot, statusLabel));

            // Override input + buttons
            var overrideSection = ui.section("Override");
            card.body.appendChild(overrideSection);

            var inp = ui.input({ placeholder: entry["default"], action: "model-input-" + role });
            inp.value = entry.override;
            card.body.appendChild(inp);

            var errorSpan = document.createElement("span");
            errorSpan.style.fontSize = "12px";
            errorSpan.style.color = ui.tokens.danger;
            errorSpan.style.display = "none";
            card.body.appendChild(errorSpan);

            var applyBtn = ui.button("Apply", { variant: "primary", action: "model-apply-" + role });
            var resetBtn = ui.button("Reset", { variant: "ghost", action: "model-reset-" + role });
            card.body.appendChild(ui.row(applyBtn, resetBtn));

            applyBtn.addEventListener("click", function() {
              var tag = inp.value.trim();
              errorSpan.style.display = "none";
              errorSpan.textContent = "";
              settings.setModel(role, tag).then(function(result) {
                if (result.ok) {
                  refreshModelsPage();
                } else {
                  errorSpan.textContent = result.error || "Invalid tag";
                  errorSpan.style.display = "inline";
                }
              });
            });

            resetBtn.addEventListener("click", function() {
              errorSpan.style.display = "none";
              errorSpan.textContent = "";
              settings.setModel(role, "").then(function(result) {
                if (result.ok) {
                  inp.value = "";
                  refreshModelsPage();
                } else {
                  errorSpan.textContent = result.error || "Reset failed";
                  errorSpan.style.display = "inline";
                }
              });
            });
          })(entries[ei]);
        }
      }).catch(function() {});
    }

    // ========================================================================
    // PAGE: Appearance
    // ========================================================================
    var appearancePage = document.createElement("div");
    pages["appearance"] = appearancePage;

    appearancePage.appendChild(ui.heading("Orb renderer", "Auto detects your GPU; Flat uses a simpler 2D orb."));

    var orbOptions = [
      { label: "Auto", value: "auto", action: "orb-auto" },
      { label: "Flat", value: "flat", action: "orb-flat" },
    ];
    var orbBtns = [];
    var orbRow = document.createElement("div");
    orbRow.style.display = "flex";
    orbRow.style.gap = "6px";

    function refreshOrbBtns(current) {
      for (var i = 0; i < orbBtns.length; i++) {
        var b = orbBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var oi = 0; oi < orbOptions.length; oi++) {
      (function(opt) {
        var btn = document.createElement("button");
        btn.className = "lui-btn";
        btn.style.borderRadius = "8px";
        btn.style.padding = "7px 14px";
        btn.style.fontWeight = "600";
        btn.style.fontSize = "14px";
        btn.style.cursor = "pointer";
        btn.style.fontFamily = "inherit";
        btn.style.transition = "filter .15s, background .15s, border-color .15s";
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.color = ui.tokens.t1;
        btn.dataset.action = opt.action;
        btn._value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener("click", function() {
          settings.set("orb.tier", opt.value);
          refreshOrbBtns(opt.value);
        });
        orbBtns.push(btn);
        orbRow.appendChild(btn);
      })(orbOptions[oi]);
    }
    appearancePage.appendChild(orbRow);

    // Tapestry section
    appearancePage.appendChild(ui.section("Tapestry"));

    var tapNote = document.createElement("div");
    tapNote.style.fontSize = "12px";
    tapNote.style.color = ui.tokens.t3;
    tapNote.style.marginBottom = "8px";
    tapNote.textContent = "Show the tapestry — LOOM's history woven behind the orb.";
    appearancePage.appendChild(tapNote);

    var tapOptions = [
      { label: "On", value: "on", action: "tapestry-on" },
      { label: "Off", value: "off", action: "tapestry-off" },
    ];
    var tapBtns = [];
    var tapRow = document.createElement("div");
    tapRow.style.display = "flex";
    tapRow.style.gap = "6px";

    function refreshTapBtns(current) {
      for (var i = 0; i < tapBtns.length; i++) {
        var b = tapBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var ti = 0; ti < tapOptions.length; ti++) {
      (function(opt) {
        var btn = document.createElement("button");
        btn.className = "lui-btn";
        btn.style.borderRadius = "8px";
        btn.style.padding = "7px 14px";
        btn.style.fontWeight = "600";
        btn.style.fontSize = "14px";
        btn.style.cursor = "pointer";
        btn.style.fontFamily = "inherit";
        btn.style.transition = "filter .15s, background .15s, border-color .15s";
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.color = ui.tokens.t1;
        btn.dataset.action = opt.action;
        btn._value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener("click", function() {
          settings.set("cockpit.tapestry", opt.value);
          refreshTapBtns(opt.value);
        });
        tapBtns.push(btn);
        tapRow.appendChild(btn);
      })(tapOptions[ti]);
    }
    appearancePage.appendChild(tapRow);


    // Initiative section
    appearancePage.appendChild(ui.section("Initiative"));

    var initNote = document.createElement("div");
    initNote.style.fontSize = "12px";
    initNote.style.color = ui.tokens.t3;
    initNote.style.marginBottom = "8px";
    initNote.textContent = "Let LOOM propose organs from how you use it. Earned from your activity, one idea at a time, never a nag.";
    appearancePage.appendChild(initNote);

    var initOptions = [
      { label: "On", value: "on", action: "initiative-on" },
      { label: "Off", value: "off", action: "initiative-off" },
    ];
    var initBtns = [];
    var initRow = document.createElement("div");
    initRow.style.display = "flex";
    initRow.style.gap = "6px";

    function refreshInitBtns(current) {
      for (var i = 0; i < initBtns.length; i++) {
        var b = initBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var iti = 0; iti < initOptions.length; iti++) {
      (function(opt) {
        var btn = document.createElement("button");
        btn.className = "lui-btn";
        btn.style.borderRadius = "8px";
        btn.style.padding = "7px 14px";
        btn.style.fontWeight = "600";
        btn.style.fontSize = "14px";
        btn.style.cursor = "pointer";
        btn.style.fontFamily = "inherit";
        btn.style.transition = "filter .15s, background .15s, border-color .15s";
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.color = ui.tokens.t1;
        btn.dataset.action = opt.action;
        btn._value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener("click", function() {
          settings.set("cockpit.initiative", opt.value);
          refreshInitBtns(opt.value);
        });
        initBtns.push(btn);
        initRow.appendChild(btn);
      })(initOptions[iti]);
    }
    appearancePage.appendChild(initRow);

    // ========================================================================
    // PAGE: Building
    // ========================================================================
    var buildingPage = document.createElement("div");
    pages["building"] = buildingPage;

    buildingPage.appendChild(ui.heading("Review before save", "When on, LOOM shows a diff before writing any organ file."));

    var reviewOptions = [
      { label: "On", value: "1", action: "review-on" },
      { label: "Off", value: "0", action: "review-off" },
    ];
    var reviewBtns = [];
    var reviewRow = document.createElement("div");
    reviewRow.style.display = "flex";
    reviewRow.style.gap = "6px";

    function refreshReviewBtns(current) {
      for (var i = 0; i < reviewBtns.length; i++) {
        var b = reviewBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var rvi = 0; rvi < reviewOptions.length; rvi++) {
      (function(opt) {
        var btn = document.createElement("button");
        btn.className = "lui-btn";
        btn.style.borderRadius = "8px";
        btn.style.padding = "7px 14px";
        btn.style.fontWeight = "600";
        btn.style.fontSize = "14px";
        btn.style.cursor = "pointer";
        btn.style.fontFamily = "inherit";
        btn.style.transition = "filter .15s, background .15s, border-color .15s";
        btn.style.background = "transparent";
        btn.style.border = "1px solid rgba(255,255,255,.18)";
        btn.style.color = ui.tokens.t1;
        btn.dataset.action = opt.action;
        btn._value = opt.value;
        btn.textContent = opt.label;
        btn.addEventListener("click", function() {
          settings.set("loom.reviewBeforeSave", opt.value);
          refreshReviewBtns(opt.value);
        });
        reviewBtns.push(btn);
        reviewRow.appendChild(btn);
      })(reviewOptions[rvi]);
    }
    buildingPage.appendChild(reviewRow);

    // ========================================================================
    // PAGE: System
    // ========================================================================
    var systemPage = document.createElement("div");
    pages["system"] = systemPage;

    systemPage.appendChild(ui.heading("System", "Reset LOOM to factory defaults."));

    var resetNote = document.createElement("div");
    resetNote.style.fontSize = "12px";
    resetNote.style.color = ui.tokens.t3;
    resetNote.style.marginBottom = "12px";
    resetNote.textContent = "Organs' code is kept; deleted seed organs will return.";
    systemPage.appendChild(resetNote);

    var resetBtn = ui.button("Reset LOOM to defaults", { variant: "ghost", action: "system-reset" });
    resetBtn.style.color = ui.tokens.danger;
    resetBtn.style.borderColor = ui.tokens.danger;

    var resetConfirmStrip = document.createElement("div");
    resetConfirmStrip.style.display = "none";
    resetConfirmStrip.style.gap = "8px";
    resetConfirmStrip.style.alignItems = "center";
    resetConfirmStrip.style.marginTop = "8px";
    resetConfirmStrip.dataset.testid = "system-reset-confirm";

    var resetConfirmLabel = document.createElement("span");
    resetConfirmLabel.style.fontSize = "12px";
    resetConfirmLabel.style.color = ui.tokens.t2;
    resetConfirmLabel.textContent = "This will clear all settings and restart. Organs' code is kept.";

    var resetConfirmBtn = ui.button("RESET", { variant: "primary", action: "system-reset-confirm" });
    resetConfirmBtn.style.background = ui.tokens.danger;
    resetConfirmBtn.style.color = "#fff";
    resetConfirmBtn.style.border = "none";

    var resetCancelBtn = ui.button("KEEP", { variant: "ghost", action: "system-reset-cancel" });

    resetConfirmStrip.appendChild(resetConfirmLabel);
    resetConfirmStrip.appendChild(resetConfirmBtn);
    resetConfirmStrip.appendChild(resetCancelBtn);

    resetBtn.addEventListener("click", function() {
      resetConfirmStrip.style.display = "flex";
      resetBtn.style.display = "none";
    });

    resetCancelBtn.addEventListener("click", function() {
      resetConfirmStrip.style.display = "none";
      resetBtn.style.display = "";
    });

    resetConfirmBtn.addEventListener("click", function() {
      resetConfirmBtn.disabled = true;
      resetConfirmBtn.textContent = "Resetting...";
      settings.resetAll().catch(function() {
        resetConfirmBtn.disabled = false;
        resetConfirmBtn.textContent = "RESET";
      });
    });

    systemPage.appendChild(resetBtn);
    systemPage.appendChild(resetConfirmStrip);

    // -- Assemble -----------------------------------------------------------------
    for (var pi = 0; pi < NAV_ITEMS.length; pi++) {
      var pitem = NAV_ITEMS[pi];
      var pageEl = pages[pitem.page];
      if (pageEl) {
        pageEl.style.display = "none";
        content.appendChild(pageEl);
      }
    }

    root.appendChild(sidebar);
    root.appendChild(content);
    el.appendChild(root);

    // -- Initialize state ---------------------------------------------------------
    function refreshStatus() {
      settings.voiceStatus().then(function(status) {
        if (status.ready) {
          statusText.textContent = "Voice models ready.";
          voiceStatusDot.style.background = ui.tokens.go;
          voiceStatusDot.style.boxShadow = "0 0 6px " + ui.tokens.go;
          downloadRow.style.display = "none";
        } else {
          statusText.textContent = "Models not downloaded." + (status.missing_bytes_hint ? " (~" + status.missing_bytes_hint + ")" : "");
          voiceStatusDot.style.background = ui.tokens.warn;
          voiceStatusDot.style.boxShadow = "0 0 6px " + ui.tokens.warn;
          downloadRow.style.display = "block";
        }
      }).catch(function() {
        statusText.textContent = "Voice not available.";
        voiceStatusDot.style.background = ui.tokens.danger;
        voiceStatusDot.style.boxShadow = "0 0 6px " + ui.tokens.danger;
      });
    }

    settings.voices().then(function(voices) {
      var currentDefault = settings.get("voice.default") || "en_US-lessac-medium";
      refreshVoiceList(voices, currentDefault);
    });

    refreshSpeakBtns(settings.get("voice.speakReplies") || "whenSpoken");
    refreshOrbBtns(settings.get("orb.tier") || "auto");
    refreshTapBtns(settings.get("cockpit.tapestry") || "on");
    refreshInitBtns(settings.get("cockpit.initiative") || "on");
    refreshReviewBtns(settings.get("loom.reviewBeforeSave") || "0");
    refreshStatus();
    refreshLoomPage();
    showPage("loom");
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "choose voice sets voice.default in settings",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var useBtn = el.querySelector('[data-action="choose-en_GB-alba-medium"]');
      assert(useBtn !== null, "Use button for alba voice exists");
      useBtn.click();
      assert(loom.settings.get("voice.default") === "en_GB-alba-medium", "voice.default updated in settings");
    },
  },
  {
    name: "speak-replies choice persists via settings.set",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 10); });
      var alwaysBtn = el.querySelector('[data-action="speak-always"]');
      assert(alwaysBtn !== null, "speak-always button exists");
      alwaysBtn.click();
      assert(loom.settings.get("voice.speakReplies") === "always", "speakReplies set to always");
      var neverBtn = el.querySelector('[data-action="speak-never"]');
      assert(neverBtn !== null, "speak-never button exists");
      neverBtn.click();
      assert(loom.settings.get("voice.speakReplies") === "never", "speakReplies updated to never");
    },
  },
  {
    name: "renders all three voice rows",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var voiceIds = ["en_US-lessac-medium", "en_GB-alba-medium", "en_US-libritts-high"];
      for (var i = 0; i < voiceIds.length; i++) {
        var id = voiceIds[i];
        var auditionBtn = el.querySelector('[data-action="audition-' + id + '"]');
        assert(auditionBtn !== null, "Audition button exists for " + id);
      }
    },
  },
  {
    name: "nav to models page renders models content",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      assert(modelsNav !== null, "page-models nav button exists");
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 50); });
      var applyBtn = el.querySelector('[data-action="model-apply-builder"]');
      assert(applyBtn !== null, "model-apply-builder button appears after nav to models");
    },
  },
  {
    name: "model apply writes via setModel mock",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      var inp = el.querySelector('[data-action="model-input-rewriter"]');
      assert(inp !== null, "model-input-rewriter exists");
      inp.value = "qwen3:0.6b";
      var applyBtn = el.querySelector('[data-action="model-apply-rewriter"]');
      assert(applyBtn !== null, "model-apply-rewriter button exists");
      applyBtn.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      assert(loom.settings.get("model.rewriter") === "qwen3:0.6b", "setModel wrote model.rewriter via mock");
    },
  },
  {
    name: "model reset clears override",
    fn: async function({ el, loom, assert }) {
      loom.settings.set("model.builder", "llama3:8b");
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      assert(modelsNav !== null, "page-models nav button exists");
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 80); });
      var inp = el.querySelector('[data-action="model-input-builder"]');
      assert(inp !== null, "model-input-builder exists");
      assert(inp.value === "llama3:8b", "input reflects live override before reset (got: " + inp.value + ")");
      var resetBtn = el.querySelector('[data-action="model-reset-builder"]');
      assert(resetBtn !== null, "model-reset-builder button exists");
      resetBtn.click();
      await new Promise(function(r) { setTimeout(r, 80); });
      assert(loom.settings.get("model.builder") === "", "reset clears model.builder to empty string");
      var inp2 = el.querySelector('[data-action="model-input-builder"]');
      assert(inp2 !== null, "model-input-builder still present after reset");
      assert(inp2.value === "", "input cleared after reset (got: " + inp2.value + ")");
    },
  },
  {
    name: "invalid model tag shows error, does not write",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      var inp = el.querySelector('[data-action="model-input-companion"]');
      assert(inp !== null, "model-input-companion exists");
      inp.value = "bad tag!";
      var applyBtn = el.querySelector('[data-action="model-apply-companion"]');
      applyBtn.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      assert(loom.settings.get("model.companion") === "", "invalid tag was not written");
    },
  },
  {
    name: "page-system nav exists",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      assert(sysNav !== null, "page-system nav button exists");
    },
  },
  {
    name: "system reset confirm strip appears on reset button click",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      assert(sysNav !== null, "page-system nav exists");
      sysNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var resetBtn = el.querySelector('[data-action="system-reset"]');
      assert(resetBtn !== null, "system-reset button exists");
      resetBtn.click();
      var strip = el.querySelector('[data-testid="system-reset-confirm"]');
      assert(strip !== null, "system-reset-confirm strip exists");
      assert(strip.style.display !== "none", "confirm strip is visible after click");
    },
  },
  {
    name: "system reset confirm calls settings.resetAll",
    fn: async function({ el, loom, assert }) {
      var resetAllCalls = 0;
      loom.settings.resetAll = function() {
        resetAllCalls++;
        return Promise.resolve();
      };
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      sysNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var resetBtn = el.querySelector('[data-action="system-reset"]');
      resetBtn.click();
      var confirmBtn = el.querySelector('[data-action="system-reset-confirm"]');
      assert(confirmBtn !== null, "system-reset-confirm button exists");
      confirmBtn.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      assert(resetAllCalls === 1, "settings.resetAll called once (got: " + resetAllCalls + ")");
    },
  },
  {
    name: "initiative toggle sets cockpit.initiative via settings.set",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var appearanceNav = el.querySelector('[data-action="page-appearance"]');
      assert(appearanceNav !== null, "page-appearance nav button exists");
      appearanceNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var offBtn = el.querySelector('[data-action="initiative-off"]');
      assert(offBtn !== null, "initiative-off button exists");
      offBtn.click();
      assert(loom.settings.get("cockpit.initiative") === "off", "initiative-off sets cockpit.initiative to off");
      var onBtn = el.querySelector('[data-action="initiative-on"]');
      assert(onBtn !== null, "initiative-on button exists");
      onBtn.click();
      assert(loom.settings.get("cockpit.initiative") === "on", "initiative-on sets cockpit.initiative to on");
    },
  },
  {
    name: "LOOM page is first in the nav and shows the threaded dev identity",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var navBtns = el.querySelectorAll('[data-action^="page-"]');
      assert(navBtns[0].getAttribute("data-action") === "page-loom", "LOOM is the first nav item");
      var page = el.querySelector('[data-testid="loom-page"]');
      assert(page !== null && page.style.display !== "none", "LOOM page is shown at open");
      var id = el.querySelector('[data-testid="loom-identity"]');
      assert(id.textContent.indexOf("dev") !== -1, "identity names the mode");
      assert(id.textContent.indexOf("a1b2c3d") !== -1, "identity shows the genome sha7");
    },
  },
  {
    name: "no THREAD or REWEAVE action when the body matches the genome",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      assert(el.querySelector('[data-action="self-thread"]') === null, "no THREAD action when threaded");
      var rw = el.querySelector('[data-action="self-reweave"]');
      assert(rw === null || rw.style.display === "none", "no REWEAVE when nothing new");
      var tools = el.querySelector('[data-testid="loom-tools"]');
      assert(tools.textContent.indexOf("/usr/bin/git") !== -1, "tool table lists git's path");
      assert(el.querySelector('[data-testid="loom-tool-install"]') === null, "no install line when every tool is present");
      assert(el.querySelector('[data-testid="loom-generations"]').textContent.indexOf("no generations yet") !== -1, "empty shelf says so");
    },
  },
  {
    name: "autoReweave toggle arms the body through the self power",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var toggle = el.querySelector('[data-action="self-autoreweave"]');
      assert(toggle !== null, "autoReweave toggle exists");
      assert(toggle.textContent.indexOf("in dev the body stays") !== -1, "the label tells this body's truth");
      toggle.click();
      await new Promise(function(r) { setTimeout(r, 10); });
      assert(loom.settings.get("kernel.autoReweave") === "on", "toggle on arms it");
      toggle.click();
      await new Promise(function(r) { setTimeout(r, 10); });
      assert(loom.settings.get("kernel.autoReweave") === "off", "toggle off disarms it");
    },
  },
  {
    name: "storage line is honest about loomhome",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var line = el.querySelector('[data-testid="loom-storage"]');
      assert(line.textContent === "loomhome uses 0.0 GB (vendor + warm build)", "storage line (got: " + line.textContent + ")");
    },
  },
  {
    name: "about strip renders glyph, name, story, and version",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var about = el.querySelector('[data-testid="settings-about"]');
      assert(about !== null, "settings-about strip exists");
      assert(about.querySelector("svg") !== null, "about strip contains the glyph svg");
      assert(about.textContent.indexOf("LOOM") !== -1, "about strip names LOOM");
      assert(about.textContent.indexOf("a computer that weaves itself") !== -1, "about strip carries the story line");
      assert(/v\\d+\\.\\d+\\.\\d+/.test(about.textContent), "about strip shows a semver version");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
