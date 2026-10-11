import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import {
  RS, ISCO, DISK_IN, DISK_OUT, ARENA_RADIUS,
  integrate, circularSpeed, circularOrbitState, createPrediction, predictTrajectory,
  gravityAt, occludedByHole,
} from './physics.js';
import { createBlackHole } from './blackhole.js';
import { buildPlayerShip } from './ships.js';
import { BoltPool, Particles, Trail, createDust } from './fx.js';
import { Enemy } from './enemies.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { MissileSystem } from './missiles.js';

// ===========================================================================
// Tunables
// ===========================================================================
const FIXED_DT = 1 / 120;
const MAIN_THRUST = 16;
const RETRO_THRUST = 9;
const SIDE_THRUST = 10;
const BOLT_SPEED = 340;
const BOLT_LIFE = 2.4;
const BOLT_DAMAGE = 1;
const FIRE_INTERVAL = 0.085;
const HEAT_PER_SHOT = 0.055;
const CONVERGE_DIST = 250;
const ROLL_RATE = 2.0;
const START_RADIUS = 1100;
const DANGER_CLOSE = 750;            // kills inside this radius score double
const TIDAL_RADIUS = 3.4 * RS;       // tidal stress starts here

const QUALITY = {
  HIGH: { ratio: 1.5, label: 'HIGH' },
  MEDIUM: { ratio: 1.0, label: 'MEDIUM' },
  LOW: { ratio: 0.7, label: 'LOW' },
};

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ===========================================================================
// Renderer / scene
// ===========================================================================
const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);
const canvas = renderer.domElement;

let qualityKey = store.get('eh_quality', 'HIGH');
if (!QUALITY[qualityKey]) qualityKey = 'HIGH';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 40000);

const blackHole = createBlackHole(renderer);
scene.add(blackHole.mesh);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromCubemap(blackHole.skyTexture).texture;

// The accretion disk is the key light; a cool fill from the galactic band.
const diskLight = new THREE.PointLight(0xffb070, 4500, 0, 1);
scene.add(diskLight);
const fill = new THREE.DirectionalLight(0x7088ff, 0.7);
fill.position.set(-0.4, 1, 0.6);
scene.add(fill);
scene.add(new THREE.AmbientLight(0x30406a, 0.6));

// pooled flash lights for explosions (constant light count -> no shader recompiles)
const flashLights = [];
for (let i = 0; i < 3; i++) {
  const l = new THREE.PointLight(0xffa050, 0, 160, 2);
  l.userData.t = 0;
  scene.add(l);
  flashLights.push(l);
}
let flashIdx = 0;

const dust = createDust(scene);
const particles = new Particles(scene, 9000);
const playerBolts = new BoltPool(scene, { max: 400, color: 0x4af0ff, radius: 0.07, length: 4.5, glowRadius: 0.24 });
const enemyBolts = new BoltPool(scene, { max: 500, color: 0xff3050, radius: 0.16, length: 3.5, glowRadius: 0.55 });

// --- predicted orbit line ---
const pred = createPrediction(720);
const orbitGeo = new THREE.BufferGeometry();
orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(720 * 3), 3).setUsage(THREE.DynamicDrawUsage));
orbitGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(720 * 3), 3).setUsage(THREE.DynamicDrawUsage));
const orbitLine = new THREE.Line(orbitGeo, new THREE.LineBasicMaterial({
  vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
orbitLine.frustumCulled = false;
scene.add(orbitLine);

// --- shockwave rings & debris pools ---
const ringGeo = new THREE.RingGeometry(0.94, 1, 64);
const shockwaves = [];
for (let i = 0; i < 8; i++) {
  const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: 0xffb070, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  }));
  m.visible = false;
  m.userData = { t: 0, life: 0.6, size: 20, vel: new THREE.Vector3() };
  scene.add(m);
  shockwaves.push(m);
}
const debrisGeos = [new THREE.TetrahedronGeometry(0.5), new THREE.BoxGeometry(0.7, 0.2, 0.5), new THREE.TetrahedronGeometry(0.35)];
const debris = [];
for (let i = 0; i < 90; i++) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.7, roughness: 0.5, emissive: new THREE.Color(0xff6a20), emissiveIntensity: 0 });
  const m = new THREE.Mesh(debrisGeos[i % 3], mat);
  m.visible = false;
  m.userData = { vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 };
  scene.add(m);
  debris.push(m);
}
let debrisIdx = 0;

// --- post-processing ---
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null }, uDamage: { value: 0 }, uAberration: { value: 0 }, uTime: { value: 0 }, uFade: { value: 0 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uDamage; uniform float uAberration; uniform float uTime; uniform float uFade;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 c = vUv - 0.5;
      float d = length(c);
      vec2 off = c * (0.004 + uAberration);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= mix(1.0, smoothstep(0.95, 0.2, d), 0.6);
      float edge = smoothstep(0.2, 0.75, d);
      col = mix(col, vec3(1.2, 0.03, 0.05) + col * 0.4, clamp(uDamage, 0.0, 1.0) * edge);
      col += (h(vUv * 917.0 + fract(uTime) * 31.0) - 0.5) * 0.008;
      col *= 1.0 - uFade;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

const composerRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, composerRT);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 1.0);
composer.addPass(bloom);
const finalPass = new ShaderPass(FinalShader);
composer.addPass(finalPass);
composer.addPass(new OutputPass());

function applyQuality() {
  const ratio = Math.min(window.devicePixelRatio || 1, QUALITY[qualityKey].ratio);
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  onResize();
  document.getElementById('btn-quality').textContent = `GRAPHICS: ${QUALITY[qualityKey].label}`;
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
}
window.addEventListener('resize', onResize);

// ===========================================================================
// Audio / HUD
// ===========================================================================
const audio = new GameAudio();
const hud = new HUD();

// ===========================================================================
// Player
// ===========================================================================
const shipParts = buildPlayerShip();
scene.add(shipParts.group);
shipParts.group.visible = false;

const player = {
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  thrustAcc: new THREE.Vector3(),
  alive: false,
  radius: 1.6,              // hitbox: covers the fuselage; wingtips are forgiving
  hull: 100, shield: 100, heat: 0, overheated: false,
  shieldDelay: 0, fireCd: 0, gun: 0,
  pendingYaw: 0, pendingPitch: 0, yawRate: 0, pitchRate: 0,
  throttle: 0,
};
const playerTrails = [
  new Trail(scene, { segments: 50, width: 0.11, color: 0x3fc8ff, interval: 0.02, fadeNear: 30 }),
  new Trail(scene, { segments: 50, width: 0.11, color: 0x3fc8ff, interval: 0.02, fadeNear: 30 }),
];
for (const t of playerTrails) t.mesh.visible = false;

