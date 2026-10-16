import * as THREE from 'three';
import { integrate, accelAt } from './physics.js';

// ---------------------------------------------------------------------------
// Docking assist (B). A small model-predictive autopilot. Twice a second it
// simulates candidate plans under the real gravity model, against the target's
// future position, and flies the one that reaches the capture zone (for the
// station: inside 250 m, under 25 m/s relative) soonest without coming near the
// hole:
//
//  - a burn (prograde, retrograde, radial, normal and blends; 0.5–18 s) then a
//    ballistic coast;
//  - a powered pursuit: fly at the target along a braking curve, with the
//    gravity difference fed forward, straight away or after a short detour burn
//    that swings round the hole. There's no fuel, so this is usually fastest.
//
// A hole guard overrides everything: sinking faster than it could stop before
// the safe floor, it climbs first. It only commands the ship's main engine: it
// turns the ship to the burn direction and throttles by how well the nose is
// aligned.
// ---------------------------------------------------------------------------

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, 0.7, 0], [-0.7, -0.7, 0], [0, 0, 1], [0, 0, -1]];
const DURS = [0.5, 1.5, 3, 5, 8, 12, 18];   // long burns too: there's no fuel, only flight time
// detour burns before a powered pursuit (prograde/retrograde/radial out and blends), to get round the hole
const DETOURS = [[1, 0], [-1, 0], [0, 1], [0.7, 0.7], [-0.7, 0.7]];
const DETOUR_DURS = [3, 6, 10];
const HORIZON = 110;
const SIM_DT = 0.25;
const TERMINAL_RANGE = 900;
const MIN_SAFE_R = 620;   // tidal stress starts at 510 m: stay well clear
export const CAPTURE_R = 250;   // the station docks you inside 300 m…
export const CAPTURE_V = 25;    // …under 40 m/s relative; aim a little inside both
const PURSUIT_MAX = 260;  // m/s cap on a powered pursuit's closing speed
const TIME_W = 5;        // cost per second until the approach
const BURN_W = 1;        // cost per second of engine time (small: speed matters more than fuel here)

const _rh = new THREE.Vector3();
const _th = new THREE.Vector3();
const _nh = new THREE.Vector3();
const _tp = new THREE.Vector3();
const _tv = new THREE.Vector3();
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _thr = new THREE.Vector3();
const _d = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _g = new THREE.Vector3();
const _sa = new THREE.Vector3();
const _sp2 = new THREE.Vector3();
const _sv2 = new THREE.Vector3();
const _pa = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _pd = new THREE.Vector3();

/**
 * Chase target for a body that moves under its own power (the dreadnought).
 * Every frame it re-predicts where the body will coast over the planner's
 * horizon, so the assist always aims at its latest course. Same interface the
 * assist uses for the station: pos, vel, stateAt(dt, pos, vel), accel(out).
 */
export class BodyTarget {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.body = null;
    this.n = Math.ceil(HORIZON / SIM_DT) + 2;
    this.P = new Float32Array(this.n * 3);
    this.V = new Float32Array(this.n * 3);
  }

  follow(body) { this.body = body; this.update(); }

  update() {
    if (!this.body) return;
    this.pos.copy(this.body.pos);
    this.vel.copy(this.body.vel);
    _tp.copy(this.pos); _tv.copy(this.vel);
    for (let i = 0; i < this.n; i++) {
      if (i) integrate(_tp, _tv, null, SIM_DT);
      _tp.toArray(this.P, i * 3);
      _tv.toArray(this.V, i * 3);
    }
  }

  stateAt(dt, pos, vel) {
    const f = THREE.MathUtils.clamp(dt / SIM_DT, 0, this.n - 1.001);
    const i = Math.floor(f), w = f - i;
    pos.fromArray(this.P, i * 3).lerp(_rh.fromArray(this.P, i * 3 + 3), w);
    vel.fromArray(this.V, i * 3).lerp(_rh.fromArray(this.V, i * 3 + 3), w);
  }

  accel(out) { return accelAt(this.pos, out); }
}

