// OrbitSim physics engine — pure functions, no rendering.
// Units: kilometres, seconds, radians (degrees only at the UI boundary).
// Frame: Earth-centred inertial (ECI). z points to the North Pole, x towards the vernal equinox.

export const MU_EARTH = 398600.4418;          // km^3/s^2, Earth's standard gravitational parameter
export const R_EARTH = 6371.0;                 // km, mean radius
export const OMEGA_EARTH = 7.2921159e-5;       // rad/s, sidereal rotation rate
export const DEG = Math.PI / 180;
const TWO_PI = 2 * Math.PI;

// ---------- small vector helpers ----------
export const vec = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => Math.hypot(a[0], a[1], a[2]),
  unit: (a) => { const n = Math.hypot(a[0], a[1], a[2]); return n ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0]; },
};

export const wrap2pi = (x) => ((x % TWO_PI) + TWO_PI) % TWO_PI;

// ---------- basic orbit properties ----------
/** Orbital period in seconds for semi-major axis a (km). */
export function period(a, mu = MU_EARTH) {
  return TWO_PI * Math.sqrt((a * a * a) / mu);
}

/** Vis-viva: speed (km/s) at radius r on an orbit with semi-major axis a. */
export function visViva(r, a, mu = MU_EARTH) {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

export const periapsis = (a, e) => a * (1 - e);
export const apoapsis = (a, e) => a * (1 + e);
/** Specific orbital energy (km^2/s^2). Negative means bound. */
export const specificEnergy = (a, mu = MU_EARTH) => -mu / (2 * a);

// ---------- anomalies ----------
/** Solve Kepler's equation M = E - e sin E for E (elliptic orbits) by Newton's method. */
export function solveKepler(M, e, tol = 1e-12) {
  M = wrap2pi(M);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 50; i++) {
    const f = E - e * Math.sin(E) - M;
    const dE = f / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

export function trueToEccentric(nu, e) {
  return 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
}
export function eccentricToTrue(E, e) {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}
export function trueToMean(nu, e) {
  const E = trueToEccentric(nu, e);
  return wrap2pi(E - e * Math.sin(E));
}
export function meanToTrue(M, e) {
  return wrap2pi(eccentricToTrue(solveKepler(M, e), e));
}

/** Advance an orbit's true anomaly by dt seconds (analytic two-body propagation). */
export function propagate(el, dt, mu = MU_EARTH) {
  const n = Math.sqrt(mu / el.a ** 3);
  const M = trueToMean(el.nu, el.e) + n * dt;
  return { ...el, nu: meanToTrue(M, el.e) };
}

// ---------- element <-> state vector conversions ----------
/**
 * Classical orbital elements -> ECI position (km) and velocity (km/s).
 * el = { a, e, i, raan, argp, nu } with angles in radians.
 */
export function elementsToState(el, mu = MU_EARTH) {
  const { a, e, i, raan, argp, nu } = el;
  const p = a * (1 - e * e);
  const r = p / (1 + e * Math.cos(nu));
  // perifocal frame
  const rPQW = [r * Math.cos(nu), r * Math.sin(nu), 0];
  const k = Math.sqrt(mu / p);
  const vPQW = [-k * Math.sin(nu), k * (e + Math.cos(nu)), 0];
  // rotation PQW -> ECI : R3(-raan) R1(-i) R3(-argp)
  const cO = Math.cos(raan), sO = Math.sin(raan);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const R = [
    [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * si],
    [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, -cO * si],
    [sw * si, cw * si, ci],
  ];
  const mul = (v) => [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
  return { r: mul(rPQW), v: mul(vPQW) };
}

/** ECI state vector -> classical orbital elements (handles circular / equatorial edge cases). */
export function stateToElements(rv, vv, mu = MU_EARTH) {
  const eps = 1e-10;
  const r = vec.norm(rv), v = vec.norm(vv);
  const h = vec.cross(rv, vv);
  const hn = vec.norm(h);
  const nvec = [-h[1], h[0], 0];                       // node vector = k × h
  const nn = vec.norm(nvec);
  const evec = vec.scale(vec.sub(vec.scale(rv, v * v - mu / r), vec.scale(vv, vec.dot(rv, vv))), 1 / mu);
  const e = vec.norm(evec);
  const energy = (v * v) / 2 - mu / r;
  const a = -mu / (2 * energy);
  const i = Math.acos(Math.min(1, Math.max(-1, h[2] / hn)));

  let raan = 0, argp = 0, nu = 0;
  if (nn > eps) {
    raan = Math.acos(Math.min(1, Math.max(-1, nvec[0] / nn)));
    if (nvec[1] < 0) raan = TWO_PI - raan;
  }
  if (e > eps) {
    if (nn > eps) {
      argp = Math.acos(Math.min(1, Math.max(-1, vec.dot(nvec, evec) / (nn * e))));
      if (evec[2] < 0) argp = TWO_PI - argp;
    } else {
      // equatorial: measure periapsis from x-axis
      argp = wrap2pi(Math.atan2(evec[1], evec[0]) * (h[2] >= 0 ? 1 : -1));
    }
    nu = Math.acos(Math.min(1, Math.max(-1, vec.dot(evec, rv) / (e * r))));
    if (vec.dot(rv, vv) < 0) nu = TWO_PI - nu;
  } else if (nn > eps) {
    // circular inclined: argument of latitude
    nu = Math.acos(Math.min(1, Math.max(-1, vec.dot(nvec, rv) / (nn * r))));
    if (rv[2] < 0) nu = TWO_PI - nu;
  } else {
    // circular equatorial: true longitude
    nu = wrap2pi(Math.atan2(rv[1], rv[0]));
  }
  return { a, e, i, raan, argp, nu };
}

// ---------- manoeuvres ----------
/**
 * Apply an impulsive burn in the local orbital frame.
 * dv = { prograde, normal, radial } in km/s. Returns new elements.
 */
export function applyBurn(el, dv, mu = MU_EARTH) {
  const { r, v } = elementsToState(el, mu);
  const T = vec.unit(v);                         // prograde
  const N = vec.unit(vec.cross(r, v));           // orbit normal
  const Rr = vec.cross(T, N);                    // radial-out (completes the frame)
  const dV = vec.add(vec.add(vec.scale(T, dv.prograde || 0), vec.scale(N, dv.normal || 0)), vec.scale(Rr, dv.radial || 0));
  return stateToElements(r, vec.add(v, dV), mu);
}

/** Hohmann transfer between circular orbits of radius r1 -> r2 (km). */
export function hohmann(r1, r2, mu = MU_EARTH) {
  const at = (r1 + r2) / 2;
  const v1 = Math.sqrt(mu / r1), v2 = Math.sqrt(mu / r2);
  const dv1 = visViva(r1, at, mu) - v1;
  const dv2 = v2 - visViva(r2, at, mu);
  return { transferA: at, dv1, dv2, total: Math.abs(dv1) + Math.abs(dv2), time: period(at, mu) / 2 };
}

// ---------- launch sites ----------
/** Eastward surface speed from Earth's rotation at latitude (degrees), km/s. */
export const rotationalBoost = (latDeg) => OMEGA_EARTH * R_EARTH * Math.cos(latDeg * DEG);
/** Lowest inclination reachable by a direct launch from latitude (degrees) → degrees. */
export const minInclination = (latDeg) => Math.abs(latDeg);
/** Launch azimuth (degrees from north) to reach inclination i from latitude, ignoring Earth rotation. */
export function launchAzimuth(latDeg, incDeg) {
  const c = Math.cos(incDeg * DEG) / Math.cos(latDeg * DEG);
  if (Math.abs(c) > 1) return NaN;               // not reachable directly
  return Math.asin(c) / DEG;
}

/** Validate elements for a bound orbit that does not hit the Earth. */
export function validate(el) {
  if (!(el.a > 0)) return 'Semi-major axis must be positive';
  if (el.e < 0 || el.e >= 1) return 'Only elliptical orbits (0 ≤ e < 1) are supported';
  if (periapsis(el.a, el.e) <= R_EARTH + 100) return 'Periapsis is inside the atmosphere — this orbit would decay or crash';
  return null;
}