// ===========================================================================
// Input
// ===========================================================================
const keys = new Set();
let firing = false;
let sensitivity = store.get('eh_sens', 1);
let invertY = store.get('eh_invert', false);
let hadLock = false;

window.addEventListener('keydown', (e) => {
  if (['Space', 'ShiftLeft', 'ShiftRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyZ', 'KeyC'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (state === 'playing' && player.alive && !e.repeat) {
    if (e.code === 'KeyE') missiles.pressLock();
    if (e.code === 'KeyQ') missiles.fire();
  }
  if ((e.code === 'KeyP' || (e.code === 'Escape' && document.pointerLockElement !== canvas)) && state === 'playing') pauseGame();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); firing = false; });

document.addEventListener('mousemove', (e) => {
  if (state !== 'playing' || !player.alive) return;
  const s = 0.0021 * sensitivity;
  player.pendingYaw -= e.movementX * s;
  player.pendingPitch -= e.movementY * s * (invertY ? -1 : 1);
});
canvas.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (document.pointerLockElement !== canvas) requestLock();
  if (e.button === 0) firing = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
window.addEventListener('contextmenu', (e) => e.preventDefault());

function requestLock() {
  const plain = () => {
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { /* ignore */ }
  };
  try {
    const p = canvas.requestPointerLock({ unadjustedMovement: true });
    if (p && p.catch) p.catch(plain);
  } catch {
    plain();
  }
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) hadLock = true;
  if (!locked && state === 'playing' && hadLock) pauseGame();
});

// ===========================================================================
// Game state
// ===========================================================================
let state = 'menu';
const game = {
  score: 0, wave: 0, kills: 0, mult: 1, comboTimer: 0,
  enemies: [], spawnQueue: [], spawnTimer: 0, waveTimer: -1, waveActive: false,
  time: 0, timeScale: 1, deathTimer: 0, deathCause: '', trauma: 0, damageFlash: 0,
  warnBeep: 0, proximityBeep: 0, plasmaFx: 0,
  enemyFire,
};
let best = store.get('eh_best', 0);

const camQuat = new THREE.Quaternion();
const camOffset = new THREE.Vector3();
let fovKick = 0;
let accumulator = 0;

// scratch
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const scr = {};

function forwardOf(q, out) { return out.set(0, 0, -1).applyQuaternion(q); }

// ===========================================================================
// Effects
// ===========================================================================
function rand(a, b) { return a + Math.random() * (b - a); }
function randDir(out) {
  const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(t), s * Math.sin(t), u);
}

function explode(pos, vel, scale = 1, tint = [1.0, 0.45, 0.12]) {
  const d = _v3;
  for (let i = 0; i < 80 * scale; i++) {
    randDir(d);
    const sp = rand(3, 30) * scale;
    particles.emit(pos.x, pos.y, pos.z, vel.x + d.x * sp, vel.y + d.y * sp, vel.z + d.z * sp,
      tint[0] * rand(0.5, 1.0), tint[1] * rand(0.45, 1.0), tint[2] * rand(0.4, 1.0),
      rand(1.2, 2.4) * scale, rand(4, 7) * scale, rand(0.5, 1.3), true);
  }
  for (let i = 0; i < 50 * scale; i++) {
    randDir(d);
    const sp = rand(30, 95) * Math.sqrt(scale);
    particles.emit(pos.x, pos.y, pos.z, vel.x + d.x * sp, vel.y + d.y * sp, vel.z + d.z * sp,
      1.6, 1.1, 0.6, 0.35, 0.15, rand(0.8, 2.2), true);
  }
  particles.emit(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, 1.4, 0.9, 0.55, 7 * scale, 20 * scale, 0.25, true);
  // shockwave
  const sw = shockwaves.find((s) => !s.visible) || shockwaves[0];
  sw.visible = true;
  sw.position.copy(pos);
  sw.userData.t = 0; sw.userData.life = 0.5; sw.userData.size = 17 * scale;
  sw.userData.vel.copy(vel);
  sw.material.color.setRGB(tint[0] * 1.3, tint[1] * 1.3, tint[2] * 1.3);
  // debris
  for (let i = 0; i < 9 * scale; i++) {
    const m = debris[debrisIdx];
    debrisIdx = (debrisIdx + 1) % debris.length;
    m.visible = true;
    m.position.copy(pos);
    randDir(d);
    m.userData.vel.copy(vel).addScaledVector(d, rand(8, 30));
    m.userData.spin.set(rand(-6, 6), rand(-6, 6), rand(-6, 6));
    m.userData.life = rand(4, 8);
    m.material.emissiveIntensity = 3;
    m.scale.setScalar(rand(0.6, 1.6) * Math.sqrt(scale));
  }
  // light flash
  const l = flashLights[flashIdx];
  flashIdx = (flashIdx + 1) % flashLights.length;
  l.position.copy(pos);
  l.userData.t = 1;
  l.userData.peak = 1400 * scale;
  l.userData.vel = vel.clone();
}

function sparks(pos, vel, n, r, g, b, speed = 25) {
  for (let i = 0; i < n; i++) {
    randDir(_v3);
    const sp = rand(0.3, 1) * speed;
    particles.emit(pos.x, pos.y, pos.z, vel.x + _v3.x * sp, vel.y + _v3.y * sp, vel.z + _v3.z * sp, r, g, b, 0.5, 0.1, rand(0.2, 0.6), false);
  }
}

function updateEffects(dt) {
  for (const s of shockwaves) {
    if (!s.visible) continue;
    s.userData.t += dt;
    const t = s.userData.t / s.userData.life;
    if (t >= 1) { s.visible = false; continue; }
    s.position.addScaledVector(s.userData.vel, dt);
    const k = 1 - Math.pow(1 - t, 3);
    s.scale.setScalar(0.5 + k * s.userData.size);
    s.material.opacity = (1 - t) * (1 - t) * 0.6;
    s.lookAt(camera.position);
  }
  for (const m of debris) {
    if (!m.visible) continue;
    const u = m.userData;
    u.life -= dt;
    const r = m.position.length();
    if (u.life <= 0 || r < RS) { m.visible = false; continue; }
    integrate(m.position, u.vel, null, dt);
    m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
    m.material.emissiveIntensity = Math.max(0, m.material.emissiveIntensity - dt * 1.2);
    if (Math.random() < 0.3) particles.emit(m.position.x, m.position.y, m.position.z, u.vel.x, u.vel.y, u.vel.z, 0.9, 0.35, 0.1, 0.6, 1.6, 0.5, true);
  }
  for (const l of flashLights) {
    if (l.userData.t <= 0) { l.intensity = 0; continue; }
    l.userData.t = Math.max(0, l.userData.t - dt * 3);
    l.intensity = l.userData.peak * l.userData.t * l.userData.t;
    if (l.userData.vel) l.position.addScaledVector(l.userData.vel, dt);
  }
}

