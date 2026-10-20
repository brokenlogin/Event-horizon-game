import * as THREE from 'three';
import { integrate, periapsisEstimate, accelAt, occludedByHole, circularSpeed, ARENA_RADIUS, RS } from './physics.js';
import { shareGeometry, buildRaider, buildWarden, buildSeeker, buildSeeker2, buildDreadnought, buildLancer, buildSower, buildMine, buildAegis } from './ships.js';
import { Trail } from './fx.js';

export const ENEMY_DEFS = {
  raider: {
    hp: 3, accel: 34, turn: 2.0, engageRange: 900, preferred: 150, approach: 45,
    fireRange: 420, boltSpeed: 190, burst: 3, burstGap: 0.13, cooldown: [1.8, 3.0], dmg: 6, aimError: 6,
    score: 100, trailColor: 0xff3a3a, build: buildRaider,
  },
  // keeps its cannon, and launches a seeker drone every ~15 s at a pilot it can see
  warden: {
    hp: 9, accel: 24, turn: 1.0, engageRange: 1000, preferred: 230, approach: 30,
    fireRange: 520, boltSpeed: 150, burst: 1, burstGap: 0, cooldown: [1.6, 2.4], dmg: 9, spread: 5, aimError: 9,
    seekerEvery: 15, seekerRange: 1000,   // s (±7%); custom ADVANCED can change it
    score: 300, trailColor: 0xd050ff, build: buildWarden,
  },
  seeker: {
    seeker: true, hp: 2, accel: 38, turn: 4.0, engageRange: 1200, preferred: 0, approach: 70,
    fireRange: 0, ramDamage: 34, score: 150, trailColor: 0xffb030, build: buildSeeker,
  },
  // wave 14+ replaces seekers: 30% faster, 50% more damage
  seeker2: {
    seeker: true, hp: 2, accel: 38 * 1.3, turn: 4.6, engageRange: 1200, preferred: 0, approach: 70 * 1.3,
    fireRange: 0, ramDamage: 34 * 1.5, score: 225, trailColor: 0xffe680, build: buildSeeker2,
  },
  // wave 6+: a sniper that charges a beam. It aims where you'll be if you keep
  // coasting, then locks for a second before firing, so any thrust then dodges it.
  lancer: {
    hp: 5, accel: 26, turn: 1.6, engageRange: 1400, preferred: 650, approach: 35,
    weapon: 'beam', fireRange: 1100, charge: 2.5, lockAt: 1.35, beamDmg: 36, beamRange: 1500, cooldown: [4.5, 6.5],
    score: 250, trailColor: 0x3dff8a, build: buildLancer,
  },
  // wave 8+: an armoured mine-layer; its mines drift along its orbit
  sower: {
    hp: 8, accel: 18, turn: 0.9, engageRange: 1100, preferred: 420, approach: 25,
    weapon: 'mines', mineEvery: [1.6, 2.4], mineRange: 1000, maxMines: 16,
    score: 300, trailColor: 0xff8a2a, build: buildSower,
  },
  mine: {
    hp: 1, inert: true, noClear: true, noWreck: true, life: 45, arm: 1.5, trigger: 78, blast: 130, blastDmg: 24,
    score: 25, trailColor: 0xff5a2a, build: buildMine,
  },
  // wave 11+: unarmed; ships near it take far less damage until it's destroyed
  aegis: {
    hp: 8, accel: 28, turn: 1.4, engageRange: 1400, preferred: 700, approach: 40,
    weapon: 'none', support: true, shieldRange: 260, shieldMult: 0.1,
    score: 300, trailColor: 0x7a6bff, build: buildAegis,
  },
  // boss: an orbital fortress that holds one low orbit, defended by six turrets (up to twelve on later appearances) and a seeker launcher
  dread: {
    boss: true, hp: 200, accel: 32, turn: 0.4, score: 3000, trailColor: 0xff2a3c, build: buildDreadnought,
    // hunts the nearest pilot: closes at up to `approach` m/s and settles about `standoff` m away.
    // Strong engines (it holds altitude against the hole) but a capped closing speed, so you can outrun it.
    approach: 55, standoff: 550, minRadius: 1000,
    turret: {
      hp: 10, range: 1300, boltSpeed: 240, burst: 3, burstGap: 0.11, cooldown: [1.4, 2.0], dmg: 5, aimError: 6, turn: 1.5, score: 250,
    },
    // seeker launcher: a pair (one per tube) per volley, flung out to the sides to flank
    launchCooldown: [6, 8], launchRange: 2200,
    // launch bay: a raider every 15 s while a pilot is within launchRange
    raiderEvery: 15, maxRaiders: 6,
    // spinal railgun, like a lancer's but heavier and much wider: tracks, locks (aim line flashes), fires
    beam: true, charge: 3.0, lockAt: 1.9, beamDmg: 60, beamRange: 2600, fireRange: 2200, cooldown: [8, 11], muzzle: 48,
  },
};

