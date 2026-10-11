import * as THREE from 'three';
import { integrate, accelAt, occludedByHole } from './physics.js';
import { buildMissile } from './ships.js';
import { Trail } from './fx.js';

// ---------------------------------------------------------------------------
// Homing missiles. E starts a seeker lock on the hostile nearest the
// crosshair; holding it in the seeker cone completes the lock. Q launches.
// Missiles are gravitating bodies with a rocket motor: they steer by
// relative-velocity pursuit (with the gravity difference to the target fed
// forward), burn for a limited time, then coast ballistically and self-destruct.
// ---------------------------------------------------------------------------

export const MISSILES_PER_WAVE = 2;
const LOCK_TIME = 1.5;                         // seconds to complete a lock
const LOCK_RANGE = 1000;                       // m, seeker acquisition range
const ACQUIRE_CONE = Math.cos(THREE.MathUtils.degToRad(14));
const HOLD_CONE = Math.cos(THREE.MathUtils.degToRad(26));
const MOTOR_ACCEL = 120;                       // m/s²
const BURN_TIME = 4.0;                         // s of motor burn
const MAX_LIFE = 5.5;                          // s before self-destruct
const LAUNCH_KICK = 30;                        // m/s ejection speed
const FUSE = 5;                                // proximity fuse (plus target radius)
const DAMAGE = 12;
const SPLASH_RADIUS = 30;
const SPLASH_DAMAGE = 4;

const _to = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _des = new THREE.Vector3();
const _gT = new THREE.Vector3();
const _gM = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _back = new THREE.Vector3();
const _negZ = new THREE.Vector3(0, 0, -1);

export class MissileSystem {
  /**
   * ctx: { scene, particles, audio, hud, player, camera, enemies(), explode(pos, vel, scale, tint),
   *        hitEnemy(e, dmg, point, cause), damagePlayer(amount, opts) }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.missiles = [];
    this.ammo = MISSILES_PER_WAVE;
    this.lockState = 'idle';  // idle | locking | locked
    this.lockTarget = null;
    this.lockProgress = 0;
    this.beepTimer = 0;
  }

  refill() {
    this.ammo = MISSILES_PER_WAVE;
  }

  clear() {
    for (const m of this.missiles) this._dispose(m);
    this.missiles.length = 0;
    this.cancelLock(true);
    this.ammo = MISSILES_PER_WAVE;
  }

  cancelLock(silent = false) {
    if (this.lockState !== 'idle' && !silent) this.ctx.hud.notice('LOCK CANCELLED', 'dim');
    this.lockState = 'idle';
    this.lockTarget = null;
    this.lockProgress = 0;
    this.ctx.audio.setLockTone(false);
  }

  /** E key */
  pressLock() {
    const { hud, audio } = this.ctx;
    if (this.lockState !== 'idle') { this.cancelLock(); return; }
    if (this.ammo <= 0) { hud.notice('NO MISSILES — RESUPPLY NEXT WAVE', 'red'); audio.beep(180, 0.15, 0.06, 'square'); return; }
    const target = this._findCandidate(ACQUIRE_CONE, LOCK_RANGE);
    if (!target) {
      const masked = this._findCandidate(ACQUIRE_CONE, LOCK_RANGE, true);
      hud.notice(masked ? 'TARGET MASKED BY THE HOLE' : 'NO TARGET IN SEEKER CONE', 'dim');
      audio.beep(240, 0.12, 0.05, 'square');
      return;
    }
    this.lockState = 'locking';
    this.lockTarget = target;
    this.lockProgress = 0;
    this.beepTimer = 0;
  }

  /** Q key */
  fire() {
    const { hud, audio, player } = this.ctx;
    if (!player.alive) return;
    if (this.ammo <= 0) { hud.notice('NO MISSILES — RESUPPLY NEXT WAVE', 'red'); audio.beep(180, 0.15, 0.06, 'square'); return; }
    if (this.lockState !== 'locked') {
      hud.notice(this.lockState === 'locking' ? 'LOCK NOT COMPLETE' : 'NO LOCK — PRESS E', 'dim');
      audio.beep(240, 0.12, 0.05, 'square');
      return;
    }
    this._launch(this.lockTarget);
    this.ammo--;
    this.cancelLock(true);
    hud.notice('FOX THREE — MISSILE AWAY', 'orange');
  }