// ===========================================================================
// Spawning & waves
// ===========================================================================
function waveComposition(n) {
  const list = [];
  const raiders = Math.min(2 + n, 9);
  const seekers = n >= 2 ? Math.min(Math.floor(n / 1.5), 6) : 0;
  const wardens = n >= 3 ? Math.min(Math.floor((n - 1) / 2), 4) : 0;
  for (let i = 0; i < raiders; i++) list.push('raider');
  for (let i = 0; i < seekers; i++) list.push('seeker');
  for (let i = 0; i < wardens; i++) list.push('warden');
  // shuffle
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

function startWave(n) {
  game.wave = n;
  game.spawnQueue = waveComposition(n);
  game.spawnTimer = 1.2;
  game.waveActive = true;
  const restocked = missiles.ammo < 2;
  missiles.refill();
  hud.banner(`WAVE ${n}`, `${game.spawnQueue.length} HOSTILE SIGNATURES INBOUND${restocked ? ' · MISSILES REARMED' : ''}`, 2800);
  audio.waveStart();
}

function spawnEnemy(type) {
  const e = new Enemy(type, scene, game.wave - 1);
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  // about a third of the gunships spawn on the far side of the hole
  const farSide = type !== 'seeker' && Math.random() < 0.35;
  for (let tries = 0; tries < 40; tries++) {
    const r = type === 'seeker' ? rand(800, 1400) : rand(750, 1900);
    // mostly prograde, modest inclinations: orbital speeds are high, so a
    // retrograde or steeply inclined orbit would make for blink-and-miss passes
    const normal = new THREE.Vector3(rand(-0.3, 0.3), 1, rand(-0.3, 0.3)).normalize();
    circularOrbitState(r, normal, rand(0, Math.PI * 2), pos, vel, rand(0.93, 1.07));
    const d = pos.distanceTo(player.pos);
    if (farSide ? d > 1600 && occludedByHole(pos, player.pos, 1.2) : d > 400 && d < 1100) break;
  }
  e.pos.copy(pos);
  e.vel.copy(vel);
  e.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(vel), new THREE.Vector3(0, 1, 0)));
  e.mesh.position.copy(pos);
  e.mesh.scale.setScalar(0.01);
  e.trail.reset(pos);
  game.enemies.push(e);
  // warp-in flash
  for (let i = 0; i < 40; i++) {
    randDir(_v3);
    const sp = rand(10, 40);
    particles.emit(pos.x + _v3.x * 8, pos.y + _v3.y * 8, pos.z + _v3.z * 8, vel.x - _v3.x * sp, vel.y - _v3.y * sp, vel.z - _v3.z * sp,
      1.2, 0.5, 1.6, 1.2, 0.2, 0.4, false);
  }
  particles.emit(pos.x, pos.y, pos.z, vel.x, vel.y, vel.z, 2, 1.2, 3, 4, 22, 0.35, false);
  const d = pos.distanceTo(player.pos);
  if (d < 600) audio.warp();
}

function enemyFire(e) {
  const def = e.def;
  const fwd = forwardOf(e.quat, _v1);
  _up.set(0, 1, 0).applyQuaternion(e.quat);
  const muzzle = _v2.copy(e.pos).addScaledVector(fwd, e.radius * 0.9);
  const shots = def.spread || 1;
  const accuracy = Math.max(0.01, 0.022 - e.difficulty * 0.0012);  // per-shot jitter (rad)
  for (let k = 0; k < shots; k++) {
    const off = shots > 1 ? (k - (shots - 1) / 2) * 0.06 : 0;
    const dir = _v3.copy(fwd).applyAxisAngle(_up, off);
    dir.x += rand(-accuracy, accuracy); dir.y += rand(-accuracy, accuracy); dir.z += rand(-accuracy, accuracy);
    dir.normalize();
    enemyBolts.spawn(muzzle, _q1Vec.copy(e.vel).addScaledVector(dir, def.boltSpeed), 4.2, def.dmg);
  }
  particles.emit(muzzle.x, muzzle.y, muzzle.z, e.vel.x, e.vel.y, e.vel.z, 2.5, 0.4, 0.5, 2.5, 0.5, 0.12, false);
  const dist = e.pos.distanceTo(player.pos);
  audio.enemyLaser(THREE.MathUtils.clamp(1.3 - dist / 500, 0, 1), e.type === 'warden');
}
const _q1Vec = new THREE.Vector3();

function killEnemy(e, cause) {
  if (!e.alive) return;
  const scale = e.type === 'warden' ? 1.8 : e.type === 'seeker' ? 0.9 : 1.15;
  const tint = e.type === 'warden' ? [1.0, 0.35, 1.0] : e.type === 'seeker' ? [1.0, 0.7, 0.15] : [1.0, 0.42, 0.12];
  const dist = e.pos.distanceTo(player.pos);
  if (cause === 'void') { e.destroy(); return; }
  if (cause !== 'horizon') explode(e.pos, e.vel, scale, tint);
  audio.explosion(scale, THREE.MathUtils.clamp(1.4 - dist / 700, 0.15, 1));
  if (dist < 60) game.trauma = Math.min(1, game.trauma + 0.35);

  let pts = 0;
  let sub = '';
  if (cause === 'player' || cause === 'ram' || cause === 'missile') {
    game.mult = game.comboTimer > 0 ? Math.min(game.mult + 1, 5) : 1;
    game.comboTimer = 5;
    const dangerClose = player.pos.length() < DANGER_CLOSE;
    pts = e.def.score * game.mult * (dangerClose ? 2 : 1);
    sub = dangerClose ? 'DANGER CLOSE ×2' : (game.mult > 1 ? `COMBO ×${game.mult}` : '');
    if (cause === 'ram') sub = 'RAMMED';
    if (cause === 'missile') sub = dangerClose ? 'MISSILE · DANGER CLOSE ×2' : 'MISSILE KILL';
    game.kills++;
    hud.hitmarker(true);
  } else if (cause === 'horizon') {
    pts = Math.round(e.def.score * 0.5);
    sub = 'CONSUMED BY SINGULARITY';
    game.kills++;
  }
  if (pts > 0) {
    game.score += pts;
    hud.project(e.pos, camera, scr);
    if (scr.onScreen) hud.popup(scr.x, scr.y, `+${pts}`, sub);
    else hud.popup(innerWidth / 2, innerHeight * 0.36, `+${pts}`, sub);
  }
  e.destroy();
}

// ===========================================================================
// Player actions
// ===========================================================================
function hitEnemy(e, dmg, point, cause = 'player') {
  if (!e.alive) return;
  e.hp -= dmg;
  e.flash = 1;
  sparks(point, e.vel, 10, 0.5, 1.6, 2.2, 30);
  audio.hitConfirm();
  if (e.hp <= 0) killEnemy(e, cause);
  else hud.hitmarker(false);
}

