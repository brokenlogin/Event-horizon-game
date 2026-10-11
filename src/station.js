import * as THREE from 'three';
import { gravityAt } from './physics.js';
import { buildStation } from './ships.js';

// ---------------------------------------------------------------------------
// Orbital outpost. It holds a high, deliberately slow circular orbit: slower
// than a free orbit at that altitude, so its station-keeping thrusters burn
// continuously outward (you can see them firing toward the hole) to make up
// the difference in centripetal force. Docking is automatic when you're close
// and your speed relative to it is low.
// ---------------------------------------------------------------------------

export const STATION_NAME = 'KEPLER STATION';
export const DOCK_RANGE = 300;         // m from the station's centre
export const STATION_SPEED = 100;      // m/s — a free orbit up there would be ~167 m/s
export const DOCK_MAX_REL_SPEED = 40;  // m/s relative to the station
const DOCK_ANIM_BASE = 1.4;            // s, plus travel time from the capture point

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _flip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

export class Station {
  constructor(scene) {
    this.scene = scene;
    this.built = buildStation();
    this.group = this.built.group;
    this.group.visible = false;
    scene.add(this.group);
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.u = new THREE.Vector3();
    this.w = new THREE.Vector3();
    this.radius = 2500;
    this.speed = STATION_SPEED;
    this.omega = STATION_SPEED / 2500;
    this.phase = 0;
    this.keepThrust = 0;

    // faint green orbit track (a circle)
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(257 * 3), 3));
    this.orbitLine = new THREE.Line(g, new THREE.LineBasicMaterial({
      color: new THREE.Color(0.2, 0.9, 0.45), transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.orbitLine.frustumCulled = false;
    this.orbitLine.visible = false;
    scene.add(this.orbitLine);

    // docking state for the player
    this.dockAnim = 0;
    this.dockClamp = 0;
    this.occupied = [false, false];   // which clamps hold a ship (for the status lights)
    this.captureLocal = new THREE.Vector3();
    this.captureQuat = new THREE.Quaternion();
  }

  reset(radius, normal, phase, speed = STATION_SPEED) {
    this.normal.copy(normal).normalize();
    const ref = Math.abs(this.normal.y) < 0.95 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.u.crossVectors(ref, this.normal).normalize();
    this.w.crossVectors(this.normal, this.u).normalize();
    this.radius = radius;
    this.speed = speed;
    this.omega = speed / radius;
    this.phase = phase;
    this.stateAt(0, this.pos, this.vel);
    // thrust needed to hold this slower-than-orbital speed
    this.keepThrust = gravityAt(radius) - (speed * speed) / radius;
    this._orient(1);
    const attr = this.orbitLine.geometry.attributes.position;
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      _v.copy(this.u).multiplyScalar(Math.cos(a) * radius).addScaledVector(this.w, Math.sin(a) * radius);
      attr.array[i * 3] = _v.x; attr.array[i * 3 + 1] = _v.y; attr.array[i * 3 + 2] = _v.z;
    }
    attr.needsUpdate = true;
    this.setVisible(true);
  }

  /** Position/velocity dt seconds from now (the orbit is exactly circular, so this is analytic). */
  stateAt(dt, pos, vel) {
    const a = this.phase + this.omega * dt;
    pos.copy(this.u).multiplyScalar(Math.cos(a) * this.radius).addScaledVector(this.w, Math.sin(a) * this.radius);
    if (vel) vel.crossVectors(this.normal, pos).normalize().multiplyScalar(this.speed);
    return pos;
  }

  /** The station's acceleration (centripetal, toward the hole). */
  accel(out) {
    return out.copy(this.pos).multiplyScalar(-this.omega * this.omega);
  }

  setVisible(v) {
    this.group.visible = v;
    this.orbitLine.visible = v;
  }

  physics(h) {
    this.phase += this.omega * h;
    this.stateAt(0, this.pos, this.vel);
  }

  /** Attitude: spine along the velocity (port leading), up = orbit normal. */
  _orient(k) {
    _m.lookAt(this.pos, _v.copy(this.pos).add(this.vel), this.normal);
    _q.setFromRotationMatrix(_m);
    this.quat.slerp(_q, k);
  }

  update(dt, time) {
    this._orient(1 - Math.exp(-dt * 2));
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    this.built.ring.rotation.z += dt * 0.12;
    for (const b of this.built.beacons) {
      b.visible = b.userData.strobe ? (time % 1.6) < 0.08 : (time % 1.2) < 0.6;
    }
    // clamp status lights: green when free, amber when holding a ship
    this.built.clamps.forEach((c, i) => c.light.material.color.setRGB(...(this.occupied[i] ? [3, 1.6, 0.3] : [0.4, 3, 1.2])));
    // chasing approach lights toward the port
    // station-keeping burn: exhaust on the hole-facing side
    this.toLocal(_v.set(0, 0, 0), _n);            // local position of the hole
    _n.normalize();
    for (const k of this.built.keepers) {
      const on = k.dir.dot(_n) > 0.3;
      k.flame.visible = k.glow.visible = on;
      if (on) {
        const flick = 0.85 + Math.random() * 0.3;
        k.flame.scale.set(1.1, 1.1, (6 + this.keepThrust * 0.6) * flick);
        k.mat.uniforms.uTime.value = time;
        k.mat.uniforms.uIntensity.value = 1.2;
        k.glow.scale.setScalar(6);
      }
    }
    for (const s of this.built.guides) {
      const phase = (time * 1.4 - s.userData.i * 0.12) % 1;
      s.material.opacity = 0.15 + 0.85 * Math.pow(1 - Math.abs(phase - 0.5) * 2, 4);
    }
  }

  /** World transform of a point given in station-local coordinates. */
  toWorld(local, out) {
    return out.copy(local).applyQuaternion(this.quat).add(this.pos);
  }

  toLocal(world, out) {
    _qInv.copy(this.quat).invert();
    return out.copy(world).sub(this.pos).applyQuaternion(_qInv);
  }

  canDock(player) {
    return player.pos.distanceTo(this.pos) < DOCK_RANGE &&
      _v.subVectors(player.vel, this.vel).length() < DOCK_MAX_REL_SPEED;
  }

  /** Docked-ship position for clamp i, in station-local coordinates. */
  clampLocal(i) { return this.built.clamps[i].dockedShipLocal; }

  beginDock(player, clamp = 0) {
    this.dockClamp = clamp;
    this.toLocal(player.pos, this.captureLocal);
    _qInv.copy(this.quat).invert();
    this.captureQuat.copy(_qInv).multiply(player.quat);
    this.dockAnim = 0;
    this.dockDuration = DOCK_ANIM_BASE + this.captureLocal.distanceTo(this.clampLocal(clamp)) / 140;
  }

  /** Slaves the docked (or docking) player to the port. Returns true once fully docked. */
  holdPlayer(player, dt) {
    this.dockAnim = Math.min(1, this.dockAnim + dt / (this.dockDuration || DOCK_ANIM_BASE));
    const s = this.dockAnim * this.dockAnim * (3 - 2 * this.dockAnim);
    _v.copy(this.captureLocal).lerp(this.clampLocal(this.dockClamp), s);
    this.toWorld(_v, player.pos);
    // docked attitude: nose into the port (ship -Z facing station +Z)
    _q.copy(this.captureQuat).slerp(_flip, s);
    player.quat.copy(this.quat).multiply(_q);
    player.vel.copy(this.vel);
    return this.dockAnim >= 1;
  }

  /** Place the player just outside their clamp, facing away, drifting clear. */
  releasePlayer(player) {
    this.toWorld(this.built.clamps[this.dockClamp].exitLocal, player.pos);
    player.quat.copy(this.quat);
    const out = _v.set(0, 0, -1).applyQuaternion(this.quat);
    player.vel.copy(this.vel).addScaledVector(out, 12);
  }

  relativeSpeed(player) {
    return _v.subVectors(player.vel, this.vel).length();
  }
}
