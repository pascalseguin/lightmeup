// LightMeUp show builder UI. Data model and exports live in core.js (window.LMU).
(function () {
  'use strict';
  const L = window.LMU;
  const $ = s => document.querySelector(s);
  const clamp = L.clamp;

  // Timeline geometry (CSS pixels).
  const GUT = 150, RULER = 26, WAVE = 64, ROW = 58;
  const STORE_KEY = 'lightmeup.project.v1';

  let P = loadAutosave() || L.demoProject();
  const UI = {
    pps: 60, viewStart: 0, playhead: 0, sel: null, selProp: P.props[0] ? P.props[0].id : null, selRow: null,
    tool: 'select', loop: false, drag: null, undo: [], redo: [], playing: false,
  };
  const A = { name: '', ctx: null, buf: null, src: null, startCtx: 0, startPos: 0, peaks: null, clock0: 0, extra: {} };
  const LIVE = { available: false, on: false, inflight: false, lastSend: 0, lastStatus: null };

  // ---------- helpers ----------
  function fmt(t) {
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const C = {};
  function readColors() { ['--panel', '--panel2', '--line', '--text', '--muted', '--accent', '--bg', '--sel'].forEach(k => C[k] = cssVar(k)); }
  readColors();

  function sizeCanvas(cv, w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
      cv.style.width = w + 'px'; cv.style.height = h + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
      else if (k === 'class') e.className = attrs[k];
      else if (k in e && typeof attrs[k] !== 'string') e[k] = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    kids.flat().forEach(c => e.append(c && c.nodeType ? c : document.createTextNode(c == null ? '' : c)));
    return e;
  }
  function download(name, data, type) {
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function safeName(s) { return (s || 'show').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'show'; }
  function propById(id) { return P.props.find(p => p.id === id); }
  function keysFor(p, ck) { const id = L.trackId(p, ck); return P.tracks[id] || (P.tracks[id] = []); }

  // ---------- persistence & undo ----------
  function loadAutosave() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      const p = raw && JSON.parse(raw);
      return p && p.app === 'lightmeup' ? p : null;
    } catch (e) { return null; }
  }
  let saveTimer = 0;
  function changed() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { try { localStorage.setItem(STORE_KEY, JSON.stringify(P)); } catch (e) { /* storage full or blocked */ } }, 400);
  }
  function pushUndo() {
    UI.undo.push(JSON.stringify(P));
    if (UI.undo.length > 60) UI.undo.shift();
    UI.redo.length = 0;
  }
  function restore(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(P));
    P = JSON.parse(from.pop());
    if (!propById(UI.selProp)) UI.selProp = P.props[0] ? P.props[0].id : null;
    refreshAll(); changed();
  }

  // ---------- rows ----------
  function rows() {
    const r = [];
    for (const p of P.props) for (const c of L.channelsOf(p)) r.push({ p, c, id: L.trackId(p, c.key) });
    return r;
  }
  function selectedRow() { return rows().find(r => r.id === UI.selRow) || null; }

  // ---------- audio ----------
  function audioCtx() {
    if (!A.ctx) A.ctx = new (window.AudioContext || window.webkitAudioContext)();
    return A.ctx;
  }
  async function decodeFile(file) {
    const data = await file.arrayBuffer();
    return await audioCtx().decodeAudioData(data);
  }
  function buildPeaks(buf) {
    const per = 100, n = Math.ceil(buf.duration * per), hop = buf.sampleRate / per;
    const ch = [];
    for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) ch.push(buf.getChannelData(c));
    const lo = new Float32Array(n), hi = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let a = 0, b = 0;
      const s0 = Math.floor(i * hop), s1 = Math.min(buf.length, Math.floor((i + 1) * hop));
      for (let s = s0; s < s1; s += 4) {
        let v = 0; for (const d of ch) v += d[s]; v /= ch.length;
        if (v < a) a = v; if (v > b) b = v;
      }
      lo[i] = a; hi[i] = b;
    }
    return { per, lo, hi };
  }
  async function loadSong(file) {
    busy('Loading song…');
    try {
      const buf = await decodeFile(file);
      stop();
      A.buf = buf; A.peaks = buildPeaks(buf); A.name = file.name;
      if (P.audioName !== file.name) pushUndo();
      P.audioName = file.name; P.duration = Math.round(buf.duration * 100) / 100;
      changed(); refreshAll();
    } catch (e) {
      alert('Could not read that audio file. Try MP3, WAV or OGG.\n\n' + e.message);
    } finally { busy(null); }
  }

  // Loudness envelope (RMS per frame) of one frequency band, using an offline filter render.
  async function bandEnvelope(buf, band, fps) {
    const off = new OfflineAudioContext(1, buf.length, buf.sampleRate);
    const src = off.createBufferSource(); src.buffer = buf;
    let node = src;
    const filt = (type, f) => { const b = off.createBiquadFilter(); b.type = type; b.frequency.value = f; node.connect(b); node = b; };
    if (band === 'voice') { filt('highpass', 250); filt('highpass', 250); filt('lowpass', 3500); }
    else if (band === 'bass') { filt('lowpass', 150); filt('lowpass', 150); }
    else if (band === 'mid') { filt('highpass', 400); filt('lowpass', 2500); }
    else if (band === 'treble') { filt('highpass', 5000); filt('highpass', 5000); }
    node.connect(off.destination);
    src.start();
    const out = (await off.startRendering()).getChannelData(0);
    const hop = buf.sampleRate / fps, n = Math.ceil(buf.length / hop);
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s0 = Math.floor(i * hop), s1 = Math.min(out.length, Math.floor((i + 1) * hop));
      let sum = 0; for (let s = s0; s < s1; s++) sum += out[s] * out[s];
      env[i] = Math.sqrt(sum / Math.max(1, s1 - s0));
    }
    return env;
  }

  // ---------- transport ----------
  function now() {
    if (!UI.playing) return UI.playhead;
    if (A.buf) return A.startPos + (A.ctx.currentTime - A.startCtx);
    return A.startPos + (performance.now() - A.clock0) / 1000;
  }
  function play() {
    if (UI.playing) return;
    let from = UI.playhead;
    if (UI.loop && UI.sel && (from < UI.sel.a || from >= UI.sel.b)) from = UI.sel.a;
    if (from >= P.duration - 0.05) from = 0;
    A.startPos = from;
    if (A.buf) {
      const ctx = audioCtx();
      if (ctx.state === 'suspended') ctx.resume();
      A.src = ctx.createBufferSource(); A.src.buffer = A.buf; A.src.connect(ctx.destination);
      A.startCtx = ctx.currentTime; A.src.start(0, from);
    } else {
      A.clock0 = performance.now();
    }
    UI.playing = true; $('#playBtn').textContent = '❚❚ Pause';
  }
  function pause() {
    if (!UI.playing) return;
    UI.playhead = clamp(now(), 0, P.duration);
    if (A.src) { try { A.src.stop(); } catch (e) { /* already stopped */ } A.src = null; }
    UI.playing = false; $('#playBtn').textContent = '▶ Play';
  }
  function stop() { pause(); UI.playhead = UI.sel && UI.loop ? UI.sel.a : 0; UI.viewStart = 0; syncScroll(); }
  function seek(t) {
    const was = UI.playing; pause();
    UI.playhead = clamp(t, 0, P.duration);
    if (was) play();
  }

  // ---------- stage preview ----------
  function drawStage(t) {
    const cv = $('#stage'), wrap = $('#stageWrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const g = sizeCanvas(cv, W, H);
    const skels = P.props.filter(p => p.type === 'skeleton');
    const lights = P.props.filter(p => p.type === 'light');

    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#05060a'); sky.addColorStop(1, '#141824');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    const groundY = H - 34;
    g.fillStyle = '#0a0c10'; g.fillRect(0, groundY, W, H - groundY);

    // Light washes on the ground and the lamps themselves.
    g.globalCompositeOperation = 'lighter';
    lights.forEach((p, i) => {
      const d = L.trackValue(P, p, 'dim', t) / 255;
      const [r, gg, b] = p.mode === 'rgb' ? L.hexToRgb(p.color) : [255, 244, 214];
      const x = W * (i + 1) / (lights.length + 1);
      if (d > 0.01) {
        const wash = g.createRadialGradient(x, groundY, 0, x, groundY, W * 0.45);
        wash.addColorStop(0, `rgba(${r},${gg},${b},${0.55 * d})`); wash.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = wash; g.fillRect(0, 0, W, H);
        const halo = g.createRadialGradient(x, 26, 0, x, 26, 18 + 50 * d);
        halo.addColorStop(0, `rgba(${r},${gg},${b},${0.9 * d})`); halo.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = halo; g.fillRect(x - 80, 0, 160, 110);
      }
    });
    g.globalCompositeOperation = 'source-over';
    lights.forEach((p, i) => {
      const d = L.trackValue(P, p, 'dim', t) / 255;
      const [r, gg, b] = p.mode === 'rgb' ? L.hexToRgb(p.color) : [255, 244, 214];
      const x = W * (i + 1) / (lights.length + 1);
      g.beginPath(); g.arc(x, 26, 9, 0, Math.PI * 2);
      g.fillStyle = `rgb(${Math.round(40 + (r - 40) * d)},${Math.round(40 + (gg - 40) * d)},${Math.round(44 + (b - 44) * d)})`;
      g.fill(); g.strokeStyle = '#555'; g.stroke();
      g.fillStyle = '#9aa1b1'; g.font = '11px system-ui'; g.textAlign = 'center';
      g.fillText(p.name, x, 50);
    });

    const n = Math.max(1, skels.length);
    const slot = W / n;
    const s = clamp(Math.min(slot / 200, (groundY - 70) / 245), 0.25, 2.2);
    skels.forEach((p, i) => {
      const x = slot * (i + 0.5);
      drawSkeleton(g, x, groundY, s,
        L.trackValue(P, p, 'arm', t) / 255, L.trackValue(P, p, 'mouth', t) / 255,
        (L.trackValue(P, p, 'body', t) - 128) / 127, p.id === UI.selProp ? p.color : null);
      g.fillStyle = p.id === UI.selProp ? p.color : '#9aa1b1';
      g.font = '600 12px system-ui'; g.textAlign = 'center';
      g.fillText(p.name, x, groundY + 22);
    });
    if (!skels.length && !lights.length) {
      g.fillStyle = '#8d95a6'; g.font = '15px system-ui'; g.textAlign = 'center';
      g.fillText('Add a skeleton or a light on the right to get started', W / 2, H / 2);
    }
  }

  function drawSkeleton(g, x, y, s, arm, mouth, turn, highlight) {
    const ang = clamp(turn, -1, 1) * Math.PI / 3;
    const c = Math.cos(ang), sn = Math.sin(ang), cx = 0.35 + 0.65 * Math.abs(c);
    const bone = '#efe9d6', dark = '#14161c';
    g.save(); g.translate(x, y); g.scale(s, s);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (highlight) { g.shadowColor = highlight; g.shadowBlur = 18; }
    g.strokeStyle = bone; g.fillStyle = bone;
    const line = (pts, w) => { g.lineWidth = w; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(q => g.lineTo(q[0], q[1])); g.stroke(); };

    // legs
    line([[-9 * cx, -108], [-14 * cx, -55], [-16 * cx, -2]], 6);
    line([[9 * cx, -108], [14 * cx, -55], [16 * cx, -2]], 6);
    line([[-16 * cx, -2], [-16 * cx + 10 * sn - 6, 0]], 5);
    line([[16 * cx, -2], [16 * cx + 10 * sn + 6, 0]], 5);
    // pelvis + spine
    g.lineWidth = 4; g.beginPath(); g.ellipse(0, -110, 20 * cx, 8, 0, 0, Math.PI * 2); g.stroke();
    line([[0, -110], [0, -182]], 4);
    // ribs
    for (let i = 0; i < 4; i++) {
      g.lineWidth = 3; g.beginPath();
      g.ellipse(sn * 4, -170 + i * 10, (26 - i * 2.5) * cx, 5.5, 0, 0, Math.PI * 2); g.stroke();
    }
    // shoulders
    const shL = [-30 * cx, -180], shR = [30 * cx, -180];
    line([shL, shR], 4);
    // left arm hangs at rest
    line([shL, [-38 * cx, -142], [-36 * cx, -106]], 4.5);
    g.beginPath(); g.arc(-36 * cx, -102, 4.5, 0, Math.PI * 2); g.fill();
    // right arm: 0 = down, 1 = raised (about 150 degrees)
    const a1 = arm * Math.PI * 0.83, a2 = a1 + 0.35;
    const elb = [shR[0] + Math.sin(a1) * 36 * cx, shR[1] + Math.cos(a1) * 36];
    const hd = [elb[0] + Math.sin(a2) * 32 * cx, elb[1] + Math.cos(a2) * 32];
    line([shR, elb, hd], 4.5);
    g.beginPath(); g.arc(hd[0], hd[1], 4.5, 0, Math.PI * 2); g.fill();

    // skull
    const hx = sn * 9, hy = -212;
    g.beginPath(); g.ellipse(hx, hy, 22 * (0.8 + 0.2 * Math.abs(c)), 24, 0, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    g.fillStyle = dark;
    [-1, 1].forEach(side => {
      const ex = hx + side * 8.5 * c + sn * 9, vis = 0.45 + 0.55 * clamp(c + side * sn * 0.9, 0, 1);
      g.beginPath(); g.ellipse(ex, hy - 3, 6 * vis, 7, 0, 0, Math.PI * 2); g.fill();
    });
    g.beginPath(); g.moveTo(hx + sn * 14, hy + 5); g.lineTo(hx + sn * 14 - 3, hy + 11); g.lineTo(hx + sn * 14 + 3, hy + 11); g.closePath(); g.fill();
    // upper teeth
    const tx = hx + sn * 10, ty = hy + 15, tw = 11 * (0.7 + 0.3 * Math.abs(c));
    g.fillStyle = bone; g.fillRect(tx - tw, ty - 1, tw * 2, 5);
    // mouth opening and jaw (drops with the mouth value)
    const drop = mouth * 15;
    g.fillStyle = dark; g.fillRect(tx - tw, ty + 4, tw * 2, drop);
    g.fillStyle = bone;
    g.beginPath(); g.roundRect ? g.roundRect(tx - tw - 3, ty + 4 + drop, tw * 2 + 6, 9, [0, 0, 7, 7]) : g.rect(tx - tw - 3, ty + 4 + drop, tw * 2 + 6, 9); g.fill();
    g.strokeStyle = dark; g.lineWidth = 0.8;
    for (let i = -2; i <= 2; i++) {
      g.beginPath(); g.moveTo(tx + i * tw / 2.6, ty - 1); g.lineTo(tx + i * tw / 2.6, ty + 4); g.stroke();
      g.beginPath(); g.moveTo(tx + i * tw / 2.6, ty + 4 + drop); g.lineTo(tx + i * tw / 2.6, ty + 8 + drop); g.stroke();
    }
    g.restore();
  }

  // ---------- timeline ----------
  const tToX = t => GUT + (t - UI.viewStart) * UI.pps;
  const xToT = x => UI.viewStart + (x - GUT) / UI.pps;
  function rowTop(i) { return RULER + WAVE + i * ROW; }
  const vToY = (v, top) => top + 6 + (1 - v / 255) * (ROW - 12);
  const yToV = (y, top) => clamp(Math.round((1 - (y - top - 6) / (ROW - 12)) * 255), 0, 255);

  function niceStep(min) {
    for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s >= min) return s;
    return 300;
  }

  function drawTimeline(t) {
    const cv = $('#tl'), wrap = $('#tlWrap');
    const W = wrap.clientWidth, rs = rows();
    const H = Math.max(wrap.clientHeight, rowTop(rs.length) + 4);
    const g = sizeCanvas(cv, W, H);
    g.fillStyle = C['--panel']; g.fillRect(0, 0, W, H);
    const t0 = UI.viewStart, t1 = xToT(W);

    // past-the-end shading
    const endX = tToX(P.duration);
    if (endX < W) { g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(Math.max(GUT, endX), 0, W, H); }

    // ruler
    g.fillStyle = C['--panel2']; g.fillRect(GUT, 0, W - GUT, RULER);
    const step = niceStep(70 / UI.pps), minor = step / 5;
    g.font = '11px system-ui'; g.textAlign = 'left'; g.fillStyle = C['--muted'];
    for (let s = Math.floor(t0 / minor) * minor; s <= t1; s += minor) {
      const x = Math.round(tToX(s)) + 0.5;
      if (x < GUT) continue;
      const major = Math.abs(s / step - Math.round(s / step)) < 1e-6;
      g.fillStyle = major ? C['--muted'] : C['--line'];
      g.fillRect(x, major ? 12 : 19, 1, RULER - (major ? 12 : 19));
      if (major) { g.fillStyle = C['--muted']; g.fillText(fmt(s).replace(/\.00$/, ''), x + 3, 11); }
      if (major) { g.fillStyle = 'rgba(255,255,255,.035)'; g.fillRect(x, RULER, 1, H); }
    }

    // waveform
    const wy = RULER, wm = wy + WAVE / 2;
    g.fillStyle = '#12151c'; g.fillRect(GUT, wy, W - GUT, WAVE);
    if (A.peaks) {
      const pk = A.peaks;
      g.fillStyle = '#4b5a78';
      for (let x = GUT; x < W; x++) {
        const i0 = Math.floor(xToT(x) * pk.per), i1 = Math.max(i0 + 1, Math.floor(xToT(x + 1) * pk.per));
        if (i0 >= pk.lo.length || i1 <= 0) continue;
        let lo = 0, hi = 0;
        for (let i = Math.max(0, i0); i < Math.min(pk.lo.length, i1); i++) { if (pk.lo[i] < lo) lo = pk.lo[i]; if (pk.hi[i] > hi) hi = pk.hi[i]; }
        g.fillRect(x, wm - hi * (WAVE / 2 - 3), 1, Math.max(1, (hi - lo) * (WAVE / 2 - 3)));
      }
    } else {
      g.fillStyle = C['--muted']; g.font = '12px system-ui';
      g.fillText(P.audioName ? `Load "${P.audioName}" again to see and hear it (♪ Load song)` : 'No song loaded yet — click ♪ Load song', GUT + 10, wm + 4);
    }

    // tracks
    rs.forEach((r, i) => {
      const top = rowTop(i);
      const isSel = r.id === UI.selRow;
      g.fillStyle = isSel ? C['--sel'] : (i % 2 ? '#181b23' : '#151820');
      g.fillRect(GUT, top, W - GUT, ROW);
      if (r.p !== (rs[i - 1] || {}).p) { g.fillStyle = C['--line']; g.fillRect(0, top, W, 1); }
      g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(GUT, vToY(128, top), W - GUT, 1);

      const keys = P.tracks[r.id] || [];
      const col = r.p.color;
      g.strokeStyle = col; g.lineWidth = 1.8;
      g.beginPath();
      g.moveTo(GUT, vToY(L.valueAt(keys, t0, r.c.def), top));
      let first = Math.max(0, L.lowerBound(keys, t0)), last = first;
      while (last < keys.length && keys[last].t <= t1) { g.lineTo(tToX(keys[last].t), vToY(keys[last].v, top)); last++; }
      g.lineTo(W, vToY(L.valueAt(keys, t1, r.c.def), top));
      if (!keys.length) g.setLineDash([4, 4]);
      g.stroke(); g.setLineDash([]);
      g.lineTo(W, top + ROW); g.lineTo(GUT, top + ROW); g.closePath();
      g.globalAlpha = 0.12; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
      if (last - first < (W - GUT) / 7) {
        for (let k = first; k < last; k++) {
          g.beginPath(); g.arc(tToX(keys[k].t), vToY(keys[k].v, top), 3.6, 0, Math.PI * 2);
          g.fillStyle = (UI.drag && UI.drag.key === keys[k]) ? '#fff' : col; g.fill();
          g.strokeStyle = '#0d0f14'; g.lineWidth = 1; g.stroke();
        }
      }
    });

    // selected section
    if (UI.sel) {
      const a = tToX(UI.sel.a), b = tToX(UI.sel.b);
      g.fillStyle = 'rgba(255,138,31,.10)'; g.fillRect(Math.max(GUT, a), 0, b - Math.max(GUT, a), H);
      g.fillStyle = C['--accent'];
      if (a >= GUT) g.fillRect(a, 0, 1, H);
      if (b >= GUT) g.fillRect(b, 0, 1, H);
      g.fillRect(Math.max(GUT, a), RULER - 4, b - Math.max(GUT, a), 4);
    }

    // playhead
    const px = Math.round(tToX(t)) + 0.5;
    if (px >= GUT) {
      g.fillStyle = '#fff'; g.fillRect(px - 0.5, 0, 1.5, H);
      g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px, 8); g.closePath(); g.fill();
    }

    // gutter labels drawn last so curves never cover them
    g.fillStyle = C['--panel']; g.fillRect(0, 0, GUT, H);
    g.fillStyle = C['--line']; g.fillRect(GUT - 1, 0, 1, H);
    g.textAlign = 'left';
    g.fillStyle = C['--muted']; g.font = '600 11px system-ui';
    g.fillText('TIME', 12, 17); g.fillText('MUSIC', 12, wy + WAVE / 2 + 4);
    rs.forEach((r, i) => {
      const top = rowTop(i);
      if (r.id === UI.selRow) { g.fillStyle = C['--sel']; g.fillRect(0, top, GUT - 1, ROW); g.fillStyle = C['--accent']; g.fillRect(0, top, 3, ROW); }
      if (r.p !== (rs[i - 1] || {}).p) {
        g.fillStyle = C['--line']; g.fillRect(0, top, GUT, 1);
        g.fillStyle = r.p.color; g.beginPath(); g.arc(14, top + 17, 5, 0, Math.PI * 2); g.fill();
        g.fillStyle = C['--text']; g.font = '600 12.5px system-ui';
        g.fillText(clipText(g, r.p.name, GUT - 34), 26, top + 21);
      }
      g.fillStyle = C['--muted']; g.font = '12px system-ui';
      g.fillText(r.c.label, 26, top + (r.p !== (rs[i - 1] || {}).p ? 39 : 27));
      g.font = '600 11px system-ui'; g.fillStyle = C['--text']; g.textAlign = 'right';
      g.fillText(Math.round(L.trackValue(P, r.p, r.c.key, t)), GUT - 9, top + ROW - 8);
      g.textAlign = 'left';
    });
    if (!rs.length) { g.fillStyle = C['--muted']; g.font = '13px system-ui'; g.fillText('Add a skeleton or light to create tracks.', GUT + 12, rowTop(0) + 30); }
  }
  function clipText(g, s, w) {
    if (g.measureText(s).width <= w) return s;
    while (s.length > 1 && g.measureText(s + '…').width > w) s = s.slice(0, -1);
    return s + '…';
  }

  function syncScroll() {
    const hs = $('#hs');
    $('#hsInner').style.width = Math.max(1, P.duration * UI.pps + 40) + 'px';
    const want = UI.viewStart * UI.pps;
    if (Math.abs(hs.scrollLeft - want) > 1) hs.scrollLeft = want;
    UI.viewStart = hs.scrollLeft / UI.pps;
  }
  function zoom(f, anchorT) {
    const W = $('#tlWrap').clientWidth;
    if (anchorT == null) anchorT = (UI.playhead >= UI.viewStart && UI.playhead <= xToT(W)) ? UI.playhead : xToT((W + GUT) / 2);
    const ax = tToX(anchorT);
    UI.pps = clamp(UI.pps * f, 4, 1200);
    UI.viewStart = Math.max(0, anchorT - (ax - GUT) / UI.pps);
    syncScroll();
  }

  // ---------- timeline mouse/touch ----------
  function hitKey(keys, x, y, top) {
    const t = xToT(x), r = 7 / UI.pps;
    let i = L.lowerBound(keys, t - r);
    let best = null, bd = 64;
    for (; i < keys.length && keys[i].t <= t + r; i++) {
      const dx = tToX(keys[i].t) - x, dy = vToY(keys[i].v, top) - y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = keys[i]; }
    }
    return best;
  }
  function removeRange(keys, a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i].t >= lo && keys[i].t <= hi) keys.splice(i, 1);
  }

  const tl = $('#tl');
  tl.addEventListener('contextmenu', e => e.preventDefault());
  tl.addEventListener('pointerdown', e => {
    const rect = tl.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    const rs = rows(), t = clamp(xToT(x), 0, P.duration);
    tl.setPointerCapture(e.pointerId);
    if (y < RULER && x >= GUT) { UI.drag = { type: 'ruler', a: t, x0: x }; return; }
    if (y < RULER + WAVE) { if (x >= GUT) { UI.drag = { type: 'scrub' }; seek(t); } return; }
    const ri = Math.floor((y - RULER - WAVE) / ROW), r = rs[ri];
    if (!r) return;
    UI.selRow = r.id;
    if (UI.selProp !== r.p.id) { UI.selProp = r.p.id; renderProps(); } else renderPose();
    if (x < GUT) return;
    const top = rowTop(ri), keys = keysFor(r.p, r.c.key);
    const tool = e.button === 2 ? 'delete' : UI.tool;
    if (tool === 'select' || tool === 'delete') {
      const k = hitKey(keys, x, y, top);
      if (k && (tool === 'delete' || e.shiftKey)) { pushUndo(); keys.splice(keys.indexOf(k), 1); changed(); return; }
      if (tool === 'delete') return;
      pushUndo();
      const key = k || L.insertKey(keys, { t: Math.round(t * P.fps) / P.fps, v: yToV(y, top) });
      UI.drag = { type: 'key', key, keys, top };
    } else if (tool === 'draw') {
      pushUndo();
      const v = yToV(y, top);
      removeRange(keys, t - 0.5 / P.fps, t + 0.5 / P.fps);
      L.insertKey(keys, { t, v });
      UI.drag = { type: 'draw', keys, top, lastT: t };
    } else if (tool === 'erase') {
      pushUndo();
      UI.drag = { type: 'erase', keys, lastT: t };
    }
  });
  tl.addEventListener('pointermove', e => {
    const d = UI.drag;
    const rect = tl.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    tl.style.cursor = y < RULER + WAVE ? 'text' : (UI.tool === 'draw' ? 'crosshair' : UI.tool === 'erase' ? 'cell' : 'default');
    if (!d) return;
    const t = clamp(xToT(x), 0, P.duration);
    if (d.type === 'ruler') {
      if (Math.abs(x - d.x0) > 4) UI.sel = { a: Math.min(d.a, t), b: Math.max(d.a, t) };
    } else if (d.type === 'scrub') {
      seek(t);
    } else if (d.type === 'key') {
      d.key.t = e.altKey ? t : Math.round(t * P.fps) / P.fps;
      d.key.v = yToV(y, d.top);
      d.keys.sort((a, b) => a.t - b.t);
      changed();
    } else if (d.type === 'draw') {
      if (Math.abs(t - d.lastT) < 1 / P.fps) return;
      const v = yToV(y, d.top);
      if (t > d.lastT) removeRange(d.keys, d.lastT + 1e-6, t); else removeRange(d.keys, t, d.lastT - 1e-6);
      L.insertKey(d.keys, { t, v });
      d.lastT = t; changed();
    } else if (d.type === 'erase') {
      removeRange(d.keys, d.lastT, t); d.lastT = t; changed();
    }
  });
  const endDrag = e => {
    const d = UI.drag; UI.drag = null;
    if (!d) return;
    if (d.type === 'ruler') {
      const rect = tl.getBoundingClientRect(), x = e.clientX - rect.left;
      if (Math.abs(x - d.x0) <= 4) { UI.sel = null; seek(d.a); }
      else { UI.sel = { a: Math.min(d.a, clamp(xToT(x), 0, P.duration)), b: Math.max(d.a, clamp(xToT(x), 0, P.duration)) }; }
    }
    if (d.type === 'key' || d.type === 'draw' || d.type === 'erase') { changed(); renderPose(); }
  };
  tl.addEventListener('pointerup', endDrag);
  tl.addEventListener('pointercancel', endDrag);
  tl.addEventListener('wheel', e => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = tl.getBoundingClientRect();
      zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, xToT(e.clientX - rect.left));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      $('#hs').scrollLeft += (e.shiftKey ? e.deltaY : e.deltaX);
    }
  }, { passive: false });
  $('#hs').addEventListener('scroll', () => { UI.viewStart = $('#hs').scrollLeft / UI.pps; });

  // ---------- side panel ----------
  function renderProps() {
    const list = $('#propList'); list.textContent = '';
    for (const p of P.props) {
      const end = p.start + L.footprint(p) - 1;
      list.append(el('div', {
        class: 'propItem' + (p.id === UI.selProp ? ' sel' : ''),
        onclick: () => { UI.selProp = p.id; UI.selRow = L.trackId(p, L.channelsOf(p)[0].key); renderProps(); },
      },
      el('span', { class: 'sw', style: 'background:' + p.color }),
      el('span', {}, p.name, el('br'), el('small', {}, p.type === 'skeleton' ? 'Skeleton (arm · mouth · turn)' : (p.mode === 'rgb' ? 'RGB light' : 'Single-colour light'))),
      el('small', {}, 'DMX ' + (end > p.start ? p.start + '–' + end : p.start))));
    }
    const probs = L.patchProblems(P);
    $('#patchWarn').textContent = probs.length ? '⚠ ' + probs.join(' ') : '';
    renderEdit();
  }

  function renderEdit() {
    const box = $('#propEdit'); box.textContent = '';
    const p = propById(UI.selProp);
    if (!p) return;
    const upd = (fn) => e => { pushUndo(); fn(e.target); changed(); renderProps(); };
    const card = el('div', { class: 'card' },
      el('h3', {}, p.type === 'skeleton' ? 'Skeleton settings' : 'Light settings'),
      el('label', { class: 'f' }, 'Name', el('input', { type: 'text', value: p.name, onchange: upd(i => p.name = i.value.trim() || p.name) })),
      el('div', { class: 'grid2' },
        el('label', { class: 'f' }, 'First DMX channel',
          el('input', { type: 'number', min: 1, max: 512, value: p.start, onchange: upd(i => p.start = clamp(parseInt(i.value, 10) || 1, 1, 512)) })),
        el('label', { class: 'f' }, 'Colour (timeline' + (p.type === 'light' && p.mode === 'rgb' ? ' + light)' : ')'),
          el('input', { type: 'color', value: p.color, onchange: upd(i => p.color = i.value) }))),
      p.type === 'light' ? el('label', { class: 'f' }, 'Light type',
        el('select', { onchange: upd(i => p.mode = i.value) },
          el('option', { value: 'rgb', selected: p.mode === 'rgb' }, 'RGB (3 channels: red, green, blue)'),
          el('option', { value: 'dimmer', selected: p.mode === 'dimmer' }, 'Dimmer (1 channel)'))) : '',
      el('div', { id: 'pose', class: 'card', style: 'background:var(--panel);gap:8px' }),
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('span', { class: 'muted' }, 'Channels ' + p.start + (L.footprint(p) > 1 ? '–' + (p.start + L.footprint(p) - 1) : '')),
        el('button', { class: 'danger', onclick: () => {
          if (!confirm(`Remove ${p.name} and all its movements?`)) return;
          pushUndo();
          P.props = P.props.filter(q => q !== p);
          L.channelsOf(p).forEach(c => delete P.tracks[L.trackId(p, c.key)]);
          UI.selProp = P.props[0] ? P.props[0].id : null;
          changed(); refreshAll();
        } }, 'Remove')));
    box.append(card);
    renderPose();
  }

  // Sliders that show the pose at the playhead; moving one sets a point there.
  let poseInputs = [], poseHeld = null;
  window.addEventListener('pointerup', () => { poseHeld = null; });
  function renderPose() {
    const box = $('#pose'), p = propById(UI.selProp);
    if (!box || !p) return;
    box.textContent = '';
    box.append(el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h3', {}, p.type === 'skeleton' ? 'Pose at playhead' : 'Level at playhead'),
      el('span', { class: 'muted' }, 'drag to set a point')));
    poseInputs = L.channelsOf(p).map(c => {
      const val = el('b', {}, '0');
      let undoPushed = false;
      const input = el('input', {
        type: 'range', min: 0, max: 255, step: 1,
        onpointerdown: e => { undoPushed = false; poseHeld = e.target; },
        oninput: e => {
          if (UI.playing) pause();
          if (!undoPushed) { pushUndo(); undoPushed = true; }
          const keys = keysFor(p, c.key), t = Math.round(UI.playhead * P.fps) / P.fps, v = +e.target.value;
          const i = L.lowerBound(keys, t - 0.5 / P.fps);
          if (keys[i] && Math.abs(keys[i].t - t) < 0.5 / P.fps) keys[i].v = v; else L.insertKey(keys, { t, v });
          UI.selRow = L.trackId(p, c.key);
          val.textContent = v; changed();
        },
        onchange: () => { undoPushed = false; },
      });
      box.append(el('div', { class: 'pose' }, el('div', { class: 'lbl' }, el('span', { title: c.hint }, c.label + ' '), val), input));
      return { c, input, val };
    });
    updatePose(UI.playhead);
  }
  function updatePose(t) {
    const p = propById(UI.selProp);
    if (!p) return;
    for (const pi of poseInputs) {
      if (poseHeld === pi.input) continue;
      const v = Math.round(L.trackValue(P, p, pi.c.key, t));
      pi.input.value = v; pi.val.textContent = v;
    }
  }

  function refreshAll() {
    $('#projName').value = P.name;
    $('#durInput').value = P.duration;
    $('#songName').textContent = A.buf && A.name === P.audioName ? P.audioName : (P.audioName ? '(' + P.audioName + ' — not loaded)' : '');
    UI.playhead = clamp(UI.playhead, 0, P.duration);
    if (UI.sel && UI.sel.a >= P.duration) UI.sel = null;
    renderProps(); syncScroll();
  }

  // ---------- modal forms ----------
  function modal(title, body, buttons) {
    return new Promise(resolve => {
      const bg = el('div', { class: 'modalBg' });
      const close = v => { bg.remove(); document.removeEventListener('keydown', esc); resolve(v); };
      const esc = e => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', esc);
      bg.addEventListener('pointerdown', e => { if (e.target === bg) close(null); });
      const m = el('div', { class: 'modal' }, el('h2', {}, title), body,
        el('div', { class: 'actions' }, buttons.map(b => el('button', { class: b.primary ? 'primary' : '', onclick: () => close(b.value ? b.value() : null) }, b.label))));
      bg.append(m); document.body.append(bg);
    });
  }
  // fields: {key,label,type:'range'|'select'|'file'|'check', ...}
  function askForm(title, intro, fields, okLabel) {
    const vals = {};
    const body = el('div', { style: 'display:grid;gap:12px' }, intro ? el('p', {}, intro) : '');
    for (const f of fields) {
      vals[f.key] = f.value;
      if (f.type === 'range') {
        const out = el('b', {}, f.fmt ? f.fmt(f.value) : f.value);
        body.append(el('label', { class: 'f' }, el('span', { class: 'row', style: 'justify-content:space-between' }, f.label, out),
          el('input', { type: 'range', min: f.min, max: f.max, step: f.step || 1, value: f.value, oninput: e => { vals[f.key] = +e.target.value; out.textContent = f.fmt ? f.fmt(+e.target.value) : e.target.value; } }),
          f.help ? el('span', {}, f.help) : ''));
      } else if (f.type === 'select') {
        body.append(el('label', { class: 'f' }, f.label,
          el('select', { onchange: e => { vals[f.key] = e.target.value; } }, f.options.map(o => el('option', { value: o[0], selected: o[0] === f.value }, o[1]))),
          f.help ? el('span', {}, f.help) : ''));
      } else if (f.type === 'file') {
        vals[f.key] = null;
        body.append(el('label', { class: 'f' }, f.label,
          el('input', { type: 'file', accept: 'audio/*', onchange: e => { vals[f.key] = e.target.files[0] || null; } }),
          f.help ? el('span', {}, f.help) : ''));
      } else if (f.type === 'check') {
        body.append(el('label', { class: 'row' },
          el('input', { type: 'checkbox', checked: !!f.value, onchange: e => { vals[f.key] = e.target.checked; } }), f.label));
      }
    }
    return modal(title, body, [{ label: 'Cancel' }, { label: okLabel || 'Apply', primary: true, value: () => vals }]);
  }
  function busy(msg) {
    let b = document.getElementById('busy');
    if (!msg) { if (b) b.remove(); return; }
    if (!b) { b = el('div', { id: 'busy', class: 'busy' }); document.body.append(b); }
    b.textContent = msg;
  }

  function rangeOrAll() { return UI.sel ? [UI.sel.a, UI.sel.b] : [0, P.duration]; }
  function rangeText() { return UI.sel ? `the selected section (${fmt(UI.sel.a)} – ${fmt(UI.sel.b)})` : 'the whole show'; }
  function pickSkeleton() {
    const p = propById(UI.selProp);
    if (p && p.type === 'skeleton') return p;
    const s = P.props.find(q => q.type === 'skeleton');
    if (!s) alert('Add a skeleton first (+ Skeleton on the right).');
    return s;
  }
  function needSong() {
    if (A.buf) return true;
    alert('Load the song first (♪ Load song) so the music can be analysed.');
    return false;
  }
  async function sourceBuffer(file) {
    if (!file) return A.buf;
    if (!A.extra[file.name]) A.extra[file.name] = await decodeFile(file);
    return A.extra[file.name];
  }

  // ---------- auto tools ----------
  async function autoMouth() {
    const p = pickSkeleton(); if (!p || !needSong()) return;
    const o = await askForm(`Auto mouth for ${p.name}`,
      `Makes ${p.name}'s jaw open with the singing over ${rangeText()}. For a duet, select each singer's lines on the time ruler and run this once per skeleton. Fine-tune afterwards with the Draw tool.`,
      [
        { key: 'file', type: 'file', label: 'Vocals-only file (optional, works much better)', help: 'A vocal stem from a free "stem splitter" (e.g. Ultimate Vocal Remover). Leave empty to use the song.' },
        { key: 'sensitivity', type: 'range', label: 'Sensitivity', min: 0.5, max: 2.5, step: 0.05, value: 1.2, fmt: v => v.toFixed(2) + '×' },
        { key: 'gate', type: 'range', label: 'Ignore quiet sounds below', min: 0, max: 0.6, step: 0.01, value: 0.25, fmt: v => Math.round(v * 100) + '%', help: 'Raise this if the mouth flaps during instruments.' },
        { key: 'maxOpen', type: 'range', label: 'Widest mouth opening', min: 60, max: 255, value: 255 },
        { key: 'release', type: 'range', label: 'Close speed', min: 0.03, max: 0.3, step: 0.01, value: 0.08, fmt: v => v < 0.07 ? 'snappy' : v > 0.15 ? 'lazy' : 'natural' },
      ], 'Make mouth moves');
    if (!o) return;
    busy('Listening to the vocals…');
    try {
      const buf = await sourceBuffer(o.file);
      const env = await bandEnvelope(buf, 'voice', P.fps);
      const [a, b] = rangeOrAll();
      const dense = L.mouthFromEnvelope(env, P.fps, o).filter(k => k.t >= a && k.t <= b);
      const pts = L.simplify(dense, 6);
      pushUndo();
      L.replaceRange(keysFor(p, 'mouth'), a, b, pts);
      UI.selRow = L.trackId(p, 'mouth'); changed(); renderProps();
    } catch (e) { alert('Could not analyse that audio: ' + e.message); }
    finally { busy(null); }
  }

  async function autoLights() {
    const lights = P.props.filter(q => q.type === 'light');
    if (!lights.length) { alert('Add a light first (+ Light on the right).'); return; }
    if (!needSong()) return;
    const sel = propById(UI.selProp);
    const o = await askForm('Auto lights',
      `Generates light changes from the music over ${rangeText()}.`,
      [
        { key: 'target', type: 'select', label: 'Which lights', value: sel && sel.type === 'light' ? sel.id : 'all',
          options: [['all', 'All lights'], ...lights.map(q => [q.id, q.name])] },
        { key: 'style', type: 'select', label: 'Style', value: 'pulse', options: [
          ['pulse', 'Flash on every beat'], ['alternate', 'Take turns on each beat (chase)'], ['follow', 'Follow the loudness smoothly']] },
        { key: 'band', type: 'select', label: 'Listen to', value: 'bass', options: [
          ['bass', 'Bass / kick drum'], ['mid', 'Middle (vocals, guitar)'], ['treble', 'Treble (cymbals, hi-hats)']] },
        { key: 'threshold', type: 'range', label: 'Beat sensitivity', min: 1.1, max: 2.5, step: 0.05, value: 1.5, fmt: v => v < 1.4 ? 'more flashes' : v > 1.9 ? 'fewer flashes' : 'medium', help: 'Only used for the beat styles.' },
        { key: 'decay', type: 'range', label: 'Flash fade time', min: 0.05, max: 1, step: 0.05, value: 0.3, fmt: v => v.toFixed(2) + ' s' },
        { key: 'floor', type: 'range', label: 'Minimum brightness', min: 0, max: 200, value: 0, help: 'Keep lights glowing a little between beats.' },
      ], 'Make light moves');
    if (!o) return;
    busy('Listening for the beat…');
    try {
      const env = await bandEnvelope(A.buf, o.band, P.fps);
      const [a, b] = rangeOrAll();
      const targets = o.target === 'all' ? lights : lights.filter(q => q.id === o.target);
      const lift = pts => pts.map(k => ({ t: k.t, v: Math.round(o.floor + k.v * (255 - o.floor) / 255) }));
      pushUndo();
      if (o.style === 'follow') {
        const norm = L.normalise(env);
        let cur = 0; const rel = Math.exp(-1 / (P.fps * o.decay));
        const dense = norm.map((x, i) => { cur = x > cur ? x : cur * rel + x * (1 - rel); return { t: i / P.fps, v: Math.round(cur * 255) }; })
          .filter(k => k.t >= a && k.t <= b);
        const pts = lift(L.simplify(dense, 8));
        targets.forEach(q => L.replaceRange(keysFor(q, 'dim'), a, b, pts.map(k => ({ ...k }))));
      } else {
        const beats = L.detectBeats(env, P.fps, { threshold: o.threshold, minGap: 0.18 }).filter(t => t >= a && t <= b);
        targets.forEach((q, qi) => {
          const mine = o.style === 'alternate' ? beats.filter((_, i) => i % targets.length === qi) : beats;
          L.replaceRange(keysFor(q, 'dim'), a, b, lift(L.pulseKeys(mine, o.decay, 255, a, b)));
        });
      }
      UI.selRow = L.trackId(targets[0], 'dim'); changed(); renderProps();
    } catch (e) { alert('Could not analyse the song: ' + e.message); }
    finally { busy(null); }
  }

  async function autoBody() {
    const p = pickSkeleton(); if (!p) return;
    const o = await askForm(`Auto turn for ${p.name}`, `Adds body turning over ${rangeText()}.`, [
      { key: 'style', type: 'select', label: 'Style', value: 'look', options: [['look', 'Look around (random, lifelike)'], ['sway', 'Sway side to side (steady)']] },
      { key: 'amount', type: 'range', label: 'How far to turn', min: 10, max: 127, value: 70 },
      { key: 'speed', type: 'range', label: 'Time per move', min: 0.5, max: 6, step: 0.25, value: 2, fmt: v => v + ' s' },
    ], 'Make turn moves');
    if (!o) return;
    const [a, b] = rangeOrAll();
    const pts = [];
    if (o.style === 'sway') {
      for (let t = a; t <= b; t += 1 / 10) pts.push({ t, v: Math.round(128 + o.amount * Math.sin((t - a) * Math.PI / o.speed)) });
    } else {
      let t = a, v = 128;
      pts.push({ t, v });
      while (t < b) {
        const move = o.speed * (0.4 + Math.random() * 0.4), hold = o.speed * (0.3 + Math.random() * 0.9);
        v = Math.round(clamp(128 + (Math.random() * 2 - 1) * o.amount, 0, 255));
        if (t + move > b) break;
        t += move; pts.push({ t, v });
        if (t + hold > b) break;
        t += hold; pts.push({ t, v });
      }
    }
    pushUndo();
    L.replaceRange(keysFor(p, 'body'), a, b, L.simplify(pts.map(k => ({ t: Math.round(k.t * P.fps) / P.fps, v: clamp(k.v, 0, 255) })), 2));
    UI.selRow = L.trackId(p, 'body'); changed(); renderProps();
  }

  function clearTrack() {
    const r = selectedRow();
    if (!r) { alert('Click a track in the timeline first.'); return; }
    if (!confirm(`Clear ${r.p.name} – ${r.c.label} over ${rangeText()}?`)) return;
    pushUndo();
    const [a, b] = rangeOrAll();
    L.replaceRange(keysFor(r.p, r.c.key), a, b, []);
    changed(); renderPose();
  }

  // ---------- exports ----------
  function exportFseq() {
    const probs = L.patchProblems(P);
    if (probs.length && !confirm('Channel problems:\n' + probs.join('\n') + '\n\nExport anyway?')) return;
    download(safeName(P.name) + '.fseq', L.buildFseq(P), 'application/octet-stream');
  }
  function exportCsv() { download(safeName(P.name) + '.csv', L.buildCsv(P), 'text/csv'); }
  function showMap() {
    const map = L.channelMap(P);
    const text = [`${P.name} — DMX channel map (universe ${P.universe || 1})`, '']
      .concat(map.map(m => `ch ${String(m.ch).padStart(3)}  ${m.prop.padEnd(18)} ${m.fn.padEnd(14)} ${m.hint}`))
      .concat(['', 'Arduino receivers: set START_ADDRESS in each skeleton sketch to:'])
      .concat(P.props.filter(p => p.type === 'skeleton').map(p => `  ${p.name}: START_ADDRESS = ${p.start}`)).join('\n');
    const probs = L.patchProblems(P);
    const body = el('div', { style: 'display:grid;gap:10px' },
      probs.length ? el('div', { class: 'warn' }, '⚠ ' + probs.join(' ')) : '',
      el('table', {}, el('tr', {}, el('th', {}, 'DMX ch'), el('th', {}, 'Prop'), el('th', {}, 'Function'), el('th', {}, 'Values')),
        map.map(m => el('tr', {}, el('td', {}, m.ch), el('td', {}, m.prop), el('td', {}, m.fn), el('td', { class: 'muted' }, m.hint)))),
      el('p', {}, 'For each skeleton\'s Arduino, set START_ADDRESS to its first channel: ' +
        (P.props.filter(p => p.type === 'skeleton').map(p => `${p.name} = ${p.start}`).join(', ') || 'no skeletons yet') + '.'));
    modal('Channel map', body, [
      { label: 'Download as text', value: () => download(safeName(P.name) + '_channels.txt', text, 'text/plain') },
      { label: 'Close', primary: true },
    ]);
  }

  // ---------- live DMX output (via server.py) ----------
  async function checkLive() {
    if (location.protocol === 'file:') return;
    try {
      const r = await fetch('api/status', { cache: 'no-store' });
      if (r.ok) { LIVE.available = true; LIVE.lastStatus = await r.json(); }
    } catch (e) { LIVE.available = false; }
    $('#liveBtn').title = LIVE.available
      ? `Send DMX to ${LIVE.lastStatus.target} (universe ${LIVE.lastStatus.universe})`
      : 'Run server.py to enable live output';
  }
  const liveFrame = new Uint8Array(512);
  let lastSentKey = '';
  function sendLive(t) {
    if (!LIVE.on || LIVE.inflight) return;
    const nowMs = performance.now();
    if (nowMs - LIVE.lastSend < 1000 / P.fps - 2) return;
    L.dmxFrame(P, t, liveFrame);
    const sig = UI.playing ? '' : liveFrame.join(',');
    if (!UI.playing && sig === lastSentKey && nowMs - LIVE.lastSend < 1000) return;
    lastSentKey = sig; LIVE.lastSend = nowMs; LIVE.inflight = true;
    fetch('api/dmx', { method: 'POST', body: liveFrame.slice(), headers: { 'Content-Type': 'application/octet-stream' } })
      .catch(() => { LIVE.on = false; $('#liveBtn').classList.remove('on'); alert('Lost connection to server.py — live output turned off.'); })
      .finally(() => { LIVE.inflight = false; });
  }

  // ---------- help ----------
  function showHelp() {
    modal('How to build a show', el('div', { style: 'display:grid;gap:10px' },
      el('ol', {},
        el('li', {}, el('b', {}, 'Set up your props. '), 'On the right, add a skeleton for each animatronic and a light for each light or RGB flood. Set each one\'s first DMX channel to match its receiver (see Export ▸ Channel map).'),
        el('li', {}, el('b', {}, 'Load the song. '), '♪ Load song. The waveform appears so you can see where the singing and beats are.'),
        el('li', {}, el('b', {}, 'Let it do the heavy lifting. '), '🗣 Auto mouth makes jaws follow the singing; 💡 Auto lights flashes or chases lights on the beat; ↻ Auto turn adds lifelike head and body turns. Drag across the time ruler first to apply to just one section (e.g. one singer\'s verse).'),
        el('li', {}, el('b', {}, 'Fine-tune. '), 'Click a track to add a point, drag points to move them, right-click to delete. ✎ Draw lets you paint movement freehand. Or pause, then drag the sliders under "Pose at playhead".'),
        el('li', {}, el('b', {}, 'Watch it. '), 'Press Space to play. The stage on top shows the skeletons and lights moving. Turn on Live output (with server.py running) to drive the real ones.'),
        el('li', {}, el('b', {}, 'Export. '), 'Export ▸ .fseq for Falcon Player / xLights, and Save to keep the project file for later edits.')),
      el('p', {}, 'Shortcuts: ', el('kbd', {}, 'Space'), ' play/pause · ', el('kbd', {}, 'Home'), ' start · ', el('kbd', {}, 'V'), ' ', el('kbd', {}, 'D'), ' ', el('kbd', {}, 'E'), ' tools · ',
        el('kbd', {}, 'Ctrl'), '+', el('kbd', {}, 'Z'), ' undo · ', el('kbd', {}, '+'), '/', el('kbd', {}, '−'), ' zoom · ', el('kbd', {}, 'Ctrl'), '+scroll zoom · ', el('kbd', {}, 'Esc'), ' clear selection')),
      [{ label: 'Got it', primary: true }]);
  }

  // ---------- wiring ----------
  $('#songBtn').onclick = () => $('#songFile').click();
  $('#songFile').onchange = e => { const f = e.target.files[0]; if (f) loadSong(f); e.target.value = ''; };
  $('#projName').onchange = e => { pushUndo(); P.name = e.target.value.trim() || 'My Show'; changed(); };
  $('#durInput').onchange = e => { pushUndo(); P.duration = clamp(+e.target.value || 30, 1, 3600); changed(); refreshAll(); };
  $('#newBtn').onclick = () => {
    if (!confirm('Start a new show? (Unsaved changes to this one will be lost — use Save first if you want to keep it.)')) return;
    pushUndo(); stop(); P = L.demoProject(); P.name = 'New Show'; P.duration = A.buf ? Math.round(A.buf.duration * 100) / 100 : 30;
    P.audioName = A.buf ? A.name : ''; UI.sel = null; UI.selProp = P.props[0].id; changed(); refreshAll();
  };
  $('#saveBtn').onclick = () => download(safeName(P.name) + '.lightmeup.json', JSON.stringify(P, null, 1), 'application/json');
  $('#openBtn').onclick = () => $('#projFile').click();
  $('#projFile').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const p = JSON.parse(await f.text());
      if (p.app !== 'lightmeup' || !Array.isArray(p.props)) throw new Error('not a LightMeUp project');
      pushUndo(); stop(); P = p; UI.sel = null; UI.selProp = P.props[0] ? P.props[0].id : null;
      if (A.buf && P.audioName !== A.name) { A.buf = null; A.peaks = null; A.name = ''; }
      changed(); refreshAll();
    } catch (err) { alert('Could not open that file: ' + err.message); }
  };
  $('#exportMenu').addEventListener('click', e => {
    const b = e.target.closest('[data-export]'); if (!b) return;
    $('#exportMenu').open = false;
    ({ fseq: exportFseq, csv: exportCsv, map: showMap })[b.dataset.export]();
  });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('#exportMenu')) $('#exportMenu').open = false; });
  $('#liveBtn').onclick = async () => {
    if (!LIVE.available) await checkLive();
    if (!LIVE.available) {
      alert('Live output needs the small bridge program.\n\nOn the computer connected to the show network run:\n    python3 server.py --target <controller IP>\nthen open the address it prints (http://localhost:8085) instead of this file.');
      return;
    }
    LIVE.on = !LIVE.on; $('#liveBtn').classList.toggle('on', LIVE.on); lastSentKey = '';
  };
  $('#helpBtn').onclick = showHelp;
  $('#addSkel').onclick = () => { pushUndo(); const p = L.addProp(P, 'skeleton'); UI.selProp = p.id; changed(); renderProps(); };
  $('#addLight').onclick = () => { pushUndo(); const p = L.addProp(P, 'light'); UI.selProp = p.id; changed(); renderProps(); };
  $('#playBtn').onclick = () => UI.playing ? pause() : play();
  $('#stopBtn').onclick = stop;
  $('#loopBtn').onclick = () => {
    UI.loop = !UI.loop; $('#loopBtn').classList.toggle('on', UI.loop);
    if (UI.loop && !UI.sel) alert('Drag across the time ruler to choose the section to loop.');
  };
  document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
  function setTool(t) { UI.tool = t; document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); }
  $('#autoMouth').onclick = autoMouth;
  $('#autoLights').onclick = autoLights;
  $('#autoBody').onclick = autoBody;
  $('#clearTrack').onclick = clearTrack;
  $('#undoBtn').onclick = () => restore(UI.undo, UI.redo);
  $('#redoBtn').onclick = () => restore(UI.redo, UI.undo);
  $('#zoomIn').onclick = () => zoom(1.4);
  $('#zoomOut').onclick = () => zoom(1 / 1.4);

  document.addEventListener('keydown', e => {
    if (e.target.matches('input[type=text], input[type=number], select, textarea') || document.querySelector('.modalBg')) return;
    const k = e.key.toLowerCase();
    if (e.target.matches('input[type=range]') && k.startsWith('arrow')) return;
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? restore(UI.redo, UI.undo) : restore(UI.undo, UI.redo); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); restore(UI.redo, UI.undo); return; }
    if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); $('#saveBtn').click(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === ' ') { e.preventDefault(); UI.playing ? pause() : play(); }
    else if (k === 'home') { e.preventDefault(); seek(0); UI.viewStart = 0; syncScroll(); }
    else if (k === 'end') { e.preventDefault(); seek(P.duration); }
    else if (k === 'v') setTool('select');
    else if (k === 'd') setTool('draw');
    else if (k === 'e') setTool('erase');
    else if (k === '+' || k === '=') zoom(1.4);
    else if (k === '-') zoom(1 / 1.4);
    else if (k === 'escape') UI.sel = null;
    else if (k === 'arrowleft') seek(UI.playhead - 1 / P.fps * (e.shiftKey ? 10 : 1));
    else if (k === 'arrowright') seek(UI.playhead + 1 / P.fps * (e.shiftKey ? 10 : 1));
  });

  // ---------- main loop ----------
  function frame() {
    let t = now();
    if (UI.playing) {
      if (UI.loop && UI.sel && t >= UI.sel.b) { pause(); UI.playhead = UI.sel.a; play(); t = UI.sel.a; }
      else if (t >= P.duration) { pause(); UI.playhead = P.duration; t = P.duration; }
      // keep the playhead in view
      const W = $('#tlWrap').clientWidth;
      if (tToX(t) > W - 40 || tToX(t) < GUT) { UI.viewStart = Math.max(0, t - 0.1 * (W - GUT) / UI.pps); syncScroll(); }
      updatePose(t);
    }
    $('#time').textContent = fmt(t) + ' / ' + fmt(P.duration).replace(/\.\d\d$/, '');
    drawStage(t);
    drawTimeline(t);
    sendLive(t);
    requestAnimationFrame(frame);
  }

  window.addEventListener('beforeunload', () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(P)); } catch (e) { /* ignore */ } });
  UI.selRow = P.props[0] ? L.trackId(P.props[0], L.channelsOf(P.props[0])[0].key) : null;
  refreshAll();
  checkLive();
  requestAnimationFrame(frame);
  if (!loadAutosave()) { changed(); setTimeout(showHelp, 300); }
})();
