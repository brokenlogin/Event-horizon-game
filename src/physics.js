import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Orbital physics around a non-rotating black hole in a galactic nucleus.
//
// The hole itself uses the Paczyński–Wiita pseudo-Newtonian potential
//     Φ_bh(r) = -GM / (r - Rs)
// which reproduces the relativistic features close in: an innermost stable
// circular orbit, a marginally bound orbit and runaway infall at the horizon.
//
// The hole sits inside a dense nuclear star cluster / dark-matter cusp, modelled
// as a cored isothermal halo (the standard flat-rotation-curve potential)
//     Φ_halo(r) = ½·V0²·ln(r² + Rc²)
// Its pull falls off only as ~1/r, so gravity stays strong across the whole
// arena and there is no escape velocity — everything eventually falls back.
//
// Beyond ARENA_RADIUS the well gets a steep outer wall: an extra inward pull
// growing with the square of the overshoot, so anything that strays too far is
// hauled back toward the hole instead of drifting off.
// Integration is symplectic leapfrog (kick-drift-kick) so orbits don't drift.
// ---------------------------------------------------------------------------

export const RS = 150;                // event horizon radius (world units)
export const GM = 6000000;            // black hole gravitational parameter
export const HALO_V0 = 165;           // halo circular-velocity scale
export const HALO_RC = 700;           // halo core radius
const V02 = HALO_V0 * HALO_V0;
const RC2 = HALO_RC * HALO_RC;
export const ISCO = 3 * RS;           // innermost stable circular orbit (≈)
export const DISK_IN = ISCO;
export const DISK_OUT = 7 * RS;
export const ARENA_RADIUS = 3200;     // where the outer gravity wall begins
export const WALL_K = 6.5e-4;         // wall pull = WALL_K · overshoot²  (≈60 m/s² at +300 m)

/** Scalar k such that acceleration = k · position. Hot path: used inline by bolts/particles. */
export function gravK(x, y, z) {
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2) || 1e-6;
  const d = Math.max(r - RS, 0.75);
  let k = -GM / (d * d * r) - V02 / (r2 + RC2);
  if (r > ARENA_RADIUS) {
    const o = r - ARENA_RADIUS;
    k -= (WALL_K * o * o) / r;
  }
  return k;
}

/** Magnitude of gravitational acceleration at radius r. */
export function gravityAt(r) {
  const d = Math.max(r - RS, 0.75);
  let g = GM / (d * d) + (V02 * r) / (r * r + RC2);
  if (r > ARENA_RADIUS) g += WALL_K * (r - ARENA_RADIUS) ** 2;
  return g;
}

/** Closest distance from the black hole (origin) to the segment a→b — for line-of-sight checks. */
export function segmentClearance(a, b) {
  const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
  const l2 = sx * sx + sy * sy + sz * sz || 1e-6;
  let t = -(a.x * sx + a.y * sy + a.z * sz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = a.x + sx * t, y = a.y + sy * t, z = a.z + sz * t;
  return Math.sqrt(x * x + y * y + z * z);
}

/** True if the hole blocks the straight line between a and b. */
export function occludedByHole(a, b, margin = 1.6) {
  return segmentClearance(a, b) < RS * margin;
}

export function accelAt(p, out) {
  const k = gravK(p.x, p.y, p.z);
  return out.set(p.x * k, p.y * k, p.z * k);
}

const _a = new THREE.Vector3();

function leapfrog(pos, vel, extra, dt) {
  accelAt(pos, _a);
  if (extra) _a.add(extra);
  vel.addScaledVector(_a, dt * 0.5);
  pos.addScaledVector(vel, dt);
  accelAt(pos, _a);
  if (extra) _a.add(extra);
  vel.addScaledVector(_a, dt * 0.5);
}

/**
 * Advance a body by dt with optional constant extra acceleration (thrust).
 * Near the hole the free-fall timescale collapses, so the step is subdivided
 * to keep close passes accurate (no numerical slingshots). Bodies that cross
 * the horizon stop there — nothing comes back out.
 */
export function integrate(pos, vel, extra, dt) {
  let r = pos.length();
  if (r <= RS) return false;
  const d = r - RS;
  const tau = Math.sqrt((d * d * d) / GM);
  const n = Math.min(64, Math.max(1, Math.ceil(dt / (0.04 * tau))));
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    leapfrog(pos, vel, extra, h);
    r = pos.length();
    if (r <= RS) return false;
  }
  return true;
}