export class DockAssist {
  constructor(station, maxAccel) {
    this.station = station;           // the current target (the station, or a BodyTarget)
    this.stopAt = 120;                // m short of the target where the terminal approach settles
    // the zone the transfer aims for and the speed the approach arrives at (the station's
    // capture zone for docking; the "in range" zone for the dreadnought intercept)
    this.captureR = CAPTURE_R;
    this.captureV = CAPTURE_V;
    this.maxAccel = maxAccel;
    this.active = false;
    this.mode = 'transfer';
    this.replan = 0;
    this.burnLeft = 0;
    this.planDir = new THREE.Vector3();
    this.eta = 0;
    this.out = { dir: new THREE.Vector3(), mag: 0, has: false };
  }

  engage() {
    this.active = true;
    this.replan = 0;
    this.burnLeft = 0;
    this.pursuing = false;
    this.detourLeft = 0;
    this.mode = 'transfer';
  }

  disengage() {
    this.active = false;
    this.out.has = false;
  }

  /**
   * Powered pursuit: close on the target along a braking curve (half the engine's
   * braking held in reserve) that arrives at the capture zone at a gentle speed,
   * with the gravity difference fed forward. Writes the thrust into `out` and
   * returns the closing speed it's aiming for.
   */
  _pursuit(pos, vel, tPos, tVel, tAcc, out) {
    out.subVectors(tPos, pos);
    const dist = out.length();
    const brake = 0.5 * this.maxAccel;
    // (inside the stop distance: hold, don't keep closing)
    const close = dist <= this.stopAt ? 0 : Math.min(PURSUIT_MAX, Math.sqrt(this.captureV * this.captureV + 2 * brake * (dist - this.stopAt)));
    out.divideScalar(Math.max(dist, 1e-3)).multiplyScalar(close);
    _pv.subVectors(vel, tVel);
    accelAt(pos, _g);
    out.sub(_pv).multiplyScalar(0.8).add(tAcc).sub(_g).clampLength(0, this.maxAccel);
    return close;
  }

  /** Has the (simulated) ship reached the zone where the approach is done? */
  _arrived(dist, rel) { return dist < this.captureR && rel < this.captureV; }

  _plan(pos, vel) {
    const st = this.station;
    _rh.copy(pos).normalize();
    _th.copy(vel).addScaledVector(_rh, -vel.dot(_rh)).normalize();
    _nh.crossVectors(_rh, _th);
    let bestJ = Infinity, bestDur = 0, bestEta = 0;
    const bestDir = this.planDir;
    const tryCand = (d, dur) => {
      if (dur > 0) _thr.set(0, 0, 0).addScaledVector(_th, d[0]).addScaledVector(_rh, d[1]).addScaledVector(_nh, d[2]).normalize().multiplyScalar(this.maxAccel);
      _tp.copy(pos); _tv.copy(vel);
      let J = Infinity, eta = 0, pen = 0;
      for (let t = 0; t < HORIZON; t += SIM_DT) {
        if (!integrate(_tp, _tv, t < dur ? _thr : null, SIM_DT)) { pen = 1e6; break; }
        const r = _tp.length();
        if (r < MIN_SAFE_R) pen += (MIN_SAFE_R - r) * 20;
        st.stateAt(t + SIM_DT, _sp, _sv);
        // aim for the capture zone (inside CAPTURE_R, under CAPTURE_V), not a dead stop at the centre
        const j = Math.max(0, _tp.distanceTo(_sp) - this.captureR) + 4 * Math.max(0, _tv.distanceTo(_sv) - this.captureV) + TIME_W * t;
        if (j < J) { J = j; eta = t; }
      }
      J += pen + dur * BURN_W;
      if (J < bestJ) {
        bestJ = J; bestDur = dur; bestEta = eta;
        if (dur > 0) bestDir.copy(_thr).normalize();
      }
    };
    tryCand(null, 0);
    for (const d of DIRS) for (const dur of DURS) tryCand(d, dur);

    // …and flying at it under power (straight away, or after a short detour burn that swings
    // round the hole), if that gets there sooner without diving at the hole
    let bestP = Infinity, bestPEta = 0, bestPDur = 0;
    const pdir = _pd;
    const tryPursuit = (d, dur) => {
      if (dur > 0) _thr.set(0, 0, 0).addScaledVector(_th, d[0]).addScaledVector(_rh, d[1]).normalize().multiplyScalar(this.maxAccel);
      _tp.copy(pos); _tv.copy(vel);
      let pen = 0, arrive = -1;
      for (let t = 0; t < HORIZON; t += SIM_DT) {
        if (t < dur) {
          if (!integrate(_tp, _tv, _thr, SIM_DT)) { pen = 1e6; break; }
        } else {
          st.stateAt(t, _sp, _sv);
          st.stateAt(t + SIM_DT, _sp2, _sv2);
          _sa.subVectors(_sv2, _sv).divideScalar(SIM_DT);
          this._pursuit(_tp, _tv, _sp, _sv, _sa, _pa);
          if (!integrate(_tp, _tv, _pa, SIM_DT)) { pen = 1e6; break; }
        }
        const r = _tp.length();
        if (r < MIN_SAFE_R) pen += (MIN_SAFE_R - r) * 20;
        st.stateAt(t + SIM_DT, _sp2, _sv2);
        if (this._arrived(_tp.distanceTo(_sp2), _tv.distanceTo(_sv2))) { arrive = t + SIM_DT; break; }
      }
      if (arrive < 0) return;
      const J = TIME_W * arrive + pen;
      if (J < bestP) { bestP = J; bestPEta = arrive; bestPDur = dur; if (dur > 0) pdir.copy(_thr).normalize(); }
    };
    tryPursuit(null, 0);
    for (const d of DETOURS) for (const dur of DETOUR_DURS) tryPursuit(d, dur);

    this.pursuing = bestP < bestJ;
    this.detourLeft = this.pursuing ? bestPDur : 0;
    this.burnLeft = this.pursuing ? 0 : bestDur;
    this.eta = this.pursuing ? bestPEta : bestEta;
  }

