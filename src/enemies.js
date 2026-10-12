import * as THREE from 'three';
import { integrate, periapsisEstimate, accelAt, occludedByHole, circularSpeed, ARENA_RADIUS, RS } from './physics.js';
import { buildRaider, buildWarden, buildSeeker, buildDreadnought } from './ships.js';
import { Trail } from './fx.js';

export const ENEMY_DEFS = {
  raider: {
    hp: 3, accel: 34, turn: 2.0, engageRange: 900, preferred: 150, approach: 45,
    fireRange: 420, boltSpeed: 190, burst: 3, burstGap: 0.13, cooldown: [1.8, 3.0], dmg: 6, aimError: 6,
    score: 100, trailColor: 0xff3a3a, build: buildRaider,
  },
  warden: {
    hp: 9, accel: 24, turn: 1.0, engageRange: 1000, preferred: 230, approach: 30,
    fireRange: 520, boltSpeed: 150, burst: 1, burstGap: 0, cooldown: [2.6, 3.6], dmg: 9, spread: 5, aimError: 9,
    score: 300, trailColor: 0xd050ff, build: buildWarden,
  },
  seeker: {
    hp: 2, accel: 38, turn: 4.0, engageRange: 1200, preferred: 0, approach: 70,
    fireRange: 0, ramDamage: 34, score: 150, trailColor: 0xffb030, build: buildSeeker,
  },
  // boss: an orbital fortress that holds one low orbit, defended by six turrets and a missile launcher
  dread: {
    boss: true, hp: 200, accel: 14, turn: 0.25, score: 3000, trailColor: 0xff2a3c, build: buildDreadnought,
    turret: {
      hp: 10, range: 800, boltSpeed: 240, burst: 3, burstGap: 0.12, cooldown: [2.0, 3.0], dmg: 6, aimError: 6, turn: 1.5, score: 250,
    },
    missileCooldown: [6.5, 8.5], missileRange: 1500,
  },
};

const _toP = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _des = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _tq = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _gP = new THREE.Vector3();
const _white = new THREE.Color(2.5, 2.5, 2.5);
const _gE = new THREE.Vector3();
const _np = new THREE.Vector3();
const _nv = new THREE.Vector3();
const _render = new THREE.Vector3();
const _zero = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

// network ids: the host numbers its enemies so guests can refer to them
let nextNetId = 1;
export function resetEnemyIds() { nextNetId = 1; }

export class Enemy {
  constructor(type, scene, difficulty, netId) {
    this.type = type;
    this.def = ENEMY_DEFS[type];
    this.difficulty = difficulty;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.thrust = new THREE.Vector3();
    this.hp = this.def.hp;
    this.maxHp = this.def.hp;
    this.alive = true;
    this.flash = 0;
    this.fireTimer = 1.5 + Math.random() * 2.5;
    this.burstLeft = 0;
    this.burstTimer = 0;
    this.phase = Math.random() * 100;
    this.age = 0;
    this.throttle = 0;
    this.spawnFx = 1;
    this.netId = netId !== undefined ? netId : nextNetId++;
    // multiplayer guests: a "proxy" follows the host's snapshots instead of running AI
    this.proxy = false;
    this.hasNet = false;
    this.lastSnapT = -Infinity;
    this.lastSeen = 0;
    this.err = new THREE.Vector3();
    this.targetQuat = new THREE.Quaternion();
    this.aimErr = new THREE.Vector3();
    this.leadFactor = 1;
    this.rollAim();

    const built = this.def.build();
    this.built = built;
    this.mesh = built.group;
    this.radius = built.radius;
    scene.add(this.mesh);
    this.trail = new Trail(scene, { segments: 36, width: this.def.boss ? 1.8 : type === 'warden' ? 0.9 : 0.5, color: this.def.trailColor, interval: 0.025 });
    this.scene = scene;
    if (this.def.boss) this._initBoss();
  }

