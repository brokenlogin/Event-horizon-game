import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

import {
  RS, ISCO, DISK_IN, DISK_OUT, ARENA_RADIUS,
  integrate, circularSpeed, circularOrbitState, createPrediction, predictTrajectory,
  gravityAt, occludedByHole, accelAt,
} from './physics.js';
import { createBlackHole } from './blackhole.js';
import { buildPlayerShip, setLoadout, buildMissile, buildWreck, shareGeometry } from './ships.js';
import { buildCockpit, drawCockpit, updateCockpitLamp, updateCockpitControls, EYE } from './cockpit.js';
import { BoltPool, Particles, Trail, createDust } from './fx.js';
import { Enemy, ENEMY_DEFS, resetEnemyIds } from './enemies.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { MissileSystem } from './missiles.js';
import { Station, DOCK_RANGE, DOCK_MAX_REL_SPEED } from './station.js';
import { DockAssist, BodyTarget, CAPTURE_R, CAPTURE_V } from './autopilot.js';
import { Radar3D } from './radar3d.js';
import { net, PROTOCOL, MAX_PILOTS, normalizeCode, parseShareCode } from './net.js';
import { RemotePlayer } from './remote.js';
import { WreckSystem, COLLECT_RANGE } from './wrecks.js';
import { StationUI, UPGRADES, newUpgradeLevels, upgradeCost, REPAIR_HP_PER_SCRAP, REARM_COST, REVIVE_COST } from './stationui.js';
import { TechTreeUI, TECH, TECH_BY_ID, MK2_COST, mk2Ready, techUnlocked, techCost } from './techtree.js';

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
const INTERMISSION = 120;            // seconds between waves
const STATION_RADIUS = 2500;           // high orbit, held a little under orbital speed (≈1.8 min period)
const BASE_HULL = 100;
const SHIELD_MAX = 100;

// ratio: render resolution (capped at the display's); step: black hole ray-march
// step scale (bigger = fewer steps); msaa: anti-aliasing samples.
const QUALITY = {
  HIGH: { ratio: 1.5, step: 1.0, msaa: 4, label: 'HIGH' },
  MEDIUM: { ratio: 1.0, step: 1.4, msaa: 4, label: 'MEDIUM' },
  LOW: { ratio: 0.7, step: 2.0, msaa: 2, label: 'LOW' },
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
const allyBolts = new BoltPool(scene, { max: 400, color: 0xffa040, radius: 0.07, length: 4.5, glowRadius: 0.24 });
// other pilots in a multiplayer session, by pilot id (host 0, guests 1–7)
const remotes = new Map();
function remoteFor(id) {
  let r = remotes.get(id);
  if (!r) {
    r = new RemotePlayer(scene);
    r.pilotId = id;
    r.parts.mk2.visible = !!game.levels.mk2;
    r.parts.rail.visible = !!game.levels.railgun;
    r.name = pilotName(id);
    remotes.set(id, r);
  }
  return r;
}
function clearRemotes() {
  for (const r of remotes.values()) r.dispose();
  remotes.clear();
}
const NO_TARGETS = [];

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
      // tone mapping + sRGB output happen here, saving a separate full-screen pass
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

/**
 * Draws the scene with 4× MSAA into its own target, then copies the resolved
 * image into the composer's plain buffer. Only the scene needs anti-aliasing:
 * keeping the bloom and final passes off multisampled targets saves a resolve
 * (and a lot of memory bandwidth) on every one of them.
 */
class MSAARenderPass extends Pass {
  constructor(scene, camera) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false, depthWrite: false,
    }));
    this.copy.material.uniforms.tDiffuse.value = this.target.texture;
  }

  setSize(width, height) { this.target.setSize(width, height); }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target);
    renderer.render(this.scene, this.camera);   // (autoClear clears the target)
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }
}

const composerRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
const composer = new EffectComposer(renderer, composerRT);
const scenePass = new MSAARenderPass(scene, camera);
composer.addPass(scenePass);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 1.0);
composer.addPass(bloom);
const finalPass = new ShaderPass(FinalShader);   // also tone-maps: it's the last pass, drawn to the screen
composer.addPass(finalPass);

function applyQuality() {
  const q = QUALITY[qualityKey];
  const ratio = Math.min(window.devicePixelRatio || 1, q.ratio);
  blackHole.uniforms.uStepMul.value = q.step;
  if (scenePass.target.samples !== q.msaa) {
    scenePass.target.samples = q.msaa;
    scenePass.target.dispose();   // re-created with the new sample count on next use
  }
  renderer.setPixelRatio(ratio);
  composer.setPixelRatio(ratio);
  onResize();
  for (const id of ['btn-quality', 'btn-quality-pause']) document.getElementById(id).textContent = `GRAPHICS: ${QUALITY[qualityKey].label}`;
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
const radar = new Radar3D(document.getElementById('radar'));

// ===========================================================================
// Player
// ===========================================================================
const shipParts = buildPlayerShip();
scene.add(shipParts.group);
shipParts.group.visible = false;
const cockpit = buildCockpit();   // first-person interior, shown only in that view
shipParts.model.add(cockpit.group);

const player = {
  pos: new THREE.Vector3(),
  vel: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  thrustAcc: new THREE.Vector3(),
  alive: false,
  radius: 1.6,              // hitbox: covers the fuselage; wingtips are forgiving
  hull: 100, maxHull: BASE_HULL, shield: 100, maxShield: SHIELD_MAX, heat: 0, overheated: false,
  shieldDelay: 0, fireCd: 0, gun: 0,
  docking: false, docked: false, needsClearance: false,
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
const keyAliases = {
  ArrowUp: 'KeyI',
  ArrowDown: 'KeyK',
  ArrowLeft: 'KeyJ',
  ArrowRight: 'KeyL',
};
const isKeyDown = (code) => keys.has(code) || (keyAliases[code] && keys.has(keyAliases[code]));
let firing = false;
let sensitivity = store.get('eh_sens', 1);
let invertY = store.get('eh_invert', false);
let hadLock = false;

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;   // typing a room code
  if (e.code === 'Escape' && techTree.visible) { techTree.close(); e.stopImmediatePropagation(); return; }
  if (e.code === 'KeyP' && !e.repeat) togglePerf();   // (T is a flight key: TFGH aim)
  if (['Space', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Digit5', 'Digit6', 'Digit7', 'Numpad5', 'Numpad6', 'Numpad7', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'KeyT', 'KeyG', 'KeyH', 'KeyQ', 'KeyE', 'KeyZ', 'KeyC'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (state === 'playing' && player.alive && !player.docked && (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'Digit5' || e.code === 'Numpad5')) firing = true;
  if (state === 'playing' && player.alive && !player.docked && !player.docking && game.levels.railgun && !e.repeat && (e.code === 'Digit7' || e.code === 'Numpad7')) railHeld = true;
  if (state === 'playing' && player.alive && !e.repeat) {
    const inDock = player.docked || player.docking;
    if (e.code === 'KeyE' && !inDock) missiles.pressLock();
    if (e.code === 'KeyQ' && !inDock) missiles.fire();
    if (e.code === 'KeyF' && player.docked) undock();
    if (e.code === 'KeyN') callNextWave();
    if (e.code === 'KeyB') toggleDockAssist();
    if (e.code === 'KeyR' && !inDock) useAfterburner();
    if (e.code === 'KeyY' && !inDock) useJumpDrive();
    if (e.code === 'Comma') changeWarp(-1);
    if (e.code === 'Period') changeWarp(1);
  }
  if (e.code === 'Escape' && document.pointerLockElement !== canvas && state === 'playing') pauseGame();
  else if (e.code === 'Escape' && state === 'dead' && mp.spectating) setOverlay('pause');
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'Digit5' || e.code === 'Numpad5') firing = false;
  if (e.code === 'Digit7' || e.code === 'Numpad7') releaseRail();
});
window.addEventListener('blur', () => { keys.clear(); firing = false; });

document.addEventListener('mousemove', (e) => {
  if (state !== 'playing' || !player.alive || player.docked || player.docking) return;
  const s = 0.0021 * sensitivity;
  if (keys.has('KeyV')) {   // free look: turn your head (or swing the chase camera) instead of the ship
    head.lookYaw = THREE.MathUtils.clamp(head.lookYaw - e.movementX * s, -2.3, 2.3);
    head.lookPitch = THREE.MathUtils.clamp(head.lookPitch - e.movementY * s * (invertY ? -1 : 1), -1.25, 0.95);
    return;
  }
  player.pendingYaw -= e.movementX * s;
  player.pendingPitch -= e.movementY * s * (invertY ? -1 : 1);
});
canvas.addEventListener('mousedown', (e) => {
  if (state === 'dead' && mp.spectating) { cycleSpectate(); return; }
  if (state !== 'playing' || player.docked) return;
  if (document.pointerLockElement !== canvas) requestLock();
  if (e.button === 0) firing = true;
  if (e.button === 2 && game.levels.railgun && player.alive && !player.docking) railHeld = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) firing = false;
  if (e.button === 2) releaseRail();
});
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
  if (!locked && state === 'playing' && hadLock && !player.docked) pauseGame();
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
  scrap: 0, scrapTotal: 0, levels: newUpgradeLevels(), underAttack: 0,
  mp: false,
  bumpCd: 0, clearHold: 0, chargeBeep: 0,
  warp: 1,   // time warp between waves (solo): 1–10×
  enemyFire, turretFire, bossLaunch, bossVolley, wardenLaunch, lancersAlive, nearestPilot, lancerFire, layMine, supportTarget,
  seenTypes: new Set(),
};
// Difficulty: scales the damage enemies deal and how many missiles you carry.
const DIFFICULTIES = {
  easy: { name: 'EASY', dmg: 0.65, missiles: 3, count: 0.7, hp: 1, price: 1, desc: '30% fewer enemies · 35% less damage · 3 missiles per wave' },
  normal: { name: 'NORMAL', dmg: 1, missiles: 2, count: 1, hp: 1, price: 1, desc: 'Standard waves · standard damage · 2 missiles per wave' },
  hard: { name: 'HARD', dmg: 1.3, missiles: 1, count: 1.35, hp: 1, price: 1, desc: '35% more enemies · 30% more damage · 1 missile per wave' },
  custom: { name: 'CUSTOM', missiles: 2 },   // the numbers come from customDef()
};
// Custom difficulty: four percentages. Sliders cover 50–150%; the boxes take anything in these limits.
const CUSTOM_FIELDS = [
  { key: 'count', name: 'ENEMY COUNT', min: 10, max: 1000 },
  { key: 'dmg', name: 'ENEMY DAMAGE', min: 0, max: 1000 },
  { key: 'hp', name: 'ENEMY HEALTH', min: 10, max: 1000 },
  { key: 'price', name: 'UPGRADE PRICES', min: 0, max: 1000 },
];
function sanitizeCustom(c) {
  const out = {};
  for (const f of CUSTOM_FIELDS) {
    const v = Number((c || {})[f.key]);
    out[f.key] = Number.isFinite(v) ? THREE.MathUtils.clamp(Math.round(v), f.min, f.max) : 100;
  }
  out.fpv = !!(c || {}).fpv;   // first-person view
  return out;
}
let customDiff = sanitizeCustom(store.get('eh_custom', {}));   // this player's custom settings
function customDef(c) {
  return {
    name: 'CUSTOM', missiles: 2, dmg: c.dmg / 100, count: c.count / 100, hp: c.hp / 100, price: c.price / 100,
    desc: `Enemies ${c.count}% · damage ${c.dmg}% · health ${c.hp}% · prices ${c.price}% · 2 missiles${c.fpv ? ' · first person' : ''}`,
  };
}
const diffInfo = (d, c = customDiff) => (d === 'custom' ? customDef(c) : DIFFICULTIES[d]);
const validDifficulty = (d) => (Object.hasOwn(DIFFICULTIES, d) ? d : 'normal');
let difficulty = validDifficulty(store.get('eh_difficulty', 'normal'));   // what this player picked
game.difficulty = difficulty;                                              // what the current run uses
game.custom = customDiff;                                                  // its custom numbers (the host's in multiplayer)
const diffDef = () => diffInfo(game.difficulty, game.custom);
/** First-person view: a custom-difficulty option (the host's choice in multiplayer). */
const firstPerson = () => game.difficulty === 'custom' && !!game.custom.fpv;
const bestKey = (d) => (d === 'normal' ? 'eh_best' : `eh_best_${d}`);
let best = store.get(bestKey(difficulty), 0);

const camQuat = new THREE.Quaternion();
const camOffset = new THREE.Vector3();
let fovKick = 0;

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
// Crew scaling: every extra pilot adds +100% hostiles and makes upgrades +60% pricier.
const ENEMIES_PER_PILOT = 1.0;
const COST_PER_PILOT = 0.6;
function pilotCount() {
  if (!game.mp) return 1;
  return net.isHost ? 1 + net.openLinks().length : Math.max(2, mp.players.size);
}
/** Crew size as the waves see it: each pilot up to four counts fully, the rest half (keeps big rooms playable and the host's upload sane). */
const crewWeightOf = (n) => (n <= 4 ? n : 4 + 0.5 * (n - 4));
function crewWeight() { return crewWeightOf(pilotCount()); }
function enemyScale() { return 1 + ENEMIES_PER_PILOT * (crewWeight() - 1); }
function costScale() { return (1 + COST_PER_PILOT * (crewWeight() - 1)) * diffDef().price; }
/** Enemy health on this difficulty. */
function scaleEnemyHp(e) { e.hp = e.maxHp = e.def.hp * diffDef().hp; }

// Every fifth wave a dreadnought (boss) takes up a low orbit, with a lighter escort.
const BOSS_EVERY = 5;
const BOSS_ORBIT = 1350;
const isBossWave = (n) => n > 0 && n % BOSS_EVERY === 0;

/** Enemies that have to die to clear a wave (mines don't count). */
function hostileCount() {
  let n = 0;
  for (const e of game.enemies) if (e.alive && !e.def.noClear) n++;
  return n;
}

/** Seekers from wave 14 on are the faster, harder-hitting MK2. */
const seekerType = (n) => (n > 13 ? 'seeker2' : 'seeker');
const isSeekerType = (t) => t === 'seeker' || t === 'seeker2';

function waveComposition(n) {
  const list = [];
  const k = enemyScale() * diffDef().count;   // crew size × difficulty
  if (isBossWave(n)) {
    const raiders = Math.max(1, Math.round(Math.min(2 + n, 9) * k * 0.4));
    const lancers = n >= 10 ? Math.round(Math.min(Math.floor((n - 4) / 2), 4) * k * 0.4) : 0;
    for (let i = 0; i < raiders; i++) list.push('raider');
    for (let i = 0; i < lancers; i++) list.push('lancer');
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    list.unshift('dread');   // the fortress arrives first
    return list;
  }
  const raiders = Math.round(Math.min(2 + n, 9) * k);
  const wardens = n >= 3 ? Math.round(Math.min(Math.floor((n - 1) / 2), 4) * k) : 0;
  // after the first boss, new types join one at a time
  const lancers = n >= 6 ? Math.round(Math.min(Math.floor((n - 4) / 2), 4) * k) : 0;       // 6: 1, 8: 2 … up to 4
  const sowers = n >= 8 ? Math.round(Math.min(Math.floor((n - 6) / 2), 3) * k) : 0;        // 8: 1, 10: 2 … up to 3
  const aegis = n >= 11 ? Math.round(Math.min(1 + Math.floor((n - 11) / 4), 2) * k) : 0;   // 11: 1, 15: 2
  for (let i = 0; i < raiders; i++) list.push('raider');
  // (seekers don't come in waves: wardens and the dreadnought launch them)
  for (let i = 0; i < wardens; i++) list.push('warden');
  for (let i = 0; i < lancers; i++) list.push('lancer');
  for (let i = 0; i < sowers; i++) list.push('sower');
  for (let i = 0; i < aegis; i++) list.push('aegis');
  // shuffle
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list;
}

function startWave(n) {
  game.wave = n;
  game.emergencyUsed = false;
  game.spawnQueue = waveComposition(n);
  game.spawnTimer = 1.2;
  game.waveActive = true;
  game.aggroTimer = 10;   // the first surge a little after the wave arrives
  game.aggroParty = false;
  const restocked = missiles.ammo < missiles.capacity;
  missiles.refill();
  const fresh = newContacts(game.spawnQueue);
  waveBanner(n, game.spawnQueue.length, restocked, fresh);
  if (game.mp) net.sendEvent({ k: 'waveStart', n, count: game.spawnQueue.length, nt: fresh });
}

// The first time a new kind of enemy shows up in a run, the wave banner explains it.
const NEW_CONTACT = {
  warden: ['WARDEN', 'IT LAUNCHES SEEKER DRONES THAT RAM YOU · SHOOT THE DRONES BEFORE THEY REACH YOU'],
  lancer: ['LANCER', 'IT CHARGES A BEAM · WHEN ITS GREEN AIM LINE FLASHES, THRUST ACROSS IT TO DODGE'],
  sower: ['SOWER', 'IT SEEDS PROXIMITY MINES ALONG ITS ORBIT · SHOOT THEM FROM A DISTANCE'],
  aegis: ['AEGIS', 'IT SHIELDS NEARBY SHIPS (−90% DAMAGE) · TAKE IT OUT FIRST'],
  seeker2: ['SEEKER MK2', 'FASTER SEEKERS THAT HIT 50% HARDER · SHOOT THEM EARLY'],
};
function newContacts(queue) {
  const fresh = [];
  for (const t of Object.keys(NEW_CONTACT)) if (queue.includes(t) && !game.seenTypes.has(t)) fresh.push(t);
  // seeker MK2s aren't in the queue (wardens and the dreadnought launch them)
  if (seekerType(game.wave) === 'seeker2' && !game.seenTypes.has('seeker2') && (queue.includes('warden') || queue.includes('dread'))) fresh.push('seeker2');
  for (const t of fresh) game.seenTypes.add(t);
  return fresh;
}

function waveBanner(n, count, restocked, fresh = []) {
  fresh = fresh.filter((t) => NEW_CONTACT[t]);
  if (fresh.length && !isBossWave(n)) {
    hud.banner(`WAVE ${n} · NEW CONTACT: ${fresh.map((t) => NEW_CONTACT[t][0]).join(' + ')}`, fresh.map((t) => NEW_CONTACT[t][1]).join('  ·  '), 5200);
    audio.waveStart();
    audio.alarm();
    return;
  }
  if (isBossWave(n)) {
    hud.banner(`WAVE ${n} · DREADNOUGHT`, `ENEMY FORTRESS ON A LOW ORBIT · KNOCK OUT ITS TURRETS · WATCH FOR LAUNCHED SEEKERS${restocked ? ' · MISSILES REARMED' : ''}`, 4200);
    audio.waveStart();
    audio.alarm();
  } else {
    hud.banner(`WAVE ${n}`, `${count} HOSTILE SIGNATURES INBOUND${restocked ? ' · MISSILES REARMED' : ''}`, 2800);
    audio.waveStart();
  }
}

/** The dreadnought: a circular, inclined low orbit, appearing well clear of the pilots. */
function spawnBoss(e) {
  const pilots = alivePilots();
  const ref = pilots.length ? pilots[Math.floor(Math.random() * pilots.length)].pos : player.pos;
  const normal = new THREE.Vector3(rand(-0.45, 0.45), 1, rand(-0.45, 0.45)).normalize();
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  let bestPhase = 0, bestScore = -Infinity;
  for (let i = 0; i < 48; i++) {
    const ph = (i / 48) * Math.PI * 2;
    circularOrbitState(BOSS_ORBIT, normal, ph, pos, vel);
    const d = pos.distanceTo(ref);
    const score = -Math.abs(d - 1700) - (occludedByHole(pos, ref, 1.2) ? 400 : 0);
    if (score > bestScore) { bestScore = score; bestPhase = ph; }
  }
  circularOrbitState(BOSS_ORBIT, normal, bestPhase, pos, vel);
  e.pos.copy(pos);
  e.vel.copy(vel);
  e.setOrbit(BOSS_ORBIT, normal);
  // tougher with each appearance, and with every extra pilot
  const appearance = bossAppearance();
  e.appearance = appearance;
  const grow = 1 + 0.3 * (appearance - 1);
  e.maxHp = e.hp = Math.round(e.def.hp * enemyScale() * grow * diffDef().hp);
  const turretHp = e.def.turret.hp * (1 + 0.5 * (pilotCount() - 1)) * grow * diffDef().hp;
  for (const t of e.turrets) t.hp = t.maxHp = turretHp;
  e.mesh.position.copy(pos);
  e.mesh.quaternion.copy(e.quat);
  e.mesh.scale.setScalar(0.01);
  e.trail.reset(pos);
  game.enemies.push(e);
  bossWarpFx(e);
}

function bossWarpFx(e) {
  for (let i = 0; i < 4; i++) {
    _v1.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(30).add(e.pos);
    warpInFx(_v1, e.vel);
  }
  particles.emit(e.pos.x, e.pos.y, e.pos.z, e.vel.x, e.vel.y, e.vel.z, 2, 0.6, 0.8, 40, 180, 0.6, false);
  audio.warp();
}

/** Which appearance of the dreadnought this is (1st, 2nd …), from the wave number. */
const bossAppearance = (wave = game.wave) => Math.max(1, Math.round(wave / BOSS_EVERY));
/** Later fortresses carry more guns: 6, 8, 10, then 12 turrets. */
const bossTurretCount = (wave) => Math.min(12, 6 + 2 * (bossAppearance(wave) - 1));

function spawnEnemy(type) {
  const e = new Enemy(type, scene, game.wave - 1, undefined, type === 'dread' ? bossTurretCount() : undefined);
  scaleEnemyHp(e);
  if (e.def.boss) { spawnBoss(e); return; }
  const pos = new THREE.Vector3(), vel = new THREE.Vector3();
  // in multiplayer, place each newcomer relative to a random pilot
  const pilots = alivePilots();
  const ref = pilots.length ? pilots[Math.floor(Math.random() * pilots.length)].pos : player.pos;
  // about a third of the gunships spawn on the far side of the hole
  const farSide = !isSeekerType(type) && Math.random() < 0.35;
  for (let tries = 0; tries < 40; tries++) {
    const r = isSeekerType(type) ? rand(800, 1400) : rand(750, 1900);
    // mostly prograde, modest inclinations: orbital speeds are high, so a
    // retrograde or steeply inclined orbit would make for blink-and-miss passes
    const normal = new THREE.Vector3(rand(-0.3, 0.3), 1, rand(-0.3, 0.3)).normalize();
    circularOrbitState(r, normal, rand(0, Math.PI * 2), pos, vel, rand(0.93, 1.07));
    const d = pos.distanceTo(ref);
    if (farSide ? d > 1600 && occludedByHole(pos, ref, 1.2) : d > 400 && d < 1100) break;
  }
  e.pos.copy(pos);
  e.vel.copy(vel);
  e.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(vel), new THREE.Vector3(0, 1, 0)));
  e.mesh.position.copy(pos);
  e.mesh.scale.setScalar(0.01);
  e.trail.reset(pos);
  game.enemies.push(e);
  warpInFx(pos, vel);
  // a warden arrives with a seeker already on its way, then settles into its usual rhythm
  if (e.def.seekerEvery) {
    wardenLaunch(e);
    e.seekerTimer = rand(...e.def.seekerEvery);
  }
}