const missiles = new MissileSystem({
  scene, particles, audio, hud, player, camera,
  enemies: () => game.enemies,
  explode, hitEnemy, damagePlayer,
});

function damagePlayer(amount, opts = {}) {
  if (!player.alive) return;
  player.shieldDelay = 2.6;
  let rem = amount;
  const hadShield = player.shield > 0;
  if (player.shield > 0) {
    const a = Math.min(player.shield, rem);
    player.shield -= a;
    rem -= a;
  }
  player.hull -= rem;
  if (!opts.silent) {
    game.trauma = Math.min(1, game.trauma + amount * 0.025);
    game.damageFlash = Math.min(1, game.damageFlash + (rem > 0 ? 0.6 : 0.3));
    audio.hit(hadShield && rem <= 0);
  } else {
    game.damageFlash = Math.min(0.6, game.damageFlash + amount * 0.02);
  }
  if (player.hull <= 0) killPlayer(opts.cause || 'SHIP DESTROYED');
}

function killPlayer(cause) {
  if (!player.alive) return;
  player.alive = false;
  game.deathCause = cause;
  game.deathTimer = 0;
  missiles.cancelLock(true);
  state = 'dead';
  firing = false;
  audio.silenceEngine();
  if (cause !== 'CROSSED THE EVENT HORIZON') {
    explode(player.pos, player.vel, 1.6, [0.4, 0.8, 1.2]);
    explode(player.pos, player.vel, 1.0, [1.0, 0.5, 0.15]);
    audio.explosion(1.8, 1);
    shipParts.group.visible = false;
    game.trauma = 1;
  }
  game.timeScale = 0.35;
}

function firePlayer(lockInfo) {
  const fwd = forwardOf(player.quat, _fwd);
  const local = shipParts.muzzles[player.gun];
  player.gun = 1 - player.gun;
  const muzzle = _v1.copy(local).applyQuaternion(player.quat).add(player.pos);
  let dir;
  if (lockInfo && lockInfo.assist) {
    dir = _v2.subVectors(lockInfo.aim, muzzle).normalize();
  } else {
    dir = _v2.copy(player.pos).addScaledVector(fwd, CONVERGE_DIST).sub(muzzle).normalize();
  }
  _v3.copy(player.vel).addScaledVector(dir, BOLT_SPEED);
  playerBolts.spawn(muzzle, _v3, BOLT_LIFE, BOLT_DAMAGE);
  particles.emit(muzzle.x, muzzle.y, muzzle.z, player.vel.x + dir.x * 20, player.vel.y + dir.y * 20, player.vel.z + dir.z * 20, 0.6, 2.2, 3, 1.4, 0.3, 0.07, false);
  player.heat += HEAT_PER_SHOT;
  if (player.heat >= 1) { player.heat = 1; player.overheated = true; audio.beep(220, 0.25, 0.08, 'sawtooth'); }
  audio.laser(player.gun ? 0.35 : -0.35);
  game.trauma = Math.min(1, game.trauma + 0.03);
}

// ===========================================================================
// Game lifecycle
// ===========================================================================
function clearWorld() {
  for (const e of game.enemies) if (e.alive) e.destroy();
  game.enemies.length = 0;
  playerBolts.clear();
  enemyBolts.clear();
  missiles.clear();
  particles.clear();
  for (const d of debris) d.visible = false;
  for (const s of shockwaves) s.visible = false;
}

function startGame() {
  clearWorld();
  Object.assign(game, {
    score: 0, wave: 0, kills: 0, mult: 1, comboTimer: 0, spawnQueue: [], spawnTimer: 0, waveTimer: 2.5, waveActive: false,
    time: 0, timeScale: 1, deathTimer: 0, trauma: 0, damageFlash: 0,
  });
  Object.assign(player, {
    alive: true, hull: 100, shield: 100, heat: 0, overheated: false, shieldDelay: 0, fireCd: 0, gun: 0,
    pendingYaw: 0, pendingPitch: 0, yawRate: 0, pitchRate: 0, throttle: 0,
  });
  const normal = new THREE.Vector3(0.12, 1, 0.08).normalize();
  circularOrbitState(START_RADIUS, normal, Math.PI * 0.25, player.pos, player.vel);
  // face mostly prograde, angled toward the hole so it's in view
  const pro = _v1.copy(player.vel).normalize();
  const inward = _v2.copy(player.pos).normalize().negate();
  const look = pro.multiplyScalar(Math.cos(0.6)).addScaledVector(inward, Math.sin(0.6)).normalize();
  // Matrix4.lookAt aims -Z at the target
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), look, normal);
  player.quat.setFromRotationMatrix(m);
  camQuat.copy(player.quat);
  shipParts.group.visible = true;
  shipParts.model.scale.set(1, 1, 1);
  for (const t of playerTrails) { t.mesh.visible = true; t.reset(player.pos); }
  orbitLine.visible = true;
  hud.show(true);
  hud.clearPopups();
  hud.banner('ORBIT ESTABLISHED', 'HOSTILES APPROACHING · STAND BY', 2400);
  state = 'playing';
  setOverlay(null);
  document.body.style.cursor = 'none';
}