  // -------------------------------------------------------------------------
  // Boss: station-keeping on a circular orbit, independent turrets, missiles
  // -------------------------------------------------------------------------
  _initBoss() {
    const td = this.def.turret;
    this.orbitR = 1350;
    this.orbitN = new THREE.Vector3(0, 1, 0);
    this.orbitV = circularSpeed(this.orbitR);
    this.missileTimer = 5;
    this.launcherIdx = 0;
    this.turrets = this.built.turrets.map((b, i) => ({
      ...b, index: i, owner: this, isTurret: true,
      hp: td.hp, maxHp: td.hp, alive: true, radius: 6.5,
      pos: new THREE.Vector3(), worldN: new THREE.Vector3(), aimQuat: new THREE.Quaternion(), aimDir: new THREE.Vector3(),
      aimErr: new THREE.Vector3(), lead: 1, engaged: false,
      fireTimer: 1.5 + Math.random() * 2, burstLeft: 0, burstTimer: 0,
    }));
    // hit volume: a chain of spheres down the hull plus the reactor ring (a single
    // big sphere would swallow shots meant for the turrets on its surface)
    const parts = [[0, 0, -40, 11], [0, 0, -26, 15], [0, 0, -10, 15], [0, 0, 6, 15], [0, 0, 22, 15], [0, 0, 36, 13]];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      parts.push([Math.cos(a) * 29, Math.sin(a) * 29, 6, 3.4]);
    }
    this.hitParts = parts.map(([x, y, z, radius]) => ({
      local: new THREE.Vector3(x, y, z), pos: new THREE.Vector3(), radius, owner: this, isHull: true,
      get alive() { return this.owner.alive; },
    }));
  }

  /** Put the fortress on its orbit (radius, unit normal, start position/velocity already set). */
  setOrbit(radius, normal) {
    this.orbitR = radius;
    this.orbitN.copy(normal);
    this.orbitV = circularSpeed(radius);
    _m.lookAt(this.pos, _tmp.copy(this.pos).add(this.vel), this.orbitN);
    this.quat.setFromRotationMatrix(_m);
    this.updateTurretPositions();
    for (const t of this.turrets) {
      _m.lookAt(_zero, t.worldN, this.orbitN);
      t.aimQuat.setFromRotationMatrix(_m);
    }
  }

  updateTurretPositions() {
    for (const p of this.hitParts) p.pos.copy(p.local).applyQuaternion(this.quat).add(this.pos);
    for (const t of this.turrets) {
      t.pos.copy(t.local).applyQuaternion(this.quat).add(this.pos);
      t.worldN.copy(t.normal).applyQuaternion(this.quat);
    }
  }

  get turretsAlive() { return this.turrets ? this.turrets.reduce((n, t) => n + (t.alive ? 1 : 0), 0) : 0; }

  rollTurretAim(t) {
    const td = this.def.turret;
    t.lead = 0.75 + Math.random() * 0.35;
    const mag = td.aimError * Math.max(0.55, 1 - this.difficulty * 0.05) * Math.sqrt(Math.random());
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, sq = Math.sqrt(1 - u * u);
    t.aimErr.set(sq * Math.cos(th), sq * Math.sin(th), u).multiplyScalar(mag);
  }

  thinkBoss(dt, game) {
    const def = this.def;
    this.age += dt;
    // station-keeping: hold the circular orbit (gravity does nearly all the work)
    const r = this.pos.length();
    const radial = _up.copy(this.pos).divideScalar(Math.max(r, 1e-3));
    const n = this.orbitN;
    const pro = _tmp.crossVectors(n, radial).normalize();
    const vr = this.vel.dot(radial), vn = this.vel.dot(n), vt = this.vel.dot(pro);
    this.thrust.set(0, 0, 0)
      .addScaledVector(radial, -0.02 * (r - this.orbitR) - 0.4 * vr)
      .addScaledVector(n, -0.02 * this.pos.dot(n) - 0.4 * vn)
      .addScaledVector(pro, 0.4 * (this.orbitV - vt))
      .clampLength(0, def.accel);
    this.throttle = 0.35;
    // nose along the orbit, belly to the hole's plane
    _m.lookAt(this.pos, _tmp2.copy(this.pos).add(this.vel), n);
    _tq.setFromRotationMatrix(_m);
    this.quat.rotateTowards(_tq, def.turn * dt);
    this.updateTurretPositions();
    this.aimTurrets(dt, game, true);

    // missile launcher: one at a time at the nearest pilot in range
    this.missileTimer -= dt;
    if (this.missileTimer <= 0 && this.age > 4) {
      const target = game.nearestPilot(this.pos);
      const ok = target && target.alive && target.pos.distanceTo(this.pos) < def.missileRange && !occludedByHole(this.pos, target.pos, 1.6);
      if (ok) {
        game.bossMissile(this, this.launcherIdx++ % this.built.launchers.length, target);
        const [a, b] = def.missileCooldown;
        this.missileTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.04);
      } else this.missileTimer = 1;
    }
  }

  /**
   * Each turret tracks the nearest pilot on its own side of the hull (the hull
   * and the hole both block it). `armed` turrets also fire (host / solo only);
   * guests run this just to point the guns.
   */
  aimTurrets(dt, game, armed) {
    const td = this.def.turret;
    const fwd = this.forward;
    for (const t of this.turrets) {
      if (!t.alive) continue;
      const target = game.nearestPilot(t.pos);
      let aim = null;
      t.engaged = false;
      if (target && target.alive) {
        _toP.subVectors(target.pos, t.pos);
        const dist = _toP.length();
        if (dist < td.range * 1.4 && _toP.dot(t.worldN) > 0.08 * dist && !occludedByHole(t.pos, target.pos, 1.6)) {
          const lead = (dist / td.boltSpeed) * t.lead;
          // long shots arc: allow for the difference between the gravity along the
          // bolt's path and the gravity on the target over the flight time
          _gE.addVectors(t.pos, target.pos).multiplyScalar(0.5);
          accelAt(_gE, _gE);
          accelAt(target.pos, _gP).sub(_gE).multiplyScalar(0.5 * lead * lead);
          aim = _des.copy(target.pos).addScaledVector(target.vel, lead).addScaledVector(this.vel, -lead)
            .add(_gP).add(t.aimErr).sub(t.pos).normalize();
          t.engaged = dist < td.range;
        }
      }
      if (!aim) aim = _des.copy(t.worldN).add(fwd).normalize();   // idle: watch forward
      t.aimDir.copy(aim);
      _m.lookAt(_zero, aim, t.worldN);
      _tq.setFromRotationMatrix(_m);
      t.aimQuat.rotateTowards(_tq, td.turn * dt);
      if (!armed) continue;
      t.fireTimer -= dt;
      if (t.burstLeft > 0) {
        t.burstTimer -= dt;
        if (t.burstTimer <= 0) {
          t.burstLeft--;
          t.burstTimer = td.burstGap;
          game.turretFire(this, t);
        }
      } else if (t.engaged && t.fireTimer <= 0 && this.age > 3) {
        const barrel = _tmp.set(0, 0, -1).applyQuaternion(t.aimQuat);
        if (barrel.dot(aim) > 0.995) {
          t.burstLeft = td.burst;
          t.burstTimer = 0;
          const [a, b] = td.cooldown;
          t.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.06);
          this.rollTurretAim(t);
        }
      }
    }
  }

  /** A turret has been destroyed (visuals only; the caller handles score and effects). */
  killTurret(i) {
    const t = this.turrets[i];
    if (!t || !t.alive) return false;
    t.alive = false;
    t.hp = 0;
    t.head.visible = false;
    t.ring.visible = false;
    t.stub.visible = true;
    return true;
  }

  /**
   * Gunners aren't perfect: each burst aims at the player's predicted position
   * plus a random miss offset, with a lead that under- or over-estimates.
   * Accuracy improves a little with each wave.
   */
  rollAim() {
    const def = this.def;
    this.leadFactor = 0.7 + Math.random() * 0.4;
    if (!def.aimError) { this.aimErr.set(0, 0, 0); return; }
    const mag = def.aimError * Math.max(0.55, 1 - this.difficulty * 0.05) * Math.sqrt(Math.random());
    const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, sq = Math.sqrt(1 - u * u);
    this.aimErr.set(sq * Math.cos(th), sq * Math.sin(th), u).multiplyScalar(mag);
  }

  get forward() { return _fwd.set(0, 0, -1).applyQuaternion(this.quat); }

  /** Per-frame AI: decide thrust vector & facing, maybe fire. */
  think(dt, player, game) {
    if (this.def.boss) { this.thinkBoss(dt, game); return; }
    const def = this.def;
    this.age += dt;
    this.thrust.set(0, 0, 0);
    const r = this.pos.length();
    _toP.subVectors(player.pos, this.pos);
    const dist = _toP.length();
    const dirP = _tmp.copy(_toP).divideScalar(Math.max(dist, 1e-3));
    // the hole blocks line of sight: hold fire, and route around it instead of through it
    const blocked = occludedByHole(this.pos, player.pos, 1.6);
    if (blocked) {
      _up.copy(this.pos).normalize();
      dirP.addScaledVector(_up, -dirP.dot(_up));
      if (dirP.lengthSq() < 1e-6) dirP.crossVectors(_up, this.vel);
      dirP.normalize();
    }
    _rel.subVectors(this.vel, player.vel); // our velocity relative to the player
    const accel = def.accel * (1 + this.difficulty * 0.05);

    let faceTarget = null;
    const rp = periapsisEstimate(this.pos, this.vel);
    // feed-forward the difference in gravity between us and the player, so
    // relative-motion steering behaves as it would in free space
    const gDiff = _gP.copy(accelAt(player.pos, _gP)).sub(accelAt(this.pos, _gE));
    const engaged = player.alive && dist < def.engageRange;

    const radialVel = this.vel.dot(this.pos) / Math.max(r, 1e-3);
    // look ahead along the current heading: would we pass inside the hole's shadow?
    const v2 = this.vel.lengthSq() || 1;
    const tc = THREE.MathUtils.clamp(-this.pos.dot(this.vel) / v2, 0, 4);
    const cpa = _tmp2.copy(this.pos).addScaledVector(this.vel, tc).length();
    if (r < 600 || (rp < 560 && radialVel < 0) || cpa < RS * 2.8) {
      // falling toward the hole: burn prograde + radial-out to climb
      _des.copy(this.vel).normalize().multiplyScalar(0.8).addScaledVector(_tmp2.copy(this.pos).normalize(), 0.6).normalize();
      this.thrust.copy(_des).multiplyScalar(accel * 1.15);
      faceTarget = _tmp2.copy(this.pos).add(_des);
    } else if (r > ARENA_RADIUS * 0.9) {
      // drifted too far: kill outward velocity, head back in
      _des.copy(this.pos).normalize().multiplyScalar(-35).sub(_tmp2.copy(this.vel).projectOnVector(this.pos)).clampLength(0, 1).multiplyScalar(accel);
      this.thrust.copy(_des);
    } else if (engaged) {
      if (this.type === 'seeker') {
        // pure pursuit with relative-velocity steering; it overshoots and can be dodged
        _des.copy(dirP).multiplyScalar(def.approach + this.difficulty * 3);
        _des.sub(_rel).multiplyScalar(1.2).add(gDiff);
        this.thrust.copy(_des).clampLength(0, accel);
        faceTarget = _tmp2.copy(player.pos);
      } else {
        const closing = THREE.MathUtils.clamp((dist - def.preferred) * 0.3, -30, def.approach);
        _des.copy(dirP).multiplyScalar(closing);
        // jink sideways so they're harder to hit
        _up.set(0, 1, 0).applyQuaternion(this.quat);
        _tmp2.crossVectors(dirP, _up).normalize();
        _des.addScaledVector(_tmp2, Math.sin(this.age * 0.9 + this.phase) * 22);
        _des.addScaledVector(_up, Math.cos(this.age * 0.7 + this.phase * 2) * 10);
        _des.sub(_rel).multiplyScalar(0.9).add(gDiff);
        this.thrust.copy(_des).clampLength(0, accel);
        // aim with an imperfect lead and a per-burst aiming error (see rollAim)
        const t = (dist / def.boltSpeed) * this.leadFactor;
        faceTarget = _tmp2.copy(player.pos).addScaledVector(player.vel, t).addScaledVector(this.vel, -t).add(this.aimErr);
      }
    } else if (player.alive) {
      // patrol: drift in orbit, nudging gently toward the player
      _des.copy(dirP).multiplyScalar(55).sub(_rel).multiplyScalar(0.5).clampLength(0, accel * 0.6);
      this.thrust.copy(_des);
    }

    // turn toward target (or along velocity when idle)
    if (!faceTarget) faceTarget = _tmp2.copy(this.pos).add(this.vel);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _m.lookAt(this.pos, faceTarget, _up);
    _tq.setFromRotationMatrix(_m);
    this.quat.rotateTowards(_tq, def.turn * dt);
    this.throttle = this.thrust.length() / accel;

    // weapons
    if (this.type !== 'seeker' && engaged && !blocked) {
      this.fireTimer -= dt;
      const fwd = this.forward;
      const aimDir = _tmp.subVectors(faceTarget, this.pos).normalize();
      const aligned = fwd.dot(aimDir) > 0.985;
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          this.burstLeft--;
          this.burstTimer = def.burstGap;
          game.enemyFire(this);
        }
      } else if (this.fireTimer <= 0 && aligned && dist < def.fireRange && this.age > 1.5) {
        this.burstLeft = def.burst;
        this.burstTimer = 0;
        const [a, b] = def.cooldown;
        this.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.06);
        this.rollAim();
      }
    }
  }

  physics(dt) {
    integrate(this.pos, this.vel, this.thrust, dt);
    if (this.turrets) this.updateTurretPositions();
  }

  /** Guest side: adopt the host's state for this enemy, extrapolated to `now` with the real physics. */
  applyNet(s, now) {
    this.lastSeen = now;
    if (s.t <= this.lastSnapT) return;
    this.lastSnapT = s.t;
    _np.fromArray(s.p); _nv.fromArray(s.v);
    this.thrust.fromArray(s.a);
    this.targetQuat.fromArray(s.q);
    this.hp = s.hp;
    if (s.mhp) this.maxHp = s.mhp;
    this.throttle = s.th;
    let dt = Math.min(Math.max(now - s.t, 0), 0.6);
    while (dt > 1e-6) {
      const h = Math.min(1 / 60, dt);
      integrate(_np, _nv, this.thrust, h);
      dt -= h;
    }
    if (this.hasNet) {
      // keep the drawn ship where it is and let the difference fade (see updateVisual)
      this.err.add(this.pos).sub(_np);
      if (this.err.length() > 300) this.err.set(0, 0, 0);
    } else {
      this.quat.copy(this.targetQuat);
      this.hasNet = true;
    }
    this.pos.copy(_np);
    this.vel.copy(_nv);
  }

  /** Where the ship is drawn (proxies glide toward corrections instead of jumping). */
  get renderPos() { return this.proxy ? _render.copy(this.pos).add(this.err) : this.pos; }

  updateVisual(dt, camPos, time) {
    if (this.proxy) {
      this.err.multiplyScalar(Math.exp(-dt / 0.2));
      this.quat.slerp(this.targetQuat, 1 - Math.exp(-dt * 10));
    }
    this.mesh.position.copy(this.renderPos);
    this.mesh.quaternion.copy(this.quat);
    this.flash = Math.max(0, this.flash - dt * 5);
    for (const m of this.built.mats) m.emissive.copy(m.userData.baseEmissive).lerp(_white, this.flash);
    for (const f of this.built.flames) {
      const l = 0.6 + this.throttle * 3.0 + Math.random() * 0.3;
      f.flame.scale.set(f.flame.userData.radius, f.flame.userData.radius, l);
      f.mat.uniforms.uTime.value = time;
      f.mat.uniforms.uIntensity.value = 0.5 + this.throttle;
      f.glow.material.opacity = 0.5 + this.throttle * 0.5;
    }
    if (this.built.ringPivot) this.built.ringPivot.rotation.z += dt * (this.def.boss ? 0.25 : 0.8);
    if (this.turrets) {
      // turret heads hold their world aim while the hull turns under them
      _qInv.copy(this.quat).invert();
      for (const t of this.turrets) if (t.alive) t.head.quaternion.copy(_qInv).multiply(t.aimQuat);
      const p = 1 + Math.sin(time * 2.2) * 0.12;
      this.built.core.scale.setScalar(p);
      this.built.coreGlow.material.opacity = 0.75 + Math.sin(time * 2.2) * 0.25;
    }
    if (this.type === 'seeker') {
      this.built.model.rotation.z += dt * 3;
      this.built.model.rotation.x += dt * 1.7;
      const s = 1 + Math.sin(time * 14) * 0.15;
      this.built.core.scale.setScalar(s);
    }
    // warp-in scale pop
    if (this.spawnFx > 0) {
      this.spawnFx = Math.max(0, this.spawnFx - dt * (this.def.boss ? 0.7 : 2.5));
      const s = 1 - this.spawnFx;
      this.mesh.scale.setScalar(Math.max(0.01, s * s * (3 - 2 * s)));
    }
    _tmp.set(0, 0, 1).applyQuaternion(this.quat).multiplyScalar(this.def.boss ? 40 : this.type === 'warden' ? 3.4 : 1.9).add(this.mesh.position);
    if (this.def.boss) this.trail.mesh.visible = false;   // its engine plume is enough; a 90 m trail reads as a laser
    else this.trail.update(dt, _tmp, camPos, 0.35 + this.throttle * 0.9);
  }

  destroy() {
    this.alive = false;
    this.scene.remove(this.mesh);
    this.trail.dispose();
    const mats = new Set();
    this.mesh.traverse((o) => {
      if (o.geometry && !o.isSprite && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material) mats.add(o.material);
    });
    for (const m of mats) m.dispose();
  }
}