function warpInFx(pos, vel) {
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
  const sent = [];
  const accuracy = Math.max(0.01, 0.022 - e.difficulty * 0.0012);  // per-shot jitter (rad)
  for (let k = 0; k < shots; k++) {
    const off = shots > 1 ? (k - (shots - 1) / 2) * 0.06 : 0;
    const dir = _v3.copy(fwd).applyAxisAngle(_up, off);
    dir.x += rand(-accuracy, accuracy); dir.y += rand(-accuracy, accuracy); dir.z += rand(-accuracy, accuracy);
    dir.normalize();
    _q1Vec.copy(e.vel).addScaledVector(dir, def.boltSpeed);
    enemyBolts.spawn(muzzle, _q1Vec, 4.2, def.dmg);
    if (game.mp) sent.push(...r2(_q1Vec));
  }
  enemyFireFx(muzzle, e.vel, e.type === 'warden');
  // everyone simulates the same bolts; each pilot judges hits on their own ship
  if (game.mp) net.sendEvent({ k: 'ef', t: simNow(), p: r2(muzzle), ev: r2(e.vel), v: sent, dmg: def.dmg, w: e.type === 'warden' ? 1 : 0 });
}

/** One shot from a dreadnought turret (its twin barrels alternate). */
function turretFire(e, t) {
  const td = e.def.turret;
  // shoot along the gunner's solution (the barrel is already within a few degrees of it)
  const fwd = _v1.copy(t.aimDir);
  const side = _v3.crossVectors(fwd, t.worldN).normalize();
  t.gun = !t.gun;
  const muzzle = _v2.copy(t.pos).addScaledVector(fwd, t.muzzle).addScaledVector(side, t.gun ? 1.15 : -1.15);
  const jitter = Math.max(0.006, 0.011 - e.difficulty * 0.0006);
  fwd.x += rand(-jitter, jitter); fwd.y += rand(-jitter, jitter); fwd.z += rand(-jitter, jitter);
  fwd.normalize();
  _q1Vec.copy(e.vel).addScaledVector(fwd, td.boltSpeed);
  const life = td.range / td.boltSpeed + 1;   // long enough to reach its full range
  enemyBolts.spawn(muzzle, _q1Vec, life, td.dmg);
  enemyFireFx(muzzle, e.vel, false);
  if (game.mp) net.sendEvent({ k: 'ef', t: simNow(), p: r2(muzzle), ev: r2(e.vel), v: r2(_q1Vec), dmg: td.dmg, w: 0, l: round2(life) });
}

/**
 * The dreadnought launches a seeker drone from its prow (host / solo). Launched
 * seekers are ordinary seekers, but leave no wreck (no farming the fortress).
 * Returns false when too many of its drones are already out.
 */
/**
 * A dreadnought volley. Solo: a pair at you. Multiplayer: one seeker at each
 * pilot within reach (not docked), so nobody gets the whole volley.
 */
function bossVolley(e) {
  const n = e.built.launchers.length;
  const extra = Math.min(3, (e.appearance || 1) - 1);   // later fortresses add a seeker a volley (up to 3)
  if (!game.mp) {
    const size = n + extra;
    let any = false;
    for (let i = 0; i < size; i++) any = bossLaunch(e, i % n, null, i === 0, Math.floor(i / n), size) || any;
    return any;
  }
  const reach = (e.def.launchRange || 1800) * 1.5;
  let targets = alivePilots().filter((p) => !p.docked && !p.docking && p.pos.distanceTo(e.pos) < reach);
  if (!targets.length) targets = [nearestPilot(e.pos)];
  // one at each pilot, then the extras shared round the pilots in turn
  const size = targets.length + extra;
  let any = false;
  for (let i = 0; i < size; i++) any = bossLaunch(e, i % n, targets[i % targets.length], i === 0, Math.floor(i / n), size) || any;
  return any;
}

function bossLaunch(e, li, target = null, alert = true, stagger = 0, volley = 2) {
  const cap = 2 * volley;   // two volleys' worth in flight at most
  let out = 0;
  for (const x of game.enemies) if (x.alive && x.launched) out++;
  if (out >= cap) return false;
  const s = new Enemy(seekerType(game.wave), scene, game.wave - 1);
  scaleEnemyHp(s);
  s.launched = true;
  s.noWreck = true;
  s.assigned = target;
  const fwd = forwardOf(e.quat, _v3);
  s.pos.copy(e.built.launchers[li]).applyQuaternion(e.quat).add(e.pos);
  if (stagger) s.pos.addScaledVector(_v1.set(0, 1, 0).applyQuaternion(e.quat), (stagger % 2 ? 4 : -4) * Math.ceil(stagger / 2)).addScaledVector(fwd, -3 * stagger);   // extras clear of the first pair
  s.vel.copy(e.vel).addScaledVector(fwd, 45 - 4 * stagger);
  s.quat.copy(e.quat);
  s.age = 0.8;             // skip most of the warm-up: it comes out hot
  s.spawnFx = 0.6;
  s.mesh.position.copy(s.pos);
  s.mesh.scale.setScalar(0.4);
  s.trail.reset(s.pos);
  game.enemies.push(s);
  launchFx(s.pos, s.vel);
  if (alert) {   // one alert per volley
    seekerLaunchAlert(s.pos);
    if (game.mp) net.sendEvent({ k: 'sl', p: r2(s.pos) });
  }
  return true;
}

function lancersAlive() { let n = 0; for (const e of game.enemies) if (e.alive && e.type === 'lancer') n++; return n; }

/**
 * A warden launches a seeker drone (host / solo), at most two of its own in flight.
 * Like the dreadnought's, they leave no wreck, so a warden can't be farmed.
 */
function wardenLaunch(w) {
  let mine = 0;
  for (const x of game.enemies) if (x.alive && x.launchedBy === w) mine++;
  if (mine >= 2) return;
  const s = new Enemy(seekerType(game.wave), scene, game.wave - 1);
  scaleEnemyHp(s);
  s.launchedBy = w;
  s.noWreck = true;
  const fwd = forwardOf(w.quat, _v3);
  s.pos.copy(w.pos).addScaledVector(fwd, 5);
  s.vel.copy(w.vel).addScaledVector(fwd, 30);
  s.quat.copy(w.quat);
  s.age = 0.8;
  s.spawnFx = 0.6;
  s.mesh.position.copy(s.pos);
  s.mesh.scale.setScalar(0.4);
  s.trail.reset(s.pos);
  game.enemies.push(s);
  launchFx(s.pos, s.vel);
  seekerLaunchAlert(s.pos, true);
  if (game.mp) net.sendEvent({ k: 'sl', p: r2(s.pos), w: 1 });
}

/** Seekers just launched (from the dreadnought's tubes, or a warden): warn anyone in reach. */
function seekerLaunchAlert(pos, warden = false) {
  if (!player.alive || pos.distanceTo(player.pos) > (warden ? 1500 : 2600)) return;
  hud.notice(warden ? '⚠ WARDEN LAUNCHED A SEEKER' : '⚠ SEEKERS LAUNCHED FROM THE DREADNOUGHT', warden ? 'orange' : 'red');
  audio.beep(1250, 0.1, 0.07, 'square');
  setTimeout(() => audio.beep(1250, 0.1, 0.07, 'square'), 140);
}

function launchFx(pos, vel) {
  for (let i = 0; i < 24; i++) {
    randDir(_v1);
    particles.emit(pos.x, pos.y, pos.z, vel.x + _v1.x * 12, vel.y + _v1.y * 12, vel.z + _v1.z * 12, 1.4, 0.9, 0.3, 1.2, 3, 0.7, false);
  }
  if (pos.distanceTo(player.pos) < 1000) audio.missileLaunch();
}

/** A cannon hit on one of the dreadnought's turrets. The host owns turret health. */
function hitTurret(e, i, dmg, point, cause = 'player', by = net.myId) {
  const t = e.turrets && e.turrets[i];
  if (!e.alive || !t || !t.alive) return;
  if (by === net.myId) {
    sparks(point, e.vel, 10, 2.2, 1.0, 0.4, 30);
    audio.hitConfirm();
  }
  if (isGuest()) {
    net.sendEvent({ k: 'hit', id: e.netId, dmg, cause, tu: i });
    hud.hitmarker(false);
    return;
  }
  t.hp -= dmg;
  if (t.hp <= 0) destroyTurret(e, i, by);
  else if (by === net.myId) hud.hitmarker(false);
}

function destroyTurret(e, i, by = net.myId) {
  if (!e.killTurret(i)) return;
  if (game.mp && !isGuest()) net.sendEvent({ k: 'tkill', id: e.netId, tu: i, by });
  const t = e.turrets[i];
  explode(t.pos, e.vel, 1.1, [1.0, 0.4, 0.15]);
  audio.explosion(1.1, THREE.MathUtils.clamp(1.4 - t.pos.distanceTo(player.pos) / 700, 0.15, 1));
  const left = e.turretsAlive;
  if (by === net.myId || !game.mp) {
    const pts = e.def.turret.score * game.mult;
    game.score += pts;
    hud.hitmarker(true);
    hud.project(t.pos, camera, scr);
    hud.popup(scr.onScreen ? scr.x : innerWidth / 2, scr.onScreen ? scr.y : innerHeight * 0.36, `+${pts}`, left ? `TURRET DOWN · ${left} LEFT` : 'ALL TURRETS DOWN');
  }
  if (!left) hud.notice('DREADNOUGHT TURRETS SILENCED', 'green');
}

function enemyFireFx(muzzle, vel, heavy) {
  particles.emit(muzzle.x, muzzle.y, muzzle.z, vel.x, vel.y, vel.z, 2.5, 0.4, 0.5, 2.5, 0.5, 0.12, false);
  const dist = muzzle.distanceTo(player.pos);
  audio.enemyLaser(THREE.MathUtils.clamp(1.3 - dist / 500, 0, 1), heavy);
}
const _q1Vec = new THREE.Vector3();

const KILL_FX = {
  raider: [1.15, [1.0, 0.42, 0.12]], warden: [1.8, [1.0, 0.35, 1.0]], seeker: [0.9, [1.0, 0.7, 0.15]], seeker2: [1.0, [1.0, 0.92, 0.4]],
  lancer: [1.2, [0.45, 1.0, 0.55]], sower: [1.7, [1.0, 0.55, 0.15]], aegis: [1.6, [0.6, 0.55, 1.0]],
  dread: [3.2, [1.0, 0.35, 0.2]],
};

/**
 * A mine goes off (shot, triggered, or the wave ended). Its blast hurts any
 * pilot close by; each pilot's game checks its own ship.
 */
function mineBlast(e, cause, by) {
  if (cause === 'void' || cause === 'horizon' || cause === 'fizzle') {
    if (cause === 'fizzle') sparks(e.pos, e.vel, 14, 1.2, 0.5, 0.2, 12);
    e.destroy();
    return;
  }
  const def = e.def;
  explode(e.pos, e.vel, 2.4, [1.0, 0.45, 0.15]);
  const d = player.pos.distanceTo(e.pos);
  audio.explosion(1.2, THREE.MathUtils.clamp(1.4 - d / 700, 0.15, 1));
  if (player.alive && d < def.blast) {
    damagePlayer(def.blastDmg * (1 - 0.5 * d / def.blast) * diffDef().dmg, { cause: 'CAUGHT IN A MINE BLAST' });
    game.trauma = Math.min(1, game.trauma + 0.5);
  }
  if ((cause === 'player' || cause === 'missile') && (by === net.myId || !game.mp)) {
    game.score += def.score;
    hud.hitmarker(true);
    hud.project(e.pos, camera, scr);
    if (scr.onScreen) hud.popup(scr.x, scr.y, `+${def.score}`, 'MINE CLEARED');
  }
  e.destroy();
}

/**
 * Destroy an enemy. `by` is the pilot credited (multiplayer); only that pilot's
 * game scores it. The host decides kills and tells everyone; guests replay them.
 */
function killEnemy(e, cause, by = net.myId, fromHost = false) {
  if (!e.alive) return;
  if (isGuest() && !fromHost) return;   // guests never decide kills themselves
  if (game.mp && !isGuest()) {
    net.sendEvent({ k: 'kill', id: e.netId, y: ENEMY_TYPES.indexOf(e.type), cause, by, p: r2(e.pos), v: r2(e.vel), nw: e.noWreck ? 1 : 0 });
  }
  if (isGuest()) mp.deadIds.add(e.netId);
  if (e.def.inert) { mineBlast(e, cause, by); return; }
  const boss = !!e.def.boss;
  const [scale, tint] = KILL_FX[e.type] || KILL_FX.raider;
  if (boss && cause !== 'void') bossDeathFx(e);
  const dist = e.pos.distanceTo(player.pos);
  if (cause === 'void') { e.destroy(); return; }
  if (cause !== 'horizon') explode(e.pos, e.vel, scale, tint);
  if ((cause === 'player' || cause === 'ram' || cause === 'missile') && !e.noWreck) wrecks.spawn(e);
  audio.explosion(scale, THREE.MathUtils.clamp(1.4 - dist / 700, 0.15, 1));
  if (dist < 60) game.trauma = Math.min(1, game.trauma + 0.35);

  let pts = 0;
  let sub = '';
  if (by !== net.myId && game.mp) {
    // someone else's kill: no score here
  } else if (cause === 'player' || cause === 'ram' || cause === 'missile') {
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

// ---------------------------------------------------------------------------
// Lancer beams. The host's lancer fires; every pilot's game draws the beam and
// checks whether it hit their own ship.
// ---------------------------------------------------------------------------
const beamPool = [];
const beamGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);
for (let i = 0; i < 6; i++) {
  const outer = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x3dff8a).multiplyScalar(3), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const inner = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  const g = new THREE.Group();
  g.add(outer, inner);
  g.visible = false;
  g.userData = { t: 0, outer, inner };
  outer.frustumCulled = inner.frustumCulled = false;
  scene.add(g);
  beamPool.push(g);
}
function updateBeams(dt) {
  for (const g of beamPool) {
    if (!g.visible) continue;
    g.userData.t -= dt;
    const k = Math.max(0, g.userData.t / 0.4);
    if (k <= 0) { g.visible = false; continue; }
    g.userData.outer.material.opacity = k * 0.8;
    g.userData.inner.material.opacity = k;
    const w = 0.4 + 1.6 * k;
    g.userData.outer.scale.set(w * 1.6, w * 1.6, g.userData.len);
    g.userData.inner.scale.set(w * 0.45, w * 0.45, g.userData.len);
  }
}

/** Length of a beam before the hole swallows it. */
function beamLength(o, d, max) {
  const t = -o.dot(d);                          // closest approach to the singularity
  const reach = RS * 1.5;
  if (t > 0 && t < max) {
    const c2 = o.lengthSq() - t * t;
    if (c2 < reach * reach) return Math.max(0, t - Math.sqrt(reach * reach - c2));
  }
  return max;
}

const LANCER_BEAM = new THREE.Color(0x3dff8a).multiplyScalar(3);
const RAIL_BEAM = new THREE.Color(0x5ef2ff).multiplyScalar(3);
function drawBeam(origin, dir, len, color = LANCER_BEAM) {
  const g = beamPool.find((b) => !b.visible) || beamPool[0];
  g.visible = true;
  g.userData.t = 0.4;
  g.userData.len = len;
  g.userData.outer.material.color.copy(color);
  g.position.copy(origin);
  g.quaternion.setFromUnitVectors(_v1.set(0, 0, -1), dir);
  for (let i = 0; i < 30; i++) {
    randDir(_v3);
    particles.emit(origin.x, origin.y, origin.z, _v3.x * 20, _v3.y * 20, _v3.z * 20, color.r * 0.25, color.g * 0.25, color.b * 0.25, 1.2, 1.5, 0.4, false);
  }
}

const BOSS_BEAM = new THREE.Color(0xff3a3a).multiplyScalar(3.2);
// Beam hitbox: the fuselage plus spheres down each wing (the MK2's nacelles sit inside the outer ones),
// in the ship's frame as [x, z, radius].
const BEAM_HULL = [[0, 0, 1.6], [0, -1.6, 0.9], [1.25, 0.6, 0.9], [-1.25, 0.6, 0.9], [2.35, 1.1, 0.75], [-2.35, 1.1, 0.75]];
const _bh = new THREE.Vector3();
/** How close a beam passes to the ship's hull (negative = through it). */
function beamMiss(origin, dir, len, pos, quat) {
  let best = Infinity;
  for (const [x, z, rad] of BEAM_HULL) {
    _bh.set(x, 0, z).applyQuaternion(quat).add(pos).sub(origin);
    const t = THREE.MathUtils.clamp(_bh.dot(dir), 0, len);
    best = Math.min(best, _bh.addScaledVector(dir, -t).length() - rad);
  }
  return best;
}
/**
 * Draw a beam and work out who it hit. The host (or solo) is the judge for every
 * pilot, against the same picture of them it aimed with, so lag or clock drift
 * can't make a shot at someone sitting still miss. Guests only draw it.
 */
function fireBeam(origin, dir, len, dmg, boss = false, judge = true) {
  drawBeam(origin, dir, len, boss ? BOSS_BEAM : LANCER_BEAM);
  const light = flashLights[flashIdx];
  flashIdx = (flashIdx + 1) % flashLights.length;
  light.position.copy(origin);
  light.userData.t = 1;
  light.userData.peak = 900;
  light.userData.vel = null;
  const margin = boss ? 3 : 1.2;   // about the drawn beam's width
  const miss = beamMiss(origin, dir, len, player.pos, player.quat);
  audio.beam(THREE.MathUtils.clamp(1.4 - Math.min(Math.max(miss, 0), origin.distanceTo(player.pos)) / 900, 0.1, 1));
  if (judge) {
    if (player.alive && !player.docked && miss < margin) beamHitMe(dmg, boss);
    if (game.mp) {
      for (const [id, r] of remotes) {
        if (!r.present || !r.alive || r.docked) continue;
        if (beamMiss(origin, dir, len, r.pos, r.quat) < margin) net.sendEvent({ k: 'beamHit', dmg, b: boss ? 1 : 0 }, id);
      }
    }
  }
  if (player.alive && miss >= margin + (judge ? 0 : 4) && miss < 25) hud.notice('BEAM NEAR MISS', 'dim');
}

function beamHitMe(dmg, boss) {
  if (!player.alive) return;
  damagePlayer(dmg * diffDef().dmg, { cause: boss ? 'HIT BY THE DREADNOUGHT RAILGUN' : 'BURNED BY A LANCER BEAM' });
  game.trauma = 1;
  sparks(player.pos, player.vel, 30, 0.6, 2.0, 0.9, 30);
}

function lancerFire(e) {
  const dir = forwardOf(e.quat, new THREE.Vector3());
  const origin = e.pos.clone().addScaledVector(dir, e.def.muzzle || 7.2);
  const len = beamLength(origin, dir, e.def.beamRange);
  const boss = !!e.def.boss;
  fireBeam(origin, dir, len, e.def.beamDmg, boss);
  if (boss) { game.trauma = Math.min(1, game.trauma + 0.4); audio.explosion(0.8, 0.6); }
  if (game.mp) net.sendEvent({ k: 'beam', t: simNow(), p: r2(origin), d: [dir.x, dir.y, dir.z].map((x) => Math.round(x * 1e5) / 1e5), l: Math.round(len), dmg: e.def.beamDmg, b: boss ? 1 : 0 });
}

/**
 * A sower flings a mine out behind it (host / solo); capped per sower. Each one gets a
 * sideways kick in a random direction across the sower's path, so it ends up on its own
 * slightly different orbit and the field fans out instead of trailing in a line.
 */
function layMine(s) {
  let out = 0;
  for (const x of game.enemies) if (x.alive && x.owner === s.netId) out++;
  if (out >= s.def.maxMines) return;
  const m = new Enemy('mine', scene, game.wave - 1);
  scaleEnemyHp(m);
  m.owner = s.netId;
  const back = forwardOf(s.quat, _v1).negate();
  m.pos.copy(s.pos).addScaledVector(back, 6);
  m.vel.copy(s.vel).addScaledVector(back, 4);
  randDir(_v2);
  _v2.addScaledVector(back, -_v2.dot(back)).normalize();   // across the sower's path
  m.vel.addScaledVector(_v2, rand(10, 22));
  m.mesh.position.copy(m.pos);
  m.mesh.scale.setScalar(0.3);
  m.spawnFx = 0.7;
  game.enemies.push(m);
  for (let i = 0; i < 10; i++) {
    randDir(_v3);
    particles.emit(m.pos.x, m.pos.y, m.pos.z, m.vel.x + _v3.x * 4, m.vel.y + _v3.y * 4, m.vel.z + _v3.z * 4, 1.2, 0.5, 0.2, 0.8, 1.2, 0.5, false);
  }
}

// ---------------------------------------------------------------------------
// Aegis: ships within range of one take reduced damage; tethers show which.
// ---------------------------------------------------------------------------
const AEGIS_MULT = 0.1;   // −90% damage while shielded
function supportTarget(a) {
  let best = null, bd = 1500 * 1500;
  for (const e of game.enemies) {
    if (!e.alive || e === a || e.def.support || e.def.inert || e.def.boss) continue;
    const d = e.pos.distanceToSquared(a.pos);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
const MAX_TETHERS = 48;
const tetherGeo = new THREE.BufferGeometry();
tetherGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TETHERS * 6), 3));
const tethers = new THREE.LineSegments(tetherGeo, new THREE.LineBasicMaterial({
  color: new THREE.Color(0x7a6bff).multiplyScalar(2.5), transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false,
}));
tethers.frustumCulled = false;
scene.add(tethers);
const _tA = new THREE.Vector3();
function updateAegis(time) {
  const P = tetherGeo.attributes.position.array;
  let n = 0;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    let by = null;
    if (!e.def.support && !e.def.inert && !e.def.boss) {
      for (const a of game.enemies) {
        if (a.alive && a.def.support && a.pos.distanceTo(e.pos) < a.def.shieldRange) { by = a; break; }
      }
    }
    e.setShielded(!!by);
    if (by && n < MAX_TETHERS) {
      _tA.copy(by.renderPos);
      const b = e.renderPos;
      P.set([_tA.x, _tA.y, _tA.z, b.x, b.y, b.z], n * 6);
      n++;
    }
  }
  tetherGeo.setDrawRange(0, n * 2);
  tetherGeo.attributes.position.needsUpdate = true;
  tethers.material.opacity = 0.45 + 0.25 * Math.sin(time * 6);
}