function pauseGame() {
  if (state !== 'playing') return;
  state = 'paused';
  firing = false;
  keys.clear();
  audio.silenceEngine();
  setOverlay('pause');
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

function resumeGame() {
  if (state !== 'paused') return;
  state = 'playing';
  setOverlay(null);
  document.body.style.cursor = 'none';
  if (missiles.lockState === 'locked') audio.setLockTone(true);
  requestLock();
}

function toMenu() {
  clearWorld();
  state = 'menu';
  player.alive = false;
  shipParts.group.visible = false;
  for (const t of playerTrails) t.mesh.visible = false;
  orbitLine.visible = false;
  hud.show(false);
  hud.hideMarkers();
  hud.hideBanner();
  audio.silenceEngine();
  setOverlay('menu');
  updateBest();
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  finalPass.uniforms.uFade.value = 0;
}

function showGameOver() {
  state = 'gameover';
  if (game.score > best) { best = game.score; store.set('eh_best', best); }
  document.getElementById('go-cause').textContent = game.deathCause;
  document.getElementById('go-score').textContent = game.score.toLocaleString();
  document.getElementById('go-wave').textContent = game.wave;
  document.getElementById('go-kills').textContent = game.kills;
  document.getElementById('go-best').textContent = game.score >= best && game.score > 0 ? '★ NEW BEST ★' : `BEST ${best.toLocaleString()}`;
  hud.show(false);
  hud.hideMarkers();
  for (const e of game.enemies) if (e.alive) e.destroy();
  game.enemies.length = 0;
  playerBolts.clear();
  enemyBolts.clear();
  shipParts.group.visible = false;
  for (const t of playerTrails) t.mesh.visible = false;
  orbitLine.visible = false;
  setOverlay('gameover');
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

function updateBest() {
  document.getElementById('best').textContent = best > 0 ? `BEST SCORE  ${best.toLocaleString()}` : '';
}

// ===========================================================================
// Per-frame player control
// ===========================================================================
let lockInfo = { enemy: null, aim: new THREE.Vector3(), assist: false };

function updatePlayerControl(dt) {
  // --- rotation from mouse (smoothed) + roll ---
  const k = 1 - Math.exp(-dt * 24);
  const yaw = player.pendingYaw * k;
  const pitch = player.pendingPitch * k;
  player.pendingYaw -= yaw;
  player.pendingPitch -= pitch;
  const roll = ((keys.has('KeyZ') ? 1 : 0) - (keys.has('KeyC') ? 1 : 0)) * ROLL_RATE * dt;
  _e1.set(pitch, yaw, roll, 'YXZ');
  _q1.setFromEuler(_e1);
  player.quat.multiply(_q1).normalize();
  player.yawRate = THREE.MathUtils.lerp(player.yawRate, yaw / Math.max(dt, 1e-4), 1 - Math.exp(-dt * 8));
  player.pitchRate = THREE.MathUtils.lerp(player.pitchRate, pitch / Math.max(dt, 1e-4), 1 - Math.exp(-dt * 8));

  // --- thrust ---
  const W = keys.has('KeyW'), S = keys.has('KeyS'), A = keys.has('KeyA'), D = keys.has('KeyD');
  const U = keys.has('Space'), Dn = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const lx = (D ? 1 : 0) - (A ? 1 : 0);
  const ly = (U ? 1 : 0) - (Dn ? 1 : 0);
  const lz = (W ? -MAIN_THRUST : 0) + (S ? RETRO_THRUST : 0);
  player.thrustAcc.set(lx * SIDE_THRUST, ly * SIDE_THRUST, lz).applyQuaternion(player.quat);
  player.throttle = THREE.MathUtils.lerp(player.throttle, W ? 1 : 0, 1 - Math.exp(-dt * 10));
  hud.setThrusters(W, A, D, U, Dn);
  audio.setEngine(player.throttle, (lx || ly || S) ? 1 : 0);

  // RCS puffs
  const fwd = forwardOf(player.quat, _fwd);
  _up.set(0, 1, 0).applyQuaternion(player.quat);
  _right.set(1, 0, 0).applyQuaternion(player.quat);
  if (lx || ly || S) {
    for (let i = 0; i < 2; i++) {
      const p = _v1.copy(player.pos);
      const v = _v2.copy(player.vel);
      if (lx) { p.addScaledVector(_right, -lx * 1.0); v.addScaledVector(_right, -lx * 18); }
      if (ly) { p.addScaledVector(_up, -ly * 0.5); v.addScaledVector(_up, -ly * 18); }
      if (S) { p.addScaledVector(fwd, 2.2); v.addScaledVector(fwd, 18); }
      v.x += rand(-3, 3); v.y += rand(-3, 3); v.z += rand(-3, 3);
      particles.emit(p.x, p.y, p.z, v.x, v.y, v.z, 0.5, 0.6, 0.75, 0.25, 1.1, 0.25, false);
    }
  }
  // exhaust
  if (W) {
    for (const e of shipParts.engines) {
      const p = _v1.copy(e).applyQuaternion(player.quat).add(player.pos);
      const v = _v2.copy(player.vel).addScaledVector(fwd, -rand(25, 45));
      v.x += rand(-2, 2); v.y += rand(-2, 2); v.z += rand(-2, 2);
      particles.emit(p.x, p.y, p.z, v.x, v.y, v.z, 0.2, 0.7, 1.6, 0.5, 0.15, rand(0.15, 0.3), false);
    }
  }

  // --- target lock & lead ---
  lockInfo.enemy = null;
  lockInfo.assist = false;
  let bestDot = Math.cos(THREE.MathUtils.degToRad(18));
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const to = _v1.subVectors(e.pos, player.pos);
    const d = to.length();
    if (d > 900) continue;
    const dot = to.divideScalar(d).dot(fwd);
    if (dot > bestDot) { bestDot = dot; lockInfo.enemy = e; }
  }
  if (lockInfo.enemy) {
    const e = lockInfo.enemy;
    let t = e.pos.distanceTo(player.pos) / BOLT_SPEED;
    for (let i = 0; i < 3; i++) {
      lockInfo.aim.copy(e.pos).addScaledVector(_v1.subVectors(e.vel, player.vel), t);
      t = lockInfo.aim.distanceTo(player.pos) / BOLT_SPEED;
    }
    const aimDir = _v1.subVectors(lockInfo.aim, player.pos).normalize();
    lockInfo.assist = aimDir.dot(fwd) > Math.cos(0.045);
  }

  // --- weapons ---
  player.fireCd -= dt;
  if (player.overheated) {
    player.heat -= dt * 0.5;
    if (player.heat < 0.3) player.overheated = false;
  } else {
    player.heat = Math.max(0, player.heat - dt * 0.38);
  }
  if (firing && !player.overheated && player.fireCd <= 0) {
    player.fireCd = FIRE_INTERVAL;
    firePlayer(lockInfo);
  }

  // --- shields ---
  player.shieldDelay -= dt;
  if (player.shieldDelay <= 0) player.shield = Math.min(100, player.shield + 22 * dt);
}

function updatePlayerVisual(dt, time) {
  const g = shipParts.group;
  g.position.copy(player.pos);
  g.quaternion.copy(player.quat);
  const model = shipParts.model;
  const lx = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
  const targetRoll = THREE.MathUtils.clamp(player.yawRate * 0.35, -0.7, 0.7) - lx * 0.25;
  const targetPitch = THREE.MathUtils.clamp(player.pitchRate * 0.12, -0.3, 0.3);
  model.rotation.z = THREE.MathUtils.lerp(model.rotation.z, targetRoll, 1 - Math.exp(-dt * 6));
  model.rotation.x = THREE.MathUtils.lerp(model.rotation.x, targetPitch, 1 - Math.exp(-dt * 6));
  for (const f of shipParts.flames) {
    const l = 0.5 + player.throttle * 4.2 + Math.random() * 0.4 * (0.3 + player.throttle);
    f.flame.scale.set(f.flame.userData.radius, f.flame.userData.radius, l);
    f.mat.uniforms.uTime.value = time;
    f.mat.uniforms.uIntensity.value = 0.45 + player.throttle * 1.3;
    f.glow.material.opacity = 0.35 + player.throttle * 0.65;
    f.glow.scale.setScalar(1.3 + player.throttle * 1.4);
  }
  const blink = (time % 1.3) < 0.1;
  for (const n of shipParts.navLights) n.visible = blink;

  // spaghettification near the horizon
  const r = player.pos.length();
  const s = THREE.MathUtils.clamp((RS * 2.9 - r) / (RS * 1.8), 0, 1);
  model.scale.set(1 - 0.55 * s, 1 - 0.55 * s, 1 + 2.5 * s);

  for (let i = 0; i < 2; i++) {
    const p = _v1.copy(shipParts.engines[i]).applyQuaternion(player.quat).add(player.pos);
    playerTrails[i].update(dt, p, camera.position, 0.15 + player.throttle * 0.7);
  }
}

// ===========================================================================
// Fixed-step physics
// ===========================================================================
const playerTarget = { pos: player.pos, radius: player.radius, alive: true };

function physicsStep(h) {
  if (player.alive) {
    integrate(player.pos, player.vel, player.thrustAcc, h);
  } else if (player.pos.length() > RS) {
    integrate(player.pos, player.vel, null, h);
  } else {
    // inside the horizon: nothing comes back out — sink toward the singularity
    player.vel.multiplyScalar(Math.exp(-h * 3));
    player.pos.multiplyScalar(Math.exp(-h * 0.5));
  }
  for (const e of game.enemies) if (e.alive) e.physics(h);

  playerBolts.step(h, game.enemies, (e, point, dmg) => hitEnemy(e, dmg, point, 'player'));
  missiles.physics(h);

  playerTarget.alive = player.alive;
  playerTarget.radius = player.radius;
  enemyBolts.step(h, [playerTarget], (t, point, dmg) => {
    sparks(point, player.vel, 14, player.shield > 0 ? 0.4 : 2.0, player.shield > 0 ? 1.2 : 0.6, player.shield > 0 ? 2.4 : 0.2, 22);
    damagePlayer(dmg, { cause: 'SHOT DOWN' });
  });

  // collisions & hazards for enemies
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const r = e.pos.length();
    if (r < RS * 1.05) { killEnemy(e, 'horizon'); continue; }
    if (r > ARENA_RADIUS * 2.5) { killEnemy(e, 'void'); continue; }
    if (!player.alive) continue;
    const d = e.pos.distanceTo(player.pos);
    if (e.type === 'seeker' && d < player.radius + e.radius + 2.5) {
      damagePlayer(e.def.ramDamage, { cause: 'SEEKER IMPACT' });
      killEnemy(e, 'none');
      game.trauma = 1;
    } else if (d < player.radius + e.radius * 0.8) {
      damagePlayer(30, { cause: 'COLLISION' });
      killEnemy(e, 'ram');
    }
  }

  if (player.alive && player.pos.length() < RS * 1.02) {
    killPlayer('CROSSED THE EVENT HORIZON');
  }
}

