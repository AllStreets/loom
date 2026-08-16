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
  warn: "#f97316",
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
      '.lui-grid-row:hover > div { background:rgba(255,255,255,.04); }',
      '@keyframes lui-spin { from { transform:rotate(0deg); } to { transform:rotate(360deg); } }',
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
        warn:   { bg:'rgba(249,115,22,.15)',  color:tokens.warn },
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
      var wrap = el('div', { marginTop:'8px' });
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

    // --- tabs(labels, opts?) -> { root, panels, onChange } ---
    tabs: function(labels, opts) {
      opts = opts || {};
      var root = el('div', { display:'flex', flexDirection:'column', gap:'0' });
      var tabBar = el('div', {
        display:'flex',
        flexDirection:'row',
        gap:'4px',
        borderBottom:'1px solid rgba(255,255,255,.08)',
        paddingBottom:'0',
        marginBottom:'10px',
      });
      var panels = [];
      var tabBtns = [];
      var selected = 0;

      function selectTab(idx) {
        selected = idx;
        for (var i = 0; i < tabBtns.length; i++) {
          if (i === idx) {
            tabBtns[i].style.borderBottom = '2px solid ' + tokens.accent;
            tabBtns[i].style.color = tokens.accent;
            tabBtns[i].style.opacity = '1';
            panels[i].style.display = 'block';
          } else {
            tabBtns[i].style.borderBottom = '2px solid transparent';
            tabBtns[i].style.color = tokens.t2;
            tabBtns[i].style.opacity = '0.7';
            panels[i].style.display = 'none';
          }
        }
        if (opts.onTabChange) opts.onTabChange(idx);
      }

      for (var i = 0; i < labels.length; i++) {
        (function(idx) {
          var btn = el('button', {
            background:'transparent',
            border:'none',
            borderBottom:'2px solid transparent',
            padding:'6px 12px 8px',
            fontSize:'12.5px',
            fontFamily:'monospace',
            fontWeight:'600',
            textTransform:'uppercase',
            letterSpacing:'0.06em',
            cursor:'pointer',
            transition:'color .15s, border-color .15s',
            marginBottom:'-1px',
          }, 'lui-btn');
          btn.textContent = labels[idx];
          btn.addEventListener('click', function() { selectTab(idx); });
          tabBtns.push(btn);
          append(tabBar, btn);

          var panel = el('div', { display:'none' });
          panels.push(panel);
          append(root, panel);
        })(i);
      }

      append(root, tabBar);
      root.insertBefore(tabBar, root.firstChild);
      selectTab(0);

      var onChange = function(idx) { selectTab(idx); };
      return { root: root, panels: panels, onChange: onChange };
    },

    // --- barChart(data, opts?) -> SVGSVGElement ---
    barChart: function(data, opts) {
      opts = opts || {};
      var W = opts.width || 200;
      var H = opts.height || 80;
      var color = opts.color || tokens.accent;
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.style.display = 'block';
      svg.style.overflow = 'visible';

      if (!data || data.length === 0) return svg;

      var maxVal = data.reduce(function(m, d) { return Math.max(m, d.value); }, 0) || 1;
      var barW = Math.floor((W / data.length) * 0.65);
      var gap = W / data.length;

      for (var i = 0; i < data.length; i++) {
        var barH = Math.max(2, Math.round((data[i].value / maxVal) * (H - 18)));
        var x = Math.round(i * gap + (gap - barW) / 2);
        var y = H - barH - 12;

        var rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(barW));
        rect.setAttribute('height', String(barH));
        rect.setAttribute('rx', '3');
        rect.setAttribute('fill', color);
        rect.setAttribute('opacity', '0.85');
        svg.appendChild(rect);

        var valText = document.createElementNS(ns, 'text');
        valText.setAttribute('x', String(x + barW / 2));
        valText.setAttribute('y', String(y - 3));
        valText.setAttribute('text-anchor', 'middle');
        valText.setAttribute('font-size', '9');
        valText.setAttribute('fill', color);
        valText.setAttribute('font-family', 'monospace');
        valText.textContent = String(data[i].value);
        svg.appendChild(valText);

        var lblText = document.createElementNS(ns, 'text');
        lblText.setAttribute('x', String(x + barW / 2));
        lblText.setAttribute('y', String(H - 1));
        lblText.setAttribute('text-anchor', 'middle');
        lblText.setAttribute('font-size', '9');
        lblText.setAttribute('fill', tokens.t3);
        lblText.setAttribute('font-family', 'monospace');
        lblText.textContent = String(data[i].label);
        svg.appendChild(lblText);
      }

      return svg;
    },

    // --- lineChart(series, opts?) -> SVGSVGElement ---
    lineChart: function(series, opts) {
      opts = opts || {};
      var W = opts.width || 200;
      var H = opts.height || 80;
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', String(W));
      svg.setAttribute('height', String(H));
      svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      svg.style.display = 'block';
      svg.style.overflow = 'visible';

      if (!series || series.length < 2) return svg;

      var mn = series.reduce(function(a, b) { return Math.min(a, b); }, series[0]);
      var mx = series.reduce(function(a, b) { return Math.max(a, b); }, series[0]);
      var range = mx - mn || 1;
      var pad = 14;

      function px(i) { return Math.round((i / (series.length - 1)) * (W - pad * 2) + pad); }
      function py(v) { return Math.round(H - pad - ((v - mn) / range) * (H - pad * 2)); }

      var pts = series.map(function(v, i) { return px(i) + ',' + py(v); });
      var firstPt = px(0) + ',' + py(mn);
      var lastPt = px(series.length - 1) + ',' + py(mn);

      // defs with linearGradient for area fill
      var defs = document.createElementNS(ns, 'defs');
      var grad = document.createElementNS(ns, 'linearGradient');
      grad.setAttribute('id', 'lui-lg');
      grad.setAttribute('x1', '0');
      grad.setAttribute('y1', '0');
      grad.setAttribute('x2', '0');
      grad.setAttribute('y2', '1');
      var stop1 = document.createElementNS(ns, 'stop');
      stop1.setAttribute('offset', '0%');
      stop1.setAttribute('stop-color', tokens.accent);
      stop1.setAttribute('stop-opacity', '0.3');
      var stop2 = document.createElementNS(ns, 'stop');
      stop2.setAttribute('offset', '100%');
      stop2.setAttribute('stop-color', tokens.accent);
      stop2.setAttribute('stop-opacity', '0');
      grad.appendChild(stop1);
      grad.appendChild(stop2);
      defs.appendChild(grad);
      svg.appendChild(defs);

      // Area polygon
      var areaPoints = pts.concat([lastPt, firstPt]).join(' ');
      var area = document.createElementNS(ns, 'polygon');
      area.setAttribute('points', areaPoints);
      area.setAttribute('fill', 'url(#lui-lg)');
      svg.appendChild(area);

      // Polyline
      var polyline = document.createElementNS(ns, 'polyline');
      polyline.setAttribute('points', pts.join(' '));
      polyline.setAttribute('fill', 'none');
      polyline.setAttribute('stroke', tokens.accent);
      polyline.setAttribute('stroke-width', '1.5');
      polyline.setAttribute('stroke-linecap', 'round');
      polyline.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(polyline);

      // Min label
      var minLbl = document.createElementNS(ns, 'text');
      minLbl.setAttribute('x', String(pad));
      minLbl.setAttribute('y', String(H - 2));
      minLbl.setAttribute('font-size', '9');
      minLbl.setAttribute('fill', tokens.t3);
      minLbl.setAttribute('font-family', 'monospace');
      minLbl.textContent = String(mn);
      svg.appendChild(minLbl);

      // Max label
      var maxLbl = document.createElementNS(ns, 'text');
      maxLbl.setAttribute('x', String(pad));
      maxLbl.setAttribute('y', String(pad - 2));
      maxLbl.setAttribute('font-size', '9');
      maxLbl.setAttribute('fill', tokens.t3);
      maxLbl.setAttribute('font-family', 'monospace');
      maxLbl.textContent = String(mx);
      svg.appendChild(maxLbl);

      return svg;
    },

    // --- gauge(value, max, opts?) -> SVGSVGElement ---
    gauge: function(value, max, opts) {
      opts = opts || {};
      var size = opts.size || 100;
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      var vb = '0 0 ' + size + ' ' + size;
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
      svg.setAttribute('viewBox', vb);
      svg.style.display = 'block';

      var cx = size / 2;
      var cy = size / 2;
      var r = size * 0.38;
      var circ = 2 * Math.PI * r;
      var pct = Math.max(0, Math.min(1, value / (max || 1)));
      var dash = circ * pct;
      var gap = circ - dash;

      // Track circle
      var track = document.createElementNS(ns, 'circle');
      track.setAttribute('cx', String(cx));
      track.setAttribute('cy', String(cy));
      track.setAttribute('r', String(r));
      track.setAttribute('fill', 'none');
      track.setAttribute('stroke', rgba(tokens.t3, '0.18'));
      track.setAttribute('stroke-width', '8');
      track.setAttribute('stroke-linecap', 'round');
      svg.appendChild(track);

      // Arc
      var arc = document.createElementNS(ns, 'circle');
      arc.setAttribute('cx', String(cx));
      arc.setAttribute('cy', String(cy));
      arc.setAttribute('r', String(r));
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', tokens.accent);
      arc.setAttribute('stroke-width', '8');
      arc.setAttribute('stroke-linecap', 'round');
      arc.setAttribute('stroke-dasharray', String(dash) + ' ' + String(gap));
      arc.setAttribute('stroke-dashoffset', String(circ * 0.25));
      arc.setAttribute('transform', 'rotate(-90 ' + cx + ' ' + cy + ')');
      svg.appendChild(arc);

      // Center value text
      var valText = document.createElementNS(ns, 'text');
      valText.setAttribute('x', String(cx));
      valText.setAttribute('y', String(cy + 5));
      valText.setAttribute('text-anchor', 'middle');
      valText.setAttribute('font-size', String(size * 0.18));
      valText.setAttribute('font-family', 'monospace');
      valText.setAttribute('font-weight', '700');
      valText.setAttribute('fill', tokens.accent);
      valText.textContent = String(value);
      svg.appendChild(valText);

      // Optional label
      if (opts.label) {
        var lblText = document.createElementNS(ns, 'text');
        lblText.setAttribute('x', String(cx));
        lblText.setAttribute('y', String(cy + size * 0.18 + 4));
        lblText.setAttribute('text-anchor', 'middle');
        lblText.setAttribute('font-size', String(size * 0.10));
        lblText.setAttribute('font-family', 'monospace');
        lblText.setAttribute('fill', tokens.t3);
        lblText.textContent = opts.label;
        svg.appendChild(lblText);
      }

      return svg;
    },

    // --- heatmap(values, opts?) -> HTMLElement ---
    heatmap: function(values, opts) {
      opts = opts || {};
      var cellSize = opts.cellSize || 12;
      var gap = opts.gap || 2;
      var cols = Math.ceil(values.length / 7);
      var maxVal = values.reduce(function(m, v) { return Math.max(m, v); }, 0) || 1;

      var wrap = el('div', {
        display:'grid',
        gridTemplateColumns:'repeat(' + cols + ', ' + cellSize + 'px)',
        gridTemplateRows:'repeat(7, ' + cellSize + 'px)',
        gap: gap + 'px',
        gridAutoFlow: 'column',
      });

      for (var i = 0; i < values.length; i++) {
        var alpha = values[i] > 0 ? 0.15 + 0.85 * (values[i] / maxVal) : 0.06;
        var cell = el('div', {
          width: cellSize + 'px',
          height: cellSize + 'px',
          borderRadius: '2px',
          background: rgba(tokens.accent, alpha.toFixed(2)),
        });
        append(wrap, cell);
      }

      return wrap;
    },

    // --- dataGrid(columns, rows) -> HTMLElement ---
    dataGrid: function(columns, rows) {
      var wrap = el('div', {
        overflowX: 'auto',
        borderRadius: '8px',
        border: '1px solid rgba(255,255,255,.08)',
      });
      var table = el('div', {
        display: 'table',
        width: '100%',
        borderCollapse: 'collapse',
      });

      // Header row
      var header = el('div', {
        display: 'table-row',
        position: 'sticky',
        top: '0',
        background: 'rgba(13,20,36,.95)',
        zIndex: '1',
      });
      for (var ci = 0; ci < columns.length; ci++) {
        var hCell = el('div', {
          display: 'table-cell',
          padding: '7px 12px',
          fontSize: '10.5px',
          fontFamily: 'monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          color: tokens.t3,
          fontWeight: '700',
          borderBottom: '1px solid rgba(255,255,255,.08)',
          whiteSpace: 'nowrap',
        });
        hCell.textContent = columns[ci];
        append(header, hCell);
      }
      append(table, header);

      // Data rows
      for (var ri = 0; ri < rows.length; ri++) {
        var row = el('div', {
          display: 'table-row',
        }, 'lui-grid-row');
        for (var rci = 0; rci < rows[ri].length; rci++) {
          var cell = el('div', {
            display: 'table-cell',
            padding: '7px 12px',
            fontSize: '13px',
            color: tokens.t1,
            borderBottom: '1px solid rgba(255,255,255,.04)',
            whiteSpace: 'nowrap',
          });
          cell.textContent = String(rows[ri][rci]);
          append(row, cell);
        }
        append(table, row);
      }

      append(wrap, table);
      return wrap;
    },

    // --- toggle(label, checked, onChange) -> HTMLElement ---
    toggle: function(label, checked, onChange) {
      var state = !!checked;
      var wrap = el('div', {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        cursor: 'pointer',
        userSelect: 'none',
      });

      var track = el('div', {
        width: '36px',
        height: '20px',
        borderRadius: '10px',
        background: state ? tokens.accent : 'rgba(255,255,255,.12)',
        position: 'relative',
        flexShrink: '0',
        transition: 'background .15s',
      });
      var thumb = el('div', {
        width: '14px',
        height: '14px',
        borderRadius: '50%',
        background: '#fff',
        position: 'absolute',
        top: '3px',
        left: state ? '19px' : '3px',
        transition: 'left .15s',
      });
      append(track, thumb);

      var lbl = el('span', { fontSize: '13.5px', color: tokens.t1 });
      lbl.textContent = label;

      append(wrap, track, lbl);

      wrap.addEventListener('click', function() {
        state = !state;
        track.style.background = state ? tokens.accent : 'rgba(255,255,255,.12)';
        thumb.style.left = state ? '19px' : '3px';
        if (onChange) onChange(state);
      });

      return wrap;
    },

    // --- select(options, opts?) -> HTMLSelectElement ---
    select: function(options, opts) {
      opts = opts || {};
      var sel = document.createElement('select');
      sel.style.background = 'rgba(255,255,255,.06)';
      sel.style.border = '1px solid rgba(255,255,255,.12)';
      sel.style.borderRadius = '8px';
      sel.style.padding = '7px 10px';
      sel.style.fontSize = '13.5px';
      sel.style.color = tokens.t1;
      sel.style.fontFamily = 'inherit';
      sel.style.outline = 'none';
      sel.style.cursor = 'pointer';
      sel.style.width = '100%';

      for (var i = 0; i < options.length; i++) {
        var opt = document.createElement('option');
        if (typeof options[i] === 'string') {
          opt.value = options[i];
          opt.textContent = options[i];
        } else {
          opt.value = options[i].value;
          opt.textContent = options[i].label;
        }
        sel.appendChild(opt);
      }

      if (opts.action) sel.dataset.action = opts.action;
      if (opts.onChange) {
        sel.addEventListener('change', function(e) {
          opts.onChange(e.target.value);
        });
      }

      return sel;
    },

    // --- spinner(size?) -> HTMLElement ---
    spinner: function(size) {
      var sz = size || 24;
      var wrap = el('div', {
        width: sz + 'px',
        height: sz + 'px',
        borderRadius: '50%',
        border: '3px solid rgba(255,255,255,.1)',
        borderTopColor: tokens.accent,
        display: 'inline-block',
        animation: 'lui-spin .7s linear infinite',
      });
      return wrap;
    },

    // --- icon(name) -> SVGSVGElement ---
    icon: function(name) {
      var ns = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('stroke', 'currentColor');
      svg.setAttribute('stroke-width', '2');
      svg.setAttribute('stroke-linecap', 'round');
      svg.setAttribute('stroke-linejoin', 'round');
      svg.style.display = 'inline-block';
      svg.style.verticalAlign = 'middle';

      var paths = {
        check: 'M20 6L9 17l-5-5',
        x: 'M18 6L6 18M6 6l12 12',
        plus: 'M12 5v14M5 12h14',
        arrow: 'M5 12h14M12 5l7 7-7 7',
        gear: 'M12 15a3 3 0 100-6 3 3 0 000 6z' + 'M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
        clock: 'M12 2a10 10 0 100 20A10 10 0 0012 2zM12 6v6l4 2',
        star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
        warn: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
        info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 8h.01M12 12v4',
        copy: 'M20 9H11a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
        trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
        refresh: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15',
      };

      var d = paths[name] || paths.info;
      var path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);

      return svg;
    },
  };

  return api;
}
`;
