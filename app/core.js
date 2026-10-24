// LightMeUp core: show data model, DMX frame rendering, exports.
// Pure logic with no DOM access, so it runs in the browser and in Node (for tests).
(function (root) {
  'use strict';

  // Each prop type and the DMX channels it uses, in order.
  // Skeleton layout: X = arm up/down, Y = mouth, Z = body turn.
  const CHANNELS = {
    skeleton: [
      { key: 'arm',   label: 'Arm (X)',       def: 0,   hint: '0 = down, 255 = up' },
      { key: 'mouth', label: 'Mouth (Y)',     def: 0,   hint: '0 = closed, 255 = open' },
      { key: 'body',  label: 'Body turn (Z)', def: 128, hint: '0 = left, 128 = centre, 255 = right' },
    ],
    light: [
      { key: 'dim', label: 'Brightness', def: 0, hint: '0 = off, 255 = full' },
    ],
  };

  const PALETTE = ['#ff8a1f', '#7c5cff', '#3ecf8e', '#ff4f9a', '#3fb5ff', '#ffd23f', '#ff5c5c', '#a3e635'];

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function channelsOf(p) { return CHANNELS[p.type]; }

  // How many DMX slots a prop occupies.
  function footprint(p) {
    if (p.type === 'skeleton') return 3;
    return p.mode === 'rgb' ? 3 : 1;
  }

  function newProject() {
    return {
      app: 'lightmeup', version: 1,
      name: 'My Show', fps: 40, duration: 30, audioName: '', universe: 1,
      props: [], tracks: {},
    };
  }

  let idCounter = 0;
  function newId() { return 'p' + Date.now().toString(36) + (idCounter++).toString(36); }

  function nextFreeChannel(P, size) {
    let ch = 1;
    for (;;) {
      const clash = P.props.find(p => ch <= p.start + footprint(p) - 1 && p.start <= ch + size - 1);
      if (!clash) return ch;
      ch = clash.start + footprint(clash);
    }
  }

  function addProp(P, type, opts) {
    opts = opts || {};
    const n = P.props.filter(p => p.type === type).length + 1;
    const p = {
      id: newId(), type,
      name: opts.name || (type === 'skeleton' ? 'Skeleton ' + n : 'Light ' + n),
      color: opts.color || PALETTE[P.props.length % PALETTE.length],
      mode: type === 'light' ? (opts.mode || 'rgb') : undefined,
      start: 1,
    };
    p.start = opts.start || nextFreeChannel(P, footprint(p));
    P.props.push(p);
    return p;
  }

  function demoProject() {
    const P = newProject();
    P.name = 'Skeleton Duet';
    addProp(P, 'skeleton', { name: 'Bones', color: '#ff8a1f' });
    addProp(P, 'skeleton', { name: 'Rattles', color: '#7c5cff' });
    addProp(P, 'light', { name: 'Porch (RGB)', color: '#ff6a00', mode: 'rgb' });
    addProp(P, 'light', { name: 'Purple flood', color: '#9b4dff', mode: 'rgb' });
    addProp(P, 'light', { name: 'Spotlight', color: '#fff4d6', mode: 'dimmer' });
    return P;
  }

  function trackId(p, chKey) { return p.id + ':' + chKey; }

  // Keyframes are {t: seconds, v: 0..255}, kept sorted by t.
  function lowerBound(keys, t) {
    let lo = 0, hi = keys.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (keys[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }

  function insertKey(keys, k) { keys.splice(lowerBound(keys, k.t), 0, k); return k; }

  // Linear interpolation between keyframes; holds first/last value outside them.
  function valueAt(keys, t, def) {
    if (!keys || !keys.length) return def;
    const n = keys.length;
    if (t <= keys[0].t) return keys[0].v;
    if (t >= keys[n - 1].t) return keys[n - 1].v;
    const i = lowerBound(keys, t);
    const a = keys[i - 1], b = keys[i];
    const span = b.t - a.t;
    return span > 0 ? a.v + (b.v - a.v) * (t - a.t) / span : b.v;
  }

  function trackValue(P, p, chKey, t) {
    const ch = channelsOf(p).find(c => c.key === chKey);
    return valueAt(P.tracks[trackId(p, chKey)], t, ch.def);
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0xffffff;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // The 512-slot DMX universe at time t (index 0 = DMX channel 1).
  function dmxFrame(P, t, out) {
    out = out || new Uint8Array(512);
    out.fill(0);
    const put = (ch, v) => { if (ch >= 1 && ch <= 512) out[ch - 1] = clamp(Math.round(v), 0, 255); };
    for (const p of P.props) {
      if (p.type === 'skeleton') {
        CHANNELS.skeleton.forEach((c, i) => put(p.start + i, trackValue(P, p, c.key, t)));
      } else {
        const d = trackValue(P, p, 'dim', t) / 255;
        if (p.mode === 'rgb') {
          const rgb = hexToRgb(p.color);
          rgb.forEach((c, i) => put(p.start + i, c * d));
        } else {
          put(p.start, 255 * d);
        }
      }
    }
    return out;
  }

  function maxChannel(P) {
    return P.props.reduce((m, p) => Math.max(m, p.start + footprint(p) - 1), 0);
  }

  // Human readable problems with the channel setup (overlaps, out of range).
  function patchProblems(P) {
    const issues = [];
    P.props.forEach((p, i) => {
      const end = p.start + footprint(p) - 1;
      if (p.start < 1 || end > 512) issues.push(`${p.name} uses channels ${p.start}-${end}, outside 1-512.`);
      P.props.slice(i + 1).forEach(q => {
        const qEnd = q.start + footprint(q) - 1;
        if (p.start <= qEnd && q.start <= end) issues.push(`${p.name} and ${q.name} share DMX channels.`);
      });
    });
    return issues;
  }

  function channelMap(P) {
    const lines = [];
    for (const p of P.props) {
      if (p.type === 'skeleton') {
        CHANNELS.skeleton.forEach((c, i) => lines.push({ ch: p.start + i, prop: p.name, fn: c.label, hint: c.hint }));
      } else if (p.mode === 'rgb') {
        ['Red', 'Green', 'Blue'].forEach((c, i) => lines.push({ ch: p.start + i, prop: p.name, fn: c, hint: 'colour x brightness' }));
      } else {
        lines.push({ ch: p.start, prop: p.name, fn: 'Dimmer', hint: '0-255' });
      }
    }
    return lines.sort((a, b) => a.ch - b.ch);
  }

  function frameCount(P) { return Math.max(1, Math.ceil(P.duration * P.fps)); }

  // FSEQ v1 (uncompressed), the sequence format played by Falcon Player (FPP) and xLights.
  function buildFseq(P) {
    const frames = frameCount(P);
    const chans = Math.max(4, Math.ceil(maxChannel(P) / 4) * 4);
    const stepMs = Math.round(1000 / P.fps);
    const media = P.audioName ? new TextEncoder().encode(P.audioName) : null;
    const varLen = media ? 4 + media.length + 1 : 0;
    const offset = Math.ceil((28 + varLen) / 4) * 4;
    const buf = new ArrayBuffer(offset + chans * frames);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);
    bytes.set([0x50, 0x53, 0x45, 0x51], 0);     // "PSEQ"
    dv.setUint16(4, offset, true);              // channel data offset
    dv.setUint8(6, 0);                          // minor version
    dv.setUint8(7, 1);                          // major version
    dv.setUint16(8, 28, true);                  // fixed header length
    dv.setUint32(10, chans, true);              // channels per frame
    dv.setUint32(14, frames, true);             // frame count
    dv.setUint16(18, stepMs, true);             // ms per frame
    dv.setUint16(20, 0, true);                  // universe count (unused)
    dv.setUint16(22, 0, true);                  // universe size (unused)
    dv.setUint8(24, 1);                         // gamma
    dv.setUint8(25, 2);                         // colour encoding (RGB)
    if (media) {                                // variable header "mf" = media file name
      dv.setUint16(28, varLen, true);
      bytes.set([0x6d, 0x66], 30);
      bytes.set(media, 32);
    }
    const frame = new Uint8Array(512);
    for (let f = 0; f < frames; f++) {
      dmxFrame(P, f / P.fps, frame);
      bytes.set(frame.subarray(0, chans), offset + f * chans);
    }
    return bytes;
  }

  function buildCsv(P) {
    const chans = Math.max(1, maxChannel(P));
    const head = ['time_ms'];
    for (let c = 1; c <= chans; c++) head.push('ch' + c);
    const out = [head.join(',')];
    const frame = new Uint8Array(512);
    const frames = frameCount(P);
    for (let f = 0; f < frames; f++) {
      dmxFrame(P, f / P.fps, frame);
      out.push(Math.round(f * 1000 / P.fps) + ',' + Array.from(frame.subarray(0, chans)).join(','));
    }
    return out.join('\n') + '\n';
  }

  // Reduce a dense per-frame curve to the keyframes needed to stay within `tol` (Ramer-Douglas-Peucker).
  function simplify(points, tol) {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const pa = points[a], pb = points[b];
      let worst = -1, wi = -1;
      for (let i = a + 1; i < b; i++) {
        const p = points[i];
        const span = pb.t - pa.t;
        const expect = span > 0 ? pa.v + (pb.v - pa.v) * (p.t - pa.t) / span : pa.v;
        const d = Math.abs(p.v - expect);
        if (d > worst) { worst = d; wi = i; }
      }
      if (worst > tol) { keep[wi] = 1; stack.push([a, wi], [wi, b]); }
    }
    return points.filter((_, i) => keep[i]);
  }

  // Replace a track's keys between t0 and t1 with `points`.
  function replaceRange(keys, t0, t1, points) {
    const a = lowerBound(keys, t0);
    let b = lowerBound(keys, t1);
    while (b < keys.length && keys[b].t <= t1) b++;
    const rest = keys.splice(a);
    rest.splice(0, b - a);
    for (const p of points) keys.push(p);
    for (const k of rest) keys.push(k);
  }

  // ---- music analysis helpers (envelopes are arrays sampled at P.fps) ----

  function normalise(env) {
    const sorted = Array.from(env).sort((a, b) => a - b);
    const ref = sorted[Math.floor(sorted.length * 0.95)] || 1;
    return Array.from(env, v => clamp(v / (ref || 1), 0, 1));
  }

  // Mouth curve from a vocal-band loudness envelope.
  function mouthFromEnvelope(env, fps, o) {
    const norm = normalise(env);
    const release = Math.exp(-1 / (fps * o.release));
    let cur = 0;
    return norm.map((x, i) => {
      let target = clamp((x * o.sensitivity - o.gate) / (1 - o.gate), 0, 1);
      cur = target > cur ? target : cur * release + target * (1 - release);
      return { t: i / fps, v: Math.round(cur * o.maxOpen) };
    });
  }

  // Beat times from a loudness envelope (energy jumps above the recent average).
  function detectBeats(env, fps, o) {
    const norm = normalise(env);
    const win = Math.max(1, Math.round(fps * 0.4));
    const minGap = Math.round(fps * o.minGap);
    const beats = [];
    let sum = 0, last = -1e9;
    for (let i = 0; i < norm.length; i++) {
      const avg = i ? sum / Math.min(i, win) : 0;
      if (norm[i] > 0.15 && norm[i] > avg * o.threshold && i - last >= minGap) { beats.push(i); last = i; }
      sum += norm[i];
      if (i >= win) sum -= norm[i - win];
    }
    return beats.map(i => i / fps);
  }

  // A pulse that jumps to full on each beat and fades over `decay` seconds.
  function pulseKeys(beats, decay, peak, t0, t1) {
    const keys = [{ t: t0, v: 0 }];
    beats.forEach((b, i) => {
      const next = i + 1 < beats.length ? beats[i + 1] : t1;
      const end = Math.min(b + decay, next - 0.01, t1);
      if (b - 0.01 > keys[keys.length - 1].t) keys.push({ t: b - 0.01, v: 0 });
      keys.push({ t: b, v: peak });
      if (end > b) keys.push({ t: end, v: 0 });
    });
    return keys;
  }

  const api = {
    CHANNELS, PALETTE, clamp, channelsOf, footprint, newProject, demoProject, addProp, nextFreeChannel,
    trackId, lowerBound, insertKey, valueAt, trackValue, hexToRgb, dmxFrame, maxChannel, patchProblems,
    channelMap, frameCount, buildFseq, buildCsv, simplify, replaceRange, normalise, mouthFromEnvelope,
    detectBeats, pulseKeys,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LMU = api;
})(this);