// ===========================================================================
// Hazards, warnings, telemetry
// ===========================================================================
let predTimer = 0;

function updateHazards(dt, warnings) {
  const r = player.pos.length();
  const rho = Math.hypot(player.pos.x, player.pos.z);
  if (r < TIDAL_RADIUS) {
    const k = (TIDAL_RADIUS - r) / (RS * 2.5);
    damagePlayer(k * 26 * dt, { silent: true, cause: 'TORN APART BY TIDAL FORCES' });
    game.trauma = Math.min(1, Math.max(game.trauma, k * 0.6));
    warnings.push({ text: '⚠ TIDAL STRESS CRITICAL', color: 'red' });
  }
  if (Math.abs(player.pos.y) < 6 && rho > DISK_IN && rho < DISK_OUT * 0.75) {
    damagePlayer(30 * dt, { silent: true, cause: 'INCINERATED IN THE ACCRETION DISK' });
    game.trauma = Math.min(1, Math.max(game.trauma, 0.35));
    game.plasmaFx += dt;
    sparks(player.pos, player.vel, 3, 2.0, 0.9, 0.3, 30);
    warnings.push({ text: '⚠ PLASMA BURN — LEAVE THE DISK', color: 'orange' });
  }
  if (r > ARENA_RADIUS) {
    // no damage out here — the gravity wall (see physics.js) hauls you back in
    const pull = gravityAt(r).toFixed(0);
    warnings.push({ text: `GRAVITY WALL — ${pull} m/s² PULLING YOU BACK`, color: 'orange' });
    game.trauma = Math.max(game.trauma, Math.min(0.5, (r - ARENA_RADIUS) / 600));
  } else if (r > ARENA_RADIUS * 0.92) {
    warnings.push({ text: 'APPROACHING GRAVITY WALL', color: 'orange' });
  }
}

function updateTelemetry(dt) {
  predTimer -= dt;
  if (predTimer <= 0) {
    predTimer = 1 / 30;
    predictTrajectory(player.pos, player.vel, pred);
    writeOrbitLine();
  }
  const r = player.pos.length();
  const t = {
    alt: r - RS,
    vel: player.vel.length(),
    vc: circularSpeed(r),
    pe: '—', peClass: '', ap: '—', period: '—', state: 'STABLE ORBIT', stateClass: '',
  };
  if (pred.impact) {
    t.pe = 'IMPACT'; t.peClass = 'bad';
    t.ap = `${(pred.maxR - RS).toFixed(0)} m`;
    t.state = `IMPACT IN ${pred.impactTime.toFixed(1)}s`; t.stateClass = 'bad';
  } else if (pred.escape) {
    t.pe = `${(pred.minR - RS).toFixed(0)} m`;
    t.ap = 'ESCAPE';
    t.state = 'ESCAPE TRAJECTORY'; t.stateClass = 'warn';
  } else if (pred.closed) {
    t.pe = `${(pred.minR - RS).toFixed(0)} m`;
    t.ap = `${(pred.maxR - RS).toFixed(0)} m`;
    t.period = `${pred.period.toFixed(1)} s`;
    if (pred.minR < ISCO * 1.6) { t.peClass = 'warn'; t.state = 'LOW PERIAPSIS'; t.stateClass = 'warn'; }
  }
  hud.setTelemetry(t);
}

function writeOrbitLine() {
  const pos = orbitGeo.attributes.position.array;
  const col = orbitGeo.attributes.color.array;
  const n = pred.count;
  pos.set(pred.positions.subarray(0, n * 3));
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const dx = pred.positions[i * 3] - pred.positions[i * 3 - 3];
      const dy = pred.positions[i * 3 + 1] - pred.positions[i * 3 - 2];
      const dz = pred.positions[i * 3 + 2] - pred.positions[i * 3 - 1];
      acc += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    const nearFade = THREE.MathUtils.smoothstep(acc, 6, 40);
    const along = 1 - (i / Math.max(n - 1, 1)) * 0.75;
    const a = nearFade * along * 0.75;
    const danger = THREE.MathUtils.smoothstep(ISCO * 1.6 - pred.radii[i], 0, 30);
    col[i * 3] = (0.25 + danger * 1.6) * a;
    col[i * 3 + 1] = (0.95 - danger * 0.8) * a;
    col[i * 3 + 2] = (1.1 - danger * 0.95) * a;
  }
  orbitGeo.setDrawRange(0, n);
  orbitGeo.attributes.position.needsUpdate = true;
  orbitGeo.attributes.color.needsUpdate = true;
}

