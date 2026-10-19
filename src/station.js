import * as THREE from 'three';
import { gravityAt, circularSpeed } from './physics.js';
import { buildStation } from './ships.js';

// ---------------------------------------------------------------------------
// Orbital outpost. It holds a high circular orbit a little slower than a free
// orbit at that altitude (fast enough that undocking onto the free orbit only
// drifts you ahead gently, slow enough that it's quick to intercept), so its station-keeping thrusters burn
// continuously outward (you can see them firing toward the hole) to make up
// the difference in centripetal force. Docking is automatic when you're close
// and your speed relative to it is low.
// ---------------------------------------------------------------------------

export const DOCK_RANGE = 300;         // m from the station's centre
export const STATION_SPEED = 145;      // m/s — a free orbit up there would be ~167 m/s
export const DOCK_MAX_REL_SPEED = 40;  // m/s relative to the station
const DOCK_ANIM_BASE = 1.4;            // s, plus travel time from the capture point

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
// ---------------------------------------------------------------------------
// Collision hull, in station-local coordinates (see buildStation): cylinders
// along z, boxes, capsules and the habitat torus. The ring's spokes and pods
// turn with it, so they're placed per call.
// ---------------------------------------------------------------------------
const CYLS = [   // [cx, cy, z0, z1, radius]
  [0, 0, -48, 48, 5.3],          // spine
  [0, 0, -31.2, -16.8, 11.4],    // command module
  [0, 0, -37, -31, 8],           // nose
  [0, 0, 45.5, 54.5, 8],         // drive
  [0, 0, 1.5, 10.5, 8.2],        // ring hub
];
const BOXES = [  // [cx, cy, cz, hx, hy, hz]
  [0, 0, -39, 17, 1.6, 2], [0, 0, -39, 1.6, 17, 2],                 // cross mount
  [0, 17, 40, 0.2, 12, 4.5], [0, -17, 40, 0.2, 12, 4.5],            // radiators
  [11.6, 0, -24, 1.5, 1.7, 2], [-11.6, 0, -24, 1.5, 1.7, 2], [8.4, 0, 50, 1.5, 1.7, 2], [-8.4, 0, 50, 1.5, 1.7, 2],   // thruster pods
];
for (const sx of [1, -1]) for (const px of [20, 44]) for (const pz of [-1, 1]) BOXES.push([sx * px, 0, 30 + pz * 6.4, 10, 0.15, 5.5]);   // solar panels
const CAPS = [   // [ax, ay, az, bx, by, bz, radius]
  [3, 0, 30, 64, 0, 30, 0.6], [-3, 0, 30, -64, 0, 30, 0.6],         // solar booms
  [0, 6, -24, 0, 22, -24, 0.5],                                     // antenna mast
  [0, 20.5, -24, 0, 20.5, -24, 4.2],                                // antenna dish
];
for (const a of [Math.PI / 4, -Math.PI / 4]) CAPS.push([-24 * Math.cos(a), -24 * Math.sin(a), -37, 24 * Math.cos(a), 24 * Math.sin(a), -37, 2]);   // diagonal mount
const RING_Z = 6, RING_R = 38, RING_TUBE = 3.4;
const _cp = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
/** Distance from p to a capsule's surface; normal into _cn. */
function capsuleDist(p, a, b, rad) {
  _cb.subVectors(b, a);
  const t = THREE.MathUtils.clamp(_cp.subVectors(p, a).dot(_cb) / Math.max(_cb.lengthSq(), 1e-9), 0, 1);
  _cn.subVectors(p, _cp.copy(a).addScaledVector(_cb, t));
  const d = _cn.length();
  if (d < 1e-6) _cn.set(0, 1, 0); else _cn.divideScalar(d);
  return d - rad;
}
/** Distance from p to a z-axis cylinder's surface (negative inside); normal into _cn. */
function cylinderDist(p, cx, cy, z0, z1, R) {
  const dx = p.x - cx, dy = p.y - cy, rr = Math.hypot(dx, dy);
  if (p.z >= z0 && p.z <= z1 && rr <= R) {
    const dR = R - rr, d0 = p.z - z0, d1 = z1 - p.z;
    if (dR <= d0 && dR <= d1) { if (rr < 1e-6) _cn.set(1, 0, 0); else _cn.set(dx / rr, dy / rr, 0); return -dR; }
    if (d0 < d1) { _cn.set(0, 0, -1); return -d0; }
    _cn.set(0, 0, 1); return -d1;
  }
  const cz = THREE.MathUtils.clamp(p.z, z0, z1);
  const k = rr > R ? R / rr : 1;
  _cn.set(dx - dx * k, dy - dy * k, p.z - cz);
  const d = _cn.length();
  if (d < 1e-6) _cn.set(0, 0, 1); else _cn.divideScalar(d);
  return d;
}
/** Distance from p to an axis-aligned box's surface (negative inside); normal into _cn. */
function boxDist(p, cx, cy, cz, hx, hy, hz) {
  const qx = p.x - cx, qy = p.y - cy, qz = p.z - cz;
  const ox = Math.abs(qx) - hx, oy = Math.abs(qy) - hy, oz = Math.abs(qz) - hz;
  if (ox <= 0 && oy <= 0 && oz <= 0) {
    if (ox >= oy && ox >= oz) _cn.set(Math.sign(qx) || 1, 0, 0);
    else if (oy >= oz) _cn.set(0, Math.sign(qy) || 1, 0);
    else _cn.set(0, 0, Math.sign(qz) || 1);
    return Math.max(ox, oy, oz);
  }
  _cn.set(Math.max(ox, 0) * Math.sign(qx), Math.max(oy, 0) * Math.sign(qy), Math.max(oz, 0) * Math.sign(qz));
  const d = _cn.length();
  _cn.divideScalar(Math.max(d, 1e-9));
  return d;
}

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
    this.occupied = this.built.clamps.map(() => false);   // which clamps hold a ship (for the status lights)
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

  /**
   * Place the player just outside their clamp, facing along the station's path, on
   * the free circular orbit that mirrors the station's (same radius, plane and
   * direction). The station itself is thruster-held below orbital speed, so copying
   * its velocity would drop you onto a lower ellipse; this way the orbit you leave on
   * traces the station's own circle, and you pull ahead of it.
   */
  releasePlayer(player) {
    this.toWorld(this.built.clamps[this.dockClamp].exitLocal, player.pos);
    player.quat.copy(this.quat);
    const r = player.pos.length();
    const tangent = _v.crossVectors(this.normal, player.pos).normalize();   // the station's direction of travel
    if (tangent.dot(this.vel) < 0) tangent.negate();
    player.vel.copy(tangent).multiplyScalar(circularSpeed(r));
  }

  /**
   * Bounce a ship (a sphere of `radius`) off the station's structure. Moves `pos`
   * out of anything it overlaps and reflects its velocity relative to the station.
   * Returns the speed it hit at (0 if it didn't touch).
   */
  collide(pos, vel, radius, restitution = 0.4) {
    if (pos.distanceToSquared(this.pos) > 90 * 90) return 0;   // well clear (the solar arrays reach ~65 m)
    const p = this.toLocal(pos, _v);
    let touched = false;
    const push = (d) => {
      if (d >= radius) return;
      p.addScaledVector(_cn, radius - d);
      _n.add(_cn);
      touched = true;
    };
    _n.set(0, 0, 0);
    for (const c of CYLS) push(cylinderDist(p, c[0], c[1], c[2], c[3], c[4]));
    for (const b of BOXES) push(boxDist(p, b[0], b[1], b[2], b[3], b[4], b[5]));
    for (const c of CAPS) push(capsuleDist(p, _ca.set(c[0], c[1], c[2]), _cb.set(c[3], c[4], c[5]), c[6]));
    // docking clamps: an arm and collar per port
    for (const cl of this.built.clamps) push(cylinderDist(p, cl.portLocal.x, cl.portLocal.y, -52.5, -40, 4.5));
    // habitat ring: the torus, plus its spokes and pods (which turn with it)
    {
      const qx = p.x, qy = p.y, qz = p.z - RING_Z, rr = Math.hypot(qx, qy);
      if (rr > 1e-6) {
        _cn.set(qx - qx / rr * RING_R, qy - qy / rr * RING_R, qz);
        const d = _cn.length();
        _cn.divideScalar(Math.max(d, 1e-9));
        push(d - RING_TUBE);
      }
      const spin = this.built.ring.rotation.z;
      for (let i = 0; i < 4; i++) {
        const a = spin + (i / 4) * Math.PI * 2;
        const c = Math.cos(a), s = Math.sin(a);
        push(capsuleDist(p, _ca.set(c * 4.5, s * 4.5, RING_Z), _cb.set(c * 35.5, s * 35.5, RING_Z), 1.4));
        const b = a + Math.PI / 4;
        push(capsuleDist(p, _ca.set(Math.cos(b) * 38, Math.sin(b) * 38, RING_Z - 2), _cb.set(Math.cos(b) * 38, Math.sin(b) * 38, RING_Z + 2), 4.2));
      }
    }
    if (!touched) return 0;
    this.toWorld(p, pos);
    _n.normalize().applyQuaternion(this.quat);
    const vn = _cp.subVectors(vel, this.vel).dot(_n);
    if (vn >= 0) return 0;
    vel.addScaledVector(_n, -(1 + restitution) * vn);
    return -vn;
  }

  relativeSpeed(player) {
    return _v.subVectors(player.vel, this.vel).length();
  }
}
