import type { OrganFile } from "../../lib/core";

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

    // ── Outer stack ─────────────────────────────────────────────────────────
    var wrap = document.createElement("div");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.gap = "12px";

    // ── Voice card ──────────────────────────────────────────────────────────
    var voiceCard = ui.card({ title: "Voice" });
    var voiceBody = voiceCard.body;

    voiceBody.appendChild(ui.heading("Voice", "Choose a voice, audition it, and set when LOOM speaks."));

    // Status row with dot
    var voiceStatusDot = ui.dot("warn");
    var statusText = document.createElement("span");
    statusText.style.fontSize = "13px";
    statusText.style.color = ui.tokens.t2;
    statusText.textContent = "Checking voice status...";
    var statusRow = ui.row(voiceStatusDot, statusText);
    voiceBody.appendChild(statusRow);

    var downloadRow = document.createElement("div");
    downloadRow.style.display = "none";
    var downloadBtn = ui.button("Download models", { variant: "primary", action: "voice-setup" });
    var progressBar = ui.progress(0);
    progressBar.style.marginTop = "4px";
    progressBar.style.display = "none";
    downloadRow.appendChild(downloadBtn);
    downloadRow.appendChild(progressBar);
    voiceBody.appendChild(downloadRow);

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
        downloadBtn.textContent = "Download failed — retry";
        downloadBtn.disabled = false;
        statusText.textContent = String(err);
      });
    });

    // Voices section
    var voicesSection = ui.section("Voices");
    voiceBody.appendChild(voicesSection);

    var voiceList = ui.list();
    voiceBody.appendChild(voiceList.root);

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
    var speakSection = ui.section("Speak replies");
    voiceBody.appendChild(speakSection);

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
    voiceBody.appendChild(speakRow);

    // Mic test section
    var micSection = ui.section("Microphone");
    voiceBody.appendChild(micSection);

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
    voiceBody.appendChild(ui.row(micTestBtn, micResult));

    wrap.appendChild(voiceCard.root);

    // ── Appearance card ─────────────────────────────────────────────────────
    var appCard = ui.card({ title: "Appearance" });
    var appBody = appCard.body;
    appBody.appendChild(ui.heading("Orb renderer", "Auto detects your GPU; Flat uses a simpler 2D orb."));

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
    appBody.appendChild(orbRow);
    wrap.appendChild(appCard.root);

    // ── Building card ───────────────────────────────────────────────────────
    var buildCard = ui.card({ title: "Building" });
    var buildBody = buildCard.body;
    buildBody.appendChild(ui.heading("Review before save", "When on, LOOM shows a diff before writing any organ file."));

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

    for (var ri = 0; ri < reviewOptions.length; ri++) {
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
      })(reviewOptions[ri]);
    }
    buildBody.appendChild(reviewRow);
    wrap.appendChild(buildCard.root);

    el.appendChild(wrap);

    // ── Initialize state ────────────────────────────────────────────────────
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
    refreshReviewBtns(settings.get("loom.reviewBeforeSave") || "0");
    refreshStatus();
  }
};`;

const TEST_JS = `export const tests = [
  {
    name: "choose voice sets voice.default in settings",
    fn: async function({ el, loom, assert }) {
      // Find the "Use" button for en_GB-alba-medium (not the default)
      // Give the async render time to populate voice rows
      await new Promise(function(r) { setTimeout(r, 50); });
      var useBtn = el.querySelector('[data-action="choose-en_GB-alba-medium"]');
      assert(useBtn !== null, "Use button for alba voice exists");
      useBtn.click();
      // Settings.set is called on click — check via settings mock
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
];`;

export const files: OrganFile[] = [
  { name: "manifest.json", content: MANIFEST },
  { name: "organ.js", content: ORGAN_JS },
  { name: "test.js", content: TEST_JS },
];
