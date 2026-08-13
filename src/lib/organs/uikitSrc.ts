// Plain-JS source string for the loom.ui design kit.
// MUST contain no import/export/TS syntax — executes via new Function in host AND sandbox iframe.

export const KIT_TOKENS = {
  bg: "#060b18",
  panel: "#0d1424",
  t1: "#e8edf7",
  t2: "#9fb0cc",
  t3: "#5f6f8c",
  accent: "#22d3ee",
  go: "#4ade80",
  warn: "#fbbf24",
  danger: "#f87171",
} as const;

export const UIKIT_SRC: string = `
function makeUi(tokens) {
  // --- Helpers ---
  function rgba(hex, a) {
    var h = hex.replace('#', '');
    return 'rgba(' + parseInt(h.substr(0, 2), 16) + ',' + parseInt(h.substr(2, 2), 16) + ',' + parseInt(h.substr(4, 2), 16) + ',' + a + ')';
  }

  // --- Style injection (once per document) ---
  function injectStyles() {
    if (document.getElementById('lui-style')) return;
    var style = document.createElement('style');
    style.id = 'lui-style';
    style.textContent = [
      '.lui-btn { cursor:pointer; border:none; outline:none; font-family:inherit; transition:filter .15s, background .15s, border-color .15s; }',
      '.lui-btn:focus-visible { box-shadow:0 0 0 2px ' + tokens.accent + '; }',
      '.lui-btn-primary:hover { filter:brightness(1.1); }',
      '.lui-btn-ghost:hover { background:rgba(255,255,255,.06); }',
      '.lui-btn-danger:hover { background:rgba(248,113,113,.1); }',
      '.lui-input { font-family:inherit; color:' + tokens.t1 + '; outline:none; border:1px solid rgba(255,255,255,.1); transition:border-color .15s; width:100%; box-sizing:border-box; }',
      '.lui-input:focus { border-color:' + tokens.accent + '; }',
      '.lui-list-row:hover { background:rgba(255,255,255,.06); }',
      '.lui-progress-track { background:rgba(255,255,255,.07); border-radius:6px; height:6px; overflow:hidden; width:100%; }',
      '.lui-progress-fill { height:100%; border-radius:6px; background:linear-gradient(90deg,' + tokens.accent + ',#7dd3fc); transition:width .4s; }',
    ].join(' ');
    (document.head || document.documentElement).appendChild(style);
  }

  // --- Helpers ---
  function el(tag, styles, classes) {
    var e = document.createElement(tag);
    if (styles) Object.assign(e.style, styles);
    if (classes) {
      var arr = Array.isArray(classes) ? classes : [classes];
      arr.forEach(function(c){ if(c) e.classList.add(c); });
    }
    return e;
  }
  function append(parent) {
    var children = Array.prototype.slice.call(arguments, 1);
    children.forEach(function(c){ if(c) parent.appendChild(c); });
    return parent;
  }

  injectStyles();

  var api = {
    tokens: tokens,

    // --- heading(text, sub?) ---
    heading: function(text, sub) {
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'4px' });
      var h = el('div', {
        fontSize:'17px', fontWeight:'650',
        color: tokens.t1, lineHeight:'1.25'
      });
      h.textContent = text;
      append(wrap, h);
      if (sub) {
        var s = el('div', { fontSize:'12.5px', color:tokens.t2 });
        s.textContent = sub;
        append(wrap, s);
      }
      return wrap;
    },

    // --- card(opts?) -> { root, body } ---
    card: function(opts) {
      opts = opts || {};
      var root = el('div', {
        background:'rgba(13,20,36,.55)',
        border:'1px solid rgba(255,255,255,.08)',
        borderRadius:'12px',
        padding:'14px',
        display:'flex',
        flexDirection:'column',
        gap:'10px',
      });
      if (opts.title) {
        var eyebrow = el('div', {
          fontSize:'11px',
          fontFamily:'monospace',
          textTransform:'uppercase',
          letterSpacing:'0.06em',
          color:tokens.accent,
          fontWeight:'600',
        });
        eyebrow.textContent = opts.title;
        append(root, eyebrow);
      }
      var body = el('div', { display:'flex', flexDirection:'column', gap:'8px' });
      append(root, body);
      return { root:root, body:body };
    },

    // --- button(label, opts?) ---
    button: function(label, opts) {
      opts = opts || {};
      var variant = opts.variant || 'primary';
      var btn = el('button', {
        borderRadius:'8px',
        padding:'7px 14px',
        fontWeight:'600',
        fontSize:'14px',
      }, ['lui-btn', 'lui-btn-' + variant]);

      if (variant === 'primary') {
        btn.style.background = tokens.accent;
        btn.style.color = '#04222b';
        btn.style.border = 'none';
      } else if (variant === 'ghost') {
        btn.style.background = 'transparent';
        btn.style.border = '1px solid rgba(255,255,255,.18)';
        btn.style.color = tokens.t1;
      } else if (variant === 'danger') {
        btn.style.background = 'transparent';
        btn.style.border = 'none';
        btn.style.color = tokens.danger;
      }

      btn.textContent = label;
      if (opts.action) btn.dataset.action = opts.action;
      if (opts.onClick) btn.addEventListener('click', opts.onClick);
      return btn;
    },

    // --- input(opts?) ---
    input: function(opts) {
      opts = opts || {};
      var inp = el('input', {
        background:'rgba(255,255,255,.05)',
        borderRadius:'8px',
        padding:'7px 10px',
        fontSize:'14px',
      }, 'lui-input');
      inp.type = 'text';
      if (opts.placeholder) inp.placeholder = opts.placeholder;
      if (opts.action) inp.dataset.action = opts.action;
      if (opts.onEnter) {
        inp.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') opts.onEnter(e);
        });
      }
      return inp;
    },

    // --- row(...children) ---
    row: function() {
      var children = Array.prototype.slice.call(arguments);
      var wrap = el('div', { display:'flex', flexDirection:'row', gap:'8px', alignItems:'center' });
      children.forEach(function(c){ if(c) append(wrap, c); });
      return wrap;
    },

    // --- stack(...children) ---
    stack: function() {
      var children = Array.prototype.slice.call(arguments);
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'8px' });
      children.forEach(function(c){ if(c) append(wrap, c); });
      return wrap;
    },

    // --- stat(label, value) ---
    stat: function(label, value) {
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'3px' });
      var val = el('div', {
        fontSize:'20px',
        fontFamily:'monospace',
        color:tokens.accent,
        fontWeight:'700',
        lineHeight:'1.2',
      });
      val.textContent = String(value);
      var lbl = el('div', {
        fontSize:'11px',
        fontFamily:'monospace',
        textTransform:'uppercase',
        letterSpacing:'0.06em',
        color:tokens.t3,
      });
      lbl.textContent = label;
      append(wrap, val, lbl);
      return wrap;
    },

    // --- setStat(el, value) ---
    setStat: function(statEl, value) {
      var valNode = statEl.firstChild;
      if (valNode) valNode.textContent = String(value);
    },

    // --- progress(pct) -> element with .set(pct) ---
    progress: function(pct) {
      var track = el('div', {}, 'lui-progress-track');
      var fill = el('div', {}, 'lui-progress-fill');
      var clamped = Math.max(0, Math.min(100, pct || 0));
      fill.style.width = clamped + '%';
      append(track, fill);
      track.set = function(p) {
        var c = Math.max(0, Math.min(100, p || 0));
        fill.style.width = c + '%';
      };
      return track;
    },

    // --- list() -> { root, add(el), clear() } ---
    list: function() {
      var root = el('div', { display:'flex', flexDirection:'column', gap:'6px' });
      return {
        root: root,
        add: function(child) { append(root, child); },
        clear: function() { root.innerHTML = ''; },
      };
    },

    // --- listRow(text, opts?) ---
    listRow: function(text, opts) {
      opts = opts || {};
      var row = el('div', {
        display:'flex',
        alignItems:'center',
        justifyContent:'space-between',
        padding:'8px 12px',
        borderRadius:'8px',
        transition:'background .15s',
      }, 'lui-list-row');
      var span = el('span', { color:tokens.t1, fontSize:'14px' });
      span.textContent = text;
      append(row, span);
      if (opts.onRemove) {
        var removeAction = opts.removeAction || 'remove';
        var xBtn = el('button', {
          background:'transparent',
          border:'none',
          color:tokens.danger,
          cursor:'pointer',
          fontSize:'14px',
          padding:'0 4px',
          lineHeight:'1',
          fontFamily:'inherit',
        }, ['lui-btn', 'lui-btn-ghost']);
        xBtn.textContent = 'x';
        xBtn.dataset.action = removeAction;
        xBtn.addEventListener('click', opts.onRemove);
        append(row, xBtn);
      }
      return row;
    },

    // --- badge(text, tone?) ---
    badge: function(text, tone) {
      var toneColors = {
        accent: { bg:'rgba(34,211,238,.15)', color:tokens.accent },
        go:     { bg:'rgba(74,222,128,.15)', color:tokens.go },
        warn:   { bg:'rgba(251,191,36,.15)',  color:tokens.warn },
        danger: { bg:'rgba(248,113,113,.15)', color:tokens.danger },
        muted:  { bg:'rgba(255,255,255,.06)', color:tokens.t3 },
      };
      var tc = toneColors[tone] || toneColors.accent;
      var badge = el('span', {
        display:'inline-block',
        background:tc.bg,
        color:tc.color,
        borderRadius:'999px',
        padding:'2px 8px',
        fontSize:'10.5px',
        fontFamily:'monospace',
        fontWeight:'600',
        textTransform:'uppercase',
        letterSpacing:'0.05em',
      });
      badge.textContent = text;
      return badge;
    },

    // --- empty(text) ---
    empty: function(text) {
      var wrap = el('div', {
        textAlign:'center',
        color:tokens.t3,
        fontSize:'13px',
        padding:'24px 0',
      });
      wrap.textContent = text;
      return wrap;
    },

    // --- hero(value, label) --- big luminous focal stat (ONE per organ)
    hero: function(value, label) {
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'4px' });
      var val = el('div', {
        fontSize:'28px',
        fontFamily:'monospace',
        fontWeight:'700',
        color:tokens.accent,
        lineHeight:'1.15',
        textShadow:'0 0 18px ' + rgba(tokens.accent, '.45'),
      });
      val.textContent = String(value);
      var lbl = el('div', {
        fontSize:'11px',
        fontFamily:'monospace',
        textTransform:'uppercase',
        letterSpacing:'0.07em',
        color:tokens.t3,
      });
      lbl.textContent = label;
      append(wrap, val, lbl);
      wrap._valNode = val;
      return wrap;
    },

    // --- spark(values, opts?) --- tiny inline SVG sparkline (60x18)
    spark: function(values, opts) {
      opts = opts || {};
      var W = opts.width || 60;
      var H = opts.height || 18;
      var color = opts.color || tokens.accent;

      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.style.display = 'inline-block';
      svg.style.verticalAlign = 'middle';
      svg.style.overflow = 'visible';

      function renderLine(vals) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
        if (!vals || vals.length < 2) return;
        var arr = vals.map(function(v) { return typeof v === 'number' ? v : 0; });
        var mn = arr.reduce(function(a, b) { return a < b ? a : b; }, arr[0]);
        var mx = arr.reduce(function(a, b) { return a > b ? a : b; }, arr[0]);
        var range = mx - mn || 1;
        var pts = arr.map(function(v, i) {
          var x = (i / (arr.length - 1)) * W;
          var y = H - ((v - mn) / range) * (H - 2) - 1;
          return x + ',' + y;
        });
        var polyline = document.createElementNS(ns, 'polyline');
        polyline.setAttribute('points', pts.join(' '));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', color);
        polyline.setAttribute('stroke-width', '1.5');
        polyline.setAttribute('stroke-linecap', 'round');
        polyline.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(polyline);
        // accent dot at last point
        var lastPt = pts[pts.length - 1].split(',');
        var dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('cx', lastPt[0]);
        dot.setAttribute('cy', lastPt[1]);
        dot.setAttribute('r', '2.5');
        dot.setAttribute('fill', color);
        svg.appendChild(dot);
      }

      renderLine(values || []);
      svg.update = function(newVals) { renderLine(newVals); };
      return svg;
    },

    // --- keyval(pairs) --- aligned key/value rows
    keyval: function(pairs) {
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'6px' });
      for (var i = 0; i < pairs.length; i++) {
        var pair = pairs[i];
        var rowEl = el('div', { display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:'12px' });
        var keyEl = el('span', {
          fontSize:'11.5px',
          fontFamily:'monospace',
          color:tokens.t3,
          textTransform:'uppercase',
          letterSpacing:'0.05em',
          flexShrink:'0',
        });
        keyEl.textContent = pair[0];
        var valEl = el('span', {
          fontSize:'14px',
          color:tokens.t1,
          textAlign:'right',
          wordBreak:'break-word',
        });
        valEl.textContent = String(pair[1]);
        append(rowEl, keyEl, valEl);
        append(wrap, rowEl);
      }
      return wrap;
    },

    // --- section(title) --- titled group with mono uppercase label + hairline
    section: function(title) {
      var wrap = el('div', { display:'flex', flexDirection:'column', gap:'8px', marginTop:'8px' });
      var header = el('div', { display:'flex', alignItems:'center', gap:'8px' });
      var label = el('span', {
        fontSize:'10px',
        fontFamily:'monospace',
        textTransform:'uppercase',
        letterSpacing:'0.09em',
        color:tokens.t3,
        fontWeight:'600',
        flexShrink:'0',
        whiteSpace:'nowrap',
      });
      label.textContent = title;
      var line = el('div', {
        flex:'1',
        height:'1px',
        background:'rgba(255,255,255,.07)',
      });
      append(header, label, line);
      append(wrap, header);
      return wrap;
    },

    // --- dot(tone) --- 8px status dot with mood color
    dot: function(tone) {
      var toneColors = {
        accent: tokens.accent,
        go:     tokens.go,
        warn:   tokens.warn,
        danger: tokens.danger,
        muted:  tokens.t3,
      };
      var color = toneColors[tone] || toneColors.accent;
      var d = el('span', {
        display:'inline-block',
        width:'8px',
        height:'8px',
        borderRadius:'50%',
        background:color,
        flexShrink:'0',
        boxShadow:'0 0 6px ' + color,
      });
      return d;
    },

    // --- toolbar(...children) --- right-aligned action row for card headers
    toolbar: function() {
      var children = Array.prototype.slice.call(arguments);
      var wrap = el('div', {
        display:'flex',
        flexDirection:'row',
        gap:'6px',
        alignItems:'center',
        justifyContent:'flex-end',
      });
      children.forEach(function(c){ if(c) append(wrap, c); });
      return wrap;
    },
  };

  return api;
}
`;