function updateNavMarkers() {
  const el = hud.el;
  // crosshair at convergence point
  const fwd = forwardOf(player.quat, _fwd);
  const aimPt = _v1.copy(player.pos).addScaledVector(fwd, CONVERGE_DIST);
  hud.project(aimPt, camera, scr);
  el.crosshair.style.left = `${scr.x}px`;
  el.crosshair.style.top = `${scr.y}px`;

  // prograde / retrograde markers (relative to the black hole frame)
  const sp = player.vel.length();
  if (sp > 0.5) {
    const dir = _v2.copy(player.vel).divideScalar(sp);
    hud.project(_v3.copy(camera.position).addScaledVector(dir, 500), camera, scr);
    showAt(el.prograde, scr);
    hud.project(_v3.copy(camera.position).addScaledVector(dir, -500), camera, scr);
    showAt(el.retrograde, scr);
  }

  // lead pip
  if (lockInfo.enemy) {
    hud.project(lockInfo.aim, camera, scr);
    showAt(el.lead, scr);
    el.lead.style.borderColor = lockInfo.assist ? '#ffad4a' : '#fff';
  } else {
    el.lead.style.display = 'none';
  }

  // periapsis / apoapsis labels
  const showPe = (pred.closed || pred.escape) && pred.maxR - pred.minR > 10;
  const showAp = pred.closed && pred.maxR - pred.minR > 10;
  if (showPe && pred.minIdx > 3) {
    _v3.fromArray(pred.positions, pred.minIdx * 3);
    hud.project(_v3, camera, scr);
    showAt(el.peLabel, scr);
    el.peLabel.textContent = `Pe ${(pred.minR - RS).toFixed(0)}`;
    el.peLabel.classList.toggle('bad', pred.minR < ISCO * 1.6);
  } else el.peLabel.style.display = 'none';
  if (pred.impact) {
    _v3.fromArray(pred.positions, (pred.count - 1) * 3);
    hud.project(_v3, camera, scr);
    showAt(el.peLabel, scr);
    el.peLabel.textContent = 'IMPACT';
    el.peLabel.classList.add('bad');
  }
  if (showAp && pred.maxIdx > 3) {
    _v3.fromArray(pred.positions, pred.maxIdx * 3);
    hud.project(_v3, camera, scr);
    showAt(el.apLabel, scr);
    el.apLabel.textContent = `Ap ${(pred.maxR - RS).toFixed(0)}`;
  } else el.apLabel.style.display = 'none';
}

function showAt(el, s) {
  if (!s.onScreen) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
}

