import * as THREE from 'three';
import { integrate, accelAt, occludedByHole } from './physics.js';
import { buildEnemyMissile } from './ships.js';
import { Trail } from './fx.js';

// ---------------------------------------------------------------------------
// The dreadnought's homing missiles. Each one chases a single pilot with
// relative-velocity pursuit. Counterplay: shoot it down (one hit), or put the
// hole between you and it — once it loses sight of its target it can't
// reacquire and flies on blind until the motor burns out.
//
// Multiplayer: the host launches them and tells everyone (id, state, target).
// Every pilot flies the same missiles; the pilot who gets hit (or who shoots
// one down) reports it, and the others remove theirs.
// ---------------------------------------------------------------------------

const MOTOR_ACCEL = 80;        // m/s²
const BURN_TIME = 7;           // s
const MAX_LIFE = 9.5;          // s before it self-destructs
const FUSE = 5;                // m, plus the target's radius
export const ENEMY_MISSILE_DAMAGE = 18;
export const ENEMY_MISSILE_RADIUS = 3.5;   // hit sphere for the player's cannons

const _to = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _des = new THREE.Vector3();
const _gT = new THREE.Vector3();
const _gM = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _back = new THREE.Vector3();
const _negZ = new THREE.Vector3(0, 0, -1);
const _q = new THREE.Quaternion();

export class EnemyMissileSystem {
  /**
   * ctx: { scene, particles, audio, explode(pos, vel, scale, tint), player,
   *        pilotById(id) -> ship | null, localId() -> id, onLocalHit(m) }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.list = [];
  }

  spawn({ id, pos, vel, targetId, late = 0 }) {
    const built = buildEnemyMissile();
    this.ctx.scene.add(built.group);
    const m = {
      id, targetId, built,
      pos: pos.clone(), vel: vel.clone(),
      thrust: new THREE.Vector3(),
      quat: new THREE.Quaternion().setFromUnitVectors(_negZ, _dir.copy(vel).normalize()),
      age: 0, alive: true, burning: true, lost: false,
      radius: ENEMY_MISSILE_RADIUS, isMissile: true,
      trail: new Trail(this.ctx.scene, { segments: 60, width: 0.4, color: 0xff3a3a, interval: 0.03, fadeNear: 10 }),
    };
    // catch up on network latency
    for (let t = Math.min(late, 0.5); t > 1e-6; t -= 1 / 60) {
      const h = Math.min(1 / 60, t);
      m.age += h;
      this._guide(m);
      integrate(m.pos, m.vel, m.thrust, h);
    }
    m.trail.reset(m.pos);
    this.list.push(m);
    return m;
  }

  _guide(m) {
    m.burning = m.age < BURN_TIME;
    m.thrust.set(0, 0, 0);
    if (!m.burning) return;
    const t = this.ctx.pilotById(m.targetId);
    if (!m.lost && (!t || !t.alive || occludedByHole(m.pos, t.pos, 1.3))) m.lost = true;
    if (m.lost) {
      // blind: keep burning straight along the current heading
      m.thrust.copy(_negZ).applyQuaternion(m.quat).multiplyScalar(MOTOR_ACCEL * 0.5);
      return;
    }
    _to.subVectors(t.pos, m.pos);
    const d = _to.length();
    _rel.subVectors(m.vel, t.vel);
    const speed = Math.min(70 + m.age * 110, 300);
    _des.copy(_to).divideScalar(Math.max(d, 1e-3)).multiplyScalar(speed);
    _des.sub(_rel).multiplyScalar(2.5);
    _des.add(accelAt(t.pos, _gT).sub(accelAt(m.pos, _gM)));
    m.thrust.copy(_des).clampLength(0, MOTOR_ACCEL);
  }

  /** Fixed-step physics + proximity fuse against this pilot's own ship. */
  physics(h) {
    const { player } = this.ctx;
    for (const m of this.list) {
      if (!m.alive) continue;
      if (!integrate(m.pos, m.vel, m.burning ? m.thrust : null, h)) { this._dispose(m); continue; }
      if (player.alive && m.pos.distanceTo(player.pos) < FUSE + player.radius) {
        this.ctx.onLocalHit(m);
        this.detonate(m, 1.1);
        continue;
      }
      // closing on another pilot: they judge the hit; here it just goes off
      if (m.targetId !== this.ctx.localId()) {
        const t = this.ctx.pilotById(m.targetId);
        if (t && t.alive && m.pos.distanceTo(t.pos) < FUSE + 3) this.detonate(m, 1.1);
      }
    }
  }

  update(dt, camPos, time) {
    for (const m of this.list) {
      if (!m.alive) continue;
      m.age += dt;
      this._guide(m);
      const look = m.thrust.lengthSq() > 1 ? _dir.copy(m.thrust) : _dir.copy(m.vel);
      if (look.lengthSq() > 1e-4) {
        _q.setFromUnitVectors(_negZ, look.normalize());
        m.quat.slerp(_q, 1 - Math.exp(-dt * 10));
      }
      m.built.group.position.copy(m.pos);
      m.built.group.quaternion.copy(m.quat);
      const f = m.built.flame;
      f.flame.visible = f.glow.visible = m.burning;
      f.flame.scale.set(0.24, 0.24, 1.6 + Math.random() * 0.9);
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uIntensity.value = 1.8;
      m.built.beacon.material.opacity = m.lost ? 0.35 : 0.7 + 0.3 * Math.sin(time * 18);
      _back.set(0, 0, 1).applyQuaternion(m.quat);
      const tail = _dir.copy(m.pos).addScaledVector(_back, 1.6);
      m.trail.update(dt, tail, camPos, m.burning ? 0.9 : Math.max(0, 0.9 - (m.age - BURN_TIME) * 0.6));
      if (m.burning) {
        this.ctx.particles.emit(tail.x, tail.y, tail.z,
          m.vel.x + _back.x * 25 + (Math.random() - 0.5) * 4,
          m.vel.y + _back.y * 25 + (Math.random() - 0.5) * 4,
          m.vel.z + _back.z * 25 + (Math.random() - 0.5) * 4,
          1.0, 0.3, 0.2, 0.6, 2.4, 0.45, false);
      }
      if (m.age > MAX_LIFE) this.detonate(m, 0.6);
    }
    this.list = this.list.filter((m) => m.alive);
  }

  /** Blow up a missile (hit, shot down, or burnt out). Effects only — callers handle damage. */
  detonate(m, scale = 0.8) {
    if (!m.alive) return;
    const { explode, audio, player } = this.ctx;
    explode(m.pos, m.vel, scale, [1.0, 0.3, 0.2]);
    audio.explosion(scale, THREE.MathUtils.clamp(1.4 - m.pos.distanceTo(player.pos) / 700, 0.15, 1));
    this._dispose(m);
  }

  byId(id) { return this.list.find((m) => m.alive && m.id === id) || null; }

  removeById(id) {
    const m = this.byId(id);
    if (m) this.detonate(m, 0.8);
  }

  /** The closest live missile still tracking this pilot, or null. */
  threat(localId, pos) {
    let best = null, bd = Infinity;
    for (const m of this.list) {
      if (!m.alive || m.lost || !m.burning || m.targetId !== localId) continue;
      const d = m.pos.distanceTo(pos);
      if (d < bd) { bd = d; best = m; }
    }
    return best ? { m: best, dist: bd } : null;
  }

  clear() {
    for (const m of this.list) this._dispose(m);
    this.list.length = 0;
  }

  _dispose(m) {
    m.alive = false;
    this.ctx.scene.remove(m.built.group);
    m.trail.dispose();
  }
}
