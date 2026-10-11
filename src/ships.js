import * as THREE from 'three';

// Procedurally modelled ships. Forward is -Z for every ship.

let glowTexture = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.2, 'rgba(255,255,255,0.65)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

function hdr(hex, intensity) {
  return new THREE.Color(hex).multiplyScalar(intensity);
}

// ---------------------------------------------------------------------------
// Engine flame: an additive cone whose length tracks throttle.
// ---------------------------------------------------------------------------
const flameGeo = (() => {
  const g = new THREE.ConeGeometry(1, 1, 18, 1, true);
  g.rotateX(Math.PI / 2);   // apex -> +Z
  g.translate(0, 0, 0.5);   // base at z = 0, tip at z = 1
  g.userData.shared = true;
  return g;
})();

export function makeFlameMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: 1 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */`
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        vT = position.z;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uIntensity; uniform float uTime;
      varying float vT; varying vec3 vN; varying vec3 vV;
      void main() {
        float rim = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.5);
        float a = pow(clamp(1.0 - vT, 0.0, 1.0), 1.4) * rim;
        float flick = 0.85 + 0.15 * sin(uTime * 70.0 + vT * 18.0);
        vec3 col = mix(vec3(1.0, 0.95, 0.9) * 2.5, uColor, smoothstep(0.0, 0.45, vT));
        gl_FragColor = vec4(col * a * uIntensity * flick, 1.0);
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function addFlame(group, x, y, z, radius, color, list) {
  const mat = makeFlameMaterial(color);
  const m = new THREE.Mesh(flameGeo, mat);
  m.position.set(x, y, z);
  m.scale.set(radius, radius, 1);
  m.userData.radius = radius;
  group.add(m);
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: hdr(color, 2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  glow.position.set(x, y, z + 0.1);
  glow.scale.setScalar(radius * 5);
  group.add(glow);
  list.push({ flame: m, glow, mat });
}

// ---------------------------------------------------------------------------
// Player: twin-engine interceptor
// ---------------------------------------------------------------------------
export function buildPlayerShip() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);

  const hull = new THREE.MeshStandardMaterial({ color: 0xd4dce8, metalness: 0.7, roughness: 0.3, envMapIntensity: 1.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x252c3a, metalness: 0.8, roughness: 0.4, envMapIntensity: 1.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x061624, metalness: 1, roughness: 0.05, emissive: 0x0b6a8a, emissiveIntensity: 0.9 });
  const accent = new THREE.MeshBasicMaterial({ color: hdr(0x5ef2ff, 3.2) });
  const accentWarm = new THREE.MeshBasicMaterial({ color: hdr(0xffa040, 2.5) });
  const ringMat = new THREE.MeshBasicMaterial({ color: hdr(0x5ef2ff, 1.1) });

  // fuselage
  const fus = new THREE.CylinderGeometry(0.12, 0.62, 4.2, 8);
  fus.rotateX(-Math.PI / 2);
  fus.scale(1, 0.55, 1);
  const fuselage = new THREE.Mesh(fus, hull);
  fuselage.position.z = -0.2;
  model.add(fuselage);

  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.28, 2.2), dark);
  spine.position.set(0, 0.22, 0.9);
  model.add(spine);

  // canopy
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), glass);
  canopy.scale.set(0.3, 0.22, 0.85);
  canopy.position.set(0, 0.27, -0.45);
  model.add(canopy);

  // swept wings
  const ws = new THREE.Shape();
  ws.moveTo(0.25, -0.5);
  ws.lineTo(2.55, 0.95);
  ws.lineTo(2.7, 1.55);
  ws.lineTo(0.35, 1.7);
  ws.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(ws, { depth: 0.1, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.04, bevelSegments: 1 });
  wingGeo.rotateX(Math.PI / 2);
  wingGeo.translate(0, 0.05, 0);
  for (const s of [1, -1]) {
    const w = new THREE.Mesh(wingGeo, hull);
    w.scale.x = s;
    w.rotation.z = s * -0.06;
    model.add(w);
    // wing stripe
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.9), accent);
    stripe.position.set(s * 2.62, 0.02, 1.15);
    model.add(stripe);
    // leading-edge glow
    const le = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 2.6), accent);
    le.position.set(s * 1.38, 0.0, 0.22);
    le.rotation.y = s * 1.0;
    model.add(le);
    // gun barrel
    const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.5, 8).rotateX(Math.PI / 2), dark);
    gun.position.set(s * 2.0, -0.08, -0.15);
    model.add(gun);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.12, 8).rotateX(Math.PI / 2), accentWarm);
    tip.position.set(s * 2.0, -0.08, -0.9);
    model.add(tip);
    // tail fin
    const fs = new THREE.Shape();
    fs.moveTo(0, 0); fs.lineTo(0.9, 0.0); fs.lineTo(1.25, 0.85); fs.lineTo(0.85, 0.85); fs.closePath();
    const fg = new THREE.ExtrudeGeometry(fs, { depth: 0.06, bevelEnabled: false });
    fg.rotateY(-Math.PI / 2);
    const fin = new THREE.Mesh(fg, dark);
    fin.position.set(s * 0.42, 0.2, 1.0);
    fin.rotation.z = s * -0.35;
    model.add(fin);
  }

  // engines
  const flames = [];
  const engGeo = new THREE.CylinderGeometry(0.3, 0.36, 1.2, 14).rotateX(Math.PI / 2);
  for (const s of [1, -1]) {
    const e = new THREE.Mesh(engGeo, dark);
    e.position.set(s * 0.52, 0, 1.75);
    model.add(e);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.3, 0.035, 6, 18), ringMat);
    ring.position.set(s * 0.52, 0, 2.36);
    model.add(ring);
    addFlame(model, s * 0.52, 0, 2.38, 0.26, 0x3fb8ff, flames);
  }

  // nav lights
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(0xff2030, 4) }));
  navL.position.set(-2.72, 0.02, 1.55);
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(0x20ff60, 4) }));
  navR.position.set(2.72, 0.02, 1.55);
  model.add(navL, navR);

  return {
    group, model, flames, navLights: [navL, navR],
    muzzles: [new THREE.Vector3(2.0, -0.08, -1.0), new THREE.Vector3(-2.0, -0.08, -1.0)],
    engines: [new THREE.Vector3(0.52, 0, 2.4), new THREE.Vector3(-0.52, 0, 2.4)],
  };
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------
function enemyMaterials(baseHex, glowHex) {
  const hull = new THREE.MeshStandardMaterial({ color: baseHex, metalness: 0.45, roughness: 0.4, flatShading: true, envMapIntensity: 1.6 });
  hull.userData.baseEmissive = new THREE.Color(glowHex).multiplyScalar(0.07);
  const dark = new THREE.MeshStandardMaterial({ color: 0x3a3a46, metalness: 0.6, roughness: 0.45, flatShading: true, envMapIntensity: 1.4 });
  dark.userData.baseEmissive = new THREE.Color(glowHex).multiplyScalar(0.03);
  return { hull, dark, glow: new THREE.MeshBasicMaterial({ color: hdr(glowHex, 4) }) };
}

export function buildRaider() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0xa0383f, 0xff2a3c);

  const body = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), m.hull);
  body.scale.set(1.0, 0.7, 1.45);
  model.add(body);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), m.glow);
  eye.position.set(0, 0.05, -1.3);
  model.add(eye);

  const bs = new THREE.Shape();
  bs.moveTo(0, 0.2);
  bs.lineTo(2.5, -1.4);
  bs.lineTo(2.75, -0.7);
  bs.lineTo(0.7, 0.9);
  bs.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(bs, { depth: 0.1, bevelEnabled: false });
  bladeGeo.rotateX(Math.PI / 2);
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      const b = new THREE.Mesh(bladeGeo, m.dark);
      b.scale.x = sx;
      b.rotation.z = sx * sy * 0.42;
      b.position.y = sy * 0.12;
      model.add(b);
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 1.0), m.glow);
      const tip = new THREE.Vector3(sx * 2.6, 0, -1.05);
      tip.applyAxisAngle(new THREE.Vector3(0, 0, 1), sx * sy * 0.42);
      edge.position.copy(tip).add(new THREE.Vector3(0, sy * 0.12, 0.4));
      model.add(edge);
    }
  }
  const flames = [];
  addFlame(model, 0, 0, 1.35, 0.32, 0xff4a2a, flames);
  model.scale.setScalar(1.4);

  return { group, model, flames, mats: [m.hull, m.dark], radius: 3.4, muzzles: [new THREE.Vector3(0, 0, -2.2)] };
}

export function buildWarden() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x6a3a8a, 0xff4cf2);

  const body = new THREE.Mesh(new THREE.OctahedronGeometry(1.8, 0), m.hull);
  body.scale.set(1.0, 0.75, 1.5);
  model.add(body);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 10), m.glow);
  core.position.z = -2.2;
  model.add(core);

  const ringPivot = new THREE.Group();
  model.add(ringPivot);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.16, 8, 48), m.glow);
  ringPivot.add(ring);
  const ringBody = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.34, 6, 6), m.dark);
  ringPivot.add(ringBody);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const pod = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 1.6), m.hull);
    pod.position.set(Math.cos(a) * 3.0, Math.sin(a) * 3.0, 0);
    ringPivot.add(pod);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 3.0), m.dark);
    strut.position.set(Math.cos(a) * 1.5, Math.sin(a) * 1.5, 0);
    strut.lookAt(0, 0, 0);
    model.add(strut);
  }
  const flames = [];
  addFlame(model, 0, 0, 2.6, 0.5, 0xc040ff, flames);
  model.scale.setScalar(1.3);

  return { group, model, flames, mats: [m.hull, m.dark], radius: 4.6, ringPivot, muzzles: [new THREE.Vector3(0, 0, -2.6)] };
}

export function buildSeeker() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x8a6a2a, 0xffc23a);

  const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.82, 1), m.glow);
  model.add(core);
  const shell = new THREE.Mesh(new THREE.DodecahedronGeometry(0.88, 0), m.hull);
  model.add(shell);
  const spikeGeo = new THREE.ConeGeometry(0.18, 1.3, 5);
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [0.7, 0.7, 0], [-0.7, 0.7, 0], [0.7, -0.7, 0], [-0.7, -0.7, 0]];
  for (const d of dirs) {
    const s = new THREE.Mesh(spikeGeo, m.dark);
    const v = new THREE.Vector3(...d).normalize();
    s.position.copy(v).multiplyScalar(1.15);
    s.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    model.add(s);
  }
  const flames = [];
  addFlame(model, 0, 0, 1.0, 0.3, 0xffa020, flames);
  model.scale.setScalar(1.35);
  return { group, model, flames, mats: [m.hull, m.dark], radius: 2.8, core, muzzles: [] };
}

// ---------------------------------------------------------------------------
// Player missile
// ---------------------------------------------------------------------------
export function buildMissile() {
  const group = new THREE.Group();
  const body = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 0.6, roughness: 0.35, envMapIntensity: 1.4 });
  const band = new THREE.MeshBasicMaterial({ color: hdr(0xff8030, 3) });
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.5, 10).rotateX(Math.PI / 2), body);
  group.add(tube);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.45, 10).rotateX(-Math.PI / 2), body);
  nose.position.z = -0.97;
  group.add(nose);
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.08, 10).rotateX(Math.PI / 2), band);
  ring.position.z = -0.55;
  group.add(ring);
  const finGeo = new THREE.BoxGeometry(0.02, 0.36, 0.3);
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(finGeo, body);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    f.position.set(Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.6);
    f.rotation.z = a - Math.PI / 2;
    group.add(f);
  }
  const flames = [];
  addFlame(group, 0, 0, 0.76, 0.16, 0xffa040, flames);
  group.scale.setScalar(1.3);
  return { group, flame: flames[0] };
}
