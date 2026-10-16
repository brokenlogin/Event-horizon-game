import * as THREE from 'three';

// ---------------------------------------------------------------------------
// First-person cockpit, built inside the player ship's own bubble canopy (the
// ellipsoid in buildPlayerShip). Coordinates are the ship model's frame
// (forward -Z); the group is parented to the model so the real nose, canards
// and trim stay in view around it. Only the exterior canopy shell is hidden.
// ---------------------------------------------------------------------------

export const EYE = new THREE.Vector3(0, 0.37, -0.32);
const CANOPY_C = new THREE.Vector3(0, 0.27, -0.45);
const CANOPY_R = new THREE.Vector3(0.3, 0.22, 0.85);

const CYAN = '#5ef2ff', AMBER = '#ffb14a', RED = '#ff4a5a';
const W = 256, H = 176;

function screen(w, h) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  return { c, g: c.getContext('2d'), tex, mesh };
}

export function buildCockpit() {
  const group = new THREE.Group();
  group.visible = false;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x252c3a, metalness: 0.8, roughness: 0.4 });
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x10161f, metalness: 0.4, roughness: 0.7, emissive: 0x0a0e15 });
  const trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ef2ff).multiplyScalar(0.7) });

  // --- canopy rim: where the bubble meets the hull ---
  const rimY = 0.2;
  const k = Math.sqrt(1 - ((rimY - CANOPY_C.y) / CANOPY_R.y) ** 2);
  const rimPts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    rimPts.push(new THREE.Vector3(Math.cos(a) * CANOPY_R.x * k * 0.97, rimY, CANOPY_C.z + Math.sin(a) * CANOPY_R.z * k * 0.97));
  }
  const rim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts, true), 128, 0.018, 6, true), frameMat);
  group.add(rim);

  // --- the tub: a well cut down into the hull inside the rim ---
  // The hull is solid, so a depth "hole" first resets depth inside the rim
  // opening to far; everything in the tub draws after it (renderOrder 2).
  const ox = CANOPY_R.x * k * 0.96, oz = CANOPY_R.z * k * 0.96;
  const holeShape = new THREE.Shape();
  holeShape.absellipse(0, 0, ox, oz, 0, Math.PI * 2);
  const holeGeo = new THREE.ShapeGeometry(holeShape, 48);
  holeGeo.rotateX(Math.PI / 2);
  const hole = new THREE.Mesh(holeGeo, new THREE.ShaderMaterial({
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'void main(){ gl_FragColor = vec4(0.0); gl_FragDepth = 1.0; }',
    colorWrite: false, depthFunc: THREE.AlwaysDepth, side: THREE.DoubleSide,
  }));
  hole.position.set(0, rimY + 0.001, CANOPY_C.z);
  hole.renderOrder = 1;
  group.add(hole);

  const tubMat = new THREE.MeshStandardMaterial({ color: 0x1a212c, metalness: 0.5, roughness: 0.7, emissive: 0x121a26, side: THREE.BackSide });
  const floorY = -0.12;
  const wallGeo = new THREE.CylinderGeometry(1, 0.88, rimY - floorY, 48, 1, true);
  const wall = new THREE.Mesh(wallGeo, tubMat);
  wall.scale.set(ox, 1, oz);
  wall.position.set(0, (rimY + floorY) / 2, CANOPY_C.z);
  group.add(wall);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x141a22, metalness: 0.4, roughness: 0.8, emissive: 0x0c1119 });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), floorMat);
  floor.scale.set(ox * 0.88, 1, oz * 0.88);
  floor.position.set(0, floorY, CANOPY_C.z);
  group.add(floor);
  const glowRim = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(rimPts.map((p) => new THREE.Vector3(p.x * 0.97, rimY - 0.025, CANOPY_C.z + (p.z - CANOPY_C.z) * 0.97)), true), 128, 0.002, 4, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ef2ff).multiplyScalar(0.35) }));
  group.add(glowRim);

  const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ef2ff).multiplyScalar(0.5) });
  // seat: pan, reclined back, headrest, on a pedestal
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2b313b, metalness: 0.2, roughness: 0.85, emissive: 0x1a1f29 });
  const box = (w, h, d, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    group.add(m);
    return m;
  };
  box(0.2, 0.045, 0.22, seatMat, 0, 0.0, -0.2, 0.08);              // pan
  box(0.2, 0.36, 0.05, seatMat, 0, 0.19, 0.0, -0.25);              // back
  box(0.14, 0.09, 0.05, seatMat, 0, 0.42, 0.06, -0.25);            // headrest
  for (const sx of [-1, 1]) box(0.004, 0.36, 0.004, glowMat, sx * 0.1, 0.19, -0.026, -0.25);   // piping on the seat back
  box(0.12, 0.1, 0.14, frameMat, 0, -0.07, -0.16);                 // pedestal
  for (const sx of [-1, 1]) box(0.025, 0.05, 0.2, frameMat, sx * 0.112, 0.035, -0.19);   // side bolsters

  // side consoles along the tub walls, with a throttle on the left
  const btnMats = [0x5ef2ff, 0xffb14a, 0x6dff9a].map((c) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(1.6) }));
  for (const sx of [-1, 1]) {
    box(0.08, 0.05, 0.38, dashMat, sx * 0.19, 0.075, -0.4);
    for (let i = 0; i < 4; i++) box(0.012, 0.004, 0.012, btnMats[(i + (sx > 0 ? 1 : 0)) % 3], sx * 0.19 + (i % 2 ? 0.015 : -0.015), 0.102, -0.5 + Math.floor(i / 2) * 0.03);
  }
  const throttleQ = new THREE.Group();
  throttleQ.position.set(-0.19, 0.1, -0.34);
  group.add(throttleQ);
  const tLever = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.07, 0.012), frameMat);
  tLever.position.y = 0.035;
  const tGrip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.022, 0.04), seatMat);
  tGrip.position.y = 0.075;
  throttleQ.add(tLever, tGrip);

  // centre stick between the knees, leaning with your inputs
  const stick = new THREE.Group();
  stick.position.set(0, floorY, -0.56);
  group.add(stick);
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 0.05, 12), seatMat);
  boot.position.y = 0.025;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.01, 0.26, 8), frameMat);
  shaft.position.y = 0.16;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.014, 0.065, 10), seatMat);
  grip.position.set(0, 0.31, 0.004);
  grip.rotation.x = 0.15;
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.012, 0.01), btnMats[1]);
  trigger.position.set(0, 0.3, -0.016);
  const hat = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3040).multiplyScalar(2) }));
  hat.position.set(0, 0.345, 0.004);
  stick.add(boot, shaft, grip, trigger, hat);

  // --- glass: the same ellipsoid as the outside, seen from within ---
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(1, 40, 24),
    new THREE.ShaderMaterial({
      vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vL;
        void main(){ vL = position; vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV; varying vec3 vL;
        void main(){
          if (vL.y < -0.3) discard;   // the glass stops at the rim; below it is the tub
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
          float streak = smoothstep(0.06, 0.0, abs(vL.x * 0.9 + vL.y * 0.7 - 0.55)) * step(-0.2, vL.z);
          float a = 0.08 + f * 0.5 + streak * 0.12;
          gl_FragColor = vec4(mix(vec3(0.03, 0.4, 0.55), vec3(0.5, 0.9, 1.0), f), a);
        }`,
      transparent: true, depthWrite: false, side: THREE.BackSide,
    }),
  );
  glass.position.copy(CANOPY_C);
  glass.scale.copy(CANOPY_R);
  glass.renderOrder = 2;
  group.add(glass);

  // --- instruments: a slim panel just above the hull, below the nose sightline ---
  const mount = (m, x, y, z) => {
    m.position.set(x, y, z);
    m.lookAt(EYE);
    group.add(m);
    return m;
  };
  const panel = mount(new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.078, 0.02), dashMat), 0, 0.212, -0.655);
  panel.translateZ(-0.012);
  // the panel's housing runs down to the tub floor (the front of the leg well)
  const housing = new THREE.Mesh(new THREE.BoxGeometry(0.33, 0.29, 0.05), dashMat);
  housing.position.set(0, 0.03, -0.7);
  group.add(housing);
  const lip = mount(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.0025, 0.0025), trimMat), 0, 0.2515, -0.66);
  lip.translateZ(-0.004);
  const left = screen(0.088, 0.06), mid = screen(0.088, 0.06), right = screen(0.088, 0.06);
  mount(left.mesh, -0.1, 0.215, -0.64);
  mount(mid.mesh, 0, 0.215, -0.645);
  mount(right.mesh, 0.1, 0.215, -0.64);
  // warning lamp in the top edge of the panel
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3040).multiplyScalar(3) });
  mount(new THREE.Mesh(new THREE.CircleGeometry(0.004, 16), lampMat), 0, 0.2475, -0.648);

  for (const o of group.children) if (o !== hole && o.renderOrder === 0) o.renderOrder = 2;
  glass.renderOrder = 3;
  return { group, screens: { left, mid, right }, lampMat, stick, throttleQ, t: 0, blink: 0 };
}

// --- screen drawing ---
function bg(s, title, color = CYAN) {
  const g = s.g;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(4, 16, 26, 0.92)';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = color; g.globalAlpha = 0.5; g.lineWidth = 3;
  g.strokeRect(3, 3, W - 6, H - 6);
  g.globalAlpha = 1;
  g.fillStyle = color;
  g.font = 'bold 15px monospace';
  g.textBaseline = 'top';
  g.fillText(title, 12, 10);
  return g;
}
function bar(g, y, label, frac, color) {
  g.fillStyle = color; g.font = 'bold 14px monospace';
  g.fillText(label, 12, y);
  g.globalAlpha = 0.25; g.fillRect(70, y + 2, W - 84, 12);
  g.globalAlpha = 1; g.fillRect(70, y + 2, (W - 84) * Math.max(0, Math.min(1, frac)), 12);
}

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
/** Redraw the instrument screens (call at ~10 Hz). info: player, enemies, missiles, speed, alt, warp */
export function drawCockpit(cp, info) {
  const { player } = info;
  // left: ship status
  let g = bg(cp.screens.left, 'SHIP STATUS');
  const hullF = player.hull / player.maxHull;
  bar(g, 40, 'SHLD', player.shield / player.maxShield, CYAN);
  bar(g, 68, 'HULL', hullF, hullF < 0.3 ? RED : hullF < 0.6 ? AMBER : CYAN);
  bar(g, 96, 'HEAT', player.heat, player.overheated ? RED : player.heat > 0.7 ? AMBER : CYAN);
  g.fillStyle = CYAN; g.font = 'bold 14px monospace';
  g.fillText('MSL', 12, 128);
  for (let i = 0; i < info.missiles.capacity; i++) {
    g.globalAlpha = i < info.missiles.ammo ? 1 : 0.22;
    g.fillStyle = AMBER;
    g.fillRect(70 + i * 22, 130, 16, 12);
  }
  g.globalAlpha = 1;
  cp.screens.left.tex.needsUpdate = true;

  // centre: flight
  g = bg(cp.screens.mid, 'FLIGHT');
  g.fillStyle = '#e8fbff'; g.font = 'bold 44px monospace'; g.textAlign = 'center';
  g.fillText(info.speed.toFixed(0), W / 2, 36);
  g.font = 'bold 13px monospace'; g.fillStyle = CYAN;
  g.fillText('M/S', W / 2, 84);
  g.fillText(`ALT ${info.alt.toFixed(0)} m${info.warp > 1 ? `  ·  WARP ${info.warp}×` : ''}`, W / 2, 104);
  g.textAlign = 'left';
  g.globalAlpha = 0.25; g.fillRect(20, 134, W - 40, 16);
  g.globalAlpha = 1; g.fillStyle = player.throttle > 0.95 ? AMBER : CYAN;
  g.fillRect(20, 134, (W - 40) * player.throttle, 16);
  cp.screens.mid.tex.needsUpdate = true;

  // right: a top-down scope of contacts in the ship's frame
  g = bg(cp.screens.right, 'SCOPE  2 km');
  const cx = W / 2, cy = 98, R = 68;
  g.strokeStyle = CYAN; g.globalAlpha = 0.35; g.lineWidth = 1.5;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(cx, cy, R / 2, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
  g.globalAlpha = 1;
  _q.copy(player.quat).invert();
  for (const e of info.enemies) {
    if (!e.alive) continue;
    _v.copy(e.pos).sub(player.pos).applyQuaternion(_q);
    const d = Math.hypot(_v.x, _v.z);
    if (d > 2000) continue;
    const k = R / 2000;
    g.fillStyle = _v.y > 0 ? RED : '#ff8a96';
    g.beginPath(); g.arc(cx + _v.x * k, cy + _v.z * k, e.def && e.def.boss ? 5 : 3, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = CYAN;
  g.beginPath(); g.moveTo(cx, cy - 6); g.lineTo(cx - 4, cy + 4); g.lineTo(cx + 4, cy + 4); g.fill();
  cp.screens.right.tex.needsUpdate = true;
}

/** Stick leans with pitch/yaw input; the throttle slides with thrust. */
export function updateCockpitControls(cp, dt, yawRate, pitchRate, throttle) {
  const k = 1 - Math.exp(-dt * 12);
  cp.stick.rotation.z = THREE.MathUtils.lerp(cp.stick.rotation.z, THREE.MathUtils.clamp(-yawRate * 0.12, -0.35, 0.35), k);
  cp.stick.rotation.x = THREE.MathUtils.lerp(cp.stick.rotation.x, THREE.MathUtils.clamp(-pitchRate * 0.12, -0.3, 0.3), k);
  cp.throttleQ.rotation.x = THREE.MathUtils.lerp(cp.throttleQ.rotation.x, (0.5 - throttle) * 1.1, k);
}

/** Warning lamp: blinks while hull is low or you're under fire. */
export function updateCockpitLamp(cp, dt, warn) {
  cp.blink += dt;
  const on = warn && (cp.blink % 0.6) < 0.3;
  cp.lampMat.color.setHex(on ? 0xff3040 : 0x401014).multiplyScalar(on ? 3 : 1);
}