  _findCandidate(cone, range, ignoreHole = false) {
    const { player } = this.ctx;
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(player.quat);
    let best = null;
    let bestDot = cone;
    for (const e of this.ctx.enemies()) {
      if (!e.alive) continue;
      _to.subVectors(e.pos, player.pos);
      const d = _to.length();
      if (d > range || (!ignoreHole && occludedByHole(player.pos, e.pos, 1.6))) continue;
      const dot = _to.divideScalar(d).dot(fwd);
      if (dot > bestDot) { bestDot = dot; best = e; }
    }
    return best;
  }

  _launch(target) {
    const { scene, player, audio, particles } = this.ctx;
    const built = buildMissile();
    scene.add(built.group);
    const fwd = _fwd.set(0, 0, -1).applyQuaternion(player.quat);
    const down = _dir.set(0, -1, 0).applyQuaternion(player.quat);
    const pos = player.pos.clone().addScaledVector(down, 0.9).addScaledVector(fwd, 0.5);
    const vel = player.vel.clone().addScaledVector(fwd, LAUNCH_KICK).addScaledVector(down, 6);
    const m = {
      pos, vel, target, built,
      thrust: new THREE.Vector3(),
      quat: player.quat.clone(),
      age: 0, alive: true, burning: true,
      trail: new Trail(scene, { segments: 70, width: 0.28, color: 0xffc890, interval: 0.025, fadeNear: 10 }),
    };
    m.trail.reset(pos);
    this.missiles.push(m);
    audio.missileLaunch();
    for (let i = 0; i < 16; i++) {
      particles.emit(pos.x, pos.y, pos.z,
        vel.x + (Math.random() - 0.5) * 10, vel.y + (Math.random() - 0.5) * 10, vel.z + (Math.random() - 0.5) * 10,
        0.6, 0.55, 0.5, 0.6, 2.5, 0.6, false);
    }
  }

