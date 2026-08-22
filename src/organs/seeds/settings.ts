import type { OrganFile } from "../../lib/core";
import { version as LOOM_VERSION } from "../../../package.json";

const MANIFEST = JSON.stringify({
  id: "settings",
  name: "Settings",
  description: "Voice, appearance, and building preferences.",
  version: 1,
  permissions: ["settings"],
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

    // ---- Cloud builder section ------------------------------------------------
    modelsPage.appendChild(ui.section("Cloud builder"));

    var cloudNote = document.createElement("div");
    cloudNote.style.fontSize = "12px";
    cloudNote.style.color = ui.tokens.t3;
    cloudNote.style.marginBottom = "8px";
    cloudNote.textContent = "By default all builds run on your local fleet. Enable to use claude-opus-4-8 for builder calls with automatic local fallback.";
    modelsPage.appendChild(cloudNote);

    // Enable/disable toggle
    var cloudEnableRow = document.createElement("div");
    cloudEnableRow.style.display = "flex";
    cloudEnableRow.style.gap = "6px";
    cloudEnableRow.style.marginBottom = "10px";

    var cloudOffBtn = document.createElement("button");
    cloudOffBtn.className = "lui-btn";
    cloudOffBtn.style.borderRadius = "8px";
    cloudOffBtn.style.padding = "7px 14px";
    cloudOffBtn.style.fontWeight = "600";
    cloudOffBtn.style.fontSize = "14px";
    cloudOffBtn.style.cursor = "pointer";
    cloudOffBtn.style.fontFamily = "inherit";
    cloudOffBtn.style.transition = "filter .15s, background .15s, border-color .15s";
    cloudOffBtn.dataset.action = "cloud-builder-off";
    cloudOffBtn.textContent = "Local only";

    var cloudOnBtn = document.createElement("button");
    cloudOnBtn.className = "lui-btn";
    cloudOnBtn.style.borderRadius = "8px";
    cloudOnBtn.style.padding = "7px 14px";
    cloudOnBtn.style.fontWeight = "600";
    cloudOnBtn.style.fontSize = "14px";
    cloudOnBtn.style.cursor = "pointer";
    cloudOnBtn.style.fontFamily = "inherit";
    cloudOnBtn.style.transition = "filter .15s, background .15s, border-color .15s";
    cloudOnBtn.dataset.action = "cloud-builder-on";
    cloudOnBtn.textContent = "Claude (cloud)";

    function refreshCloudToggle(current) {
      var isOn = current === "anthropic";
      cloudOffBtn.style.background = !isOn ? ui.tokens.accent : "transparent";
      cloudOffBtn.style.color = !isOn ? "#04222b" : ui.tokens.t1;
      cloudOffBtn.style.border = !isOn ? "none" : "1px solid rgba(255,255,255,.18)";
      cloudOnBtn.style.background = isOn ? ui.tokens.accent : "transparent";
      cloudOnBtn.style.color = isOn ? "#04222b" : ui.tokens.t1;
      cloudOnBtn.style.border = isOn ? "none" : "1px solid rgba(255,255,255,.18)";
    }

    cloudOffBtn.addEventListener("click", function() {
      settings.set("model.cloudBuilder", "off");
      refreshCloudToggle("off");
    });
    cloudOnBtn.addEventListener("click", function() {
      settings.set("model.cloudBuilder", "anthropic");
      refreshCloudToggle("anthropic");
    });

    cloudEnableRow.appendChild(cloudOffBtn);
    cloudEnableRow.appendChild(cloudOnBtn);
    modelsPage.appendChild(cloudEnableRow);

    // API key input (password type -- write-only)
    var keyLabel = document.createElement("div");
    keyLabel.style.fontSize = "12.5px";
    keyLabel.style.color = ui.tokens.t3;
    keyLabel.style.marginBottom = "4px";
    keyLabel.textContent = "Anthropic API key";
    modelsPage.appendChild(keyLabel);

    var keyStatusSpan = document.createElement("span");
    keyStatusSpan.style.fontSize = "12px";
    keyStatusSpan.style.color = ui.tokens.t3;
    keyStatusSpan.style.marginLeft = "8px";

    var keyInp = document.createElement("input");
    keyInp.type = "password";
    keyInp.placeholder = "sk-ant-...";
    keyInp.autocomplete = "off";
    keyInp.dataset.action = "cloud-key-input";
    keyInp.style.background = "rgba(255,255,255,.05)";
    keyInp.style.border = "1px solid rgba(255,255,255,.12)";
    keyInp.style.borderRadius = "6px";
    keyInp.style.color = ui.tokens.t1;
    keyInp.style.fontFamily = "inherit";
    keyInp.style.fontSize = "13px";
    keyInp.style.padding = "6px 10px";
    keyInp.style.width = "100%";
    keyInp.style.boxSizing = "border-box";

    modelsPage.appendChild(keyInp);

    var keySaveBtn = ui.button("Save key", { variant: "primary", action: "cloud-key-save" });
    var keyClearBtn = ui.button("Clear", { variant: "ghost", action: "cloud-key-clear" });
    var keyBtnRow = ui.row(keySaveBtn, keyClearBtn, keyStatusSpan);
    keyBtnRow.style.marginTop = "6px";
    modelsPage.appendChild(keyBtnRow);

    function refreshKeyStatus() {
      settings.cloudKeyPresent().then(function(present) {
        if (present) {
          keyStatusSpan.textContent = "key saved";
          keyStatusSpan.style.color = ui.tokens.go || "#22c55e";
          keyInp.placeholder = "sk-ant-... (key saved -- enter new to replace)";
        } else {
          keyStatusSpan.textContent = "";
          keyInp.placeholder = "sk-ant-...";
        }
      }).catch(function() {
        keyStatusSpan.textContent = "";
      });
    }

    keySaveBtn.addEventListener("click", function() {
      var k = keyInp.value.trim();
      if (!k) return;
      keySaveBtn.disabled = true;
      keySaveBtn.textContent = "Saving...";
      settings.cloudKeySet(k).then(function() {
        keyInp.value = "";
        keySaveBtn.textContent = "Save key";
        keySaveBtn.disabled = false;
        refreshKeyStatus();
      }).catch(function(err) {
        keySaveBtn.textContent = "Save key";
        keySaveBtn.disabled = false;
        keyStatusSpan.textContent = String(err);
        keyStatusSpan.style.color = ui.tokens.danger;
      });
    });

    keyClearBtn.addEventListener("click", function() {
      keyClearBtn.disabled = true;
      settings.cloudKeyClear().then(function() {
        keyClearBtn.disabled = false;
        keyInp.value = "";
        refreshKeyStatus();
      }).catch(function() {
        keyClearBtn.disabled = false;
      });
    });

    refreshCloudToggle(settings.get("model.cloudBuilder") || "off");
    refreshKeyStatus();

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

    // Constellation section
    appearancePage.appendChild(ui.section("Constellation"));

    var constNote = document.createElement("div");
    constNote.style.fontSize = "12px";
    constNote.style.color = ui.tokens.t3;
    constNote.style.marginBottom = "8px";
    constNote.textContent = "Show the agent constellation ring around the orb.";
    appearancePage.appendChild(constNote);

    var constOptions = [
      { label: "On", value: "on", action: "constellation-on" },
      { label: "Off", value: "off", action: "constellation-off" },
    ];
    var constBtns = [];
    var constRow = document.createElement("div");
    constRow.style.display = "flex";
    constRow.style.gap = "6px";

    function refreshConstBtns(current) {
      for (var i = 0; i < constBtns.length; i++) {
        var b = constBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var ci = 0; ci < constOptions.length; ci++) {
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
          settings.set("cockpit.constellation", opt.value);
          refreshConstBtns(opt.value);
        });
        constBtns.push(btn);
        constRow.appendChild(btn);
      })(constOptions[ci]);
    }
    appearancePage.appendChild(constRow);

    // Globe interaction section
    appearancePage.appendChild(ui.section("Globe interaction"));

    var interactNote = document.createElement("div");
    interactNote.style.fontSize = "12px";
    interactNote.style.color = ui.tokens.t3;
    interactNote.style.marginBottom = "8px";
    interactNote.textContent = "Allow pointer events on the globe deck (click and pan AUSPEX directly).";
    appearancePage.appendChild(interactNote);

    var interactOptions = [
      { label: "On", value: "on", action: "interact-on" },
      { label: "Off", value: "off", action: "interact-off" },
    ];
    var interactBtns = [];
    var interactRow = document.createElement("div");
    interactRow.style.display = "flex";
    interactRow.style.gap = "6px";

    function refreshInteractBtns(current) {
      for (var i = 0; i < interactBtns.length; i++) {
        var b = interactBtns[i];
        var isActive = b._value === current;
        b.style.background = isActive ? ui.tokens.accent : "transparent";
        b.style.color = isActive ? "#04222b" : ui.tokens.t1;
        b.style.border = isActive ? "none" : "1px solid rgba(255,255,255,.18)";
        b.style.fontWeight = isActive ? "700" : "600";
      }
    }

    for (var ii = 0; ii < interactOptions.length; ii++) {
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
          settings.set("cockpit.interact", opt.value);
          refreshInteractBtns(opt.value);
        });
        interactBtns.push(btn);
        interactRow.appendChild(btn);
      })(interactOptions[ii]);
    }
    appearancePage.appendChild(interactRow);

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

    // ========================================================================
    // SECTION: Decks (AGORA URL) — within the System page
    // ========================================================================
    systemPage.appendChild(ui.section("Decks"));

    var agoraUrlNote = document.createElement("div");
    agoraUrlNote.style.fontSize = "12px";
    agoraUrlNote.style.color = ui.tokens.t3;
    agoraUrlNote.style.marginBottom = "8px";
    agoraUrlNote.textContent = "AGORA URL — the local conviction-market web server (http(s)://localhost or 127.0.0.1 only).";
    systemPage.appendChild(agoraUrlNote);

    var agoraUrlLabel = document.createElement("div");
    agoraUrlLabel.style.fontSize = "12.5px";
    agoraUrlLabel.style.color = ui.tokens.t3;
    agoraUrlLabel.style.marginBottom = "4px";
    agoraUrlLabel.textContent = "AGORA URL";
    systemPage.appendChild(agoraUrlLabel);

    var agoraUrlInp = document.createElement("input");
    agoraUrlInp.type = "text";
    agoraUrlInp.placeholder = "http://localhost:3000";
    agoraUrlInp.dataset.action = "agora-url-input";
    agoraUrlInp.style.background = "rgba(255,255,255,.05)";
    agoraUrlInp.style.border = "1px solid rgba(255,255,255,.12)";
    agoraUrlInp.style.borderRadius = "6px";
    agoraUrlInp.style.color = ui.tokens.t1;
    agoraUrlInp.style.fontFamily = "inherit";
    agoraUrlInp.style.fontSize = "13px";
    agoraUrlInp.style.padding = "6px 10px";
    agoraUrlInp.style.width = "100%";
    agoraUrlInp.style.boxSizing = "border-box";
    agoraUrlInp.value = settings.get("deck.agora.url") || "http://localhost:3000";
    systemPage.appendChild(agoraUrlInp);

    var agoraUrlError = document.createElement("span");
    agoraUrlError.style.fontSize = "12px";
    agoraUrlError.style.color = ui.tokens.danger;
    agoraUrlError.style.display = "none";
    agoraUrlError.style.marginTop = "4px";
    systemPage.appendChild(agoraUrlError);

    var agoraUrlSaveBtn = ui.button("Save", { variant: "primary", action: "agora-url-save" });
    agoraUrlSaveBtn.style.marginTop = "6px";
    systemPage.appendChild(agoraUrlSaveBtn);

    agoraUrlSaveBtn.addEventListener("click", function() {
      var val = agoraUrlInp.value.trim();
      agoraUrlError.style.display = "none";
      agoraUrlError.textContent = "";
      try {
        settings.set("deck.agora.url", val);
        agoraUrlError.textContent = "Saved.";
        agoraUrlError.style.color = ui.tokens.go || "#22c55e";
        agoraUrlError.style.display = "inline";
        setTimeout(function() { agoraUrlError.style.display = "none"; }, 1500);
      } catch (e) {
        agoraUrlError.textContent = String(e && e.message || e);
        agoraUrlError.style.color = ui.tokens.danger;
        agoraUrlError.style.display = "inline";
      }
    });

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
    refreshConstBtns(settings.get("cockpit.constellation") || "off");
    refreshInteractBtns(settings.get("cockpit.interact") || "on");
    refreshReviewBtns(settings.get("loom.reviewBeforeSave") || "0");
    refreshStatus();
    showPage("voice");
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
    name: "cloud-builder-on sets model.cloudBuilder to anthropic",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      assert(modelsNav !== null, "page-models nav button exists");
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 50); });
      var onBtn = el.querySelector('[data-action="cloud-builder-on"]');
      assert(onBtn !== null, "cloud-builder-on button exists");
      onBtn.click();
      assert(loom.settings.get("model.cloudBuilder") === "anthropic", "cloud-builder-on sets model.cloudBuilder to anthropic");
    },
  },
  {
    name: "cloud-builder-off sets model.cloudBuilder to off",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      assert(modelsNav !== null, "page-models nav button exists");
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 50); });
      var offBtn = el.querySelector('[data-action="cloud-builder-off"]');
      assert(offBtn !== null, "cloud-builder-off button exists");
      offBtn.click();
      assert(loom.settings.get("model.cloudBuilder") === "off", "cloud-builder-off sets model.cloudBuilder to off");
    },
  },
  {
    name: "cloud key save calls cloudKeySet and clears input",
    fn: async function({ el, loom, assert }) {
      var cloudKeySetCalls = [];
      var origCloudKeySet = loom.settings.cloudKeySet;
      loom.settings.cloudKeySet = function(k) {
        cloudKeySetCalls.push(k);
        return Promise.resolve();
      };
      await new Promise(function(r) { setTimeout(r, 50); });
      var modelsNav = el.querySelector('[data-action="page-models"]');
      assert(modelsNav !== null, "page-models nav button exists");
      modelsNav.click();
      await new Promise(function(r) { setTimeout(r, 50); });
      var keyInp = el.querySelector('[data-action="cloud-key-input"]');
      assert(keyInp !== null, "cloud-key-input exists");
      keyInp.value = "sk-ant-test123";
      var saveBtn = el.querySelector('[data-action="cloud-key-save"]');
      assert(saveBtn !== null, "cloud-key-save button exists");
      saveBtn.click();
      await new Promise(function(r) { setTimeout(r, 60); });
      assert(cloudKeySetCalls.length === 1, "cloudKeySet called once (got: " + cloudKeySetCalls.length + ")");
      assert(cloudKeySetCalls[0] === "sk-ant-test123", "cloudKeySet called with the key");
      assert(keyInp.value === "", "input cleared after save");
      loom.settings.cloudKeySet = origCloudKeySet;
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
    name: "agora-url-input exists on system page",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      assert(sysNav !== null, "page-system nav button exists");
      sysNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var inp = el.querySelector('[data-action="agora-url-input"]');
      assert(inp !== null, "agora-url-input exists on system page");
    },
  },
  {
    name: "agora-url-save button exists on system page",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      assert(sysNav !== null, "page-system nav exists");
      sysNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var saveBtn = el.querySelector('[data-action="agora-url-save"]');
      assert(saveBtn !== null, "agora-url-save button exists on system page");
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
  {
    name: "agora-url-save saves valid URL",
    fn: async function({ el, loom, assert }) {
      await new Promise(function(r) { setTimeout(r, 50); });
      var sysNav = el.querySelector('[data-action="page-system"]');
      sysNav.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      var inp = el.querySelector('[data-action="agora-url-input"]');
      assert(inp !== null, "agora-url-input exists");
      inp.value = "http://localhost:8080";
      var saveBtn = el.querySelector('[data-action="agora-url-save"]');
      assert(saveBtn !== null, "agora-url-save button exists");
      saveBtn.click();
      await new Promise(function(r) { setTimeout(r, 30); });
      assert(loom.settings.get("deck.agora.url") === "http://localhost:8080", "settings.get returns the saved URL");
    },
  },
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