// ===========================================================================
// Camera
// ===========================================================================
function updateChaseCamera(dt) {
  camQuat.slerp(player.quat, 1 - Math.exp(-dt * (player.alive ? 9 : 2)));
  const pull = player.alive ? player.throttle * 1.3 : 6 + game.deathTimer * 4;
  camOffset.set(0, 2.5, 9.5 + pull).applyQuaternion(camQuat);
  camera.position.copy(player.pos).add(camOffset);
  camera.quaternion.copy(camQuat);
  if (!player.alive) {
    camera.lookAt(player.pos);
  }
  // screen shake
  const s = game.trauma * game.trauma;
  if (s > 0.001) {
    const t = performance.now() * 0.001;
    _e1.set(
      (Math.sin(t * 47.3) + Math.sin(t * 81.1)) * 0.012 * s,
      (Math.sin(t * 53.7) + Math.sin(t * 71.9)) * 0.012 * s,
      Math.sin(t * 38.1) * 0.02 * s,
    );
    _q1.setFromEuler(_e1);
    camera.quaternion.multiply(_q1);
  }
  game.trauma = Math.max(0, game.trauma - dt * 1.4);
  fovKick = THREE.MathUtils.lerp(fovKick, player.alive ? player.throttle * 7 : 0, 1 - Math.exp(-dt * 4));
  const fov = 72 + fovKick;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

let menuAngle = 0.6;
function updateMenuCamera(dt) {
  menuAngle += dt * 0.035;
  const R = 2700;
  camera.position.set(Math.cos(menuAngle) * R, 380 + Math.sin(menuAngle * 0.7) * 120, Math.sin(menuAngle) * R);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  camera.rotateY(0.36);
  camera.rotateZ(0.08);
  if (camera.fov !== 60) { camera.fov = 60; camera.updateProjectionMatrix(); }
}

// ===========================================================================
// Main loop
// ===========================================================================
const clock = new THREE.Clock();
let visualTime = 0;

function frame() {
  requestAnimationFrame(frame);
  tick(Math.min(clock.getDelta(), 0.05), true);
}

function tick(rawDt, render) {
  visualTime += rawDt;

  if (state === 'playing' || state === 'dead') {
    const dt = rawDt * game.timeScale;
    game.time += dt;

    if (state === 'playing') updatePlayerControl(dt);
    for (const e of game.enemies) if (e.alive) e.think(dt, player, game);

    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 10) {
      physicsStep(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps >= 10) accumulator = 0;
    game.enemies = game.enemies.filter((e) => e.alive);

    // waves
    if (state === 'playing') {
      if (game.waveTimer > 0) {
        game.waveTimer -= dt;
        if (game.waveTimer <= 0) startWave(game.wave + 1);
      }
      if (game.spawnQueue.length) {
        game.spawnTimer -= dt;
        if (game.spawnTimer <= 0) {
          spawnEnemy(game.spawnQueue.shift());
          game.spawnTimer = 0.55;
        }
      } else if (game.waveActive && game.enemies.length === 0) {
        game.waveActive = false;
        game.waveTimer = 4.5;
        player.hull = Math.min(100, player.hull + 25);
        player.shield = 100;
        hud.banner('WAVE CLEARED', `+${game.wave * 250} BONUS · HULL REPAIRED`, 3000);
        game.score += game.wave * 250;
        audio.waveClear();
      }
      game.comboTimer -= dt;
      if (game.comboTimer <= 0) game.mult = 1;
    }

    // visuals
    if (player.alive) updatePlayerVisual(dt, visualTime);
    else for (const t of playerTrails) t.update(dt, player.pos, camera.position, Math.max(0, 0.5 - game.deathTimer));
    for (const e of game.enemies) e.updateVisual(dt, camera.position, visualTime);
    missiles.update(dt, camera.position, visualTime);
    particles.update(dt);
    updateEffects(dt);
    updateChaseCamera(rawDt);
    playerBolts.updateVisuals(player.vel);
    enemyBolts.updateVisuals(player.vel);

    // HUD
    const warnings = [];
    if (state === 'playing') {
      updateHazards(dt, warnings);
      updateTelemetry(dt);
      if (pred.impact) {
        warnings.unshift({ text: '⚠ IMPACT TRAJECTORY — BURN PROGRADE', color: 'red' });
        game.warnBeep -= dt;
        if (game.warnBeep <= 0) { audio.beep(960, 0.09, 0.07); game.warnBeep = 0.45; }
      }
      if (player.overheated) warnings.push({ text: 'CANNONS OVERHEATED', color: 'orange' });
      if (player.hull < 30) warnings.push({ text: 'HULL CRITICAL', color: 'red' });
      let seekerNear = false;
      for (const e of game.enemies) if (e.type === 'seeker' && e.pos.distanceTo(player.pos) < 140) seekerNear = true;
      if (seekerNear) {
        warnings.push({ text: 'PROXIMITY ALERT — SEEKER', color: 'orange' });
        game.proximityBeep -= dt;
        if (game.proximityBeep <= 0) { audio.beep(1500, 0.05, 0.05, 'sine'); game.proximityBeep = 0.25; }
      }
      hud.setWarnings(warnings);
      hud.setBars(player.shield / 100, player.hull / 100, player.heat, player.overheated);
      hud.setScore(game.score, game.wave, game.mult, game.enemies.length + game.spawnQueue.length);
      updateNavMarkers();
      hud.setMissiles(missiles.ammo, missiles.lockInfo, camera);
      hud.updateMarkers(game.enemies, camera, player.pos, lockInfo.enemy);
      hud.drawRadar(player, game.enemies, pred, visualTime);
    }

    // post fx
    const r = player.pos.length();
    game.damageFlash = Math.max(0, game.damageFlash - rawDt * 1.8);
    finalPass.uniforms.uDamage.value = game.damageFlash * 0.7;
    finalPass.uniforms.uAberration.value = THREE.MathUtils.clamp((RS * 7 - r) / (RS * 7), 0, 1) * 0.02 + game.trauma * 0.01;
    audio.setDrone(THREE.MathUtils.clamp((RS * 9 - r) / (RS * 6), 0, 1));
    dust.uniforms.uOpacity.value = 1;

    if (state === 'dead') {
      hud.setWarnings([]);
      game.deathTimer += rawDt;
      game.timeScale = THREE.MathUtils.lerp(game.timeScale, 0.6, rawDt);
      if (game.deathCause === 'CROSSED THE EVENT HORIZON') {
        finalPass.uniforms.uFade.value = Math.min(1, game.deathTimer / 1.8);
        // keep the ship model visible, stretched, as it falls
        updatePlayerVisual(dt, visualTime);
      }
      if (game.deathTimer > 2.8) showGameOver();
    }
  } else if (state === 'menu' || state === 'gameover') {
    updateMenuCamera(rawDt);
    particles.update(rawDt);
    updateEffects(rawDt);
    audio.setDrone(0.25);
    if (state === 'gameover') finalPass.uniforms.uFade.value = Math.max(0, finalPass.uniforms.uFade.value - rawDt);
    finalPass.uniforms.uDamage.value = 0;
    finalPass.uniforms.uAberration.value = 0;
  }

  dust.uniforms.uCam.value.copy(camera.position);
  dust.uniforms.uVel.value.copy(state === 'playing' || state === 'dead' ? player.vel : _v1.set(0, 0, 0));
  dust.lines.visible = state !== 'menu' && state !== 'gameover';
  particles.material.uniforms.uScale.value = (renderer.domElement.height) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  finalPass.uniforms.uTime.value = visualTime;
  if (!render) return;
  blackHole.update(camera, visualTime, renderer.domElement.height);
  composer.render(rawDt);
}

// ===========================================================================
// Menus
// ===========================================================================
const overlays = ['menu', 'controls', 'pause', 'gameover'];
function setOverlay(name) {
  for (const o of overlays) document.getElementById(o).classList.toggle('hidden', o !== name);
}

let controlsReturn = 'menu';
function bind(id, fn) {
  const el = document.getElementById(id);
  el.addEventListener('click', (e) => { e.stopPropagation(); audio.init(); audio.uiClick(); fn(); });
  el.addEventListener('mouseenter', () => audio.uiHover());
}

function launch() {
  audio.init();
  const fade = document.getElementById('fade');
  fade.classList.add('on');
  requestLock();
  setTimeout(() => {
    startGame();
    fade.classList.remove('on');
  }, 450);
}

bind('btn-play', launch);
bind('btn-controls', () => { controlsReturn = 'menu'; setOverlay('controls'); });
bind('btn-back', () => setOverlay(controlsReturn));
bind('btn-quality', () => {
  const order = ['HIGH', 'MEDIUM', 'LOW'];
  qualityKey = order[(order.indexOf(qualityKey) + 1) % order.length];
  store.set('eh_quality', qualityKey);
  applyQuality();
});
bind('btn-resume', resumeGame);
bind('btn-quit', toMenu);
bind('btn-retry', launch);
bind('btn-menu', toMenu);

const sensEl = document.getElementById('sens');
const invEl = document.getElementById('invert');
sensEl.value = sensitivity;
invEl.checked = invertY;
sensEl.addEventListener('input', () => { sensitivity = parseFloat(sensEl.value); store.set('eh_sens', sensitivity); });
invEl.addEventListener('change', () => { invertY = invEl.checked; store.set('eh_invert', invertY); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') {
    if (state === 'menu') launch();
    else if (state === 'paused') resumeGame();
    else if (state === 'gameover') launch();
  }
});

// ===========================================================================
// Boot
// ===========================================================================
applyQuality();
updateBest();
updateMenuCamera(0);
blackHole.update(camera, 0, renderer.domElement.height);
renderer.compile(scene, camera);
composer.render(0);
let booted = false;
function hideLoading() {
  if (booted) return;
  booted = true;
  document.getElementById('loading').classList.add('done');
  setTimeout(() => document.getElementById('loading').classList.add('hidden'), 900);
}
requestAnimationFrame(hideLoading);
setTimeout(hideLoading, 1500);
frame();

// debug handle
window.__eh = {
  advance(sec) { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) tick(1 / 60, i === n - 1); },
  setFiring(v) { firing = v; },
  spawnEnemy, explode, killEnemy, missiles,
  game, player, camera, startGame, state: () => state, scene, bloom, composer, shipParts, finalPass, particles, blackHole, orbitLine, dust, playerTrails };
