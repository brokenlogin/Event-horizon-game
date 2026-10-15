import * as THREE from 'three';
import { integrate } from './physics.js';
import { buildPlayerShip } from './ships.js';
import { Trail } from './fx.js';

// ---------------------------------------------------------------------------
// The other pilot. Between network snapshots their ship is dead-reckoned with
// the same orbital physics and their last reported thrust, so it keeps moving
// correctly even at 20 updates/s with internet latency. Each new snapshot is
// extrapolated to "now" and the simulation snaps to it; the visible ship
// glides there by decaying an error offset over ~0.2 s, so it never jumps.
// ---------------------------------------------------------------------------

const ACCENT = 0xffad4a;
const EXTRAP_STEP = 1 / 60;
const MAX_EXTRAP = 0.6;           // s — don't extrapolate stale packets further than this
const SNAP_DISTANCE = 250;        // m — bigger corrections are teleports (respawn), not smoothed
const ERROR_DECAY = 0.2;          // s time constant for visual correction

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export class RemotePlayer {
  constructor(scene) {
    this.scene = scene;
    this.parts = buildPlayerShip({ accentColor: ACCENT, flameColor: 0xff8a30 });
    this.parts.group.visible = false;
    scene.add(this.parts.group);
    this.trails = [0, 1].map(() => new Trail(scene, { segments: 50, width: 0.11, color: ACCENT, interval: 0.02, fadeNear: 30 }));
    for (const t of this.trails) t.mesh.visible = false;
    this.name = 'PILOT 2';
    this.reset();
  }

  reset() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.thrust = new THREE.Vector3();
    this.targetQuat = new THREE.Quaternion();
    this.quat = new THREE.Quaternion();
    this.err = new THREE.Vector3();
    this.renderPos = new THREE.Vector3();
    this.lastT = -Infinity;
    this.hasState = false;
    this.alive = false;
    this.docked = false;
    this.clamp = 0;
    this.throttle = 0;
    this.hull = 100;
    this.shield = 100;
    this.lastCorrection = 0;     // size of the latest correction (m), for diagnostics
    this.setVisible(false);
  }

  setVisible(v) {
    this.parts.group.visible = v;
    for (const t of this.trails) t.mesh.visible = v;
  }

  get present() { return this.hasState; }

  /** `now` is the shared world clock; maxExtrap grows with time warp (world time runs faster). */
  applySnapshot(s, now, maxExtrap = MAX_EXTRAP) {
    if (s.t <= this.lastT) return;            // out of order / duplicate
    this.lastT = s.t;
    _p.fromArray(s.p); _v.fromArray(s.v);
    this.thrust.fromArray(s.a);
    this.targetQuat.fromArray(s.q);
    this.throttle = s.th;
    this.hull = s.hu; this.shield = s.sh;
    const wasAlive = this.alive;
    this.alive = !!s.al;
    this.docked = !!s.dk;
    this.clamp = s.dc || 0;

    // bring the snapshot forward to the present with the real physics
    let dt = Math.min(Math.max(now - s.t, 0), maxExtrap);
    while (dt > 1e-6) {
      const h = Math.min(EXTRAP_STEP, dt);
      if (!this.docked) integrate(_p, _v, this.thrust, h);
      else _p.addScaledVector(_v, h);
      dt -= h;
    }

    if (!this.hasState || !wasAlive) {
      this.err.set(0, 0, 0);
      this.quat.copy(this.targetQuat);
      this.hasState = true;
    } else if (!this.docked) {
      // keep the drawn ship where it is, and let the offset decay
      // (a docked ship is placed exactly at its clamp instead, see update())
      this.err.add(this.pos).sub(_p);
      this.lastCorrection = this.err.length();
      if (this.lastCorrection > SNAP_DISTANCE) this.err.set(0, 0, 0);
    }
    this.pos.copy(_p);
    this.vel.copy(_v);
    if (this.trails[0].points.length === 0 || !wasAlive) for (const t of this.trails) t.reset(this.pos);
  }

  physics(h) {
    if (!this.hasState || !this.alive || this.docked) return;
    integrate(this.pos, this.vel, this.thrust, h);
  }

  update(dt, camPos, time, station) {
    if (!this.hasState) return;
    const show = this.alive;
    this.setVisible(show);
    if (!show) return;

    if (this.docked && station) {
      // sits in the station's docking port
      station.toWorld(station.clampLocal(this.clamp), this.pos);
      this.vel.copy(station.vel);
      this.targetQuat.copy(station.quat).multiply(_flip);
    }

    this.err.multiplyScalar(Math.exp(-dt / ERROR_DECAY));
    this.renderPos.copy(this.pos).add(this.err);
    this.quat.slerp(this.targetQuat, 1 - Math.exp(-dt * 12));

    const g = this.parts.group;
    g.position.copy(this.renderPos);
    g.quaternion.copy(this.quat);
    for (const f of this.parts.flames) {
      const l = 0.5 + this.throttle * 4.2 + Math.random() * 0.4 * (0.3 + this.throttle);
      f.flame.scale.set(f.flame.userData.radius, f.flame.userData.radius, l);
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uIntensity.value = 0.45 + this.throttle * 1.3;
      f.glow.material.opacity = 0.35 + this.throttle * 0.65;
      f.glow.scale.setScalar(1.3 + this.throttle * 1.4);
    }
    const blink = (time % 1.3) < 0.1;
    for (const n of this.parts.navLights) n.visible = blink;
    for (let i = 0; i < 2; i++) {
      _v.copy(this.parts.engines[i]).applyQuaternion(this.quat).add(this.renderPos);
      this.trails[i].update(dt, _v, camPos, 0.15 + this.throttle * 0.7);
    }
  }

  /** Remote pilot left: hide everything and forget their state. */
  remove() {
    this.reset();
    for (const t of this.trails) t.points.length = 0;
  }

  /** Free the ship and trails for good. */
  dispose() {
    this.scene.remove(this.parts.group);
    for (const t of this.trails) t.dispose();
  }
}