// ===========================================================================
// Player actions
// ===========================================================================
function hitEnemy(e, dmg, point, cause = 'player', by = net.myId) {
  if (!e.alive) return;
  if (by === net.myId) {
    e.flash = 1;
    if (e.shielded) sparks(point, e.vel, 12, 0.8, 0.7, 2.6, 24);   // deflected off an aegis shield
    else sparks(point, e.vel, 10, 0.5, 1.6, 2.2, 30);
    audio.hitConfirm();
  }
  if (isGuest()) {
    // the host owns enemy health: report the hit and let it decide
    net.sendEvent({ k: 'hit', id: e.netId, dmg, cause });
    hud.hitmarker(false);
    return;
  }
  e.hp -= dmg * (e.shielded ? AEGIS_MULT : 1);
  if (by !== net.myId) e.flash = 1;
  if (e.hp <= 0) killEnemy(e, cause, by);
  else if (by === net.myId) hud.hitmarker(false);
}

const missiles = new MissileSystem({
  scene, particles, audio, hud, player, camera,
  enemies: () => game.enemies,
  wrecks: () => wrecks.list,
  collectWreck: (w, m) => wrecks.collect(w, m.pos, m.vel, 'missile'),
  explode, hitEnemy, damagePlayer,
  // missiles leave from the pylon they were hanging on (the outermost loaded one)
  launchPos: (slot, out) => {
    const p = shipParts.activePylons[slot];
    return p ? out.copy(p.local).applyQuaternion(player.quat).add(player.pos) : null;
  },
});

// The dreadnought goes up in a chain of blasts along its hull.
const bossBlasts = [];
function bossDeathFx(e) {
  for (const t of e.turrets) if (t.alive) e.killTurret(t.index);
  for (let i = 0; i < 9; i++) {
    const part = e.hitParts[i % 6];
    bossBlasts.push({
      t: 0.12 + i * 0.16 + Math.random() * 0.08,
      pos: part.pos.clone().add(_v1.set(rand(-8, 8), rand(-8, 8), rand(-8, 8))),
      vel: e.vel.clone(),
      scale: rand(1.2, 2.0),
    });
  }
  hud.banner('DREADNOUGHT DESTROYED', 'THE FORTRESS IS BREAKING UP · SALVAGE ITS HULK', 3500);
  game.clearHold = 3.5;   // let the moment land before the wave-clear banner
  if (e.pos.distanceTo(player.pos) < 900) game.trauma = 1;
}
function updateBossBlasts(dt) {
  for (const b of bossBlasts) {
    b.pos.addScaledVector(b.vel, dt);
    b.t -= dt;
    if (b.t <= 0 && !b.done) {
      b.done = true;
      explode(b.pos, b.vel, b.scale, [1.0, 0.4, 0.18]);
      audio.explosion(b.scale, THREE.MathUtils.clamp(1.4 - b.pos.distanceTo(player.pos) / 900, 0.15, 1));
    }
  }
  for (let i = bossBlasts.length - 1; i >= 0; i--) if (bossBlasts[i].done) bossBlasts.splice(i, 1);
}

// ===========================================================================
// Station, salvage & upgrades
// ===========================================================================
const station = new Station(scene);
const wrecks = new WreckSystem(scene, particles);
const dockAssist = new DockAssist(station, MAIN_THRUST);
// With a dreadnought on the field, B chases it down and holds you this far off
const BOSS_STANDOFF = 600;
const bossPark = new BodyTarget();
const liveBoss = () => game.enemies.find((e) => e.alive && e.def.boss && e.orbitR) || null;

wrecks.onCollect = (w, by) => {
  // guests ask the host (it makes sure each wreck is only salvaged once); host/solo credit directly
  const value = Math.round(w.value * scrapMult());   // Scrap Refinery
  if (isGuest()) net.sendEvent({ k: 'salvage', id: w.id });
  else {
    addScrap(value);
    if (game.mp) net.sendEvent({ k: 'salvaged', id: w.id });
  }
  audio.pickup();
  hud.project(w.pos, camera, scr);
  const sub = by === 'missile' ? 'DRONE SALVAGE' : 'SALVAGED';
  if (scr.onScreen) hud.popup(scr.x, scr.y, `+${value} SCRAP`, sub);
  else hud.popup(innerWidth / 2, innerHeight * 0.4, `+${value} SCRAP`, sub);
};

// ---------------------------------------------------------------------------
// MK2 abilities. Railgun: hold right mouse to charge, release to fire a
// hitscan slug along your nose. Afterburner: R for 3 s of double thrust.
// Auto-Rearm rebuilds missiles slowly. All come from the tech tree.
// ---------------------------------------------------------------------------
const RAIL_DAMAGE = 15;          // × the cannon damage multiplier
const RAIL_BASE_RANGE = 700, RAIL_COIL_RANGE = 300;   // Railgun Coils: +300 m a level (5 levels)
const railRange = () => RAIL_BASE_RANGE + RAIL_COIL_RANGE * (game.levels.railrange || 0);
const RAIL_COOLDOWN = 4;
const BOOST_TIME = 3, BOOST_COOLDOWN = 15;
const LAUNCH_DELAY = 2.6;      // s in the clamps at the start of a run
const AUTO_REARM_EVERY = 40;
const RAIL_ASSIST = Math.cos(THREE.MathUtils.degToRad(4));   // snaps to a target this close to the crosshair
const RAIL_PAD = 4;                                          // m added to every target's hit radius…
const RAIL_SPREAD = 0.01;                                    // …plus 1 m per 100 m of range
let railHeld = false;
let railTarget = null;   // what the railgun is locked onto while charging (for the bracket)

/** The target nearest the crosshair within the assist cone, or null. */
function findRailTarget() {
  const fwd = forwardOf(player.quat, _v1);
  let best = null, bestDot = RAIL_ASSIST;
  for (const t of collectBoltTargets()) {
    if (!t.alive || t.isMissile) continue;
    const d = _v2.subVectors(t.pos, player.pos);
    const dist = d.length();
    if (dist > railRange() || dist < 1) continue;
    const dot = d.divideScalar(dist).dot(fwd);
    if (dot > bestDot && !occludedByHole(player.pos, t.pos, 1.3)) { bestDot = dot; best = t; }
  }
  return best;
}
const railChargeTime = () => (game.levels.railcap ? 0.75 : 1.25);
/** Scrap per railgun shot: 8, less 1 per Slug Foundry level. */
const railShotCost = () => Math.max(0, 8 - (game.levels.railecon || 0));
const canAffordRail = () => game.scrap >= railShotCost();
/** Pay for a shot. Guests pay locally straight away (no round trip before the shot) and the host takes it from the pool. */
function payRailShot() {
  const cost = railShotCost();
  game.scrap = Math.max(0, game.scrap - cost);
  if (isGuest()) net.sendEvent({ k: 'railPay', amount: cost });
  else econBroadcast();
}

function resetAbilities() {
  Object.assign(game, { boostT: 0, boostCd: 0, railCd: 0, railCharge: 0, rearmT: 0, emergencyUsed: false, railTick: 0, jumpCd: 0 });
  railHeld = false;
}

// Jump Drive (Y): coast the current orbit forward under the real gravity until it has
// swept halfway round the hole, and put the ship there with the velocity it would have.
const JUMP_COOLDOWN = 45;
const JUMP_MAX_T = 900;   // s of coasting to search (well past any orbit in the arena)
const _jp = new THREE.Vector3(), _jv = new THREE.Vector3(), _jn = new THREE.Vector3(), _jprev = new THREE.Vector3(), _jc = new THREE.Vector3();
/** Where half an orbit takes the ship: { pos, vel, angle } in _jp/_jv, or a reason string it can't. */
function jumpSolution() {
  _jp.copy(player.pos); _jv.copy(player.vel);
  _jn.crossVectors(_jp, _jv);
  if (_jn.lengthSq() < 1e-6) return 'NO ORBIT';
  _jn.normalize();
  let swept = 0;
  for (let t = 0; t < JUMP_MAX_T;) {
    const h = _jp.length() < 900 ? 1 / 240 : 1 / 30;   // finer steps on a fast pass near the hole
    t += h;
    _jprev.copy(_jp);
    if (!integrate(_jp, _jv, null, h)) return 'ORBIT FALLS INTO THE HOLE';
    const r = _jp.length();
    if (r < RS * 2) return 'ORBIT FALLS INTO THE HOLE';
    if (r > ARENA_RADIUS * 2.5) return 'NOT IN ORBIT';
    swept += Math.atan2(_jc.crossVectors(_jprev, _jp).dot(_jn), _jprev.dot(_jp));
    if (swept >= Math.PI) return null;
  }
  return 'ORBIT TOO SLOW';
}

function useJumpDrive() {
  if (!game.levels.jumpdrive || player.docked || player.docking || !player.alive) return;
  if (game.jumpCd > 0) { hud.notice(`JUMP DRIVE RECHARGING · ${Math.ceil(game.jumpCd)} s`, 'dim'); return; }
  const why = jumpSolution();
  if (why) { hud.notice(`JUMP DRIVE · ${why}`, 'red'); audio.beep(220, 0.15, 0.06, 'square'); return; }
  jumpFx(player.pos, player.vel);
  // turn the ship (and camera) with the orbit, so it faces the same way relative to its path
  _q1.setFromAxisAngle(_jn, Math.PI);
  player.quat.premultiply(_q1);
  camQuat.premultiply(_q1);
  player.pos.copy(_jp);
  player.vel.copy(_jv);
  for (const t of playerTrails) t.reset(player.pos);
  jumpFx(player.pos, player.vel);
  dockAssist.disengage();
  game.jumpCd = JUMP_COOLDOWN;
  game.trauma = Math.min(1, game.trauma + 0.5);
  hud.notice('JUMP COMPLETE');
  audio.beep(300, 0.25, 0.08, 'sawtooth');
  setTimeout(() => audio.beep(1400, 0.2, 0.06, 'sine'), 120);
}
function jumpFx(pos, vel) {
  for (let i = 0; i < 90; i++) {
    randDir(_v1);
    particles.emit(pos.x, pos.y, pos.z, vel.x + _v1.x * 40, vel.y + _v1.y * 40, vel.z + _v1.z * 40, 0.35, 0.9, 1.6, 1.6, 2.2, 0.6, false);
  }
}

function useAfterburner() {
  if (!game.levels.afterburner || player.docked || player.docking || !player.alive) return;
  if (game.boostCd > 0) { hud.notice(`AFTERBURNER RECHARGING · ${Math.ceil(game.boostCd)} s`, 'dim'); return; }
  game.boostT = BOOST_TIME;
  game.boostCd = BOOST_COOLDOWN;
  hud.notice('AFTERBURNER', 'orange');
  audio.beep(180, 0.35, 0.09, 'sawtooth');
  game.trauma = Math.min(1, game.trauma + 0.3);
}

function fireRailgun() {
  const origin = shipParts.railMuzzle.clone().applyQuaternion(player.quat).add(player.pos);
  // aim assist: fire straight at whatever is nearest the crosshair, else straight ahead
  const target = findRailTarget();
  const dir = target ? new THREE.Vector3().subVectors(target.pos, origin).normalize() : forwardOf(player.quat, new THREE.Vector3());
  let len = beamLength(origin, dir, railRange());
  // everything the slug passes through, nearest first (the dreadnought counts once)
  const hits = [];
  const seen = new Set();
  for (const t of collectBoltTargets()) {
    if (!t.alive) continue;
    const vx = t.pos.x - origin.x, vy = t.pos.y - origin.y, vz = t.pos.z - origin.z;
    const along = vx * dir.x + vy * dir.y + vz * dir.z;
    if (along < 0 || along > len) continue;
    const r = t.radius + RAIL_PAD + along * RAIL_SPREAD;   // generous: a railgun shouldn't need pixel aim
    if (vx * vx + vy * vy + vz * vz - along * along > r * r) continue;
    hits.push({ t, along });
  }
  hits.sort((a, b) => a.along - b.along);
  const dmg = RAIL_DAMAGE * cannonDamage() / BOLT_DAMAGE;
  for (const h of hits) {
    const owner = h.t.isHull || h.t.isTurret ? h.t.owner : h.t;
    const key = h.t.isTurret ? h.t : owner;
    if (seen.has(key)) continue;
    seen.add(key);
    const point = origin.clone().addScaledVector(dir, h.along);
    if (h.t.isTurret) hitTurret(owner, h.t.index, dmg, point, 'player');
    else if (h.t.isMissile) continue;
    else hitEnemy(owner, dmg, point, 'player');
    if (!game.levels.railpierce) { len = h.along; break; }   // a plain slug stops in the first thing it hits
  }
  drawBeam(origin, dir, len, RAIL_BEAM);
  audio.beam(1);
  player.vel.addScaledVector(dir, -3);              // recoil
  game.trauma = Math.min(1, game.trauma + 0.35);
  game.railCd = RAIL_COOLDOWN;
  if (game.mp) net.sendEvent({ k: 'rail', p: r2(origin), d: [dir.x, dir.y, dir.z].map((x) => Math.round(x * 1e5) / 1e5), l: Math.round(len) });
}

function releaseRail() {
  if (!railHeld) return;
  railHeld = false;
  railTarget = null;
  if (game.railCharge >= 1 && player.alive && !player.docked && !player.docking) {
    if (canAffordRail()) { payRailShot(); fireRailgun(); }
    else hud.notice(`RAILGUN · NEEDS ${railShotCost()} SCRAP`, 'red');
  }
  else if (game.railCharge > 0.05) hud.notice('RAILGUN · RELEASED BEFORE FULL CHARGE', 'dim');
  game.railCharge = 0;
}

function updateAbilities(dt) {
  const lv = game.levels;
  game.boostT = Math.max(0, game.boostT - dt);
  game.boostCd = Math.max(0, game.boostCd - dt);
  game.jumpCd = Math.max(0, game.jumpCd - dt);
  game.railCd = Math.max(0, game.railCd - dt);
  if (lv.autorearm && player.alive && missiles.ammo < missiles.capacity) {
    game.rearmT += dt;
    if (game.rearmT >= AUTO_REARM_EVERY) {
      game.rearmT = 0;
      missiles.ammo++;
      hud.notice('AUTO-REARM · +1 MISSILE', 'green');
    }
  } else game.rearmT = 0;
  railTarget = railHeld && lv.railgun && player.alive && !player.docked ? findRailTarget() : null;
  if (railHeld && lv.railgun && player.alive && !player.docked && !player.docking && game.railCd <= 0 && canAffordRail()) {
    const was = game.railCharge;
    game.railCharge = Math.min(1, game.railCharge + dt / railChargeTime());
    game.railTick -= dt;
    if (game.railCharge < 1 && game.railTick <= 0) { audio.chargeTick(game.railCharge, 0.7); game.railTick = 0.12; }
    if (was < 1 && game.railCharge >= 1) audio.beep(1500, 0.12, 0.06, 'sine');
  }
}

