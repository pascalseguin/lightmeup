// Unit tests for app/core.js. Run with: node --test tests/core.test.js
const test = require('node:test');
const assert = require('node:assert');
const L = require('../app/core.js');

function demo() {
  const P = L.demoProject();
  P.duration = 2;
  P.audioName = 'song.mp3';
  return P;
}

test('demo project assigns non-overlapping channels', () => {
  const P = demo();
  assert.deepStrictEqual(P.props.map(p => [p.start, L.footprint(p)]), [[1, 3], [4, 3], [7, 3], [10, 3], [13, 1]]);
  assert.deepStrictEqual(L.patchProblems(P), []);
});

test('dmxFrame interpolates keyframes and applies RGB colour', () => {
  const P = demo();
  const [bones] = P.props;
  P.tracks[L.trackId(bones, 'mouth')] = [{ t: 0, v: 0 }, { t: 1, v: 200 }];
  P.tracks[L.trackId(P.props[2], 'dim')] = [{ t: 0, v: 255 }];
  const f = L.dmxFrame(P, 0.5);
  assert.strictEqual(f[1], 100);   // mouth halfway
  assert.strictEqual(f[2], 128);   // body default centre
  assert.deepStrictEqual([f[6], f[7], f[8]], L.hexToRgb(P.props[2].color));
});

test('buildFseq writes a valid v1 header and frame data', () => {
  const P = demo();
  P.tracks[L.trackId(P.props[0], 'mouth')] = [{ t: 0, v: 0 }, { t: 1, v: 200 }];
  const fs = L.buildFseq(P);
  const dv = new DataView(fs.buffer);
  const off = dv.getUint16(4, true), ch = dv.getUint32(10, true), frames = dv.getUint32(14, true);
  assert.strictEqual(String.fromCharCode(...fs.slice(0, 4)), 'PSEQ');
  assert.strictEqual(dv.getUint8(7), 1);
  assert.strictEqual(dv.getUint16(18, true), 25);
  assert.strictEqual(frames, 80);
  assert.strictEqual(fs.length, off + ch * frames);
  assert.strictEqual(String.fromCharCode(fs[30], fs[31]), 'mf');
  assert.strictEqual(fs[off + 20 * ch + 1], 100);
});

test('buildCsv has one row per frame', () => {
  const lines = L.buildCsv(demo()).trim().split('\n');
  assert.strictEqual(lines.length, 81);
  assert.strictEqual(lines[0].split(',').length, 14);
});

test('simplify stays within tolerance', () => {
  const pts = Array.from({ length: 400 }, (_, i) => ({ t: i / 40, v: Math.round(128 + 100 * Math.sin(i / 10)) }));
  const s = L.simplify(pts, 3);
  assert.ok(s.length < pts.length / 2);
  for (const p of pts) assert.ok(Math.abs(L.valueAt(s, p.t, 0) - p.v) <= 3.01);
});

test('replaceRange swaps only keys inside the range', () => {
  const k = [{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 2, v: 3 }, { t: 3, v: 4 }];
  L.replaceRange(k, 0.5, 2.5, [{ t: 1.5, v: 9 }]);
  assert.deepStrictEqual(k.map(x => x.t), [0, 1.5, 3]);
});

test('beat detection and pulses follow a click track', () => {
  const env = new Float32Array(400).map((_, i) => (i % 20 === 0 ? 1 : 0.05));
  const beats = L.detectBeats(env, 40, { threshold: 1.5, minGap: 0.18 });
  assert.strictEqual(beats.length, 20);
  const pk = L.pulseKeys(beats, 0.3, 255, 0, 10);
  assert.strictEqual(Math.round(L.valueAt(pk, 0.5, 0)), 255);
  assert.ok(L.valueAt(pk, 0.65, 0) < 200);
});

test('mouth opens on loud frames and closes after', () => {
  const env = new Float32Array(400).map((_, i) => (i % 20 === 0 ? 1 : 0.05));
  const m = L.mouthFromEnvelope(env, 40, { sensitivity: 1.2, gate: 0.25, maxOpen: 255, release: 0.08 });
  assert.strictEqual(m[0].v, 255);
  assert.ok(m[10].v < 20);
});

test('overlapping props are reported', () => {
  const P = demo();
  P.props[1].start = 2;
  assert.strictEqual(L.patchProblems(P).length, 1);
});
