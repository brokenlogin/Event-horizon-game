import * as THREE from 'three';

// ---------------------------------------------------------------------------
// First-person cockpit: canopy frame, dashboard with live screens, faint glass.
// Built around the pilot's eye at the origin (forward -Z) and parented to the
// ship group at EYE, so it moves with the ship while the head sways inside it.
// ---------------------------------------------------------------------------

export const EYE = new THREE.Vector3(0, 0.5, -0.35);

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

function tube(points, radius, mat) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.Mesh(new THREE.TubeGeometry(curve, points.length * 10, radius, 6, false), mat);
}

export function buildCockpit() {
  const group = new THREE.Group();
  group.position.copy(EYE);
  group.visible = false;

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b2330, metalness: 0.7, roughness: 0.4 });
  const dashMat = new THREE.MeshStandardMaterial({ color: 0x0d131b, metalness: 0.3, roughness: 0.75 });
  const trimMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x5ef2ff).multiplyScalar(1.1) });

  // --- dashboard: a panel tilted toward the pilot, a hood over it, side consoles ---
  const tilt = 0.76;
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.3), dashMat);
  panel.position.set(0, -0.355, -0.54);
  panel.rotation.x = -tilt;
  group.add(panel);
  const hood = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.035, 0.16), frameMat);
  hood.position.set(0, -0.235, -0.71);
  group.add(hood);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.004, 0.004), trimMat);
  lip.position.set(0, -0.25, -0.63);
  group.add(lip);
  for (const s of [-1, 1]) {
    const con = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.9), dashMat);
    con.position.set(s * 0.66, -0.48, -0.22);
    group.add(con);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.004, 0.8), trimMat);
    rail.position.set(s * 0.535, -0.33, -0.22);
    group.add(rail);
  }

  // screens sit just proud of the panel
  const onPanel = (m, x, y) => {
    const n = new THREE.Vector3(0, Math.sin(tilt), Math.cos(tilt));
    const up = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
    m.position.copy(panel.position).addScaledVector(up, y).addScaledVector(n, 0.004);
    m.position.x = x;
    m.rotation.x = -tilt;
    group.add(m);
  };
  const left = screen(0.2, 0.1375), mid = screen(0.18, 0.124), right = screen(0.2, 0.1375);
  onPanel(left.mesh, -0.25, 0.05);
  onPanel(mid.mesh, 0, 0.055);
  onPanel(right.mesh, 0.25, 0.05);
  // warning lamp between the screens
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff3040).multiplyScalar(3) });
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.012, 16), lampMat);
  onPanel(lamp, 0, -0.03);

  // --- canopy frame: a window outline, struts out to the corners, side rails, spine ---
  const frame = [
    tube([[-0.72, -0.23, -0.69], [-0.66, 0.1, -0.6], [-0.48, 0.34, -0.52], [0, 0.41, -0.5], [0.48, 0.34, -0.52], [0.66, 0.1, -0.6], [0.72, -0.23, -0.69]], 0.022, frameMat),
    tube([[-0.48, 0.34, -0.52], [-0.54, 0.52, -0.34], [-0.56, 0.62, -0.1]], 0.02, frameMat),
    tube([[0.48, 0.34, -0.52], [0.54, 0.52, -0.34], [0.56, 0.62, -0.1]], 0.02, frameMat),
    tube([[-0.72, -0.23, -0.69], [-0.76, -0.22, -0.2], [-0.78, -0.2, 0.2]], 0.02, frameMat),
    tube([[0.72, -0.23, -0.69], [0.76, -0.22, -0.2], [0.78, -0.2, 0.2]], 0.02, frameMat),
    tube([[-0.66, 0.1, -0.6], [-0.78, 0.2, -0.25], [-0.8, 0.24, 0.15]], 0.016, frameMat),
    tube([[0.66, 0.1, -0.6], [0.78, 0.2, -0.25], [0.8, 0.24, 0.15]], 0.016, frameMat),
    tube([[0, 0.41, -0.5], [0, 0.57, -0.2], [0, 0.62, 0.15]], 0.024, frameMat),
  ];
  for (const f of frame) group.add(f);

  // --- glass: barely there, with a glow reflected off the dash low down ---
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(1.05, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.62),
    new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying vec3 vP; uniform float uTime;
        void main(){
          vec3 d = normalize(vP);
          float low = smoothstep(0.25, -0.05, d.y) * smoothstep(0.2, -0.6, d.z);
          float streak = smoothstep(0.035, 0.0, abs(d.x * 0.8 + d.y - 0.55)) * 0.5;
          float a = low * 0.05 + streak * 0.03;
          gl_FragColor = vec4(vec3(0.35, 0.85, 1.0) * a, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    }),
  );
  glass.position.set(0, -0.15, 0);
  glass.renderOrder = 2;
  group.add(glass);

  return { group, screens: { left, mid, right }, lampMat, t: 0, blink: 0 };
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

/** Warning lamp: blinks while hull is low or you're under fire. */
export function updateCockpitLamp(cp, dt, warn) {
  cp.blink += dt;
  const on = warn && (cp.blink % 0.6) < 0.3;
  cp.lampMat.color.setHex(on ? 0xff3040 : 0x401014).multiplyScalar(on ? 3 : 1);
}