  /** Returns the desired thrust {dir, mag, has} for this frame. */
  update(dt, player) {
    const out = this.out;
    out.has = false;
    if (!this.active) return out;
    const st = this.station;
    _d.subVectors(st.pos, player.pos);
    const dist = _d.length();
    _rel.subVectors(player.vel, st.vel);

    // hole guard: sinking faster than we could stop before the safe floor (or already under
    // it)? Climb, outward and prograde, before anything else.
    _rh.copy(player.pos).normalize();
    const r = player.pos.length();
    const vr = player.vel.dot(_rh);
    const floor = MIN_SAFE_R;
    const need = vr < 0 ? (vr * vr) / (2 * Math.max(r - floor, 1)) : 0;
    if (r < floor || need > 0.25 * this.maxAccel) {
      _th.copy(player.vel).addScaledVector(_rh, -vr);
      if (_th.lengthSq() < 1e-6) _th.crossVectors(_rh, _nh.set(0, 1, 0));
      out.dir.copy(_rh).addScaledVector(_th.normalize(), 0.8).normalize();
      out.mag = this.maxAccel;
      out.has = true;
      this.mode = 'transfer';
      this.replan = 0;   // re-plan as soon as we're clear
      return out;
    }

    this.mode = this.pursuing && dist < TERMINAL_RANGE ? 'terminal' : 'transfer';
    this.replan -= dt;
    if (this.replan <= 0) {
      this._plan(player.pos, player.vel);
      this.replan = 0.5;
    }
    this.eta = Math.max(0, this.eta - dt);
    if (this.pursuing && this.detourLeft > 0) {
      this.detourLeft -= dt;
      out.dir.copy(_pd);
      out.mag = this.maxAccel;
      out.has = true;
    } else if (this.pursuing) {
      st.accel(_sa);
      this._pursuit(player.pos, player.vel, st.pos, st.vel, _sa, _d);
      const m = _d.length();
      if (m > 0.3) { out.dir.copy(_d).divideScalar(m); out.mag = m; out.has = true; }
    } else if (this.burnLeft > 0) {
      this.burnLeft -= dt;
      out.dir.copy(this.planDir);
      out.mag = this.maxAccel;
      out.has = true;
    }
    return out;
  }
}