/** Ability readout under the crosshair (only for abilities you own). */
const abilitiesEl = document.getElementById('abilities');
function updateAbilityHud() {
  const lv = game.levels;
  let html = '';
  if (lv.railgun) {
    const c = game.railCharge;
    const state = game.railCd > 0 ? `<em>${game.railCd.toFixed(1)} s</em>`
      : !canAffordRail() ? `<em>NEEDS ${railShotCost()} SCRAP</em>`
      : c >= 1 ? '<b>RELEASE TO FIRE</b>' : c > 0 ? 'CHARGING' : `READY · ${railShotCost()} SCRAP`;
    html += `<div class="ab rail${c >= 1 ? ' full' : ''}"><span>RAILGUN <kbd>RMB</kbd></span><i style="--p:${(game.railCd > 0 ? 0 : c).toFixed(2)}"></i>${state}</div>`;
  }
  if (lv.afterburner) {
    const state = game.boostT > 0 ? '<b>ACTIVE</b>' : game.boostCd > 0 ? `<em>${Math.ceil(game.boostCd)} s</em>` : 'READY';
    html += `<div class="ab boost"><span>AFTERBURNER <kbd>R</kbd></span>${state}</div>`;
  }
  if (lv.jumpdrive) {
    const state = game.jumpCd > 0 ? `<em>${Math.ceil(game.jumpCd)} s</em>` : 'READY';
    html += `<div class="ab boost"><span>JUMP DRIVE <kbd>Y</kbd></span>${state}</div>`;
  }
  if (abilitiesEl._html !== html) { abilitiesEl._html = html; abilitiesEl.innerHTML = html; }
  // bracket on whatever the railgun will snap to
  const rt = document.getElementById('rail-target');
  if (railTarget && game.railCd <= 0) {
    hud.place(rt, railTarget.pos, camera);
    rt.classList.toggle('full', game.railCharge >= 1);
  } else if (rt.style.display !== 'none') rt.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Time warp: between waves, with nothing hostile around, , and . step game
// time between 1× and 10× (handy while the docking assist flies you in). It
// drops back to 1× by itself 10 s before the next wave or if anything hits you.
//
// Multiplayer: warp is shared. Anyone can ask (unless the host turned on
// host-only warp); the host checks it's safe and schedules the change a moment
// ahead, so every pilot switches at the same instant. Everything timed by the
// shared clock uses worldNow(), the host's clock sped up by the warp. The
// simulation follows it (see frameStep), and what it stamps or extrapolates
// (the station's orbit, snapshots, shots) uses simNow(), the time it has reached.
// ---------------------------------------------------------------------------
const WARP_LEVELS = [1, 2, 3, 5, 10];
const WARP_STOP = 10;        // seconds before a wave when warp ends
const WARP_LEAD = 0.2;       // s: multiplayer warp changes are scheduled this far ahead

// shared world clock: W(t) = W0 + rate · (t − T0), with t the host's clock
const warpClock = { T0: 0, W0: 0, rate: 1, pending: null };
function resetWarpClock() {
  warpClock.T0 = 0; warpClock.W0 = 0; warpClock.rate = 1; warpClock.pending = null;
  game.warp = 1;
}
function worldAt(t) { return warpClock.W0 + warpClock.rate * (t - warpClock.T0); }
function worldNow() { return game.mp ? worldAt(net.netTime()) : net.netTime(); }
/** The world time our simulation has reached (trails worldNow by at most a frame or a hitch being made up). */
function simNow() { return game.mp && simWorld !== null ? simWorld : worldNow(); }

/** Why the world isn't safe for time warp ('' if it is). In multiplayer the host judges this. */
function worldWarpBlocker() {
  if (game.waveActive || hostileCount() > 0 || game.spawnQueue.length) return 'HOSTILES IN THE AREA';
  if (game.waveTimer <= WARP_STOP) return 'NEXT WAVE TOO CLOSE';
  return '';
}
/** Why this pilot can't warp ('' if they can). `starting` adds recent damage. */
function selfWarpBlocker(starting = true) {
  if (state !== 'playing' || !player.alive) return game.mp ? '' : 'UNAVAILABLE';
  if (pred.impact && !player.docked && !player.docking) return 'ON COURSE INTO THE HOLE';
  if (starting && game.underAttack > 0) return 'TAKING DAMAGE';
  return '';
}
function warpBlocker(starting = true) { return worldWarpBlocker() || selfWarpBlocker(starting); }

/** The warp level the game is at, or about to switch to. */
function warpTarget() { return warpClock.pending ? warpClock.pending.w : game.warp; }

function changeWarp(dir) {
  const i = WARP_LEVELS.indexOf(warpTarget());
  const next = WARP_LEVELS[THREE.MathUtils.clamp((i < 0 ? 0 : i) + dir, 0, WARP_LEVELS.length - 1)];
  if (next === warpTarget()) return;
  if (game.mp && mp.hostWarp && !net.isHost) {
    hud.notice('TIME WARP · ONLY THE HOST CAN CONTROL IT', 'dim');
    audio.beep(240, 0.1, 0.05, 'square');
    return;
  }
  if (next > 1) {
    const why = game.mp ? selfWarpBlocker() || (net.isHost ? worldWarpBlocker() : '') : warpBlocker();
    if (why) { hud.notice(`TIME WARP · ${why}`, 'dim'); audio.beep(240, 0.1, 0.05, 'square'); return; }
  }
  if (!game.mp) {
    game.warp = next;
    warpFeedback(next, net.myId, '');
  } else if (net.isHost) hostSetWarp(next, net.myId, '');
  else net.sendEvent({ k: 'warpReq', w: next });
}

function warpFeedback(w, by, why) {
  const who = game.mp && by !== net.myId ? ` · ${pilotName(by)}` : '';
  if (w > 1) hud.notice(`TIME WARP ${w}×${who}`, 'green');
  else hud.notice(why ? `TIME WARP OFF · ${why}${who}` : `TIME WARP OFF${who}`, why ? 'orange' : 'dim');
  audio.beep(why ? 420 : 500 + w * 90, why ? 0.12 : 0.06, 0.05, why ? 'square' : 'sine');
}

/** Host: validate and schedule a shared warp change for everyone. */
function hostSetWarp(w, by, why) {
  if (w > 1) {
    const block = worldWarpBlocker();
    if (block) { if (by !== net.myId) net.sendEvent({ k: 'warpDenied', why: block }, by); return; }
  }
  if (w === warpTarget()) return;
  const at = net.netTime() + WARP_LEAD;
  const W0 = worldAt(at);
  warpClock.pending = { w, at, W0, by, why };
  net.sendEvent({ k: 'warp', w, at, W0, by, why });
}

/** Every frame: apply a scheduled multiplayer warp change once its moment arrives. */
function updateWarpClock() {
  const p = warpClock.pending;
  if (!p || net.netTime() < p.at) return;
  warpClock.T0 = p.at; warpClock.W0 = p.W0; warpClock.rate = p.w;
  warpClock.pending = null;
  game.warp = p.w;
  mp.warpDropAsked = false;
  warpFeedback(p.w, p.by, p.why);
}

/** Drop back to 1× (solo), or ask for it (multiplayer). */
function endWarp(why) {
  if (!game.mp) { if (game.warp > 1) { game.warp = 1; warpFeedback(1, net.myId, why); } return; }
  if (warpTarget() <= 1) return;
  if (net.isHost) hostSetWarp(1, net.myId, why);
  else if (!mp.warpDropAsked) { mp.warpDropAsked = true; net.sendEvent({ k: 'warpReq', w: 1, why }); }
}

/** Every frame while warping: fall back to 1× as soon as it stops being safe. */
function checkWarp() {
  if (game.mp && !net.isHost) {
    const why = selfWarpBlocker(false);
    if (why) endWarp(why);
    return;
  }
  const why = game.mp ? worldWarpBlocker() || selfWarpBlocker(false) : warpBlocker(false);
  if (why) endWarp(why === 'NEXT WAVE TOO CLOSE' ? 'WAVE INBOUND' : why);
}

function toggleDockAssist() {
  if (player.docked || player.docking || !player.alive) return;
  if (dockAssist.active) {
    dockAssist.disengage();
    hud.notice(dockAssist.station === bossPark ? 'INTERCEPT OFF' : 'DOCKING ASSIST OFF', 'dim');
    return;
  }
  const boss = liveBoss();
  if (boss) {
    bossPark.follow(boss);
    dockAssist.station = bossPark;
    dockAssist.stopAt = BOSS_STANDOFF;
    dockAssist.captureR = BOSS_STANDOFF + 120;   // the "in range" zone updateBossPark hands control back in
    dockAssist.captureV = 18;
  } else {
    dockAssist.station = station;
    dockAssist.stopAt = 120;
    dockAssist.captureR = CAPTURE_R;
    dockAssist.captureV = CAPTURE_V;
  }
  // asking to dock lifts the just-undocked lockout (it only stops you drifting straight back in);
  // otherwise the assist parks inside the 540 m clearance zone and never docks
  if (!boss) player.needsClearance = false;
  dockAssist.engage();
  audio.beep(880, 0.08, 0.05, 'sine');
  setTimeout(() => audio.beep(1320, 0.1, 0.05, 'sine'), 80);
  hud.notice(boss ? `INTERCEPT ENGAGED · CLOSING TO ${BOSS_STANDOFF} m OF THE DREADNOUGHT · THRUST TO CANCEL` : 'DOCKING ASSIST ENGAGED · ANY THRUST KEY TO CANCEL', boss ? 'orange' : 'green');
}

/** Boss intercept: keep the parking spot moving with the fortress, and let go once we're there. */
function updateBossPark() {
  if (!dockAssist.active || dockAssist.station !== bossPark) return;
  if (!bossPark.body || !bossPark.body.alive) {
    dockAssist.disengage();
    hud.notice('INTERCEPT OFF · TARGET DESTROYED', 'dim');
    return;
  }
  bossPark.update();
  const d = player.pos.distanceTo(bossPark.pos);
  const rel = _v1.subVectors(player.vel, bossPark.vel).length();
  if (d < BOSS_STANDOFF + 150 && rel < 25) {   // it manoeuvres to hunt you: close enough to take over
    dockAssist.disengage();
    hud.notice(`IN RANGE · ${Math.round(d)} m FROM THE DREADNOUGHT · YOU HAVE CONTROL`, 'green');
    audio.beep(1320, 0.1, 0.05, 'sine');
  }
}

function cannonDamage() { return BOLT_DAMAGE * (1 + 0.25 * game.levels.damage); }
/** Engine power: MK2 +50%, Thruster Tuning +15% a level, Afterburner doubles it while lit. */
function thrustMult(withBoost = true) {
  const lv = game.levels;
  return (lv.mk2 ? 1.5 : 1) * (1 + 0.15 * (lv.thrusters || 0)) * (withBoost && game.boostT > 0 ? 2 : 1);
}
// Smart Ammo: faster, longer-lived bolts and a wider, gravity-aware aim assist
const smartAmmo = () => !!game.levels.smartammo;
const boltSpeed = () => BOLT_SPEED * (smartAmmo() ? 1.25 : 1);
const boltLife = () => BOLT_LIFE * (smartAmmo() ? 1.4 : 1);
const fireInterval = () => FIRE_INTERVAL / (1 + 0.15 * (game.levels.rapid || 0));
const heatPerShot = () => HEAT_PER_SHOT * (1 - 0.2 * (game.levels.heatsink || 0));
const collectRange = () => COLLECT_RANGE * (1 + 0.5 * (game.levels.magnet || 0));
const scrapMult = () => 1 + 0.2 * (game.levels.refinery || 0);
function shieldRegenRate() { return 22 * (1 + 0.4 * game.levels.shieldRegen); }
function shieldRechargeDelay() { return 2.6 * (1 - 0.12 * game.levels.shieldRegen); }

function applyUpgrades() {
  const lv = game.levels;
  player.maxHull = BASE_HULL + 25 * game.levels.hull;
  player.maxShield = SHIELD_MAX + 50 * (lv.shieldcap || 0);
  missiles.lockTimeMult = lv.quicklock ? 0.6 : 1;
  missiles.cluster = !!lv.cluster;
  missiles.payload = lv.payload || 0;
  dockAssist.maxAccel = MAIN_THRUST * thrustMult(false);
  // the MK2 hull, and the railgun under the nose once it's fitted
  shipParts.mk2.visible = !!lv.mk2;
  shipParts.rail.visible = !!lv.railgun;
  for (const r of remotes.values()) { r.parts.mk2.visible = !!lv.mk2; r.parts.rail.visible = !!lv.railgun; }
  missiles.capacity = diffDef().missiles + game.levels.missileCap;
  missiles.speedMult = 1 + 0.3 * game.levels.missileSpeed;
  missiles.rangeBonus = 200 * game.levels.missileSpeed;
}

const stationUI = new StationUI({
  buy(id) {
    if (isGuest()) { net.sendEvent({ k: 'buy', id }); return; }   // the host decides
    const u = buyUpgrade(id);
    if (!u) return;
    announcePurchase(u, game.mp ? 'YOU' : '');
    if (game.mp) net.sendEvent({ k: 'bought', id: u.id, name: u.name, by: net.myId });
  },
  repair() {
    const missing = player.maxHull - player.hull;
    if (missing < 1 || game.scrap < 1) return;
    const cost = Math.min(Math.ceil(missing / REPAIR_HP_PER_SCRAP), game.scrap);
    spendScrap(cost, () => {
      player.hull = Math.min(player.maxHull, player.hull + cost * REPAIR_HP_PER_SCRAP);
      audio.purchase();
    });
  },
  rearm() {
    const need = missiles.capacity - missiles.ammo;
    if (need <= 0 || game.scrap < need * REARM_COST) return;
    spendScrap(need * REARM_COST, () => {
      missiles.ammo = missiles.capacity;
      audio.purchase();
    });
  },
  undock: () => undock(),
  callWave: () => callNextWave(),
  revive: (id) => requestRevive(id),
  openTree: () => techTree.open(),
}, () => ({
  scrap: game.scrap, levels: game.levels, hull: player.hull, maxHull: player.maxHull,
  ammo: missiles.ammo, capacity: missiles.capacity,
  waveTimer: game.waveTimer, waveActive: game.waveActive, mp: game.mp,
  costMult: costScale(), dead: fallenPilots(),
  hostiles: hostileCount() + game.spawnQueue.length, underAttack: game.underAttack > 0,
}), audio);
const techTree = new TechTreeUI({ buy: (id) => stationUI.cb.buy(id) },
  () => ({ scrap: game.scrap, levels: game.levels, costMult: costScale() }), audio);

function callNextWave() {
  if (!(state === 'playing' || game.mp) || game.waveActive || game.waveTimer <= 6) return;
  if (isGuest()) { net.sendEvent({ k: 'callWave' }); hud.notice('ASKED THE HOST TO CALL THE NEXT WAVE', 'orange'); return; }
  game.waveTimer = 6;
  hud.notice('BEACON ACTIVE', 'orange');
  if (game.mp) mp.waveSyncTimer = 0;   // tell everyone right away
}

function tryDock() {
  if (player.docked || player.docking || !player.alive || state !== 'playing') return;
  if (player.needsClearance) {
    if (player.pos.distanceTo(station.pos) > DOCK_RANGE * 1.8) player.needsClearance = false;
    return;
  }
  if (!station.canDock(player)) return;
  dockAssist.disengage();
  player.docking = true;
  station.beginDock(player, myClamp());
  firing = false;
  missiles.cancelLock(true);
  audio.silenceEngine();
  audio.dockClamp();
  hud.notice('DOCKING CLAMPS ENGAGED', 'green');
}

function finishDock() {
  player.docking = false;
  player.docked = true;
  keys.clear();
  dockCam.init = false;
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  stationUI.show();
  if (mp.reviveBanner) { hud.banner('REVIVED', mp.reviveBanner, 3200); mp.reviveBanner = ''; }
  else hud.banner('DOCKED', 'KEPLER STATION · SPEND YOUR SCRAP', 2200);
}

function undock() {
  if (!player.docked) return;
  game.launchT = 0;
  player.docked = false;
  player.needsClearance = true;
  station.releasePlayer(player);
  camQuat.copy(player.quat);
  stationUI.hide();
  techTree.close();
  document.body.style.cursor = 'none';
  requestLock();
  audio.dockClamp();
  hud.notice('UNDOCKED · GOOD HUNTING', 'green');
}

function forceUndockUI() {
  player.docked = false;
  player.docking = false;
  stationUI.hide();
  techTree.close();
}

// docked camera: a slow orbit around the station, smoothed in the station's frame
const dockCam = { init: false, angle: 0.6, local: new THREE.Vector3(), target: new THREE.Vector3(), look: new THREE.Vector3(0, 0, -30) };
function updateDockCamera(dt) {
  dockCam.angle += dt * 0.08;
  dockCam.target.set(Math.cos(dockCam.angle) * 165, 55, -40 + Math.sin(dockCam.angle) * 165);
  if (!dockCam.init) { station.toLocal(camera.position, dockCam.local); dockCam.init = true; }
  dockCam.local.lerp(dockCam.target, 1 - Math.exp(-dt * 1.2));
  station.toWorld(dockCam.local, camera.position);
  camera.up.set(0, 1, 0).applyQuaternion(station.quat);
  camera.lookAt(station.toWorld(dockCam.look, _v3));
  const shake = game.trauma * game.trauma;
  if (shake > 0.001) {
    const t = performance.now() * 0.001;
    _e1.set(Math.sin(t * 47) * 0.01 * shake, Math.sin(t * 53) * 0.01 * shake, 0);
    _q1.setFromEuler(_e1);
    camera.quaternion.multiply(_q1);
  }
  game.trauma = Math.max(0, game.trauma - dt * 1.4);
  if (Math.abs(camera.fov - 60) > 0.01) { camera.fov = THREE.MathUtils.lerp(camera.fov, 60, 1 - Math.exp(-dt * 3)); camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}

// Reactive Armour softens these; tides, the disk and enemy fire are unaffected
const IMPACT_CAUSES = new Set(['COLLISION', 'SEEKER IMPACT', 'RAMMED THE DREADNOUGHT', 'CAUGHT IN A MINE BLAST']);

function damagePlayer(amount, opts = {}) {
  if (!player.alive) return;
  if (game.levels.armor && IMPACT_CAUSES.has(opts.cause)) amount *= 0.6;
  player.shieldDelay = shieldRechargeDelay();
  game.underAttack = 3;
  let rem = amount;
  const hadShield = player.shield > 0;
  if (player.shield > 0) {
    const a = Math.min(player.shield, rem);
    player.shield -= a;
    rem -= a;
  }
  player.hull -= rem;
  // hits, or anything that gets through to the hull, end time warp
  if (warpTarget() > 1 && (!opts.silent || rem > 0)) endWarp('TAKING DAMAGE');
  if (!opts.silent) {
    game.trauma = Math.min(1, game.trauma + amount * 0.025);
    game.damageFlash = Math.min(1, game.damageFlash + (rem > 0 ? 0.6 : 0.3));
    audio.hit(hadShield && rem <= 0);
  } else {
    game.damageFlash = Math.min(0.6, game.damageFlash + amount * 0.02);
  }
  // Emergency Shield: once per wave, refill the shield when the hull gets low
  if (game.levels.emergency && !game.emergencyUsed && player.hull > 0 && player.hull < player.maxHull * 0.25) {
    game.emergencyUsed = true;
    player.shield = player.maxShield;
    player.shieldDelay = 0;
    hud.notice('EMERGENCY SHIELD ENGAGED', 'green');
    audio.beep(660, 0.25, 0.08, 'sine');
    sparks(player.pos, player.vel, 40, 0.4, 1.2, 2.4, 30);
  }
  if (player.hull <= 0) killPlayer(opts.cause || 'SHIP DESTROYED');
}

function killPlayer(cause) {
  if (!player.alive) return;
  player.alive = false;
  game.deathCause = cause;
  game.deathTimer = 0;
  missiles.cancelLock(true);
  dockAssist.disengage();
  if (player.docked || player.docking) forceUndockUI();
  if (game.mp) net.sendEvent({ k: 'd', p: r2(player.pos), v: r2(player.vel) });
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
  _v3.copy(player.vel).addScaledVector(dir, boltSpeed());
  playerBolts.spawn(muzzle, _v3, boltLife(), cannonDamage());
  if (game.mp) net.sendEvent({ k: 'f', t: simNow(), p: r2(muzzle), v: r2(_v3), l: round2(boltLife()) });
  particles.emit(muzzle.x, muzzle.y, muzzle.z, player.vel.x + dir.x * 20, player.vel.y + dir.y * 20, player.vel.z + dir.z * 20, 0.6, 2.2, 3, 1.4, 0.3, 0.07, false);
  player.heat += heatPerShot();
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
  bossBlasts.length = 0;
  wrecks.clear();
  allyBolts.clear();
  particles.clear();
  for (const d of debris) d.visible = false;
  for (const s of shockwaves) s.visible = false;
}

const START_NORMAL = new THREE.Vector3(0.12, 1, 0.08).normalize();
const STATION_PHASE0 = Math.PI * 0.25 + 0.42;
const MP_SPAWN_GAP = 250 / START_RADIUS;   // radians along the start orbit

/** Put the player on the start orbit at `phase`, nose mostly prograde and angled toward the hole. */
function setStartPose(phase) {
  circularOrbitState(START_RADIUS, START_NORMAL, phase, player.pos, player.vel);
  const pro = _v1.copy(player.vel).normalize();
  const inward = _v2.copy(player.pos).normalize().negate();
  const look = pro.multiplyScalar(Math.cos(0.6)).addScaledVector(inward, Math.sin(0.6)).normalize();
  // Matrix4.lookAt aims -Z at the target
  player.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), look, START_NORMAL));
  camQuat.copy(player.quat);
}

function startGame(opts = {}) {
  clearWorld();
  simWorld = null;
  const multiplayer = !!opts.multiplayer;
  Object.assign(game, {
    mp: multiplayer,
    debug: !!opts.debug,
    difficulty: validDifficulty(multiplayer ? mp.difficulty : difficulty),
    custom: multiplayer ? { ...mp.custom } : { ...customDiff },
    // in multiplayer the host runs the waves; guests follow its clock
    score: 0, wave: 0, kills: 0, mult: 1, comboTimer: 0, spawnQueue: [], spawnTimer: 0, waveTimer: multiplayer ? 12 : 10, waveActive: false,
    time: 0, timeScale: 1, deathTimer: 0, trauma: 0, damageFlash: 0,
    scrap: 0, scrapTotal: 0, levels: newUpgradeLevels(), underAttack: 0,
  });
  forceUndockUI();
  dockAssist.disengage();
  exitSpectate();
  mp.wipeTimer = 0;
  applyUpgrades();
  missiles.ammo = missiles.capacity;
  Object.assign(player, {
    alive: true, hull: BASE_HULL, shield: player.maxShield, needsClearance: false, heat: 0, overheated: false, shieldDelay: 0, fireCd: 0, gun: 0,
    pendingYaw: 0, pendingPitch: 0, yawRate: 0, pitchRate: 0, throttle: 0,
  });
  // in multiplayer the pilots line up 250 m apart on the same orbit, positioned
  // from the shared clock so everyone agrees exactly where everyone starts
  const orbitRate = circularSpeed(START_RADIUS) / START_RADIUS;
  const sinceEpoch = multiplayer ? Math.max(0, net.netTime() - mp.epoch) : 0;
  setStartPose(Math.PI * 0.25 + (multiplayer ? net.myId * MP_SPAWN_GAP : 0) + orbitRate * sinceEpoch);
  resetEnemyIds();
  game.bumpCd = 0;
  game.clearHold = 0;
  resetWarpClock();
  resetAbilities();
  game.seenTypes = new Set();
  mp.deadIds.clear();
  station.reset(STATION_RADIUS, START_NORMAL, STATION_PHASE0);   // thruster-held, a little under orbital speed
  if (multiplayer) syncStation();
  // every run starts in your own docking clamp at Kepler Station, and launches from it
  station.beginDock(player, myClamp());
  station.dockAnim = 1;
  station.holdPlayer(player, 0);
  player.docked = true;
  player.docking = false;
  dockCam.init = false;   // the station camera swoops in from wherever the menu left it
  game.launchT = LAUNCH_DELAY;
  radar.setStationOrbit(station);
  clearRemotes();
  shipParts.group.visible = true;
  shipParts.model.scale.set(1, 1, 1);
  for (const t of playerTrails) { t.mesh.visible = true; t.reset(player.pos); }
  orbitLine.visible = true;
  hud.show(true);
  hud.clearPopups();
  if (multiplayer) hud.banner('LINK ESTABLISHED', `${pilotCount()} PILOTS · HOSTILES SCALED ×${enemyScale().toFixed(2)} · CLICK TO TAKE THE CONTROLS`, 3500);
  else hud.banner('KEPLER STATION', 'CLAMPS RELEASING · HOSTILES APPROACHING', 2400);
  state = 'playing';
  setOverlay(null);
  document.body.style.cursor = 'none';
}

function pauseGame() {
  if (state !== 'playing') return;
  state = 'paused';
  firing = false;
  keys.clear();
  player.thrustAcc.set(0, 0, 0);
  player.throttle = 0;
  document.getElementById('pause-note').classList.toggle('hidden', !game.mp);
  audio.silenceEngine();
  setOverlay('pause');
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

function resumeGame() {
  if (state === 'dead' && mp.spectating) { setOverlay(null); return; }
  if (state !== 'paused') return;
  state = 'playing';
  setOverlay(null);
  if (player.docked) return;
  document.body.style.cursor = 'none';
  if (missiles.lockState === 'locked') audio.setLockTone(true);
  requestLock();
}

function toMenu() {
  leaveMultiplayer();
  clearWorld();
  forceUndockUI();
  station.setVisible(false);
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
  leaveMultiplayer();
  state = 'gameover';
  best = store.get(bestKey(game.difficulty), 0);
  if (game.score > best && !game.debug) { best = game.score; store.set(bestKey(game.difficulty), best); }
  document.getElementById('go-cause').textContent = game.deathCause;
  document.getElementById('go-score').textContent = game.score.toLocaleString();
  document.getElementById('go-wave').textContent = game.wave;
  document.getElementById('go-kills').textContent = game.kills;
  const dn = diffDef().name;
  document.getElementById('go-best').textContent = game.debug ? 'DEBUG RUN · NOT SCORED'
    : game.score >= best && game.score > 0 ? `★ NEW ${dn} BEST ★` : `${dn} BEST ${best.toLocaleString()}`;
  hud.show(false);
  hud.hideMarkers();
  for (const e of game.enemies) if (e.alive) e.destroy();
  game.enemies.length = 0;
  playerBolts.clear();
  enemyBolts.clear();
  bossBlasts.length = 0;
  shipParts.group.visible = false;
  for (const t of playerTrails) t.mesh.visible = false;
  orbitLine.visible = false;
  wrecks.clear();
  forceUndockUI();
  station.setVisible(false);
  setOverlay('gameover');
  document.body.style.cursor = '';
  if (document.pointerLockElement === canvas) document.exitPointerLock();
}

function updateBest() {
  best = store.get(bestKey(difficulty), 0);
  document.getElementById('best').textContent = best > 0 ? `${DIFFICULTIES[difficulty].name} BEST  ${best.toLocaleString()}` : '';
}

// Difficulty pickers: the main menu sets your own choice; in the waiting room
// the host's choice is the one that flies, and guests just see it.
function renderDifficulty() {
  const roomDiff = net.role ? validDifficulty(net.isHost ? difficulty : mp.difficulty) : difficulty;
  for (const el of document.querySelectorAll('.diff-picker')) {
    const inLobby = el.id === 'lobby-diff';
    const d = inLobby ? roomDiff : difficulty;
    for (const b of el.querySelectorAll('button[data-diff]')) {
      b.classList.toggle('on', b.dataset.diff === d);
      b.disabled = inLobby && !net.isHost;
    }
    const info = diffInfo(d, inLobby && !net.isHost ? mp.custom : customDiff);
    const edit = d === 'custom' && !(inLobby && !net.isHost) ? ' · click CUSTOM to edit' : '';
    el.querySelector('.diff-desc').textContent = info.desc + (inLobby && !net.isHost ? ' · set by the host' : edit);
  }
}

// ---------------------------------------------------------------------------
// Custom difficulty editor
// ---------------------------------------------------------------------------
const customEl = document.getElementById('custom-diff');
function renderCustomEditor() {
  document.getElementById('cd-rows').innerHTML = CUSTOM_FIELDS.map((f) => {
    const v = customDiff[f.key];
    return `<div class="cd-row"><span class="cd-name">${f.name}</span>`
      + `<input type="range" min="50" max="150" step="5" value="${THREE.MathUtils.clamp(v, 50, 150)}" data-key="${f.key}">`
      + `<label class="cd-num"><input type="number" min="${f.min}" max="${f.max}" step="1" value="${v}" data-key="${f.key}">%</label></div>`;
  }).join('')
    + `<div class="cd-row cd-toggle"><span class="cd-name">FIRST PERSON VIEW</span>`
    + `<span class="cd-hint">Fly from the cockpit instead of behind the ship</span>`
    + `<button id="cd-fpv" class="btn small${customDiff.fpv ? ' on' : ''}">${customDiff.fpv ? 'ON' : 'OFF'}</button></div>`;
}
function setCustom(key, value, fromSlider) {
  customDiff = sanitizeCustom({ ...customDiff, [key]: value });
  store.set('eh_custom', customDiff);
  const row = customEl.querySelector(`input[type="range"][data-key="${key}"]`).closest('.cd-row');
  if (fromSlider) row.querySelector('input[type="number"]').value = customDiff[key];
  else row.querySelector('input[type="range"]').value = THREE.MathUtils.clamp(customDiff[key], 50, 150);
  if (net.isHost) broadcastRoster();
  renderDifficulty();
}
function openCustomEditor() { renderCustomEditor(); customEl.classList.remove('hidden'); }
function closeCustomEditor() { customEl.classList.add('hidden'); renderDifficulty(); }
customEl.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset.key) return;
  if (t.type === 'range') setCustom(t.dataset.key, Number(t.value), true);
});
customEl.addEventListener('change', (e) => {
  const t = e.target;
  if (t.type !== 'number' || !t.dataset.key) return;
  setCustom(t.dataset.key, Number(t.value), false);
  t.value = customDiff[t.dataset.key];   // show the value after limits
});
customEl.addEventListener('keydown', (e) => { if (e.code === 'Enter' && e.target.type === 'number') e.target.blur(); });
customEl.addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.closest('#cd-done') || e.target === customEl) { audio.uiClick(); closeCustomEditor(); }
  if (e.target.closest('#cd-fpv')) {
    audio.uiClick();
    customDiff = sanitizeCustom({ ...customDiff, fpv: !customDiff.fpv });
    store.set('eh_custom', customDiff);
    renderCustomEditor();
    if (net.isHost) broadcastRoster();
    renderDifficulty();
  }
  if (e.target.closest('#cd-reset')) {
    audio.uiClick();
    customDiff = sanitizeCustom({});
    store.set('eh_custom', customDiff);
    renderCustomEditor();
    if (net.isHost) broadcastRoster();
    renderDifficulty();
  }
});
for (const b of document.querySelectorAll('.diff-picker button[data-diff]')) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    if (b.disabled) return;
    audio.init(); audio.uiClick();
    difficulty = validDifficulty(b.dataset.diff);
    store.set('eh_difficulty', difficulty);
    if (net.isHost) { mp.difficulty = difficulty; broadcastRoster(); }
    renderDifficulty();
    updateBest();
    if (difficulty === 'custom') openCustomEditor();
  });
  b.addEventListener('mouseenter', () => { if (!b.disabled) audio.uiHover(); });
}