  /** Per-frame: lock logic, guidance, visuals. */
  update(dt, camPos, time) {
    const { player, audio } = this.ctx;

    // --- seeker lock ---
    if (this.lockState !== 'idle') {
      const t = this.lockTarget;
      let ok = t && t.alive && player.alive;
      if (ok) {
        _to.subVectors(t.pos, player.pos);
        const d = _to.length();
        const fwd = _fwd.set(0, 0, -1).applyQuaternion(player.quat);
        ok = d < LOCK_RANGE * 1.15 && _to.divideScalar(d).dot(fwd) > HOLD_CONE && !occludedByHole(player.pos, t.pos, 1.6);
      }
      if (!ok) {
        this.cancelLock(true);
        if (player.alive) { this.ctx.hud.notice('LOCK LOST', 'red'); audio.beep(300, 0.2, 0.06, 'sawtooth'); }
      } else if (this.lockState === 'locking') {
        this.lockProgress = Math.min(1, this.lockProgress + dt / LOCK_TIME);
        this.beepTimer -= dt;
        if (this.beepTimer <= 0) {
          audio.beep(900 + this.lockProgress * 700, 0.04, 0.05, 'sine');
          this.beepTimer = 0.28 - this.lockProgress * 0.2;
        }
        if (this.lockProgress >= 1) {
          this.lockState = 'locked';
          audio.setLockTone(true);
          this.ctx.hud.notice('LOCKED — PRESS Q TO FIRE', 'red');
        }
      }
    }

    // --- missile guidance & visuals ---
    for (const m of this.missiles) {
      if (!m.alive) continue;
      m.age += dt;
      m.burning = m.age < BURN_TIME;
      m.thrust.set(0, 0, 0);
      const t = m.target;
      if (m.burning && t && t.alive) {
        _to.subVectors(t.pos, m.pos);
        const d = _to.length();
        _rel.subVectors(m.vel, t.vel);
        // closing speed ramps up as the motor spools
        const speed = Math.min(80 + m.age * 160, 420);
        _des.copy(_to).divideScalar(Math.max(d, 1e-3)).multiplyScalar(speed);
        _des.sub(_rel).multiplyScalar(4);
        _des.add(accelAt(t.pos, _gT).sub(accelAt(m.pos, _gM)));
        m.thrust.copy(_des).clampLength(0, MOTOR_ACCEL);
      } else if (m.burning) {
        // target gone: burn straight ahead
        m.thrust.set(0, 0, -1).applyQuaternion(m.quat).multiplyScalar(MOTOR_ACCEL * 0.5);
      }
      // orientation follows motion relative to the target (or thrust while burning)
      const look = m.thrust.lengthSq() > 1 ? _dir.copy(m.thrust) : _dir.subVectors(m.vel, t && t.alive ? t.vel : player.vel);
      if (look.lengthSq() > 1e-4) {
        look.normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(_negZ, look);
        m.quat.slerp(q, 1 - Math.exp(-dt * 12));
      }
      m.built.group.position.copy(m.pos);
      m.built.group.quaternion.copy(m.quat);
      const f = m.built.flame;
      const thr = m.burning ? 1 : 0;
      f.flame.visible = f.glow.visible = m.burning;
      f.flame.scale.set(0.16, 0.16, 1.2 + Math.random() * 0.8);
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uIntensity.value = 1.6;
      _back.set(0, 0, 1).applyQuaternion(m.quat);
      const tail = _dir.copy(m.pos).addScaledVector(_back, 1.0);
      m.trail.update(dt, tail, camPos, m.burning ? 0.9 : Math.max(0, 0.9 - (m.age - BURN_TIME) * 0.6));
      if (thr) {
        const p = this.ctx.particles;
        p.emit(tail.x, tail.y, tail.z,
          m.vel.x + _back.x * 25 + (Math.random() - 0.5) * 4,
          m.vel.y + _back.y * 25 + (Math.random() - 0.5) * 4,
          m.vel.z + _back.z * 25 + (Math.random() - 0.5) * 4,
          0.9, 0.55, 0.25, 0.5, 2.2, 0.45, false);
      }
      if (m.age > MAX_LIFE) this._detonate(m, null, true);
    }
    this.missiles = this.missiles.filter((m) => m.alive);
  }

  /** Fixed-step physics + proximity fuse. */
  physics(h) {
    for (const m of this.missiles) {
      if (!m.alive) continue;
      if (!integrate(m.pos, m.vel, m.burning ? m.thrust : null, h)) { this._dispose(m); continue; }
      for (const e of this.ctx.enemies()) {
        if (!e.alive) continue;
        if (m.pos.distanceTo(e.pos) < FUSE + e.radius) { this._detonate(m, e, false); break; }
      }
    }
  }

  _detonate(m, direct, fizzle) {
    if (!m.alive) return;
    const { explode, audio, player, hitEnemy, damagePlayer } = this.ctx;
    explode(m.pos, m.vel, fizzle ? 0.7 : 1.2, [1.0, 0.6, 0.25]);
    const dist = m.pos.distanceTo(player.pos);
    audio.explosion(fizzle ? 0.7 : 1.3, THREE.MathUtils.clamp(1.4 - dist / 700, 0.15, 1));
    if (!fizzle) {
      for (const e of this.ctx.enemies()) {
        if (!e.alive) continue;
        if (e === direct) { hitEnemy(e, DAMAGE, m.pos, 'missile'); continue; }
        const d = e.pos.distanceTo(m.pos);
        if (d < SPLASH_RADIUS) hitEnemy(e, SPLASH_DAMAGE, e.pos, 'missile');
      }
      if (player.alive && dist < SPLASH_RADIUS) damagePlayer(10, { cause: 'CAUGHT IN YOUR OWN BLAST' });
    }
    this._dispose(m);
  }

  _dispose(m) {
    m.alive = false;
    this.ctx.scene.remove(m.built.group);
    m.trail.dispose();
  }

  get lockInfo() {
    return { state: this.lockState, target: this.lockTarget, progress: this.lockProgress };
  }
}