const _toP = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _des = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _flank = new THREE.Vector3();
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
const _gA = new THREE.Vector3();
const _gB = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _thrustKeep = new THREE.Vector3();

// the bubble drawn around ships an aegis is protecting (shared by all of them)
let shieldMat = null;
function getShieldMaterial() {
  if (shieldMat) return shieldMat;
  shieldMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
        float flick = 0.85 + 0.15 * sin(uTime * 9.0 + vN.y * 6.0);
        gl_FragColor = vec4(vec3(0.45, 0.42, 1.6) * rim * flick, 1.0);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  shieldMat.userData.shared = true;
  return shieldMat;
}
const shieldGeo = new THREE.SphereGeometry(1, 24, 16);
shieldGeo.userData.shared = true;

// network ids: the host numbers its enemies so guests can refer to them
let nextNetId = 1;
export function resetEnemyIds() { nextNetId = 1; }

// Tuning from the custom difficulty's ADVANCED settings (main.js buildTune puts it on
// game.tune). These are the standard values, used if a game has none.
const STANDARD_TUNE = { speed: 1, thrust: 1, fire: {}, burst: {}, seekerEvery: ENEMY_DEFS.warden.seekerEvery, mineRate: 1 };
const tuneOf = (game) => game.tune || STANDARD_TUNE;
/** Seconds until a warden's next seeker launch (±7% so a group doesn't fire in step). */
export function seekerInterval(game) { return tuneOf(game).seekerEvery * (0.93 + Math.random() * 0.14); }

export class Enemy {
  constructor(type, scene, difficulty, netId, turretCount) {
    this.type = type;
    this.def = ENEMY_DEFS[type];
    this.difficulty = difficulty;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.thrust = new THREE.Vector3();
    this.hp = this.def.hp;
    this.maxHp = this.def.hp;
    this.charge = 0;         // lancer: 0 = idle, else 0..1 through the charge
    this.locked = false;     // lancer: aim frozen (the last second before it fires)
    this.lockQuat = new THREE.Quaternion();
    this.shielded = false;   // protected by an aegis
    this.noWreck = !!this.def.noWreck;
    this.alive = true;
    this.flash = 0;
    this.fireTimer = 1.5 + Math.random() * 2.5;
    this.seekerTimer = 6 + Math.random() * 8;   // wardens: first launch a little after arriving
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

    const built = this.def.boss ? this.def.build(turretCount) : this.def.build();
    shareGeometry(this.def.boss ? `${type}:${turretCount}` : type, built.group);
    this.built = built;
    this.mesh = built.group;
    this.radius = built.radius;
    scene.add(this.mesh);
    this.trail = new Trail(scene, { segments: 36, width: this.def.boss ? 1.8 : type === 'warden' || type === 'sower' ? 0.9 : 0.5, color: this.def.trailColor, interval: 0.025 });
    if (this.def.inert) this.trail.mesh.visible = false;
    this.scene = scene;
    if (this.def.boss) this._initBoss();
  }