// ===========================================================================
// Per-frame player control
// ===========================================================================
let lockInfo = { enemy: null, aim: new THREE.Vector3(), assist: false };

const _apQ = new THREE.Quaternion();
const _apM = new THREE.Matrix4();
const _origin = new THREE.Vector3();

function updatePlayerControl(dt) {
  // --- docking assist: any manual thrust input hands control back ---
  if (dockAssist.active && ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyI', 'KeyJ', 'KeyK', 'KeyL', 'Space', 'ShiftLeft', 'ShiftRight'].some((k) => keys.has(k))) {
    dockAssist.disengage();
    hud.notice('DOCKING ASSIST OFF · MANUAL OVERRIDE', 'dim');
  }
  updateBossPark();
  const ap = dockAssist.active ? dockAssist.update(dt, player) : null;
  if (ap) { player.pendingYaw = 0; player.pendingPitch = 0; }
  if (ap && ap.has) {
    _up.set(0, 1, 0).applyQuaternion(player.quat);
    _apM.lookAt(_origin, ap.dir, _up);
    _apQ.setFromRotationMatrix(_apM);
    player.quat.rotateTowards(_apQ, 2.5 * dt);
  }

  if (state === 'playing' && player.alive && !player.docked && !player.docking) {
    const aimX = (keys.has('KeyH') ? 1 : 0) - (keys.has('KeyF') ? 1 : 0);
    const aimY = (keys.has('KeyT') ? 1 : 0) - (keys.has('KeyG') ? 1 : 0);
    const aimStep = 1.5 * sensitivity * dt;
    if (keys.has('KeyV')) {
      head.lookYaw = THREE.MathUtils.clamp(head.lookYaw - aimX * aimStep, -2.3, 2.3);
      head.lookPitch = THREE.MathUtils.clamp(head.lookPitch + aimY * aimStep * (invertY ? -1 : 1), -1.25, 0.95);
    } else {
      player.pendingYaw -= aimX * aimStep;
      player.pendingPitch += aimY * aimStep * (invertY ? -1 : 1);
    }
  }

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
  const W = keys.has('KeyW') || isKeyDown('ArrowUp');
  const S = keys.has('KeyS') || isKeyDown('ArrowDown');
  const A = keys.has('KeyA') || isKeyDown('ArrowLeft');
  const D = keys.has('KeyD') || isKeyDown('ArrowRight');
  const U = keys.has('Space'), Dn = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const lx = (D ? 1 : 0) - (A ? 1 : 0);
  const ly = (U ? 1 : 0) - (Dn ? 1 : 0);
  const tm = thrustMult();
  const lz = (W ? -MAIN_THRUST * tm : 0) + (S ? RETRO_THRUST * tm : 0);
  let apThrottle = 0;
  if (ap && ap.has) {
    // autopilot drives the main engine, throttled by how well the nose is aligned
    const align = THREE.MathUtils.clamp((forwardOf(player.quat, _v1).dot(ap.dir) - 0.85) / 0.15, 0, 1);
    apThrottle = (ap.mag / (MAIN_THRUST * thrustMult(false))) * align;
    player.thrustAcc.copy(_v1).multiplyScalar(ap.mag * align);
  } else {
    player.thrustAcc.set(lx * SIDE_THRUST * tm, ly * SIDE_THRUST * tm, lz).applyQuaternion(player.quat);
  }
  player.throttle = THREE.MathUtils.lerp(player.throttle, W ? 1 : apThrottle, 1 - Math.exp(-dt * 10));
  hud.setThrusters(W || apThrottle > 0.05, A, D, U, Dn);
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
  if (W || apThrottle > 0.3) {
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
  const smart = smartAmmo();
  const smart2 = (game.levels.smartammo || 0) >= 2;   // Smart Ammo II: a much stronger assist
  let bestDot = Math.cos(THREE.MathUtils.degToRad(smart2 ? 24 : 18));
  const reach = smart ? 1500 : 900;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const to = _v1.subVectors(e.pos, player.pos);
    const d = to.length();
    if (d > reach) continue;
    const dot = to.divideScalar(d).dot(fwd);
    if (dot > bestDot) { bestDot = dot; lockInfo.enemy = e; }
  }
  if (lockInfo.enemy) {
    const e = lockInfo.enemy;
    const speed = boltSpeed();
    let t = e.pos.distanceTo(player.pos) / speed;
    for (let i = 0; i < 3; i++) {
      lockInfo.aim.copy(e.pos).addScaledVector(_v1.subVectors(e.vel, player.vel), t);
      if (smart) {
        // allow for gravity bending the bolt differently from the target over the flight
        const mid = _v2.addVectors(player.pos, lockInfo.aim).multiplyScalar(0.5);
        const gBolt = accelAt(mid, _v3);
        lockInfo.aim.addScaledVector(accelAt(e.pos, _v2).sub(gBolt), 0.5 * t * t);
      }
      t = lockInfo.aim.distanceTo(player.pos) / speed;
    }
    const aimDir = _v1.subVectors(lockInfo.aim, player.pos).normalize();
    lockInfo.assist = aimDir.dot(fwd) > Math.cos(smart2 ? 0.16 : smart ? 0.09 : 0.045);
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
    player.fireCd = fireInterval();
    firePlayer(lockInfo);
  }

}

const NANITE_RATE = 0.0075;   // fraction of max hull repaired per second, per Nanite Repair level

function updateShields(dt) {
  player.shieldDelay -= dt;
  if (player.shieldDelay <= 0) player.shield = Math.min(player.maxShield, player.shield + shieldRegenRate() * dt);
  if (game.levels.repair) player.hull = Math.min(player.maxHull, player.hull + player.maxHull * NANITE_RATE * game.levels.repair * dt);
  if (player.docked || player.docking) {
    player.heat = Math.max(0, player.heat - dt * 0.5);
    if (player.heat < 0.3) player.overheated = false;
  }
}

/** In the cockpit the dashboard screens show shields, hull, heat and missiles, so the status panel goes. */
let cockpitHud = false;
function setCockpitHud(on) {
  if (on === cockpitHud) return;
  cockpitHud = on;
  document.body.classList.toggle('fpv', on);
}

