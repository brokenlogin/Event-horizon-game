import * as THREE from 'three';
import { integrate, accelAt } from './physics.js';

// ---------------------------------------------------------------------------
// Docking assist (B). A small model-predictive autopilot:
//
//  TRANSFER — twice a second it simulates a set of candidate burns (prograde,
//  retrograde, radial in/out, normal and blends, for a few durations), each
//  followed by a ballistic coast under the real gravity model, against the
//  station's future position. It picks the plan whose predicted approach is
//  closest/slowest/soonest without diving toward the hole, and flies its first
//  half-second. Because it re-plans continuously, small errors wash out.
//
//  TERMINAL — once within ~900 m, a braking-curve pursuit takes over, with the
//  gravity difference between ship and station fed forward.
//
// It only commands the ship's main engine: it turns the ship to the burn
// direction and throttles by how well the nose is aligned.
// ---------------------------------------------------------------------------

const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, 0.7, 0], [-0.7, -0.7, 0], [0, 0, 1], [0, 0, -1]];
const DURS = [0.5, 1.5, 3, 5];
const HORIZON = 110;
const SIM_DT = 0.25;
const TERMINAL_RANGE = 900;
const MIN_SAFE_R = 450;

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

export class DockAssist {
  constructor(station, maxAccel) {
    this.station = station;
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
    this.mode = 'transfer';
  }

  disengage() {
    this.active = false;
    this.out.has = false;
  }

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
        if (r < MIN_SAFE_R) pen += (MIN_SAFE_R - r) * 2;
        st.stateAt(t + SIM_DT, _sp, _sv);
        const j = _tp.distanceTo(_sp) + 4 * _tv.distanceTo(_sv) + 3 * t;
        if (j < J) { J = j; eta = t; }
      }
      J += pen + dur * 4;
      if (J < bestJ) {
        bestJ = J; bestDur = dur; bestEta = eta;
        if (dur > 0) bestDir.copy(_thr).normalize();
      }
    };
    tryCand(null, 0);
    for (const d of DIRS) for (const dur of DURS) tryCand(d, dur);
    this.burnLeft = bestDur;
    this.eta = bestEta;
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

    if (dist < TERMINAL_RANGE) {
      this.mode = 'terminal';
      const close = Math.min(120, Math.sqrt(2 * 5 * Math.max(dist - 120, 0)));
      _d.divideScalar(Math.max(dist, 1e-3)).multiplyScalar(close);
      accelAt(player.pos, _g);
      st.accel(_sa);
      _d.sub(_rel).multiplyScalar(0.8).add(_sa).sub(_g);
      const m = _d.length();
      if (m > 0.3) { out.dir.copy(_d).divideScalar(m); out.mag = Math.min(m, this.maxAccel); out.has = true; }
      this.eta = dist / Math.max(close, 20);
      return out;
    }

    this.mode = 'transfer';
    this.replan -= dt;
    if (this.replan <= 0) {
      this._plan(player.pos, player.vel);
      this.replan = 0.5;
    }
    this.eta = Math.max(0, this.eta - dt);
    if (this.burnLeft > 0) {
      this.burnLeft -= dt;
      out.dir.copy(this.planDir);
      out.mag = this.maxAccel;
      out.has = true;
    }
    return out;
  }
}