  // -------------------------------------------------------------------------
  // Lancer: charge, lock, fire
  // -------------------------------------------------------------------------
  /** Where to aim so the beam meets `target` `T` seconds from now if it keeps coasting. */
  _beamAim(target, T, out) {
    out.subVectors(target.vel, this.vel).multiplyScalar(T).add(target.pos);
    accelAt(target.pos, _gA).sub(accelAt(this.pos, _gB));
    return out.addScaledVector(_gA, 0.5 * T * T);
  }

  updateCharge(dt, target, game, canFire, dist, faceTarget) {
    const def = this.def;
    if (this.charge > 0) {
      if (!target.alive || occludedByHole(this.pos, target.pos, 1.3)) {
        this.charge = 0;                       // lost the shot
        this.locked = false;
        this.fireTimer = 1.5;
        return faceTarget;
      }
      this.charge += dt / def.charge;
      const left = Math.max(0, (1 - this.charge) * def.charge);
      if (this.charge * def.charge < def.lockAt) {
        // tracking: steady itself and swing onto the firing solution
        this.thrust.multiplyScalar(0.25);
        return this._beamAim(target, left, _aim);
      }
      if (!this.locked) {
        // lock: freeze the aim on the exact solution, and drift (no thrust) so it holds
        this.locked = true;
        this._beamAim(target, left, _aim);
        _up.set(0, 1, 0).applyQuaternion(this.quat);
        _m.lookAt(this.pos, _aim, _up);
        this.lockQuat.setFromRotationMatrix(_m);
      }
      this.thrust.set(0, 0, 0);
      if (this.charge >= 1) {
        this.quat.copy(this.lockQuat);
        game.lancerFire(this);
        this.charge = 0;
        this.locked = false;
        const [a, b] = def.cooldown;
        // the last lancer standing fires 40% faster
        const lone = this.type === 'lancer' && game.lancersAlive() === 1;
        const rate = this.type === 'lancer' ? tuneOf(game).fire.lancer || 1 : 1;
        this.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.05) / (lone ? 1.4 : 1) / rate;
      }
      return faceTarget;
    }
    this.fireTimer -= dt;
    if (canFire && this.fireTimer <= 0 && dist < def.fireRange && this.age > 2) {
      this.charge = 1e-4;
      this.locked = false;
    }
    return faceTarget;
  }

  /** Aegis protection on/off (bubble drawn around the ship). */
  setShielded(on) {
    if (on === this.shielded) return;
    this.shielded = on;
    if (on && !this.shieldMesh) {
      this.shieldMesh = new THREE.Mesh(shieldGeo, getShieldMaterial());
      this.shieldMesh.scale.setScalar(this.radius * 1.6);
      this.mesh.add(this.shieldMesh);
    }
    if (this.shieldMesh) this.shieldMesh.visible = on;
  }

  // -------------------------------------------------------------------------
  // Boss: station-keeping on a circular orbit, independent turrets, seeker launches
  // -------------------------------------------------------------------------
  _initBoss() {
    const td = this.def.turret;
    this.orbitR = 1350;
    this.orbitN = new THREE.Vector3(0, 1, 0);
    this.orbitV = circularSpeed(this.orbitR);
    this.launchTimer = 5;
    this.raiderTimer = 8;        // first raider out of the bay a little after it arrives
    this.fireTimer = 6;          // first railgun shot a little after it arrives
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
    const target = game.nearestPilot(this.pos);
    const hunting = target && target.alive;
    const r = this.pos.length();
    const radial = _up.copy(this.pos).divideScalar(Math.max(r, 1e-3));
    const desV = _des;
    let dist = Infinity;
    let near = false;
    if (hunting) {
      _toP.subVectors(target.pos, this.pos);
      dist = _toP.length();
      _toP.divideScalar(Math.max(dist, 1e-3));
      const along = -this.pos.dot(_toP);                   // closest approach of the straight line to the hole
      const miss2 = this.pos.lengthSq() - along * along;
      const holeInWay = along > 0 && along < dist && miss2 < def.minRadius * def.minRadius * 1.6;
      near = !holeInWay;
      if (!holeInWay) {
        // close in (no faster than `approach` relative to them) and hold at standoff range,
        // with the gravity difference fed forward so it co-orbits instead of falling behind
        const closing = THREE.MathUtils.clamp((dist - def.standoff) * 0.08, -20, def.approach);
        desV.copy(target.vel).addScaledVector(_toP, closing);
      } else {
        // the hole is in the way: swing round it at orbital speed instead of cutting through
        const route = _tmp.copy(_toP);
        route.addScaledVector(radial, -route.dot(radial));     // drop the part pointing at the hole
        // target more or less straight behind the hole: keep going round the way it's already moving
        if (route.length() < 0.5) route.copy(this.vel).addScaledVector(radial, -this.vel.dot(radial));
        if (route.lengthSq() < 1e-6) route.crossVectors(this.orbitN, radial);
        route.normalize();
        desV.copy(route).multiplyScalar(circularSpeed(Math.max(r, def.minRadius)) + def.approach);
        // and hold a radius near the pilot's, instead of spiralling out
        const rWant = THREE.MathUtils.clamp(target.pos.length(), def.minRadius * 1.1, 2400);
        desV.addScaledVector(radial, THREE.MathUtils.clamp((rWant - r) * 0.15, -40, 40));
      }
    } else {
      // nobody to chase: settle into a circular orbit where it is
      const pro = _tmp.crossVectors(this.orbitN, radial).normalize();
      desV.copy(pro).multiplyScalar(circularSpeed(Math.max(r, def.minRadius)));
    }
    // never sink toward the hole: inward speed is limited to what it can brake before the floor,
    // and below the floor it climbs
    const floor = def.minRadius;
    const vMaxIn = Math.sqrt(2 * 4 * Math.max(r - floor, 0));
    const vIn = desV.dot(radial);
    if (vIn < -vMaxIn) desV.addScaledVector(radial, -vMaxIn - vIn);
    if (r < floor) desV.addScaledVector(radial, (floor - r) * 0.3 + 25);
    this.thrust.subVectors(desV, this.vel).multiplyScalar(0.5);
    if (near && r > floor * 1.3 && target.pos.length() > floor) this.thrust.add(accelAt(target.pos, _gA).sub(accelAt(this.pos, _gB)));
    else if (r < floor * 1.3) this.thrust.sub(accelAt(this.pos, _gB));   // near the floor: hold altitude against gravity
    this.thrust.clampLength(0, def.accel);
    // falling faster than it could stop before the floor (or already under it): all thrust into climbing
    const vr = this.vel.dot(radial);
    const brakeNeeded = vr < 0 ? (vr * vr) / (2 * Math.max(r - floor, 1)) : 0;
    if (r < floor || brakeNeeded > 3) this.thrust.copy(radial).multiplyScalar(def.accel);
    this.throttle = 0.25 + 0.75 * this.thrust.length() / def.accel;

    // nose toward the pilot (the railgun fires along it)
    const blocked = hunting && occludedByHole(this.pos, target.pos, 1.6);
    let face = hunting ? _tmp2.copy(target.pos) : _tmp2.copy(this.pos).add(this.vel);
    const facing = hunting && _fwd.set(0, 0, -1).applyQuaternion(this.quat).dot(_toP) > 0.94;
    if (hunting) {
      // charging normally steadies a lancer by cutting its thrust; the fortress keeps flying
      // but once the shot is locked it coasts, or the aim (worked out from its velocity) would drift
      const thrust = _thrustKeep.copy(this.thrust);
      face = this.updateCharge(dt, target, game, facing && !blocked, dist, face) || face;
      const emergency = r < floor || brakeNeeded > 3;
      if (!this.locked || emergency) this.thrust.copy(thrust);
    }
    if (this.locked) this.quat.copy(this.lockQuat);
    else {
      _m.lookAt(this.pos, face, this.orbitN);
      _tq.setFromRotationMatrix(_m);
      this.quat.rotateTowards(_tq, def.turn * dt);
    }
    this.updateTurretPositions();
    this.aimTurrets(dt, game, true);

    // seeker launcher: a volley whenever a pilot is in range and in sight (a pair solo, one per pilot in multiplayer)
    this.launchTimer -= dt;
    if (this.launchTimer <= 0 && this.age > 4) {
      const ok = hunting && dist < def.launchRange && !blocked;
      let launched = false;
      if (ok) launched = game.bossVolley(this);
      if (launched) {
        const [a, b] = def.launchCooldown;
        this.launchTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.04);
      } else this.launchTimer = ok ? 2 : 1;
    }
    // launch bay: a raider while a pilot is close
    if (hunting && dist < def.launchRange && !blocked && this.age > 4 && (this.raiderTimer -= dt) <= 0) {
      this.raiderTimer = def.raiderEvery;
      game.bossRaider(this);
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
        if (dist < td.range * 1.4 && _toP.dot(t.worldN) > -0.25 * dist && !occludedByHole(t.pos, target.pos, 1.6)) {   // each covers its side and the arc ahead
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
          const tn = tuneOf(game);
          t.burstLeft = tn.burst.turret ?? td.burst;
          t.burstTimer = 0;
          const [a, b] = td.cooldown;
          t.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.06) / (tn.fire.turret || 1);
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
    if (def.inert) { this.age += dt; this.thrust.set(0, 0, 0); this.throttle = 0; return; }   // mines just orbit
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
    // aggressive (a share of each wave, rotating; see pickAggressors in main.js): hunts its
    // pilot from any range, closes faster and fights from closer in
    const aggro = this.aggro > 0;
    if (aggro) this.aggro -= dt;
    const tn = tuneOf(game);
    const accel = def.accel * (1 + this.difficulty * 0.05) * (aggro ? 1.25 : 1) * tn.thrust;

    let faceTarget = null;
    const rp = periapsisEstimate(this.pos, this.vel);
    // feed-forward the difference in gravity between us and the player, so
    // relative-motion steering behaves as it would in free space
    const gDiff = _gP.copy(accelAt(player.pos, _gP)).sub(accelAt(this.pos, _gE));
    // (seekers are homing drones: they always chase, from any range)
    const engaged = player.alive && (aggro || def.seeker || dist < def.engageRange);

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
    } else if (def.support) {
      // aegis: shadow the nearest ally, keeping it between us and the pilot
      const ally = game.supportTarget(this);
      if (ally) {
        _aim.subVectors(ally.pos, player.pos).normalize().multiplyScalar(90).add(ally.pos);
        _des.subVectors(_aim, this.pos);
        const d = _des.length();
        _des.multiplyScalar(Math.min(60, d * 0.5) / Math.max(d, 1e-3));
        _des.sub(_tmp2.subVectors(this.vel, ally.vel)).multiplyScalar(0.9);
        _des.add(accelAt(ally.pos, _gA).sub(accelAt(this.pos, _gB)));
        this.thrust.copy(_des).clampLength(0, accel);
        faceTarget = _tmp2.copy(ally.pos);
      } else if (player.alive) {
        // alone: keep its distance
        _des.copy(dirP).multiplyScalar(THREE.MathUtils.clamp((dist - def.preferred) * 0.3, -40, 30));
        _des.sub(_rel).multiplyScalar(0.8).add(gDiff);
        this.thrust.copy(_des).clampLength(0, accel);
      }
    } else if (engaged) {
      if (def.seeker) {
        // pure pursuit with relative-velocity steering; it overshoots and can be dodged.
        // The dreadnought's flank first: they aim beside the pilot, then curve in from the side.
        let chase = dirP;
        if (this.flankT > 0 && dist > 250) {
          this.flankT -= dt;
          _flank.copy(this.flankDir).addScaledVector(dirP, -this.flankDir.dot(dirP));   // across the line to the pilot
          if (_flank.lengthSq() > 1e-4) {
            chase = _flank.normalize().multiplyScalar(Math.min(dist * 0.9, 500)).add(player.pos).sub(this.pos).normalize();
          }
        } else this.flankT = 0;   // close in: from here it's a straight chase
        _des.copy(chase).multiplyScalar((def.approach + this.difficulty * 3) * tn.speed);
        _des.sub(_rel).multiplyScalar(1.2).add(gDiff);
        this.thrust.copy(_des).clampLength(0, accel);
        faceTarget = chase === dirP ? _tmp2.copy(player.pos) : _tmp2.copy(this.pos).addScaledVector(chase, 100);
      } else {
        const preferred = def.preferred * (aggro ? 0.6 : 1);
        const closing = THREE.MathUtils.clamp((dist - preferred) * 0.3, -30 * tn.speed, def.approach * (aggro ? 1.8 : 1) * tn.speed);
        _des.copy(dirP).multiplyScalar(closing);
        // jink sideways so they're harder to hit
        _up.set(0, 1, 0).applyQuaternion(this.quat);
        _tmp2.crossVectors(dirP, _up).normalize();
        _des.addScaledVector(_tmp2, Math.sin(this.age * 0.9 + this.phase) * 22);
        _des.addScaledVector(_up, Math.cos(this.age * 0.7 + this.phase * 2) * 10);
        _des.sub(_rel).multiplyScalar(0.9).add(gDiff);
        this.thrust.copy(_des).clampLength(0, accel);
        // aim with an imperfect lead and a per-burst aiming error (see rollAim)
        const t = def.boltSpeed ? (dist / def.boltSpeed) * this.leadFactor : 0;   // gunless types just face you
        faceTarget = _tmp2.copy(player.pos).addScaledVector(player.vel, t).addScaledVector(this.vel, -t).add(this.aimErr);
      }
    } else if (player.alive) {
      // patrol: drift in orbit, nudging gently toward the player
      _des.copy(dirP).multiplyScalar(55).sub(_rel).multiplyScalar(0.5).clampLength(0, accel * 0.6);
      this.thrust.copy(_des);
    }

    if (def.weapon === 'beam') faceTarget = this.updateCharge(dt, player, game, engaged && !blocked, dist, faceTarget);

    // turn toward target (or along velocity when idle); a locked lancer holds its aim
    if (this.locked) {
      this.quat.copy(this.lockQuat);
    } else {
      if (!faceTarget) faceTarget = _tmp2.copy(this.pos).add(this.vel);
      _up.set(0, 1, 0).applyQuaternion(this.quat);
      _m.lookAt(this.pos, faceTarget, _up);
      _tq.setFromRotationMatrix(_m);
      this.quat.rotateTowards(_tq, def.turn * dt);
    }
    this.throttle = this.thrust.length() / accel;

    if (def.weapon === 'mines') {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0 && player.alive && dist < def.mineRange && this.age > 2) {
        const [a, b] = def.mineEvery;
        this.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.04) / tn.mineRate;
        game.layMine(this);
      }
    }

    // guns
    if (!def.weapon && !def.seeker && engaged && !blocked) {
      this.fireTimer -= dt;
      const fwd = this.forward;
      const aimDir = _tmp.subVectors(faceTarget, this.pos).normalize();
      const aligned = fwd.dot(aimDir) > 0.985;
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          this.burstLeft--;
          this.burstTimer = def.burstGap || 0.15;   // (wardens normally fire single shots)
          game.enemyFire(this);
        }
      } else if (this.fireTimer <= 0 && aligned && dist < def.fireRange && this.age > 1.5) {
        this.burstLeft = tn.burst[this.type] ?? def.burst;
        this.burstTimer = 0;
        const [a, b] = def.cooldown;
        this.fireTimer = (a + Math.random() * (b - a)) / (1 + this.difficulty * 0.06) / (tn.fire[this.type] || 1);
        this.rollAim();
      }
    }

    // seeker launcher (wardens)
    if (def.seekerEvery && engaged && !blocked && dist < def.seekerRange && this.age > 3) {
      this.seekerTimer -= dt;
      if (this.seekerTimer <= 0) {
        this.seekerTimer = seekerInterval(game);
        game.wardenLaunch(this);
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
    if (this.def.weapon === 'beam' || this.def.beam) {
      this.charge = s.ch || 0;
      this.locked = this.charge * this.def.charge >= this.def.lockAt;
    }
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

  updateVisual(dt, camPos, time, viewVel) {
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
    if (this.proxy) this.age += dt;          // hosts age enemies in think(); proxies here
    if (this.built.ringPivot) {
      if (this.type === 'sower') this.built.ringPivot.rotation.y += dt * 0.7;
      else if (this.type === 'aegis') { this.built.ringPivot.rotation.x += dt * 1.1; this.built.ringPivot.rotation.y += dt * 0.7; }
      else this.built.ringPivot.rotation.z += dt * (this.def.boss ? 0.25 : 0.8);
    }
    if (this.built.telegraph) {
      const b = this.built;
      const c = this.charge;
      b.emitterGlow.material.opacity = c > 0 ? 0.3 + 0.7 * c : 0;
      b.emitter.scale.setScalar(1 + c * 1.6);
      b.telegraph.visible = c > 0;
      if (c > 0) b.telegraph.material.opacity = this.locked ? ((time * 14) % 1 < 0.5 ? 0.95 : 0.45) : 0.06 + 0.22 * (c * this.def.charge / this.def.lockAt);
    } else if (this.type === 'mine') {
      const armed = this.age > this.def.arm;
      const rate = this.alert ? 7 : armed ? 2 : 0.7;
      this.built.light.material.opacity = (time * rate + this.phase) % 1 < 0.35 ? 1 : armed ? 0.15 : 0.05;
      this.built.model.rotation.y += dt * 0.6;
    } else if (this.type === 'aegis') {
      this.built.core.scale.set(1, 1.5, 1).multiplyScalar(1 + Math.sin(time * 4 + this.phase) * 0.12);
    }
    if (this.shieldMesh && this.shielded) shieldMat.uniforms.uTime.value = time;
    if (this.turrets) {
      // turret heads hold their world aim while the hull turns under them
      _qInv.copy(this.quat).invert();
      for (const t of this.turrets) if (t.alive) t.head.quaternion.copy(_qInv).multiply(t.aimQuat);
      const p = 1 + Math.sin(time * 2.2) * 0.12;
      this.built.core.scale.setScalar(p);
      this.built.coreGlow.material.opacity = 0.75 + Math.sin(time * 2.2) * 0.25;
    }
    if (this.def.seeker) {
      this.built.spin.rotation.z += dt * 3;
      const s = 1 + Math.sin(time * 14) * 0.15;
      this.built.core.scale.setScalar(s);
    }
    // warp-in scale pop
    if (this.spawnFx > 0) {
      this.spawnFx = Math.max(0, this.spawnFx - dt * (this.def.boss ? 0.7 : 2.5));
      const s = 1 - this.spawnFx;
      this.mesh.scale.setScalar(Math.max(0.01, s * s * (3 - 2 * s)));
    }
    // the trail starts at the engine's mouth (where the model says it is, else just behind the hull)
    if (this.built.exhaust) _tmp.copy(this.built.exhaust).multiplyScalar(this.mesh.scale.x);
    else _tmp.set(0, 0, this.def.boss ? 40 : this.type === 'warden' ? 3.4 : 1.9);
    _tmp.applyQuaternion(this.quat).add(this.mesh.position);
    if (this.def.boss || this.def.inert) this.trail.mesh.visible = false;   // the boss's plume is enough; mines have none
    // a seeker's trail is drawn in the viewer's frame, so it streams out behind the drone
    // along the line it's chasing you on (in the hole's frame it would trail along the orbit)
    else this.trail.update(dt, _tmp, camPos, 0.35 + this.throttle * 0.9, this.def.seeker ? viewVel : null);
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
    for (const m of mats) if (!m.userData.shared) m.dispose();
  }
}