function updatePlayerVisual(dt, time) {
  const g = shipParts.group;
  g.position.copy(player.pos);
  g.quaternion.copy(player.quat);
  setLoadout(shipParts, missiles.capacity, missiles.ammo);
  const model = shipParts.model;
  const inside = firstPerson() && player.alive && !player.docked;   // the cockpit camera sits inside the hull
  setCockpitHud(inside);
  for (const m of shipParts.cockpitHide) m.visible = !inside;
  cockpit.group.visible = inside;
  const lx = ((keys.has('KeyD') || isKeyDown('ArrowRight')) ? 1 : 0) - ((keys.has('KeyA') || isKeyDown('ArrowLeft')) ? 1 : 0);
  // no banking in first person: the cockpit stays locked to your view
  const targetRoll = inside ? 0 : THREE.MathUtils.clamp(player.yawRate * 0.35, -0.7, 0.7) - lx * 0.25;
  const targetPitch = inside ? 0 : THREE.MathUtils.clamp(player.pitchRate * 0.12, -0.3, 0.3);
  model.rotation.z = inside ? 0 : THREE.MathUtils.lerp(model.rotation.z, targetRoll, 1 - Math.exp(-dt * 6));
  model.rotation.x = inside ? 0 : THREE.MathUtils.lerp(model.rotation.x, targetPitch, 1 - Math.exp(-dt * 6));
  const burn = game.boostT > 0 ? 1.9 : 1;
  for (const f of shipParts.flames) {
    const l = (0.5 + player.throttle * 4.2 + Math.random() * 0.4 * (0.3 + player.throttle)) * burn;
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
  station.physics(h);
  if (game.mp) {
    for (const r of remotes.values()) r.physics(h);
    allyBolts.step(h, NO_TARGETS, null);
  }
  wrecks.physics(h);
  if (player.alive && (player.docked || player.docking)) {
    // slaved to the docking port (see Station.holdPlayer)
  } else if (player.alive) {
    integrate(player.pos, player.vel, player.thrustAcc, h);
  } else if (player.pos.length() > RS) {
    integrate(player.pos, player.vel, null, h);
  } else {
    // inside the horizon: nothing comes back out — sink toward the singularity
    player.vel.multiplyScalar(Math.exp(-h * 3));
    player.pos.multiplyScalar(Math.exp(-h * 0.5));
  }
  for (const e of game.enemies) if (e.alive) e.physics(h);
  collidePilots(h);
  collideStation(h);

  playerBolts.step(h, collectBoltTargets(), (tg, point, dmg) => {
    if (tg.isTurret) hitTurret(tg.owner, tg.index, dmg, point, 'player');
    else if (tg.isHull) hitEnemy(tg.owner, dmg, point, 'player');
    else hitEnemy(tg, dmg, point, 'player');
  });
  missiles.physics(h);
  game.bumpCd = Math.max(0, game.bumpCd - h);

  playerTarget.alive = player.alive;
  playerTarget.radius = player.radius;
  enemyBolts.step(h, [playerTarget], (t, point, dmg) => {
    sparks(point, player.vel, 14, player.shield > 0 ? 0.4 : 2.0, player.shield > 0 ? 1.2 : 0.6, player.shield > 0 ? 2.4 : 0.2, 22);
    damagePlayer(dmg * diffDef().dmg, { cause: 'SHOT DOWN' });
  });

  // collisions & hazards for enemies
  const guest = isGuest();
  for (const e of game.enemies) {
    if (!e.alive || e.rammed) continue;
    const r = e.pos.length();
    if (!guest) {
      if (r < RS * 1.05) { killEnemy(e, 'horizon'); continue; }
      if (r > ARENA_RADIUS * 2.5) { killEnemy(e, 'void'); continue; }
      if (e.def.inert && e.age > e.def.life) { killEnemy(e, 'fizzle'); continue; }
    }
    if (!player.alive) continue;
    if (e.def.boss) { if (!player.docked && !player.docking) bossCollision(e); continue; }
    if (e.def.inert) {
      // mines: each pilot's game sets off the ones it flies into
      const md = e.pos.distanceTo(player.pos);
      const armed = e.age > e.def.arm;
      e.alert = armed && md < 260;   // blinks fast as you close on its trigger range
      if (armed && md < e.def.trigger + player.radius) {
        if (guest) { e.rammed = true; net.sendEvent({ k: 'ram', id: e.netId, cause: 'mine' }); }
        else killEnemy(e, 'mine');
      }
      continue;
    }
    const d = e.pos.distanceTo(player.pos);
    const seekerHit = e.def.seeker && d < player.radius + e.radius + 2.5;
    const bump = d < player.radius + e.radius * 0.8;
    if (!seekerHit && !bump) continue;
    // each pilot judges collisions with their own ship; the host decides the enemy's fate
    const k = diffDef().dmg;
    if (seekerHit) { damagePlayer(e.def.ramDamage * k, { cause: 'SEEKER IMPACT' }); game.trauma = 1; }
    else damagePlayer(30 * k, { cause: 'COLLISION' });
    const cause = seekerHit ? 'none' : 'ram';
    if (guest) { e.rammed = true; net.sendEvent({ k: 'ram', id: e.netId, cause }); }
    else killEnemy(e, cause);
  }

  if (player.alive && player.pos.length() < RS * 1.02) {
    killPlayer('CROSSED THE EVENT HORIZON');
  }
}

// What the player's cannons can hit: turrets first (they sit on the hull's
// surface), then hulls (the dreadnought's as a chain of spheres).
const boltTargets = [];
function collectBoltTargets() {
  boltTargets.length = 0;
  for (const e of game.enemies) if (e.alive && e.turrets) for (const t of e.turrets) if (t.alive) boltTargets.push(t);
  for (const e of game.enemies) {
    if (!e.alive) continue;
    if (e.hitParts) for (const p of e.hitParts) boltTargets.push(p);
    else boltTargets.push(e);
  }
  return boltTargets;
}

const threatItems = [];
function updateBossHud() {
  const boss = game.enemies.find((e) => e.alive && e.def.boss);
  hud.setBoss(boss ? { hp: boss.hp, maxHp: boss.maxHp, turrets: boss.turretsAlive, total: boss.turrets.length } : null);
  threatItems.length = 0;
  if (boss && boss.pos.distanceTo(player.pos) < 1100) {
    for (const t of boss.turrets) if (t.alive) threatItems.push({ pos: t.pos, kind: 'turret' });
  }
  hud.updateThreats(threatItems, camera, player.pos);
}

/** Flying into the dreadnought: it doesn't budge. Bounce off and take damage. */
function bossCollision(e) {
  for (const part of e.hitParts) {
    const min = player.radius + part.radius;
    const d = player.pos.distanceTo(part.pos);
    if (d >= min) continue;
    const n = _v1.subVectors(player.pos, part.pos).divideScalar(Math.max(d, 1e-3));
    player.pos.copy(part.pos).addScaledVector(n, min);
    const rel = _v2.subVectors(player.vel, e.vel);
    const vn = rel.dot(n);
    if (vn < 0) player.vel.addScaledVector(n, -1.5 * vn);
    player.vel.addScaledVector(n, 4);
    if (game.bumpCd <= 0) {
      game.bumpCd = 0.6;
      damagePlayer(Math.min(30, 8 + Math.max(0, -vn) * 0.25) * diffDef().dmg, { cause: 'RAMMED THE DREADNOUGHT' });
      game.trauma = Math.min(1, game.trauma + 0.6);
    }
    return;
  }
}

/**
 * Pilots bump off each other (no damage). Each game moves only its own ship: half
 * the overlap and half of an equal-mass bounce, so between the two games the pair
 * separates symmetrically.
 */
const PILOT_RADIUS = 2.4;     // ship-to-ship: about the wingspan, not the fuselage hitbox
const PILOT_BOUNCE = 0.6;     // restitution
const _pn = new THREE.Vector3();
const _pr = new THREE.Vector3();
let pilotBumpCd = 0;
function collidePilots(h) {
  pilotBumpCd = Math.max(0, pilotBumpCd - h);
  if (!game.mp || !player.alive || player.docked || player.docking) return;
  for (const r of remotes.values()) {
    if (!r.present || !r.alive || r.docked) continue;
    _pn.subVectors(player.pos, r.pos);
    const d = _pn.length();
    const min = 2 * PILOT_RADIUS;
    if (d >= min) continue;
    if (d < 1e-3) _pn.set(0, 1, 0); else _pn.divideScalar(d);
    player.pos.addScaledVector(_pn, (min - d) * 0.5);
    const vn = _pr.subVectors(player.vel, r.vel).dot(_pn);
    if (vn < 0) {
      player.vel.addScaledVector(_pn, -vn * (1 + PILOT_BOUNCE) * 0.5);
      if (-vn > 2 && pilotBumpCd <= 0) {
        pilotBumpCd = 0.4;
        audio.dockClamp();
        game.trauma = Math.min(1, game.trauma + Math.min(0.5, -vn * 0.02));
        sparks(_pr.copy(player.pos).addScaledVector(_pn, -PILOT_RADIUS), player.vel, 10, 1.2, 1.4, 1.8, 12);
      }
    }
  }
}

/** The station is solid (no damage), except while its clamps have hold of you. */
let stationBumpCd = 0;
function collideStation(h) {
  stationBumpCd = Math.max(0, stationBumpCd - h);
  if (!player.alive || player.docked || player.docking) return;
  const hit = station.collide(player.pos, player.vel, 2.2);
  if (hit > 2 && stationBumpCd <= 0) {
    stationBumpCd = 0.4;
    audio.dockClamp();
    game.trauma = Math.min(1, game.trauma + Math.min(0.6, hit * 0.02));
    sparks(player.pos, player.vel, 14, 1.2, 1.4, 1.8, 14);
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
  el.crosshair.style.display = 'block';
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

function hideNavMarkers() {
  for (const k of ['crosshair', 'prograde', 'retrograde', 'lead', 'peLabel', 'apLabel']) hud.el[k].style.display = 'none';
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
// The head sways inside the cockpit: pressed back under thrust, thrown wide in
// turns and lagging the ship's rotation a little, with engine buzz at full burn.
const head = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, lookYaw: 0, lookPitch: 0, drawT: 0 };
const _headT = new THREE.Vector3();
function updateCockpitCamera(dt) {
  camQuat.copy(player.quat);
  const k = 1 - Math.exp(-dt * 5);
  const burn = player.throttle * (game.boostT > 0 ? 1.8 : 1);
  _headT.set(
    THREE.MathUtils.clamp(-player.yawRate * 0.015, -0.035, 0.035),   // the bubble is only 0.6 m wide
    THREE.MathUtils.clamp(-player.pitchRate * 0.012, -0.02, 0.02) - burn * 0.006,
    burn * 0.035,
  );
  head.pos.lerp(_headT, k);
  head.yaw = THREE.MathUtils.lerp(head.yaw, THREE.MathUtils.clamp(-player.yawRate * 0.03, -0.08, 0.08), k);
  head.pitch = THREE.MathUtils.lerp(head.pitch, THREE.MathUtils.clamp(-player.pitchRate * 0.03, -0.06, 0.06), k);
  const t = performance.now() * 0.001;
  const buzz = burn * 0.0012;
  _v3.copy(EYE).add(head.pos);
  _v3.x += Math.sin(t * 91) * buzz;
  _v3.y += Math.sin(t * 77 + 1) * buzz;
  camera.position.copy(_v3).applyQuaternion(player.quat).add(player.pos);
  camera.quaternion.copy(player.quat);
  relaxLook(dt);
  _e1.set(head.pitch + head.lookPitch, head.yaw + head.lookYaw, 0, 'YXZ');
  camera.quaternion.multiply(_q1.setFromEuler(_e1));
  _e1.order = 'XYZ';
  updateCockpitControls(cockpit, dt, player.yawRate, player.pitchRate, player.throttle);
  shakeCamera(dt);
  // instruments
  updateCockpitLamp(cockpit, dt, player.hull < player.maxHull * 0.3 || game.underAttack > 0);
  if ((head.drawT -= dt) <= 0) {
    head.drawT = 0.1;
    drawCockpit(cockpit, {
      player, enemies: game.enemies, missiles, warp: game.warp || 1,
      speed: player.vel.length(), alt: player.pos.length() - RS,
    });
  }
  fovKick = THREE.MathUtils.lerp(fovKick, player.throttle * 5, 1 - Math.exp(-dt * 4));
  const fov = 75 + fovKick;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();
}
function shakeCamera(dt) {
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
}
/** Free look springs back to straight ahead when V is let go. */
function relaxLook(dt) {
  if (keys.has('KeyV') && player.alive) return;
  const r = Math.exp(-dt * 7);
  head.lookYaw *= r;
  head.lookPitch *= r;
}
const _lookQ = new THREE.Quaternion();
function updateChaseCamera(dt) {
  if (player.alive && firstPerson()) { updateCockpitCamera(dt); return; }
  camQuat.slerp(player.quat, 1 - Math.exp(-dt * (player.alive ? 9 : 2)));
  const pull = player.alive ? player.throttle * 1.3 : 6 + game.deathTimer * 4;
  // free look (hold V) swings the camera around the ship
  relaxLook(dt);
  _e1.set(head.lookPitch, head.lookYaw, 0, 'YXZ');
  _lookQ.copy(camQuat).multiply(_q1.setFromEuler(_e1));
  _e1.order = 'XYZ';
  camOffset.set(0, 2.5, 9.5 + pull).applyQuaternion(_lookQ);
  camera.position.copy(player.pos).add(camOffset);
  camera.quaternion.copy(_lookQ);
  if (!player.alive) {
    camera.lookAt(player.pos);
  }
  shakeCamera(dt);
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

function frame(now) {
  requestAnimationFrame(frame);
  const t0 = performance.now();
  tick(Math.min(clock.getDelta(), 0.05), true);
  if (perf.on && perf.last) perfSample(now - perf.last, performance.now() - t0);
  perf.last = now;
}

// ---------------------------------------------------------------------------
// Performance readout (P). Frame time is the real interval between displayed
// frames; CPU is the time this code spends per frame (game logic plus issuing
// the draw calls). If frames are slow while CPU stays low, the graphics card
// is the limit.
// ---------------------------------------------------------------------------
const perf = {
  on: false, last: 0, el: document.getElementById('perf'),
  n: 0, total: 0, cpu: 0, worst: 0, window: 0,
};
function togglePerf(on = !perf.on) {
  perf.on = on;
  store.set('eh_perf', on);
  perf.el.classList.toggle('hidden', !on);
  perf.n = perf.total = perf.cpu = perf.worst = perf.window = 0;
  if (on) perf.el.innerHTML = '<b>— FPS</b><span>measuring…</span>';
}
function perfSample(frameMs, cpuMs) {
  perf.n++;
  perf.total += frameMs;
  perf.cpu += cpuMs;
  perf.worst = Math.max(perf.worst, frameMs);
  perf.window += frameMs;
  if (perf.window < 500) return;
  const avg = perf.total / perf.n;
  const fps = 1000 / avg;
  const c = renderer.domElement;
  perf.el.className = fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'bad';
  perf.el.innerHTML = `<b>${fps.toFixed(0)} FPS</b>`
    + `<span>${avg.toFixed(1)} ms avg · ${perf.worst.toFixed(1)} ms worst</span>`
    + `<span>CPU ${(perf.cpu / perf.n).toFixed(1)} ms / frame</span>`
    + `<span>${c.width}×${c.height} · ${QUALITY[qualityKey].label}</span>`;
  perf.n = perf.total = perf.cpu = perf.worst = perf.window = 0;
}
togglePerf(!!store.get('eh_perf', false));

/**
 * How far to step the world this frame. Solo: the frame time (with slow-mo and warp).
 * Multiplayer: exactly as far as the shared world clock moved, so a hitch or a slow
 * frame (the frame time is capped at 50 ms) never leaves our ship behind where the
 * other pilots think it is. A gap is made up over the next few frames.
 */
let simWorld = null;
function frameStep(rawDt) {
  if (!game.mp) { simWorld = null; return rawDt * game.timeScale * game.warp; }
  const now = worldNow();
  if (simWorld === null || now - simWorld > 60 || now < simWorld - 1) simWorld = now - rawDt * game.warp;
  const dt = THREE.MathUtils.clamp(now - simWorld, 0, (9.5 / 60) * game.warp);   // stay inside maxSteps
  simWorld += dt;
  return dt;
}

function tick(rawDt, render) {
  visualTime += rawDt;
  net.update(rawDt);
  if (state === 'menu' && net.role) renderRoom();

  if (state === 'playing' || state === 'dead' || (state === 'paused' && game.mp)) {
    if (game.mp) updateWarpClock();
    if (warpTarget() > 1) checkWarp();
    const dt = frameStep(rawDt);
    game.time += dt;

    const inDock = player.docked || player.docking;
    if (state === 'playing') {
      if (!inDock) updatePlayerControl(dt);
      else {
        player.thrustAcc.set(0, 0, 0);
        player.throttle = 0;
        firing = false;
        hud.setThrusters(false, false, false, false, false);
      }
      if (player.alive) updateShields(dt);
      updateAbilities(dt);
      // the launch at the start of a run: the clamps let go by themselves (F goes sooner)
      if (game.launchT > 0 && (game.launchT -= rawDt) <= 0 && player.docked) undock();
    }
    // enemy AI runs only on the host (or solo); each enemy hunts the nearest pilot
    if (!isGuest()) for (const e of game.enemies) if (e.alive) e.think(dt, targetFor(e), game);
    else for (const e of game.enemies) if (e.alive && e.turrets) e.aimTurrets(dt, game, false);   // guns follow pilots; the host fires them

    // Physics covers exactly this frame's time, in equal steps of at most FIXED_DT. (A fixed
    // step with a carried-over remainder leaves the world up to one step behind the frame by
    // a different amount each frame, so particles and the camera, which run on frame time,
    // jittered against it.)
    const maxSteps = 10 * game.warp;   // time warp needs proportionally more physics steps per frame
    const steps = Math.min(maxSteps, Math.ceil(dt / FIXED_DT - 1e-6));
    const h = steps > 0 ? Math.min(dt / steps, FIXED_DT) : 0;   // a hitch longer than maxSteps drops the excess
    for (let i = 0; i < steps; i++) physicsStep(h);
    game.enemies = game.enemies.filter((e) => e.alive);

    // station, docking, salvage
    if (game.mp) syncStation();
    station.occupied.fill(false);
    if (player.alive && (player.docked || player.docking)) station.occupied[myClamp()] = true;
    if (game.mp) for (const r of remotes.values()) if (r.present && r.alive && r.docked) station.occupied[r.clamp] = true;
    station.update(dt, visualTime);
    if (player.alive && (player.docked || player.docking)) {
      const done = station.holdPlayer(player, dt);
      if (player.docking && done) finishDock();
    }
    tryDock();
    game.underAttack = Math.max(0, game.underAttack - dt);
    wrecks.update(dt, visualTime, player, player.alive && !player.docked && !player.docking, collectRange());

    // waves (the host runs them in multiplayer, even while its own pilot is dead or paused;
    // guests count the same timer down locally between the host's updates)
    if (state === 'playing' || game.mp) {
      if (game.waveTimer > 0) {
        const prev = game.waveTimer;
        game.waveTimer -= dt;
        if (game.wave > 0) {
          for (const th of [60, 30, 10]) {
            if (prev > th && game.waveTimer <= th) {
              hud.banner(`WAVE ${game.wave + 1} INBOUND`, `${th} SECONDS${player.docked ? ' · UNDOCK WITH [F]' : ''}`, 2200);
              audio.alarm();
            }
          }
          if (game.waveTimer <= 5 && Math.ceil(prev) !== Math.ceil(game.waveTimer) && game.waveTimer > 0) audio.beep(1200, 0.08, 0.06, 'square');
        }
        if (game.waveTimer <= 0 && !isGuest()) startWave(game.wave + 1);
      }
      if (isGuest()) {
        // nothing to spawn here: the host's enemies arrive as snapshots
      } else if (game.spawnQueue.length) {
        game.spawnTimer -= dt;
        if (game.spawnTimer <= 0) {
          spawnEnemy(game.spawnQueue.shift());
          game.spawnTimer = 0.55;
        }
      } else if (game.waveActive && hostileCount() === 0 && (game.clearHold -= dt) <= 0) {
        for (const e of game.enemies) if (e.alive && e.def.noClear) killEnemy(e, 'fizzle');   // leftover mines
        game.waveActive = false;
        game.waveTimer = INTERMISSION;
        waveClearedFx(game.wave);
        if (game.mp) net.sendEvent({ k: 'waveClear', n: game.wave });
      }
      if (!isGuest() && game.waveActive) {
        game.aggroTimer -= dt;
        // the next hunting party comes early once the last one has been shot down
        const partyDown = game.aggroParty && !game.enemies.some((e) => e.alive && e.aggro > 0);
        if (game.aggroTimer <= 0 || partyDown) {
          game.aggroTimer = AGGRO_EVERY;
          game.aggroParty = pickAggressors() > 0;
        }
      }
      game.comboTimer -= dt;
      if (game.comboTimer <= 0) game.mult = 1;
    }

    // visuals
    if (!player.alive) setCockpitHud(false);
    if (player.alive) updatePlayerVisual(dt, visualTime);
    else for (const t of playerTrails) t.update(dt, player.pos, camera.position, Math.max(0, 0.5 - game.deathTimer));
    const vVel = viewerVel();
    for (const e of game.enemies) e.updateVisual(dt, camera.position, visualTime, vVel);
    missiles.update(dt, camera.position, visualTime);
    updateBossBlasts(dt);
    updateBeams(dt);
    updateAegis(visualTime);
    particles.update(dt);
    updateEffects(dt);
    // watching a wingmate: move their ship first, then put the camera where theirs is
    const watching = mp.spectating && !(player.docked && player.alive);
    if (watching) for (const r of remotes.values()) r.update(dt, camera.position, visualTime, station, missiles.capacity);
    if (player.docked && player.alive) updateDockCamera(rawDt);
    else if (watching) updateSpectate(rawDt);
    else updateChaseCamera(rawDt);
    if (game.mp && net.isHost) checkWipe(dt);
    const vv = viewerVel();
    playerBolts.updateVisuals(vv);
    enemyBolts.updateVisuals(vv);
    if (game.mp) {
      if (!watching) for (const r of remotes.values()) r.update(dt, camera.position, visualTime, station, missiles.capacity);
      allyBolts.updateVisuals(vv);
      sendSnapshot(rawDt);
      if (isGuest()) pruneProxies();
      else sendWorld(rawDt);
    }

    // HUD
    const warnings = [];
    if (state === 'playing') {
      if (!inDock) updateHazards(dt, warnings);
      updateTelemetry(dt);
      if (pred.impact && !inDock) {
        warnings.unshift({ text: '⚠ IMPACT TRAJECTORY — BURN PROGRADE', color: 'red' });
        game.warnBeep -= dt;
        if (game.warnBeep <= 0) { audio.beep(960, 0.09, 0.07); game.warnBeep = 0.45; }
      }
      if (player.overheated) warnings.push({ text: 'CANNONS OVERHEATED', color: 'orange' });
      if (player.hull < 30) warnings.push({ text: 'HULL CRITICAL', color: 'red' });
      let seekerNear = false;
      for (const e of game.enemies) if (e.def.seeker && e.pos.distanceTo(player.pos) < 140) seekerNear = true;
      // seekers closing on you: warn well before they arrive, beeping faster as they close
      let inbound = Infinity;
      for (const e of game.enemies) {
        if (!e.alive || !e.def.seeker) continue;
        const to = _v1.subVectors(player.pos, e.renderPos);
        const d = to.length();
        if (d > 1400 || d < 140) continue;
        const closing = _v2.subVectors(e.vel, player.vel).dot(to) / d;
        if (closing > 15) inbound = Math.min(inbound, d);
      }
      if (inbound < Infinity && !seekerNear) {
        warnings.unshift({ text: `⚠ SEEKER INBOUND · ${Math.round(inbound)} m`, color: 'red' });
        game.proximityBeep -= dt;
        if (game.proximityBeep <= 0) { audio.beep(1500, 0.05, 0.05, 'sine'); game.proximityBeep = THREE.MathUtils.clamp(inbound / 1400, 0.12, 0.9); }
      }
      let mineNear = false;
      for (const e of game.enemies) if (e.alive && e.def.inert && e.alert) mineNear = true;
      if (mineNear) warnings.push({ text: 'MINE PROXIMITY', color: 'orange' });
      // a lancer charging at you: its aim line points at your ship
      let lancer = null, lancerLocked = false;
      for (const e of game.enemies) {
        if (!e.alive || !e.built.telegraph || e.charge <= 0) continue;
        _v1.subVectors(player.pos, e.renderPos);
        const d = _v1.length();
        if (d > (e.def.beamRange || 1600)) continue;
        const off = _v2.copy(forwardOf(e.quat, _v3)).cross(_v1.divideScalar(d)).length() * d;   // miss distance along the aim line
        if (off < (e.def.boss ? 80 : 40) && forwardOf(e.quat, _v3).dot(_v1) > 0) { lancer = e; lancerLocked = lancerLocked || e.locked; }
      }
      if (lancer) {
        warnings.unshift(lancerLocked
          ? { text: '⚠ BEAM LOCKED — THRUST ACROSS ITS AIM', color: 'red' }
          : { text: lancer.def.boss ? 'DREADNOUGHT RAILGUN CHARGING ON YOU' : 'LANCER CHARGING ON YOU', color: 'orange' });
        game.chargeBeep -= dt;
        if (game.chargeBeep <= 0) {
          audio.chargeTick(lancer.charge, 1, lancerLocked);
          game.chargeBeep = lancerLocked ? 0.09 : 0.22;
        }
      }
      if (seekerNear) {
        warnings.push({ text: 'PROXIMITY ALERT — SEEKER', color: 'orange' });
        game.proximityBeep -= dt;
        if (game.proximityBeep <= 0) { audio.beep(1500, 0.05, 0.05, 'sine'); game.proximityBeep = 0.25; }
      }
      hud.setWarnings(warnings);
      hud.setBars(player.shield / player.maxShield, player.hull / player.maxHull, player.heat, player.overheated);
      hud.setScrap(game.scrap);
      hud.setWaveTimer(game.waveActive ? 0 : game.waveTimer, player.docked, game.warp,
        !warpBlocker() && !(game.mp && mp.hostWarp && !net.isHost), game.mp);
      hud.updateStation(station, player, camera, {
        show: !player.docked && !player.docking, canDock: station.canDock(player),
        dockRange: DOCK_RANGE, dockSpeed: DOCK_MAX_REL_SPEED, needsClearance: player.needsClearance, assist: dockAssist.active,
      });
      hud.updateWrecks(wrecks.list, camera, player.pos, collectRange());
      updateAbilityHud();
      updateBossHud();
      hud.updateAllies(game.mp ? remotes.values() : NO_TARGETS, camera, player.pos);
      hud.setLink(game.mp ? net.rtt : null);
      hud.setAutopilot(dockAssist.active ? {
        mode: dockAssist.mode, dist: dockAssist.station.pos.distanceTo(player.pos), rel: _v1.subVectors(player.vel, dockAssist.station.vel).length(),
        eta: dockAssist.eta, burning: player.throttle > 0.1, intercept: dockAssist.station === bossPark,
      } : null);
      if (player.docked) { stationUI.render(); techTree.render(); }
      hud.setScore(game.score, game.wave, game.mult, hostileCount() + game.spawnQueue.length);
      if (inDock) hideNavMarkers();
      else updateNavMarkers();
      hud.setMissiles(missiles.ammo, missiles.capacity, missiles.lockInfo, camera);
      hud.updateMarkers(game.enemies, camera, player.pos, lockInfo.enemy);
      radar.update(player, game.enemies, wrecks.list, station, pred, camera.quaternion, visualTime, game.mp ? remotes.values() : NO_TARGETS);
    }

    // post fx (when watching a wingmate, from where the camera is, not your wreck)
    const r = (mp.spectating ? camera.position : player.pos).length();
    game.damageFlash = Math.max(0, game.damageFlash - rawDt * 1.8);
    finalPass.uniforms.uDamage.value = game.damageFlash * 0.7;
    finalPass.uniforms.uAberration.value = THREE.MathUtils.clamp((RS * 7 - r) / (RS * 7), 0, 1) * 0.02 + game.trauma * 0.01;
    audio.setDrone(THREE.MathUtils.clamp((RS * 9 - r) / (RS * 6), 0, 1));
    dust.uniforms.uOpacity.value = 1;

    if (state === 'dead') {
      hud.setWarnings([]);
      game.deathTimer += rawDt;
      game.timeScale = THREE.MathUtils.lerp(game.timeScale, 0.6, rawDt);
      if (mp.spectating) {
        // watching a wingmate: lift the fade-to-black from a fall into the hole
        finalPass.uniforms.uFade.value = Math.max(0, finalPass.uniforms.uFade.value - rawDt * 2);
        shipParts.group.visible = false;
      } else if (game.deathCause === 'CROSSED THE EVENT HORIZON') {
        finalPass.uniforms.uFade.value = Math.min(1, game.deathTimer / 1.8);
        // keep the ship model visible, stretched, as it falls
        updatePlayerVisual(dt, visualTime);
      }
      if (game.mp) { if (game.deathTimer > 2.8 && !mp.spectating) enterSpectate(); }
      else if (game.deathTimer > 2.8) showGameOver();
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
  dust.uniforms.uVel.value.copy(state === 'playing' || state === 'dead' ? viewerVel() : _v1.set(0, 0, 0));
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
const overlays = ['menu', 'controls', 'pause', 'gameover', 'lobby', 'debug'];
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

// ---------------------------------------------------------------------------
// Debug launch (solo): pick the starting wave, upgrade levels and scrap
// ---------------------------------------------------------------------------
const debugSetup = (() => {
  const saved = store.get('eh_debug', {}) || {};
  const levels = newUpgradeLevels();
  for (const u of UPGRADES) levels[u.id] = THREE.MathUtils.clamp(Math.round((saved.levels || {})[u.id] || 0), 0, u.costs.length);
  levels.mk2 = (saved.levels || {}).mk2 ? 1 : 0;
  return {
    allTech: !!saved.allTech,
    wave: THREE.MathUtils.clamp(Math.round(saved.wave || BOSS_EVERY), 1, 30),
    scrap: THREE.MathUtils.clamp(Math.round(saved.scrap || 0), 0, 2000),
    levels,
  };
})();
const debugRows = [
  { key: 'wave', name: 'START WAVE', min: 1, max: 30, step: 1 },
  ...UPGRADES.map((u) => ({ key: u.id, name: u.name, desc: u.desc, min: 0, max: u.costs.length, step: 1, upgrade: true })),
  { key: 'mk2', name: 'MK2 SHIP', desc: '+50% engines, tech tree instead of upgrades', min: 0, max: 1, step: 1, upgrade: true },
  { key: 'scrap', name: 'STARTING SCRAP', min: 0, max: 2000, step: 50 },
];
const dbgValue = (r) => (r.upgrade ? debugSetup.levels[r.key] : debugSetup[r.key]);
function renderDebug() {
  document.getElementById('dbg-rows').innerHTML = debugRows.map((r) => {
    const v = dbgValue(r);
    const shown = r.key === 'mk2' ? (v ? (debugSetup.allTech ? 'ALL TECH' : 'YES') : 'NO') : r.upgrade ? `${v} / ${r.max}` : v;
    const extras = [[6, 'lancers'], [8, 'sowers'], [11, 'aegis']].filter(([w]) => v >= w).map(([, t]) => t);
    const sub = r.key === 'wave'
      ? (isBossWave(v) ? 'DREADNOUGHT WAVE' : `next boss: wave ${Math.ceil(v / BOSS_EVERY) * BOSS_EVERY}`) + (extras.length ? ` · with ${extras.join(', ')}` : '')
      : (r.desc || '');
    return `<div class="dbg-row"><div class="dbg-name">${r.name}<small>${sub}</small></div><div class="dbg-step">`
      + `<button data-key="${r.key}" data-d="-1" ${v <= r.min ? 'disabled' : ''}>−</button><b>${shown}</b>`
      + `<button data-key="${r.key}" data-d="1" ${v >= r.max ? 'disabled' : ''}>+</button></div></div>`;
  }).join('');
  const w = debugSetup.wave;
  document.getElementById('dbg-note').textContent = `${DIFFICULTIES[difficulty].name} · WAVE ${w}${isBossWave(w) ? ' · DREADNOUGHT' : ''} · ${DIFFICULTIES[difficulty].missiles + debugSetup.levels.missileCap} MISSILES`;
  store.set('eh_debug', debugSetup);
}
document.getElementById('dbg-rows').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-key]');
  if (!b || b.disabled) return;
  e.stopPropagation();
  const r = debugRows.find((x) => x.key === b.dataset.key);
  const v = THREE.MathUtils.clamp(dbgValue(r) + Number(b.dataset.d) * r.step, r.min, r.max);
  if (r.upgrade) debugSetup.levels[r.key] = v; else debugSetup[r.key] = v;
  if (r.key === 'mk2' && !v) debugSetup.allTech = false;
  audio.init(); audio.uiClick();
  renderDebug();
});
for (const chip of document.querySelectorAll('.dbg-chip')) {
  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    audio.init(); audio.uiClick();
    const p = chip.dataset.preset;
    if (p === 'boss') debugSetup.wave = BOSS_EVERY;
    for (const u of UPGRADES) {
      if (p === 'max') debugSetup.levels[u.id] = u.costs.length;
      if (p === 'reset') debugSetup.levels[u.id] = 0;
    }
    if (p === 'reset') { debugSetup.wave = 1; debugSetup.scrap = 0; debugSetup.allTech = false; debugSetup.levels.mk2 = 0; }
    if (p === 'max') debugSetup.allTech = false;
    if (p === 'alltech') { debugSetup.levels.mk2 = 1; debugSetup.allTech = true; }
    if (p === 'mk2') { debugSetup.levels.mk2 = 1; debugSetup.allTech = false; }
    renderDebug();
  });
}
function launchDebug() {
  audio.init();
  const fade = document.getElementById('fade');
  fade.classList.add('on');
  requestLock();
  setTimeout(() => {
    startGame({ debug: true });
    game.levels = { ...newUpgradeLevels(), ...debugSetup.levels };
    if (debugSetup.allTech) for (const n of TECH) game.levels[n.key] = Math.max(game.levels[n.key] || 0, n.lvl);
    applyUpgrades();
    missiles.ammo = missiles.capacity;
    player.hull = player.maxHull;
    game.scrap = debugSetup.scrap;
    game.wave = debugSetup.wave - 1;   // the next wave to launch is the one picked
    game.waveTimer = 4;
    hud.notice(`DEBUG · WAVE ${debugSetup.wave} IN 4 s`, 'orange');
    fade.classList.remove('on');
  }, 450);
}
bind('btn-debug', () => { renderDebug(); setOverlay('debug'); });
bind('btn-dbg-launch', launchDebug);
bind('btn-dbg-back', () => setOverlay('menu'));
bind('btn-controls', () => { controlsReturn = 'menu'; setOverlay('controls'); });
bind('btn-back', () => setOverlay(controlsReturn));
function cycleQuality() {
  const order = ['HIGH', 'MEDIUM', 'LOW'];
  qualityKey = order[(order.indexOf(qualityKey) + 1) % order.length];
  store.set('eh_quality', qualityKey);
  applyQuality();
}
bind('btn-quality', cycleQuality);
bind('btn-quality-pause', cycleQuality);   // also from the pause menu, mid-run
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
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'Enter') {
    if (state === 'menu' && !lobbyOpen()) launch();
    else if (state === 'paused') resumeGame();
    else if (state === 'gameover') launch();
  }
});

// ===========================================================================
// Multiplayer (up to 8 pilots — see net.js / remote.js)
//
// The host's game is the referee: it runs the waves, the enemy AI and the
// shared scrap pool. Guests show the host's enemies as "proxies" (dead-reckoned
// between snapshots), judge enemy fire against their own ships, and report
// their hits, rams and salvage to the host, which decides and tells everyone.
// ===========================================================================
const SNAPSHOT_INTERVAL = 1 / 20;
const WORLD_INTERVAL = 1 / 10;
const ENEMY_TYPES = ['raider', 'warden', 'seeker', 'dread', 'lancer', 'sower', 'mine', 'aegis', 'seeker2'];
const mp = {
  epoch: 0, sendTimer: 0, worldTimer: 0, waveSyncTimer: 0, starting: false, pendingStart: false,
  players: new Map(),      // pilot id -> { name, ready }
  reqId: 0, pending: new Map(), deadIds: new Set(),
  spectating: false, spectateId: -1, spectateSnap: -2, wipeTimer: 0, reviveBanner: '',
  difficulty: 'normal',    // the host's pick; every pilot flies with it
  custom: sanitizeCustom({}),   // the host's custom-difficulty numbers
  hostWarp: false,         // host's setting: only the host controls time warp
  warpDropAsked: false,
};

const round2 = (x) => Math.round(x * 100) / 100;
function r2(v) { return [round2(v.x), round2(v.y), round2(v.z)]; }

/** The station's orbit is analytic, so every pilot derives its phase from the shared clock. */
function syncStation() {
  station.phase = STATION_PHASE0 + station.omega * (simNow() - mp.epoch);
  station.stateAt(0, station.pos, station.vel);
}

/** Each pilot has their own docking clamp (the station has four). */
function myClamp() { return game.mp ? net.myId : 0; }

function pilotName(id) {
  if (id === net.myId) return callsign;
  const p = mp.players.get(id);
  return (p && p.name) || (id === 0 ? 'HOST' : `PILOT ${id + 1}`);
}

/** Every living pilot (this ship + the others), for enemy targeting and spawning. */
function alivePilots() {
  const list = [];
  if (player.alive) list.push(player);
  if (game.mp) for (const r of remotes.values()) if (r.present && r.alive) list.push(r);
  return list;
}

/**
 * Every AGGRO_EVERY s of a wave (or as soon as the last party is all shot down), a
 * third of it turns aggressive for that long: those hunt their pilot from any range and
 * close in hard, so a few are always on you but never the whole wave. In multiplayer the third is shared evenly between the pilots
 * who are out flying, each taking the hostiles nearest to them. Host / solo.
 */
const AGGRO_EVERY = 25;
/** Returns how many hostiles were sent. */
function pickAggressors() {
  const pool = game.enemies.filter((e) => e.alive && !e.proxy && !e.def.boss && !e.def.inert && !e.def.support && !e.def.seeker);
  const pilots = alivePilots().filter((p) => !p.docked && !p.docking);
  if (!pool.length || !pilots.length) return 0;
  const total = Math.min(pool.length, Math.max(2, Math.round(pool.length / 3)));
  const quota = Math.ceil(total / pilots.length);
  let left = total;
  for (const p of pilots) {
    if (left <= 0 || !pool.length) break;
    pool.sort((a, b) => a.pos.distanceToSquared(p.pos) - b.pos.distanceToSquared(p.pos));
    const take = pool.splice(0, Math.min(quota, left));
    left -= take.length;
    for (const e of take) { e.aggro = AGGRO_EVERY; e.aggroTarget = p; }
    if (p === player) hud.notice(`⚠ ${take.length} HOSTILE${take.length === 1 ? '' : 'S'} CLOSING IN`, 'orange');
    else if (game.mp) for (const [id, r] of remotes) if (r === p) net.sendEvent({ k: 'aggro', n: take.length }, id);
  }
  return total - left;
}

