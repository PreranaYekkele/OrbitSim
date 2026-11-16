// Run with:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/physics.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

test('ISS period is about 92 minutes', () => {
  const a = P.R_EARTH + 420;
  close(P.period(a) / 60, 92.8, 0.5, 'period');
});

test('geostationary period equals one sidereal day', () => {
  close(P.period(42164.17), 86164.1, 5, 'GEO period');
});

test('circular-orbit speed from vis-viva (LEO ≈ 7.66 km/s)', () => {
  const r = P.R_EARTH + 420;
  close(P.visViva(r, r), 7.66, 0.02, 'v');
});

test('Kepler equation solver inverts M = E - e sinE', () => {
  for (const e of [0, 0.1, 0.5, 0.9, 0.97]) {
    for (let M = 0; M < 6.28; M += 0.37) {
      const E = P.solveKepler(M, e);
      close(E - e * Math.sin(E), M, 1e-9, `e=${e}`);
    }
  }
});

test('true <-> mean anomaly round trip', () => {
  for (const e of [0, 0.3, 0.74]) {
    for (let nu = 0.1; nu < 6.2; nu += 0.5) {
      close(P.meanToTrue(P.trueToMean(nu, e), e), nu, 1e-9, `nu e=${e}`);
    }
  }
});

test('elements -> state -> elements round trip (Molniya-like orbit)', () => {
  const el = { a: 26600, e: 0.74, i: 63.4 * P.DEG, raan: 40 * P.DEG, argp: 270 * P.DEG, nu: 30 * P.DEG };
  const { r, v } = P.elementsToState(el);
  const back = P.stateToElements(r, v);
  for (const k of ['a', 'e', 'i', 'raan', 'argp', 'nu']) close(back[k], el[k], k === 'a' ? 1e-6 : 1e-9, k);
});

test('angular momentum and energy are conserved by propagation', () => {
  const el = { a: 12000, e: 0.3, i: 0.5, raan: 1, argp: 2, nu: 0 };
  const s0 = P.elementsToState(el);
  const later = P.propagate(el, 3600 * 1.7);
  const s1 = P.elementsToState(later);
  const E = (s) => P.vec.norm(s.v) ** 2 / 2 - P.MU_EARTH / P.vec.norm(s.r);
  close(E(s1), E(s0), 1e-9, 'energy');
  close(P.vec.norm(P.vec.cross(s1.r, s1.v)), P.vec.norm(P.vec.cross(s0.r, s0.v)), 1e-6, 'h');
});

test('a full period brings the satellite back to the start', () => {
  const el = { a: 9000, e: 0.2, i: 0.3, raan: 0.2, argp: 0.1, nu: 1.0 };
  const back = P.propagate(el, P.period(el.a));
  close(back.nu, el.nu, 1e-8, 'nu after one period');
});

test('prograde burn at periapsis raises apoapsis only', () => {
  const r = P.R_EARTH + 300;
  const el = { a: r, e: 0, i: 0.4, raan: 0.3, argp: 0, nu: 0 };
  const after = P.applyBurn(el, { prograde: 0.1 });
  close(P.periapsis(after.a, after.e), r, 1e-3, 'periapsis unchanged');
  assert.ok(P.apoapsis(after.a, after.e) > r + 300, 'apoapsis raised');
  close(after.i, el.i, 1e-9, 'inclination unchanged');
});

test('normal burn changes inclination', () => {
  const el = { a: 7000, e: 0, i: 0.2, raan: 0, argp: 0, nu: 0 };
  const after = P.applyBurn(el, { normal: 0.5 });
  assert.ok(Math.abs(after.i - el.i) > 0.05, 'inclination changed');
});

test('Hohmann LEO -> GEO needs ≈ 3.9 km/s and ≈ 5.3 h', () => {
  const h = P.hohmann(P.R_EARTH + 300, 42164);
  close(h.total, 3.9, 0.05, 'total Δv');
  close(h.time / 3600, 5.27, 0.1, 'transfer time');
});

test('launch-site physics', () => {
  close(P.rotationalBoost(0), 0.4651, 0.001, 'equator boost');
  close(P.rotationalBoost(28.5), 0.4087, 0.002, 'Cape Canaveral boost');
  assert.equal(P.minInclination(-45.6), 45.6);
  close(P.launchAzimuth(28.5, 28.5), 90, 1e-9, 'due-east launch');
  assert.ok(Number.isNaN(P.launchAzimuth(45.6, 20)), 'unreachable inclination');
});

test('validation rejects orbits that hit the Earth', () => {
  assert.equal(P.validate({ a: 7000, e: 0 }), null);
  assert.match(P.validate({ a: 7000, e: 0.2 }), /atmosphere/);
  assert.match(P.validate({ a: 7000, e: 1.2 }), /elliptical/);
});