/** Speed of a circular orbit at radius r in this potential. */
export function circularSpeed(r) {
  return Math.sqrt(r * gravityAt(r));
}

/**
 * Cheap periapsis estimate for the AI: a Keplerian estimate using the local
 * effective mass (g·r²) at the body's current radius.
 */
export function periapsisEstimate(pos, vel) {
  const r = pos.length();
  const mu = gravityAt(r) * r * r;
  const hx = pos.y * vel.z - pos.z * vel.y;
  const hy = pos.z * vel.x - pos.x * vel.z;
  const hz = pos.x * vel.y - pos.y * vel.x;
  const h2 = hx * hx + hy * hy + hz * hz;
  const E = 0.5 * vel.lengthSq() - mu / r;
  const e = Math.sqrt(Math.max(0, 1 + (2 * E * h2) / (mu * mu)));
  return h2 / (mu * (1 + e));
}

/** Build a circular orbit state at radius r, in the plane with normal n. */
export function circularOrbitState(r, normal, phase, outPos, outVel, speedScale = 1) {
  const n = normal.clone().normalize();
  const ref = Math.abs(n.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const u = new THREE.Vector3().crossVectors(ref, n).normalize();
  const w = new THREE.Vector3().crossVectors(n, u).normalize();
  outPos.copy(u).multiplyScalar(Math.cos(phase) * r).addScaledVector(w, Math.sin(phase) * r);
  const tangent = new THREE.Vector3().crossVectors(n, outPos).normalize();
  outVel.copy(tangent).multiplyScalar(circularSpeed(r) * speedScale);
}

// ---------------------------------------------------------------------------
// Trajectory prediction
// ---------------------------------------------------------------------------
const _pp = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _pd = new THREE.Vector3();
const _pd2 = new THREE.Vector3();

export function createPrediction(maxPts) {
  return {
    positions: new Float32Array(maxPts * 3),
    radii: new Float32Array(maxPts),
    maxPts,
    count: 0,
    minR: 0, maxR: 0, minIdx: 0, maxIdx: 0,
    impact: false, escape: false, closed: false,
    impactTime: 0, period: 0,
  };
}

/**
 * Integrates the ballistic path forward (no thrust) for up to one revolution.
 * Step size adapts to the local orbital timescale so close passes stay accurate.
 */
export function predictTrajectory(pos0, vel0, pred) {
  const p = _pp.copy(pos0);
  const v = _pv.copy(vel0);
  const P = pred.positions;
  let n = 0;
  let swept = 0;
  let time = 0;
  const prevDir = _pd.copy(p).normalize();
  let r = p.length();
  pred.minR = r; pred.maxR = r; pred.minIdx = 0; pred.maxIdx = 0;
  pred.impact = false; pred.escape = false; pred.closed = false;

  P[0] = p.x; P[1] = p.y; P[2] = p.z; pred.radii[0] = r; n = 1;

  for (let i = 1; i < pred.maxPts; i++) {
    const T = (2 * Math.PI * r) / circularSpeed(r);
    const dt = Math.min(Math.max(T / 240, 0.004), 0.6);
    // two half steps for accuracy on close passes
    integrate(p, v, null, dt * 0.5);
    integrate(p, v, null, dt * 0.5);
    time += dt;
    r = p.length();
    P[n * 3] = p.x; P[n * 3 + 1] = p.y; P[n * 3 + 2] = p.z;
    pred.radii[n] = r;
    if (r < pred.minR) { pred.minR = r; pred.minIdx = n; }
    if (r > pred.maxR) { pred.maxR = r; pred.maxIdx = n; }
    n++;
    if (r <= RS * 1.01) { pred.impact = true; pred.impactTime = time; break; }
    if (r > ARENA_RADIUS * 2.2) { pred.escape = true; break; }
    const d = _pd2.copy(p).divideScalar(r);
    swept += Math.acos(Math.min(1, Math.max(-1, d.dot(prevDir))));
    prevDir.copy(d);
    if (swept >= Math.PI * 2) { pred.closed = true; pred.period = time; break; }
  }
  pred.count = n;
  return pred;
}