/** Who an enemy goes after: its assigned pilot (seekers from a volley) while they're still up, else the nearest. */
function targetFor(e) {
  if (e.aggro > 0 && e.aggroTarget && e.aggroTarget.alive && (e.aggroTarget === player || e.aggroTarget.present)) return e.aggroTarget;
  const t = e.assigned;
  if (t && t.alive && (t === player || t.present)) return t;
  return nearestPilot(e.pos);
}

function nearestPilot(pos) {
  let best = player, bd = Infinity;
  for (const p of alivePilots()) {
    const d = p.pos.distanceToSquared(pos);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

function sendSnapshot(dt) {
  if (!net.connected) return;
  mp.sendTimer -= dt;
  if (mp.sendTimer > 0) return;
  mp.sendTimer = SNAPSHOT_INTERVAL;
  const q = player.quat;
  net.sendState({
    k: 's', t: simNow(),
    p: r2(player.pos), v: r2(player.vel), a: r2(player.thrustAcc),
    q: [q.x, q.y, q.z, q.w].map((x) => Math.round(x * 1e4) / 1e4),
    th: round2(player.throttle), al: player.alive ? 1 : 0, dk: (player.docked || player.docking) ? 1 : 0, dc: myClamp(),
    hu: Math.round(player.hull), sh: Math.round(player.shield), mi: missiles.ammo,
  });
}

/** Host: enemy snapshots (10/s) and the wave clock (2/s). */
function sendWorld(dt) {
  if (!net.connected) return;
  mp.worldTimer -= dt;
  if (mp.worldTimer <= 0) {
    mp.worldTimer = WORLD_INTERVAL;
    const list = [];
    for (const e of game.enemies) {
      if (!e.alive) continue;
      const q = e.quat;
      const row = [e.netId, ENEMY_TYPES.indexOf(e.type), ...r2(e.pos), ...r2(e.vel), ...r2(e.thrust),
        round2(q.x), round2(q.y), round2(q.z), round2(q.w), Math.round(e.hp * 100) / 100, round2(e.throttle)];
      // the dreadnought also reports its full health and which turrets still stand
      if (e.turrets) row.push(e.maxHp, e.turrets.reduce((mask, t, i) => mask | (t.alive ? 1 << i : 0), 0), Math.round(e.charge * 1000) / 1000, e.turrets.length);
      else if (e.def.weapon === 'beam') row.push(Math.round(e.charge * 1000) / 1000);   // lancer: how far into its charge
      list.push(row);
    }
    net.sendState({ k: 'es', t: simNow(), e: list });
  }
  mp.waveSyncTimer -= dt;
  if (mp.waveSyncTimer <= 0) {
    mp.waveSyncTimer = 0.5;
    net.sendEvent({ k: 'ws', wave: game.wave, timer: round2(game.waveTimer), active: game.waveActive ? 1 : 0 });
  }
}

/** Guest: create / update proxies from the host's enemy snapshot. */
const _snap = { t: 0, p: [0, 0, 0], v: [0, 0, 0], a: [0, 0, 0], q: [0, 0, 0, 1], hp: 0, th: 0 };
function applyEnemySnapshot(msg) {
  const now = simNow();
  for (const row of msg.e) {
    const id = row[0];
    if (mp.deadIds.has(id)) continue;
    _snap.t = msg.t;
    _snap.p[0] = row[2]; _snap.p[1] = row[3]; _snap.p[2] = row[4];
    _snap.v[0] = row[5]; _snap.v[1] = row[6]; _snap.v[2] = row[7];
    _snap.a[0] = row[8]; _snap.a[1] = row[9]; _snap.a[2] = row[10];
    _snap.q[0] = row[11]; _snap.q[1] = row[12]; _snap.q[2] = row[13]; _snap.q[3] = row[14];
    _snap.hp = row[15]; _snap.th = row[16];
    const type = ENEMY_TYPES[row[1]] || 'raider';
    _snap.mhp = type === 'dread' ? row[17] || 0 : 0;
    _snap.ch = type === 'lancer' ? row[17] || 0 : type === 'dread' ? row[19] || 0 : 0;
    let e = game.enemies.find((x) => x.netId === id);
    if (!e) {
      e = new Enemy(type, scene, Math.max(0, game.wave - 1), id, type === 'dread' ? row[20] || bossTurretCount() : undefined);
      e.maxHp = e.def.hp * diffDef().hp;   // for health bars (the dreadnought's comes in the snapshot)
      e.proxy = true;
      e.applyNet(_snap, now);
      if (e.turrets) {
        e.setOrbit(BOSS_ORBIT, _v1.crossVectors(e.pos, e.vel).normalize());
        e.quat.copy(e.targetQuat);
        e.updateTurretPositions();
        e.mesh.quaternion.copy(e.quat);
      }
      e.mesh.position.copy(e.pos);
      e.mesh.scale.setScalar(0.01);
      e.trail.reset(e.pos);
      game.enemies.push(e);
      if (!e.def.inert) warpInFx(e.pos, e.vel);   // mines are dropped, not warped in
    } else {
      e.applyNet(_snap, now);
    }
    if (e.turrets && row.length > 18) {
      // catch any turret losses we missed
      for (const t of e.turrets) if (t.alive && !(row[18] & (1 << t.index))) e.killTurret(t.index);
    }
  }
}

/** Guest: drop proxies the host has stopped mentioning (missed kill message etc.). */
function pruneProxies() {
  const now = simNow();
  for (const e of game.enemies) if (e.alive && e.proxy && now - e.lastSeen > 2.5) e.destroy();
}

// ---------------------------------------------------------------------------
// Death in multiplayer: you stay down and watch your wingmates until one of
// them docks at the station and spends shared scrap to revive you. If every
// pilot is down at once, the run is over.
// ---------------------------------------------------------------------------
const spectateEls = {
  root: document.getElementById('spectate'), target: document.getElementById('sp-target'),
  scrap: document.getElementById('sp-scrap'), wave: document.getElementById('sp-wave'),
};

/** Pilots who are down and waiting for a revive (as seen from here). */
function fallenPilots() {
  if (!game.mp) return [];
  const list = [];
  for (const [id, r] of remotes) if (r.present && !r.alive) list.push({ id, name: pilotName(id) });
  return list;
}

function livingRemotes() { return [...remotes.entries()].filter(([, r]) => r.present && r.alive); }

function enterSpectate() {
  mp.spectating = true;
  mp.spectateSnap = -2;   // start right behind whoever we watch first
  hud.show(false);
  hud.hideMarkers();
  spectateEls.root.classList.remove('hidden');
  orbitLine.visible = false;
  if (document.pointerLockElement === canvas) document.exitPointerLock();
  document.body.style.cursor = '';
  cycleSpectate();
}

function exitSpectate() {
  if (mp.spectating) orbitLine.visible = true;
  mp.spectating = false;
  spectateEls.root.classList.add('hidden');
}

function cycleSpectate() {
  const living = livingRemotes().map(([id]) => id);
  if (!living.length) { mp.spectateId = -1; return; }
  const i = living.indexOf(mp.spectateId);
  mp.spectateId = living[(i + 1) % living.length];
}

const _specQ = new THREE.Quaternion();
/** Whose velocity the view moves with: the pilot we're watching, else our own ship. */
function viewerVel() {
  if (mp.spectating) {
    const r = remotes.get(mp.spectateId);
    if (r && r.present && r.alive) return r.vel;
  }
  return player.vel;
}
function updateSpectate(dt) {
  let r = remotes.get(mp.spectateId);
  if (!r || !r.present || !r.alive) { cycleSpectate(); r = remotes.get(mp.spectateId); }
  if (r && r.present && r.alive) {
    // the same chase camera the watched pilot sees (see updateChaseCamera), minus their HUD
    if (mp.spectateSnap !== mp.spectateId) { camQuat.copy(r.quat); mp.spectateSnap = mp.spectateId; }
    _specQ.copy(r.quat);
    camQuat.slerp(_specQ, 1 - Math.exp(-dt * 9));
    camOffset.set(0, 2.5, 9.5 + r.throttle * 1.3).applyQuaternion(camQuat);
    camera.position.copy(r.renderPos).add(camOffset);
    camera.quaternion.copy(camQuat);
    spectateEls.target.textContent = `${r.name}${r.docked ? ' (DOCKED)' : ''}`;
    fovKick = THREE.MathUtils.lerp(fovKick, r.throttle * 7, 1 - Math.exp(-dt * 4));
    const fov = 72 + fovKick;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  } else {
    // nobody to follow: a wide view of the hole instead of wherever you died
    updateMenuCamera(dt);
    spectateEls.target.textContent = 'NOBODY — EVERY PILOT IS DOWN';
  }
  camera.updateMatrixWorld();
  const enough = game.scrap >= REVIVE_COST;
  spectateEls.scrap.innerHTML = `<span class="${enough ? 'ok' : ''}">SHARED SCRAP ${game.scrap} / ${REVIVE_COST}</span>`;
  const hostiles = hostileCount() + game.spawnQueue.length;
  spectateEls.wave.textContent = game.waveActive ? `WAVE ${game.wave} · ${hostiles} HOSTILE${hostiles === 1 ? '' : 'S'}` :
    `NEXT WAVE ${Math.max(0, Math.ceil(game.waveTimer))} s`;
}

/** Docked pilot asks to revive a fallen wingmate (the host checks and pays from the shared pool). */
function requestRevive(id) {
  if (!game.mp || !player.alive || !player.docked) return;
  if (isGuest()) { net.sendEvent({ k: 'reviveReq', id }); return; }
  hostRevive(id, net.myId);
}

function hostRevive(id, by) {
  const target = id === net.myId ? null : remotes.get(id);
  const isDown = id === net.myId ? !player.alive : !!(target && target.present && !target.alive);
  if (!isDown) return;
  if (game.scrap < REVIVE_COST) { if (by !== net.myId) net.sendEvent({ k: 'denied', why: 'NOT ENOUGH SHARED SCRAP TO REVIVE' }, by); else hud.notice('NOT ENOUGH SHARED SCRAP TO REVIVE', 'red'); return; }
  game.scrap -= REVIVE_COST;
  econBroadcast();
  net.sendEvent({ k: 'revived', id, by });
  onRevived(id, by);
}

function onRevived(id, by) {
  audio.purchase();
  if (id === net.myId) reviveAtStation(by);
  else hud.notice(`${pilotName(id)} REVIVED BY ${by === net.myId ? 'YOU' : pilotName(by)}`, 'green');
}

/** Come back to life docked in our own clamp at the station. */
function reviveAtStation(by) {
  exitSpectate();
  Object.assign(player, {
    alive: true, hull: player.maxHull, shield: player.maxShield, heat: 0, overheated: false, shieldDelay: 0,
    pendingYaw: 0, pendingPitch: 0, yawRate: 0, pitchRate: 0, throttle: 0, needsClearance: false,
  });
  missiles.ammo = missiles.capacity;
  game.timeScale = 1;
  game.deathTimer = 0;
  finalPass.uniforms.uFade.value = 0;
  station.toWorld(station.clampLocal(myClamp()), player.pos);
  player.vel.copy(station.vel);
  player.quat.copy(station.quat);
  shipParts.group.visible = true;
  shipParts.model.scale.set(1, 1, 1);
  for (const t of playerTrails) t.reset(player.pos);
  state = 'playing';
  hud.show(true);
  player.docking = true;
  station.beginDock(player, myClamp());
  // shown once the docking clamps close (see finishDock)
  mp.reviveBanner = `${by === net.myId ? 'BACK ONLINE' : `BY ${pilotName(by)}`} · SHOP, THEN UNDOCK WITH [F]`;
}

/** Host: if every pilot is down for a few seconds, the run ends for everyone. */
function checkWipe(dt) {
  const anyoneAlive = player.alive || livingRemotes().length > 0;
  mp.wipeTimer = anyoneAlive ? 0 : mp.wipeTimer + dt;
  if (mp.wipeTimer > 3) {
    net.sendEvent({ k: 'wipe', wave: game.wave });
    endRunWiped();
  }
}

function endRunWiped() {
  exitSpectate();
  game.deathCause = 'ALL PILOTS LOST';
  showGameOver();
}

/** Wave cleared: everyone gets the bonus, a patch-up and full shields. */
function waveClearedFx(n) {
  player.hull = Math.min(player.maxHull, player.hull + 15);
  player.shield = player.maxShield;
  hud.banner('WAVE CLEARED', `+${n * 250} BONUS · 2:00 TO SALVAGE AND UPGRADE`, 3500);
  game.score += n * 250;
  audio.waveClear();
}

// ---------------------------------------------------------------------------
// Callsigns
// ---------------------------------------------------------------------------
const CALLSIGNS = ['VIPER', 'NOVA', 'COMET', 'RAVEN', 'EMBER', 'DRIFT', 'HALO', 'QUASAR', 'ZENITH', 'ORBIT'];
function cleanCallsign(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}
let callsign = cleanCallsign(store.get('eh_callsign', '')) ||
  `${CALLSIGNS[Math.floor(Math.random() * CALLSIGNS.length)]}-${Math.floor(10 + Math.random() * 90)}`;
store.set('eh_callsign', callsign);

// ---------------------------------------------------------------------------
// Session start / end
// ---------------------------------------------------------------------------
function startMultiplayer() {
  if (mp.starting) return;
  mp.starting = true;
  mp.pendingStart = false;
  setLobbyStatus('Launching', 'busy');
  const fade = document.getElementById('fade');
  fade.classList.add('on');
  setTimeout(() => {
    startGame({ multiplayer: true });
    for (const [id, p] of mp.players) if (id !== net.myId) remoteFor(id).name = p.name;
    fade.classList.remove('on');
    mp.starting = false;
    if (net.isHost) econBroadcast();
  }, 450);
}

function readyGuests() { return [...mp.players.entries()].filter(([id, p]) => id !== 0 && p.ready).length; }

function hostStart() {
  if (!net.isHost || readyGuests() === 0) return;
  net.lockRoom();
  mp.epoch = net.netTime();
  mp.difficulty = difficulty;
  mp.custom = { ...customDiff };
  net.sendEvent({ k: 'start', epoch: mp.epoch, df: mp.difficulty, cd: mp.custom, hw: mp.hostWarp ? 1 : 0 });
  startMultiplayer();
}

function broadcastRoster() {
  if (!net.isHost) return;
  mp.players.set(0, { name: callsign, ready: true });
  mp.difficulty = difficulty;
  mp.custom = { ...customDiff };
  net.sendEvent({ k: 'roster', df: difficulty, cd: customDiff, hw: mp.hostWarp ? 1 : 0, players: [...mp.players.entries()].map(([id, p]) => [id, p.name, p.ready ? 1 : 0]) });
  renderRoom();
}

function leaveMultiplayer() {
  exitSpectate();
  resetWarpClock();
  mp.wipeTimer = 0;
  if (net.role) net.close();
  game.mp = false;
  mp.players.clear();
  mp.pending.clear();
  mp.pendingStart = false;
  clearRemotes();
  allyBolts.clear();
  hud.setLink(null);
}

// ---------------------------------------------------------------------------
// Shared economy. In multiplayer the host owns the scrap pool and the upgrade
// levels; guests ask for purchases / spending and get the result back.
// Upgrades apply to every ship.
// ---------------------------------------------------------------------------
const isGuest = () => game.mp && net.role === 'client';

function econBroadcast() {
  if (game.mp && net.isHost) net.sendEvent({ k: 'econ', scrap: game.scrap, levels: game.levels });
}

/** Adopt new upgrade levels; each pilot gets the one-off bonus for any new Hull Plating / Missile Rack level. */
function applyLevels(levels) {
  const dHull = levels.hull - game.levels.hull;
  const dRacks = levels.missileCap - game.levels.missileCap;
  game.levels = { ...levels };
  applyUpgrades();
  if (dHull > 0 && player.alive) player.hull = Math.min(player.maxHull, player.hull + 25 * dHull);
  if (dRacks > 0) missiles.ammo = Math.min(missiles.capacity, missiles.ammo + dRacks);
}

/**
 * What a purchase id refers to: a classic upgrade ('damage'), the MK2 ship
 * ('mk2'), or a tech-tree node ('tech:railgun1'). Returns { key, lvl, cost, name }
 * for the next purchase, or null if it can't be bought right now.
 */
function purchaseFor(id) {
  const lv = game.levels;
  if (id === 'mk2') {
    return mk2Ready(lv) ? { key: 'mk2', lvl: 1, cost: Math.round(MK2_COST * costScale()), name: 'MK2 SHIP' } : null;
  }
  if (id.startsWith('tech:')) {
    const n = TECH_BY_ID[id.slice(5)];
    return n && techUnlocked(lv, n) ? { key: n.key, lvl: n.lvl, cost: techCost(n, costScale()), name: n.name } : null;
  }
  if (lv.mk2) return null;                      // after MK2 everything goes through the tree
  const u = UPGRADES.find((x) => x.id === id);
  if (!u) return null;
  const cost = upgradeCost(u, lv[id], costScale());
  return cost === null ? null : { key: id, lvl: lv[id] + 1, cost, name: `${u.name} · LV ${lv[id] + 1}` };
}

/** Authoritative purchase (solo or host). Returns what was bought, or null. */
function buyUpgrade(id) {
  const p = purchaseFor(id);
  if (!p || game.scrap < p.cost) return null;
  game.scrap -= p.cost;
  applyLevels({ ...game.levels, [p.key]: p.lvl });
  econBroadcast();
  return { id, name: p.name };
}

function announcePurchase(u, who) {
  audio.purchase();
  if (u.id === 'mk2') {
    hud.banner('MK2 SHIP', `${game.mp ? `${who} UPGRADED THE FLEET · ` : ''}+50% ENGINE POWER · TECH TREE UNLOCKED`, 3200);
    return;
  }
  hud.notice(game.mp ? `${who} BOUGHT ${u.name}` : u.name, 'green');
}

/** Spend shared scrap on a personal service (repair / rearm). onOk runs once it's approved. */
function spendScrap(amount, onOk) {
  if (amount <= 0 || game.scrap < amount) return;
  if (isGuest()) {
    const id = ++mp.reqId;
    mp.pending.set(id, onOk);
    net.sendEvent({ k: 'spend', id, amount });
    return;
  }
  game.scrap -= amount;
  econBroadcast();
  onOk();
}

/** Credit scrap to the pool (solo / host only — guests salvage through the host). */
function addScrap(value) {
  game.scrapTotal += value;
  game.scrap += value;
  econBroadcast();
}

// ---------------------------------------------------------------------------
// Network events — lobby
// ---------------------------------------------------------------------------
net.on('join', ({ id }) => {          // host: a guest's link opened
  mp.players.set(id, { name: `PILOT ${id + 1}`, ready: false });
  net.sendEvent({ k: 'welcome', id, v: PROTOCOL }, id);
  setLobbyStatus('A pilot is coming aboard', 'busy');
  broadcastRoster();
});
net.on('leave', ({ id, reason }) => { // host: a guest's link closed
  const name = pilotName(id);
  mp.players.delete(id);
  const r = remotes.get(id);
  if (r) { r.dispose(); remotes.delete(id); }
  broadcastRoster();
  if (game.mp) hud.banner(`${name} LEFT THE FLIGHT`, `${pilotCount()} PILOT${pilotCount() === 1 ? '' : 'S'} REMAINING`, 3000);
  else if (lobbyOpen()) setLobbyStatus(`${name} ${reason}`, readyGuests() ? '' : 'busy');
});
net.on('connected', () => setLobbyStatus('Linked — waiting for clearance', 'busy'));   // guest
net.on('welcome', (m) => {           // guest: the host accepted us
  if (m.v !== PROTOCOL) {
    setLobbyStatus('The host is running a different version of the game. Everyone needs the latest copy (hard-refresh with Cmd/Ctrl+Shift+R).', 'error');
    net.close();
    showLobbyChoice();
    return;
  }
  net.acceptedAs(m.id);
  net.sendEvent({ k: 'hello', v: PROTOCOL, name: callsign });
  showRoom();
});
net.on('hello', (m) => {             // host: a guest introduced themselves
  if (m.v !== PROTOCOL) return;
  mp.players.set(m.from, { name: cleanCallsign(m.name) || `PILOT ${m.from + 1}`, ready: true });
  audio.beep(880, 0.08, 0.05, 'sine');
  broadcastRoster();
  setLobbyStatus(`${pilotName(m.from)} is aboard — press START when everyone's ready`);
});
net.on('roster', (m) => {            // guest: who's in the room
  mp.players = new Map(m.players.map(([id, name, ready]) => [id, { name, ready: !!ready }]));
  mp.difficulty = validDifficulty(m.df);
  mp.custom = sanitizeCustom(m.cd);
  mp.hostWarp = !!m.hw;
  for (const [id, r] of remotes) if (!mp.players.has(id)) { r.dispose(); remotes.delete(id); }
  for (const [id, r] of remotes) r.name = pilotName(id);
  if (lobbyOpen()) setLobbyStatus(`Waiting for ${pilotName(0)} to launch`, 'busy');
  renderRoom();
});
net.on('name', (m) => {              // host: a guest renamed
  const p = mp.players.get(m.from);
  if (p) p.name = cleanCallsign(m.name) || p.name;
  const r = remotes.get(m.from);
  if (r) r.name = pilotName(m.from);
  broadcastRoster();
});
net.on('start', (m) => {             // guest
  mp.epoch = m.epoch;
  mp.difficulty = validDifficulty(m.df);
  mp.custom = sanitizeCustom(m.cd);
  mp.hostWarp = !!m.hw;
  if (net.synced) startMultiplayer();
  else { mp.pendingStart = true; setLobbyStatus('Syncing clocks', 'busy'); }
});
net.on('synced', () => { if (mp.pendingStart) startMultiplayer(); });

// ---------------------------------------------------------------------------
// Network events — flight
// ---------------------------------------------------------------------------
net.on('s', (snap) => { if (game.mp && snap.from !== net.myId) remoteFor(snap.from).applySnapshot(snap, simNow(), 0.6 * game.warp); });
net.on('f', (f) => {
  if (!game.mp) return;
  const late = Math.min(Math.max(simNow() - f.t, 0), 0.5);
  _v1.fromArray(f.p); _v2.fromArray(f.v);
  _v1.addScaledVector(_v2, late);
  allyBolts.spawn(_v1, _v2, (f.l || BOLT_LIFE) - late, 0);
  const d = _v1.distanceTo(player.pos);
  if (d < 400) audio.enemyLaser(THREE.MathUtils.clamp(1 - d / 400, 0, 0.6));
});
net.on('d', (d) => {
  if (!game.mp) return;
  _v1.fromArray(d.p); _v2.fromArray(d.v);
  explode(_v1, _v2, 1.6, [1.0, 0.6, 0.2]);
  audio.explosion(1.4, THREE.MathUtils.clamp(1.4 - _v1.distanceTo(player.pos) / 700, 0.15, 1));
  hud.notice(`${pilotName(d.from)} DOWN · DOCK AND SPEND ${REVIVE_COST} SCRAP TO REVIVE`, 'orange');
});

// enemies, waves and wrecks (host → guests)
net.on('es', (m) => { if (isGuest()) applyEnemySnapshot(m); });
net.on('ws', (m) => {
  if (!isGuest()) return;
  game.wave = m.wave;
  game.waveActive = !!m.active;
  if (Math.abs(game.waveTimer - m.timer) > 0.5 * game.warp) game.waveTimer = m.timer;
});
net.on('aggro', (m) => { if (isGuest() && player.alive) hud.notice(`⚠ ${m.n} HOSTILE${m.n === 1 ? '' : 'S'} CLOSING IN`, 'orange'); });
net.on('waveStart', (m) => {
  if (!isGuest()) return;
  game.wave = m.n;
  game.emergencyUsed = false;
  game.waveActive = true;
  game.waveTimer = 0;
  const restocked = missiles.ammo < missiles.capacity;
  missiles.refill();
  for (const t of m.nt || []) game.seenTypes.add(t);
  waveBanner(m.n, m.count, restocked, m.nt || []);
});
net.on('waveClear', (m) => {
  if (!isGuest()) return;
  game.waveActive = false;
  game.waveTimer = INTERMISSION;
  waveClearedFx(m.n);
});
net.on('ef', (m) => {                // an enemy fired: everyone simulates the same bolts
  if (!isGuest()) return;
  const late = Math.min(Math.max(simNow() - m.t, 0), 0.5);
  _v1.fromArray(m.p);
  for (let i = 0; i < m.v.length; i += 3) {
    _v2.set(m.v[i], m.v[i + 1], m.v[i + 2]);
    _v3.copy(_v1).addScaledVector(_v2, late);
    enemyBolts.spawn(_v3, _v2, (m.l || 4.2) - late, m.dmg);
  }
  _v2.fromArray(m.ev || [0, 0, 0]);
  enemyFireFx(_v1, _v2, !!m.w);
});
net.on('kill', (m) => {
  if (!isGuest()) return;
  mp.deadIds.add(m.id);
  const e = game.enemies.find((x) => x.netId === m.id && x.alive);
  if (e) { e.pos.fromArray(m.p); e.vel.fromArray(m.v); e.noWreck = !!m.nw; killEnemy(e, m.cause, m.by, true); }
  else if (!m.nw && (m.cause === 'player' || m.cause === 'ram' || m.cause === 'missile')) {
    wrecks.spawn({ netId: m.id, type: ENEMY_TYPES[m.y] || 'raider', pos: new THREE.Vector3().fromArray(m.p), vel: new THREE.Vector3().fromArray(m.v) });
  }
});
net.on('salvaged', (m) => { if (isGuest()) wrecks.removeById(m.id); });
net.on('rail', (m) => {               // another pilot's railgun (visual; they already applied the hits)
  if (!game.mp || m.from === net.myId) return;
  drawBeam(new THREE.Vector3().fromArray(m.p), new THREE.Vector3().fromArray(m.d).normalize(), m.l, RAIL_BEAM);
  audio.beam(THREE.MathUtils.clamp(1.2 - new THREE.Vector3().fromArray(m.p).distanceTo(player.pos) / 1200, 0.1, 0.8));
});
net.on('sl', (m) => { if (isGuest()) seekerLaunchAlert(new THREE.Vector3().fromArray(m.p), !!m.w); });
net.on('beam', (m) => {               // a lancer fired: draw it (the host judges hits)
  if (!isGuest()) return;
  fireBeam(new THREE.Vector3().fromArray(m.p), new THREE.Vector3().fromArray(m.d).normalize(), m.l, m.dmg, !!m.b, false);
});
net.on('beamHit', (m) => { if (isGuest()) beamHitMe(Number(m.dmg) || 0, !!m.b); });   // the host saw a beam hit us
// shared time warp
net.on('warpReq', (m) => {            // host: a pilot wants a different warp
  if (!game.mp || !net.isHost) return;
  if (m.w > 1 && mp.hostWarp) { net.sendEvent({ k: 'warpDenied', why: 'ONLY THE HOST CAN CONTROL IT' }, m.from); return; }
  const w = WARP_LEVELS.includes(m.w) ? m.w : 1;
  if (w < warpTarget() || !mp.hostWarp) hostSetWarp(w, m.from, typeof m.why === 'string' ? m.why.slice(0, 40) : '');
});
net.on('warp', (m) => {               // everyone: a scheduled warp change
  if (!isGuest()) return;
  warpClock.pending = { w: m.w, at: m.at, W0: m.W0, by: m.by, why: m.why || '' };
});
net.on('warpDenied', (m) => {
  if (!isGuest()) return;
  hud.notice(`TIME WARP · ${m.why}`, 'dim');
  audio.beep(240, 0.1, 0.05, 'square');
});
net.on('tkill', (m) => {             // a dreadnought turret was destroyed
  if (!isGuest()) return;
  const e = game.enemies.find((x) => x.netId === m.id && x.alive);
  if (e) destroyTurret(e, m.tu, m.by);
});
net.on('revived', (m) => { if (isGuest()) onRevived(m.id, m.by); });
net.on('wipe', () => { if (isGuest()) endRunWiped(); });

// guest reports (→ host)
const enemyById = (id) => game.enemies.find((x) => x.netId === id && x.alive);
net.on('hit', (m) => {
  if (!game.mp || !net.isHost) return;
  const e = enemyById(m.id);
  if (!e) return;
  if (m.tu !== undefined) hitTurret(e, m.tu, m.dmg, e.turrets[m.tu] ? e.turrets[m.tu].pos : e.pos, m.cause, m.from);
  else hitEnemy(e, m.dmg, e.pos, m.cause, m.from);
});
net.on('ram', (m) => {
  if (!game.mp || !net.isHost) return;
  const e = enemyById(m.id);
  if (e) killEnemy(e, m.cause, m.from);
});
net.on('callWave', () => { if (game.mp && net.isHost) callNextWave(); });
net.on('reviveReq', (m) => { if (game.mp && net.isHost) hostRevive(m.id, m.from); });
net.on('salvage', (m) => {
  if (!game.mp || !net.isHost) return;
  const w = wrecks.byId(m.id);
  if (!w) return;                    // someone got there first
  wrecks.removeById(m.id);
  addScrap(Math.round(w.value * scrapMult()));
  net.sendEvent({ k: 'salvaged', id: m.id });
});

// economy
net.on('econ', (m) => {
  if (!isGuest()) return;
  game.scrap = m.scrap;
  applyLevels(m.levels);
});
net.on('buy', (m) => {
  if (!game.mp || !net.isHost) return;
  const u = buyUpgrade(m.id);
  if (u) { announcePurchase(u, pilotName(m.from)); net.sendEvent({ k: 'bought', id: u.id, name: u.name, by: m.from }); }
  else net.sendEvent({ k: 'denied', why: 'NOT ENOUGH SHARED SCRAP' }, m.from);
});
net.on('bought', (m) => {
  if (!isGuest()) return;
  announcePurchase({ id: m.id, name: String(m.name || '').slice(0, 60) }, m.by === net.myId ? 'YOU' : pilotName(m.by));
});
net.on('denied', (m) => hud.notice(m.why, 'red'));
net.on('spend', (m) => {
  if (!game.mp || !net.isHost) return;
  const ok = m.amount > 0 && game.scrap >= m.amount;
  if (ok) { game.scrap -= m.amount; econBroadcast(); }
  net.sendEvent({ k: 'spendRes', id: m.id, ok }, m.from);
});
net.on('railPay', (m) => {           // host: a guest fired its railgun (it already paid on its side)
  if (!game.mp || !net.isHost) return;
  const amount = THREE.MathUtils.clamp(Number(m.amount) || 0, 0, 8);
  game.scrap = Math.max(0, game.scrap - amount);
  econBroadcast();
});
net.on('spendRes', (m) => {
  const cb = mp.pending.get(m.id);
  mp.pending.delete(m.id);
  if (m.ok && cb) cb();
  else if (!m.ok) hud.notice('NOT ENOUGH SHARED SCRAP', 'red');
});

// guest lost the host
net.on('disconnected', (reason) => {
  if (game.mp) {
    // carry on alone: the host's enemies are gone, so restart the wave clock locally
    game.mp = false;
    resetWarpClock();
    for (const e of game.enemies) e.destroy();
    game.enemies.length = 0;
    clearRemotes();
    allyBolts.clear();
    game.spawnQueue = [];
    game.waveActive = false;
    game.waveTimer = 10;
    hud.setLink(null);
    if (mp.spectating) { exitSpectate(); hud.show(true); showGameOver(); }
    else hud.banner('HOST DISCONNECTED', `${reason} · CONTINUING SOLO · NEXT WAVE IN 10 s`, 4500);
  } else if (lobbyOpen()) {
    showLobbyChoice();
    setLobbyStatus(reason, 'error');
  }
  net.close();
  mp.players.clear();
  renderRoom();
});
net.on('error', (msg) => { if (lobbyOpen()) setLobbyStatus(msg, 'error'); });

// Browsers pause hidden tabs. In multiplayer the shared world keeps moving, so
// when this tab comes back we fast-forward our simulation to catch up.
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { hiddenAt = performance.now(); return; }
  if (!hiddenAt) return;
  const away = Math.min((performance.now() - hiddenAt) / 1000, 60);
  hiddenAt = 0;
  if (!game.mp || away < 0.25 || !(state === 'playing' || state === 'dead' || state === 'paused')) return;
  keys.clear();
  firing = false;
  const step = 1 / 30;
  for (let t = 0; t < away; t += step) tick(step, false);
  clock.getDelta();   // discard the long frame we were away for
});

// ---------------------------------------------------------------------------
// Lobby / waiting room UI
// ---------------------------------------------------------------------------
const lobbyEls = {
  choose: document.getElementById('lobby-choose'),
  room: document.getElementById('lobby-room'),
  code: document.getElementById('lobby-code'),
  players: document.getElementById('lobby-players'),
  count: document.getElementById('lobby-count'),
  start: document.getElementById('btn-start'),
  back: document.getElementById('btn-lobby-back'),
  status: document.getElementById('lobby-status'),
  input: document.getElementById('join-code'),
  callsign: document.getElementById('callsign'),
  codeLabel: document.getElementById('lobby-code-label'),
  tabs: [...document.querySelectorAll('.lobby-tabs button')],
  lan: document.getElementById('lobby-lan'),
  remote: document.getElementById('lobby-remote'),
  remoteCode: document.getElementById('remote-code'),
  remoteDetected: document.getElementById('remote-detected'),
};
// LAN (direct WebRTC) or REMOTE (through the host's relay server + Cloudflare tunnel)
let lobbyMode = store.get('eh_lobby_mode', 'lan') === 'remote' ? 'remote' : 'lan';
lobbyEls.remoteCode.value = store.get('eh_share_code', '') || '';
function setLobbyMode(mode) {
  lobbyMode = mode === 'remote' ? 'remote' : 'lan';
  store.set('eh_lobby_mode', lobbyMode);
  for (const b of lobbyEls.tabs) b.classList.toggle('on', b.dataset.mode === lobbyMode);
  lobbyEls.lan.classList.toggle('hidden', lobbyMode !== 'lan');
  lobbyEls.remote.classList.toggle('hidden', lobbyMode !== 'remote');
  if (!net.role) setLobbyStatus('');
}
for (const b of lobbyEls.tabs) {
  b.addEventListener('click', (e) => { e.stopPropagation(); audio.init(); audio.uiClick(); setLobbyMode(b.dataset.mode); });
}
/** Opened from the host's own relay server? Then it knows the share code. */
async function detectLocalRelay() {
  if (!/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  try {
    const res = await fetch('/relay-info', { cache: 'no-store' });
    const info = res.ok ? await res.json() : null;
    if (info && info.code) {
      lobbyEls.remoteCode.value = info.code;
      store.set('eh_share_code', info.code);
      lobbyEls.remoteDetected.textContent = 'Share code picked up from your server. Press HOST.';
      setLobbyMode('remote');
    }
  } catch { /* plain file server: nothing to detect */ }
}
lobbyEls.callsign.value = callsign;

function lobbyOpen() { return !document.getElementById('lobby').classList.contains('hidden'); }
function setLobbyStatus(text, kind = '') {
  lobbyEls.status.textContent = text;
  lobbyEls.status.className = `lobby-status ${kind}`;
}
function showLobbyChoice() {
  lobbyEls.choose.classList.remove('hidden');
  lobbyEls.room.classList.add('hidden');
  lobbyEls.back.textContent = 'BACK';
}
function showRoom() {
  lobbyEls.choose.classList.add('hidden');
  lobbyEls.room.classList.remove('hidden');
  lobbyEls.back.textContent = 'LEAVE ROOM';
  renderRoom();
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let roomKey = '';
function renderRoom() {
  const host = net.isHost;
  if (host) mp.players.set(0, { name: callsign, ready: true });
  const ids = [...mp.players.keys()].sort((a, b) => a - b);
  const rows = ids.map((id) => {
    const p = mp.players.get(id);
    const you = id === net.myId;
    const tags = [id === 0 ? 'HOST' : (p.ready ? 'READY' : 'JOINING'), you ? 'YOU' : ''].filter(Boolean).join(' · ');
    let ping = '';
    if (!you && host) ping = net.rttOf(id) ? `${Math.round(net.rttOf(id) * 1000)} ms` : '';
    if (!you && !host && id === 0 && net.rtt) ping = `${Math.round(net.rtt * 1000)} ms`;
    const route = !you && (host || id === 0) ? net.routeOf(id) : '';
    if (ping && (route === 'relay' || route === 'direct')) ping += route === 'relay' ? ' · RELAY' : ' · DIRECT';
    return `<div class="lp${you ? ' you' : ''}"><i></i><b>${esc(you ? callsign : p.name)}</b><span class="lp-tag">${tags}</span><span class="lp-ping">${ping}</span></div>`;
  });
  for (let i = ids.length; i < MAX_PILOTS; i++) rows.push('<div class="lp empty">open slot — waiting for a pilot…</div>');
  const ready = readyGuests();
  const key = rows.join('') + net.code + host + ready;
  renderDifficulty();
  // host-only time warp: the host's checkbox; guests see it read-only
  const hw = document.getElementById('hostwarp');
  hw.checked = mp.hostWarp;
  hw.disabled = !host;
  document.getElementById('lobby-hostwarp').classList.toggle('locked', !host);
  if (key === roomKey) return;
  roomKey = key;
  lobbyEls.players.innerHTML = rows.join('');
  lobbyEls.code.textContent = net.code || '-----';
  lobbyEls.code.classList.toggle('long', net.mode === 'remote');
  lobbyEls.codeLabel.textContent = net.mode === 'remote' ? 'SHARE CODE · CLICK TO COPY' : 'ROOM CODE';
  lobbyEls.count.textContent = `${Math.max(1, ids.length)} / ${MAX_PILOTS}`;
  lobbyEls.start.classList.toggle('hidden', !host);
  lobbyEls.start.disabled = !(host && ready > 0);
  lobbyEls.start.textContent = host && ready > 0
    ? `START · ${ready + 1} PILOTS · HOSTILES ×${(1 + ENEMIES_PER_PILOT * (crewWeightOf(ready + 1) - 1)).toFixed(1)} · PRICES ×${(1 + COST_PER_PILOT * (crewWeightOf(ready + 1) - 1)).toFixed(1)}`
    : 'START';
}

function openLobby() {
  setOverlay('lobby');
  showLobbyChoice();
  setLobbyMode(lobbyMode);
  setLobbyStatus(net.available ? '' : 'The LAN multiplayer library failed to load. Check your internet connection and reload. (REMOTE still works.)', net.available ? '' : 'error');
  detectLocalRelay();
}
/** The REMOTE share code in the box, or null (with an error shown). */
function remoteShare() {
  const share = parseShareCode(lobbyEls.remoteCode.value);
  if (!share) {
    setLobbyStatus(lobbyEls.remoteCode.value.trim()
      ? 'That doesn\'t look like a share code. It\'s the words-with-dashes code printed by host-remote / ./serve.sh --remote.'
      : 'Paste the share code first. The host gets it by running host-remote (or ./serve.sh --remote).', 'error');
    return null;
  }
  lobbyEls.remoteCode.value = share.code;
  store.set('eh_share_code', share.code);
  return share;
}
async function hostGame(remote = false) {
  const share = remote ? remoteShare() : null;
  if (remote ? !share : !net.available) return;
  mp.players.clear();
  mp.hostWarp = false;     // a new room starts with shared time warp
  showRoom();
  lobbyEls.code.textContent = '·····';
  lobbyEls.code.classList.remove('long');
  setLobbyStatus(remote ? 'Connecting to your relay server' : 'Opening a room', 'busy');
  try {
    await net.host(remote ? { remote: share } : {});
    roomKey = '';
    renderRoom();
    setLobbyStatus(remote ? 'Send your friends the share code — waiting for pilots' : 'Share the room code — waiting for pilots', 'busy');
  } catch (msg) {
    setLobbyStatus(String(msg), 'error');
    net.close();
    showLobbyChoice();
  }
}
async function joinGame(remote = false) {
  let code, share = null;
  if (remote) {
    share = remoteShare();
    if (!share) return;
    code = share.code;
  } else {
    if (!net.available) return;
    code = normalizeCode(lobbyEls.input.value);
    if (code.length !== 5) { setLobbyStatus('Enter the 5-character room code from the host.', 'error'); return; }
  }
  setLobbyStatus(remote ? 'Connecting to the host\'s server' : `Connecting to ${code}`, 'busy');
  mp.players.clear();
  try {
    await net.join(code, remote ? { remote: share } : {});
  } catch (msg) {
    setLobbyStatus(String(msg), 'error');
    net.close();
    showLobbyChoice();
  }
}
function leaveRoom() {
  net.close();
  mp.players.clear();
  roomKey = '';
  if (lobbyEls.room.classList.contains('hidden')) setOverlay('menu');
  else { showLobbyChoice(); setLobbyStatus(''); }
}

bind('btn-multi', openLobby);
bind('btn-host', () => hostGame(false));
bind('btn-join', () => joinGame(false));
bind('btn-remote-host', () => hostGame(true));
bind('btn-remote-join', () => joinGame(true));
lobbyEls.remoteCode.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { audio.init(); joinGame(true); }
  if (e.code === 'Escape') leaveRoom();
});
lobbyEls.remoteCode.addEventListener('input', () => { lobbyEls.remoteDetected.textContent = ''; });
lobbyEls.code.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (!net.code) return;
  try {
    await navigator.clipboard.writeText(net.code);
    setLobbyStatus(`Copied ${net.code}`, '');
  } catch { /* clipboard blocked: the code is selectable */ }
});
bind('btn-start', hostStart);
document.getElementById('hostwarp').addEventListener('change', (e) => {
  if (!net.isHost) { e.target.checked = mp.hostWarp; return; }
  mp.hostWarp = e.target.checked;
  audio.init(); audio.uiClick();
  broadcastRoster();
});
document.getElementById('lobby-hostwarp').addEventListener('click', (e) => e.stopPropagation());
bind('btn-lobby-back', leaveRoom);
lobbyEls.input.addEventListener('input', () => {
  const v = normalizeCode(lobbyEls.input.value);
  if (lobbyEls.input.value !== v) lobbyEls.input.value = v;
});
lobbyEls.input.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') { audio.init(); joinGame(false); }
  if (e.code === 'Escape') leaveRoom();
});
lobbyEls.callsign.addEventListener('input', () => {
  const v = cleanCallsign(lobbyEls.callsign.value.replace(/^\s+/, ''));
  const keepSpace = /\s$/.test(lobbyEls.callsign.value) && v.length < 12;
  if (lobbyEls.callsign.value !== v + (keepSpace ? ' ' : '')) lobbyEls.callsign.value = v + (keepSpace ? ' ' : '');
});
lobbyEls.callsign.addEventListener('change', () => {
  callsign = cleanCallsign(lobbyEls.callsign.value) || callsign;
  lobbyEls.callsign.value = callsign;
  store.set('eh_callsign', callsign);
  if (net.isHost) broadcastRoster();
  else if (net.connected) net.sendEvent({ k: 'name', name: callsign });
  roomKey = '';
  renderRoom();
});
lobbyEls.callsign.addEventListener('keydown', (e) => { if (e.code === 'Enter') lobbyEls.callsign.blur(); });

// ===========================================================================
// Warm-up, behind the loading screen: one of every ship, missile and wreck,
// plus every pooled effect that starts hidden, is drawn once, so the first
// raider, aegis or explosion of a run doesn't stall a frame compiling shaders
// and uploading its model. The dummies are kept (off-scene): while their
// materials exist, three.js keeps those shaders compiled even when no ship of
// that kind is alive.
// ===========================================================================
const warmKeep = [];
function warmUp() {
  const temp = [];
  for (const [type, def] of Object.entries(ENEMY_DEFS)) {
    const e = new Enemy(type, scene, 0, -1, def.boss ? bossTurretCount(1) : undefined);
    if (type === 'raider') e.setShielded(true);   // the aegis bubble
    temp.push(e.mesh);
    warmKeep.push(e);
  }
  const missile = buildMissile();
  shareGeometry('missile', missile.group);
  const wreck = buildWreck(0xff4a2a);
  for (const o of [missile.group, wreck.group]) { scene.add(o); temp.push(o); warmKeep.push(o); }

  const restore = [];
  scene.traverse((o) => {
    restore.push([o, o.visible, o.frustumCulled]);
    o.visible = true;
    o.frustumCulled = false;
  });
  renderer.setRenderTarget(scenePass.target);   // same target (and so the same shader variant) as in play
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  for (const [o, v, f] of restore) { o.visible = v; o.frustumCulled = f; }
  for (const o of temp) scene.remove(o);
  for (const e of warmKeep) if (e.trail) e.trail.dispose();
}

// ===========================================================================
// Boot
// ===========================================================================
applyQuality();
warmUp();
updateBest();
renderDifficulty();
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
  collectBoltTargets, hitEnemy, changeWarp,
  advance(sec) { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) tick(1 / 60, i === n - 1); },
  step(dt, render = false) { tick(dt, render); },
  setFiring(v) { firing = v; },
  spawnEnemy, explode, killEnemy, missiles, station, wrecks, stationUI, undock, dockAssist, toggleDockAssist,
  net, remotes, allyBolts, playerBolts, enemyBolts, mp, reviveAtStation, requestRevive, hostGame, joinGame, hostStart, addScrap, enemyScale, costScale, pilotCount,
  killPlayer, worldNow, game, player, camera, startGame, state: () => state, scene, bloom, composer, shipParts, finalPass, particles, blackHole, orbitLine, dust, playerTrails };
