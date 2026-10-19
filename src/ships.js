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

// ---------------------------------------------------------------------------
// Geometry sharing. Every ship of one kind is built the same way, so after the
// first build of `key` each later build swaps its fresh geometry for the
// first one's, part for part. The fresh copies never reach the graphics card,
// so a spawn uploads nothing, and nothing is freed when a ship goes away.
// ---------------------------------------------------------------------------
const geoCache = new Map();
export function shareGeometry(key, root) {
  const list = [];
  root.traverse((o) => { if ((o.isMesh || o.isLine || o.isPoints) && !o.isInstancedMesh) list.push(o); });
  const cached = geoCache.get(key);
  if (!cached || cached.length !== list.length) {
    for (const o of list) o.geometry.userData.shared = true;
    geoCache.set(key, list.map((o) => o.geometry));
    return;
  }
  list.forEach((o, i) => {
    if (o.geometry === cached[i]) return;
    if (!o.geometry.userData.shared) o.geometry.dispose();
    o.geometry = cached[i];
  });
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
export function buildPlayerShip({ accentColor = 0x5ef2ff, flameColor = 0x3fb8ff } = {}) {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);

  const hull = new THREE.MeshStandardMaterial({ color: 0xd4dce8, metalness: 0.7, roughness: 0.3, envMapIntensity: 1.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x252c3a, metalness: 0.8, roughness: 0.4, envMapIntensity: 1.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x061624, metalness: 1, roughness: 0.05, emissive: 0x0b6a8a, emissiveIntensity: 0.9 });
  const accent = new THREE.MeshBasicMaterial({ color: hdr(accentColor, 3.2) });
  const accentWarm = new THREE.MeshBasicMaterial({ color: hdr(0xffa040, 2.5) });
  const ringMat = new THREE.MeshBasicMaterial({ color: hdr(accentColor, 1.1) });

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
    addFlame(model, s * 0.52, 0, 2.38, 0.26, flameColor, flames);
  }

  const cockpitHide = [canopy];   // parts the first-person camera would be inside or against
  // --- MK2 refit (shown once bought): wingtip nacelles, gold trim, dorsal fin, canards ---
  const mk2 = new THREE.Group();
  mk2.visible = false;
  model.add(mk2);
  const gold = new THREE.MeshBasicMaterial({ color: hdr(0xffc860, 2.6) });
  const zCyl = (rt, rb, len, seg, mat) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg).rotateX(Math.PI / 2), mat);
  for (const s of [1, -1]) {
    const nac = zCyl(0.14, 0.2, 1.7, 12, dark);
    nac.position.set(s * 2.5, -0.04, 1.0);
    mk2.add(nac);
    const cowl = zCyl(0.16, 0.16, 0.5, 12, hull);
    cowl.position.set(s * 2.5, -0.04, 0.35);
    mk2.add(cowl);
    // intake at the front of the cowl: a gold lip, a dark throat and a shock cone spiking forward
    const lip = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.022, 6, 18), gold);
    lip.position.set(s * 2.5, -0.04, 0.1);
    mk2.add(lip);
    const throat = new THREE.Mesh(new THREE.CircleGeometry(0.14, 18), dark);
    throat.rotation.y = Math.PI;   // faces forward (-Z)
    throat.position.set(s * 2.5, -0.04, 0.095);
    mk2.add(throat);
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 14).rotateX(-Math.PI / 2), hull);
    spike.position.set(s * 2.5, -0.04, 0.13 - 0.25);
    mk2.add(spike);
    const nring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.025, 6, 16), gold);
    nring.position.set(s * 2.5, -0.04, 1.86);
    mk2.add(nring);
    addFlame(mk2, s * 2.5, -0.04, 1.88, 0.15, flameColor, flames);
    // trim strip laid along the fuselage's skin: the hull is a cone (radius 0.12 at the
    // nose, z −2.3, to 0.62 at z 1.9) squashed to 0.55 high, so a line at a fixed angle
    // round it is straight
    const hullAt = (z, phi, out) => {
      const r = 0.12 + 0.5 * (z + 2.3) / 4.2 + 0.012;   // just proud of the skin
      return out.set(s * r * Math.sin(phi), 0.55 * r * Math.cos(phi), z);
    };
    const tA = hullAt(-1.45, 0.82, new THREE.Vector3()), tB = hullAt(0.85, 0.82, new THREE.Vector3());
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.03, 1), gold);
    trim.position.copy(tA).add(tB).multiplyScalar(0.5);
    trim.scale.z = tA.distanceTo(tB);
    trim.lookAt(tB);   // (the group has no transform yet, so this is the local direction)
    mk2.add(trim);
    cockpitHide.push(trim);   // runs right beside the canopy: a glare strip from inside
    const canard = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.04, 0.32), hull);
    canard.position.set(s * 0.55, 0.02, -1.55);
    canard.rotation.y = s * 0.35;
    mk2.add(canard);
    const cTip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, 0.3), gold);
    cTip.position.set(s * 0.9, 0.02, -1.42);
    cTip.rotation.y = s * 0.35;
    mk2.add(cTip);
  }
  const dorsal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.55, 1.1), dark);
  dorsal.position.set(0, 0.55, 1.35);
  dorsal.rotation.x = 0.35;
  mk2.add(dorsal);
  const dorsalEdge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 1.1), gold);
  dorsalEdge.position.set(0, 0.83, 1.45);
  dorsalEdge.rotation.x = 0.35;
  mk2.add(dorsalEdge);

  // --- railgun (shown once researched): a long barrel slung under the nose ---
  const rail = new THREE.Group();
  rail.visible = false;
  model.add(rail);
  const barrel = zCyl(0.08, 0.1, 3.4, 10, dark);
  barrel.position.set(0, -0.32, -1.3);
  rail.add(barrel);
  for (let i = 0; i < 4; i++) {
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 6, 14), accent);
    coil.position.set(0, -0.32, -0.3 - i * 0.55);
    rail.add(coil);
  }
  const railTip = zCyl(0.11, 0.11, 0.12, 10, accent);
  railTip.position.set(0, -0.32, -3.0);
  rail.add(railTip);

  // --- missile pylons under the wings: one per missile you can carry, filled from the inside out ---
  const pylons = [];
  const pylonGeo = new THREE.BoxGeometry(0.06, 0.16, 0.9);
  const mBody = new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 0.6, roughness: 0.35, envMapIntensity: 1.4 });
  const mBand = new THREE.MeshBasicMaterial({ color: hdr(0xff8030, 3) });
  const mTube = new THREE.CylinderGeometry(0.1, 0.1, 1.25, 8).rotateX(Math.PI / 2);
  const mNose = new THREE.ConeGeometry(0.1, 0.34, 8).rotateX(-Math.PI / 2);
  const mRing = new THREE.CylinderGeometry(0.104, 0.104, 0.06, 8).rotateX(Math.PI / 2);
  const mFin = new THREE.BoxGeometry(0.02, 0.26, 0.22);
  // six under the wings (inside the guns and the MK2's wingtip engines), then the belly:
  // one on the centreline, or a side-by-side pair when the rack holds eight (see setLoadout)
  const makePylon = (x, y, z) => {
    const pylon = new THREE.Group();
    pylon.position.set(x, y, z);
    model.add(pylon);
    const rail = new THREE.Mesh(pylonGeo, dark);
    rail.position.y = -0.08;
    pylon.add(rail);
    const missile = new THREE.Group();
    missile.position.y = -0.27;
    missile.add(new THREE.Mesh(mTube, mBody));
    const nose = new THREE.Mesh(mNose, mBody);
    nose.position.z = -0.79;
    missile.add(nose);
    const band = new THREE.Mesh(mRing, mBand);
    band.position.z = -0.45;
    missile.add(band);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(mFin, mBody);
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      fin.position.set(Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0.5);
      fin.rotation.z = a - Math.PI / 2;
      missile.add(fin);
    }
    pylon.add(missile);
    pylon.visible = false;
    return { pylon, missile, local: new THREE.Vector3(x, y - 0.27, z) };
  };
  for (const ax of [0.82, 1.22, 1.62]) {
    for (const s of [1, -1]) {
      const zMid = -0.5 + 0.63 * (ax - 0.25) + 0.75;   // a little behind the leading edge
      pylons.push(makePylon(s * ax, -0.04, zMid));
    }
  }
  // belly: behind the railgun's barrel, clear below the engines
  const belly = { centre: makePylon(0, -0.26, 0.95), right: makePylon(0.2, -0.26, 0.95), left: makePylon(-0.2, -0.26, 0.95) };

  // nav lights
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(0xff2030, 4) }));
  navL.position.set(-2.72, 0.02, 1.55);
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(0x20ff60, 4) }));
  navR.position.set(2.72, 0.02, 1.55);
  model.add(navL, navR);

  return {
    group, model, flames, navLights: [navL, navR], mk2, rail, pylons, belly, activePylons: pylons.concat(belly.centre), cockpitHide,
    railMuzzle: new THREE.Vector3(0, -0.32, -3.1),
    muzzles: [new THREE.Vector3(2.0, -0.08, -1.0), new THREE.Vector3(-2.0, -0.08, -1.0)],
    engines: [new THREE.Vector3(0.52, 0, 2.4), new THREE.Vector3(-0.52, 0, 2.4)],
  };
}

/** Show a pylon for each missile the ship can carry and a missile on each loaded one. */
export function setLoadout(parts, capacity, ammo) {
  // the seventh hangs on the centreline; with eight, the last two share the belly side by side
  const pair = capacity >= 8;
  const list = parts.activePylons;
  list.length = parts.pylons.length;
  if (pair) list.push(parts.belly.right, parts.belly.left);
  else list.push(parts.belly.centre);
  for (const p of [...parts.pylons, parts.belly.centre, parts.belly.right, parts.belly.left]) {
    const i = list.indexOf(p);
    const show = i >= 0 && i < capacity;
    if (p.pylon.visible !== show) p.pylon.visible = show;
    const loaded = show && i < ammo;
    if (p.missile.visible !== loaded) p.missile.visible = loaded;
  }
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

export function buildSeeker(hullHex = 0x8a6a2a, glowHex = 0xffc23a, flameHex = 0xffa020) {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(hullHex, glowHex);

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
  addFlame(model, 0, 0, 1.0, 0.3, flameHex, flames);
  model.scale.setScalar(1.35);
  return { group, model, flames, mats: [m.hull, m.dark], radius: 2.8, core, muzzles: [] };
}

/** Seeker MK2 (wave 14+): the same drone in a lighter yellow. */
export const buildSeeker2 = () => buildSeeker(0xa8984a, 0xffeb7a, 0xffe050);

// ---------------------------------------------------------------------------
// Lancer: a long-range beam sniper. Twin prongs frame the emitter; a thin aim
// line (the telegraph) shows where it's pointing while it charges.
// ---------------------------------------------------------------------------
export function buildLancer() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x2f5a4c, 0x3dff8a);
  const zCyl = (rt, rb, len, seg, mat) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg).rotateX(Math.PI / 2), mat);

  const spine = zCyl(0.35, 0.75, 6.5, 6, m.hull);
  spine.position.z = 0.6;
  model.add(spine);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.6, 6).rotateX(-Math.PI / 2), m.dark);
  nose.position.z = -3.4;
  model.add(nose);
  const collar = zCyl(1.0, 1.0, 1.2, 6, m.dark);
  collar.position.z = 1.4;
  model.add(collar);
  // twin prongs reaching forward past the nose
  for (const sx of [1, -1]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 3.6), m.dark);
    arm.position.set(sx * 1.05, 0, -1.4);
    arm.rotation.y = sx * -0.12;
    model.add(arm);
    const prong = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 2.6), m.hull);
    prong.position.set(sx * 0.72, 0, -4.1);
    model.add(prong);
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.24, 0.3), m.glow);
    tip.position.set(sx * 0.72, 0, -5.45);
    model.add(tip);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.6, 1.4), m.dark);
    fin.position.set(sx * 0.5, sx * 0.4, 2.6);
    fin.rotation.z = sx * 0.6;
    model.add(fin);
  }
  // the emitter between the prongs glows up as it charges
  const emitterMat = new THREE.MeshBasicMaterial({ color: hdr(0x3dff8a, 2) });
  const emitter = new THREE.Mesh(new THREE.SphereGeometry(0.32, 12, 8), emitterMat);
  emitter.position.z = -4.6;
  model.add(emitter);
  const emitterGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: hdr(0x3dff8a, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  emitterGlow.position.z = -4.6;
  emitterGlow.scale.setScalar(4);
  model.add(emitterGlow);
  const flames = [];
  addFlame(model, 0, 0, 3.9, 0.36, 0x3dff8a, flames);
  model.scale.setScalar(1.25);

  // aim line, in the unscaled group so its length is in metres
  const telegraphGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const telegraph = new THREE.Mesh(telegraphGeo, new THREE.MeshBasicMaterial({
    color: hdr(0x3dff8a, 2.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  telegraph.position.z = -5.8;
  telegraph.scale.set(1, 1, 1400);
  telegraph.visible = false;
  telegraph.frustumCulled = false;
  group.add(telegraph);

  return { group, model, flames, mats: [m.hull, m.dark], radius: 3.6, emitter, emitterGlow, telegraph, muzzles: [new THREE.Vector3(0, 0, -5.8)] };
}

// ---------------------------------------------------------------------------
// Sower: a slow, armoured mine-layer. A broad saucer with a ring of mine pods
// and a dispenser chute at the back.
// ---------------------------------------------------------------------------
export function buildSower() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x6a4a2a, 0xff8a2a);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.2, 1.3, 8), m.hull);
  model.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.dark);
  dome.position.y = 0.6;
  model.add(dome);
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), m.glow);
  eye.position.set(0, 0.7, -1.4);
  model.add(eye);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(3.1, 0.12, 6, 32).rotateX(Math.PI / 2), m.glow);
  model.add(rim);
  const ringPivot = new THREE.Group();
  model.add(ringPivot);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const pod = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 0), m.dark);
    pod.position.set(Math.cos(a) * 2.5, -0.75, Math.sin(a) * 2.5);
    ringPivot.add(pod);
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), m.glow);
    light.position.set(Math.cos(a) * 2.5, -0.2, Math.sin(a) * 2.5);
    ringPivot.add(light);
  }
  const chute = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.8), m.dark);
  chute.position.set(0, -0.3, 2.9);
  model.add(chute);
  const flames = [];
  addFlame(model, -1.2, 0, 3.0, 0.38, 0xff7a2a, flames);
  addFlame(model, 1.2, 0, 3.0, 0.38, 0xff7a2a, flames);
  model.scale.setScalar(1.25);
  return { group, model, flames, mats: [m.hull, m.dark], radius: 4.4, ringPivot, muzzles: [] };
}

// ---------------------------------------------------------------------------
// Proximity mine: a spiked ball with a warning light.
// ---------------------------------------------------------------------------
const mineCore = new THREE.IcosahedronGeometry(1.0, 0);
const mineSpike = new THREE.ConeGeometry(0.22, 1.0, 5);
mineCore.userData.shared = mineSpike.userData.shared = true;   // every mine reuses these
export function buildMine() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x4a3a30, 0xff5a2a);
  model.add(new THREE.Mesh(mineCore, m.hull));
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.6, 0.6, 0.6], [-0.6, -0.6, 0.6], [0.6, -0.6, -0.6], [-0.6, 0.6, -0.6]];
  for (const d of dirs) {
    const v = new THREE.Vector3(...d).normalize();
    const spike = new THREE.Mesh(mineSpike, m.dark);
    spike.position.copy(v).multiplyScalar(1.15);
    spike.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v);
    model.add(spike);
  }
  const light = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: hdr(0xff3a2a, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  light.scale.setScalar(4.5);
  group.add(light);
  model.scale.setScalar(1.1);
  return { group, model, flames: [], mats: [m.hull, m.dark], radius: 2.6, light, muzzles: [] };
}

// ---------------------------------------------------------------------------
// Aegis: an unarmed shield projector. A crystal core inside two gimballed
// rings; it tethers itself to the ships it protects.
// ---------------------------------------------------------------------------
export function buildAegis() {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x3a3a6a, 0x7a6bff);
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.3, 0), new THREE.MeshBasicMaterial({ color: hdr(0x8a7bff, 3) }));
  core.scale.set(1, 1.5, 1);
  model.add(core);
  const shell = new THREE.Mesh(new THREE.OctahedronGeometry(1.7, 0), m.dark);
  shell.scale.set(1, 1.5, 1);
  shell.material = m.dark.clone();
  shell.material.transparent = true;
  shell.material.opacity = 0.55;
  shell.material.userData.baseEmissive = m.dark.userData.baseEmissive;
  model.add(shell);
  const ringPivot = new THREE.Group();
  model.add(ringPivot);
  const r1 = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.14, 8, 48), m.glow);
  ringPivot.add(r1);
  const r1b = new THREE.Mesh(new THREE.TorusGeometry(3.0, 0.32, 6, 6), m.hull);
  ringPivot.add(r1b);
  const r2 = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.12, 8, 40), m.glow);
  r2.rotation.x = Math.PI / 2;
  ringPivot.add(r2);
  const flames = [];
  addFlame(model, 0, -2.4, 0.6, 0.3, 0x7a6bff, flames);
  model.scale.setScalar(1.2);
  return { group, model, flames, mats: [m.hull, m.dark, shell.material], radius: 4.2, ringPivot, core, muzzles: [] };
}

// ---------------------------------------------------------------------------
// Dreadnought (boss): a hostile orbital fortress. Armoured hex hull, a
// spinning reactor ring, twin launch tubes in the prow and six gun turrets,
// each covering its own side of the hull. Built in metres, nose along -Z,
// local +Y is "up" (the orbit normal).
// ---------------------------------------------------------------------------
export function buildDreadnought(turretCount = 6) {
  const group = new THREE.Group();
  const model = new THREE.Group();
  group.add(model);
  const m = enemyMaterials(0x857480, 0xff2a3c);
  m.hull.userData.baseEmissive.multiplyScalar(0.4);
  const plate = new THREE.MeshStandardMaterial({ color: 0x7a2430, metalness: 0.5, roughness: 0.45, flatShading: true, envMapIntensity: 1.4 });
  plate.userData.baseEmissive = new THREE.Color(0xff2a3c).multiplyScalar(0.05);
  const strip = new THREE.MeshBasicMaterial({ color: hdr(0xff2a3c, 3.2) });
  const stripDim = new THREE.MeshBasicMaterial({ color: hdr(0xff3a4a, 1.4) });
  const ember = new THREE.MeshStandardMaterial({ color: 0x241a1e, metalness: 0.5, roughness: 0.8, flatShading: true, emissive: new THREE.Color(0xff5020), emissiveIntensity: 1.4 });
  const zCyl = (rt, rb, len, seg, mat) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg).rotateX(Math.PI / 2), mat);

  // --- armoured hull ---
  // two hull sections with an open reactor bay between them (z 0..12)
  for (const [z, len] of [[-14, 28], [20, 16]]) {
    const hull = zCyl(15, 15, len, 6, m.hull);
    hull.rotation.z = Math.PI / 6;         // flat top and bottom
    hull.position.z = z;
    model.add(hull);
  }
  const spineCore = zCyl(4, 4, 14, 8, m.dark);
  spineCore.position.z = 6;
  model.add(spineCore);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const strut = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 13), m.dark);
    strut.position.set(Math.cos(a) * 12.5, Math.sin(a) * 12.5, 6);
    model.add(strut);
  }
  for (const z of [-20, -2, 16]) {
    const band = zCyl(16.4, 16.4, 3, 6, plate);
    band.rotation.z = Math.PI / 6;
    band.position.z = z;
    model.add(band);
    const glow = zCyl(16.6, 16.6, 0.5, 6, stripDim);
    glow.rotation.z = Math.PI / 6;
    glow.position.z = z - 1.9;
    model.add(glow);
  }
  // light strips along the hull's edges
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    for (const [z, len] of [[-14, 24], [20, 13]]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, len), strip);
      s.position.set(Math.cos(a) * 15.1, Math.sin(a) * 15.1, z);
      model.add(s);
    }
  }
  // prow and its seeker launch tubes
  const prow = zCyl(6, 15, 14, 6, plate);
  prow.rotation.z = Math.PI / 6;
  prow.position.z = -35;
  model.add(prow);
  const launchers = [];
  for (const x of [-4.2, 4.2]) {
    const tube = zCyl(2.2, 2.2, 6, 12, m.hull);
    tube.position.set(x, 0, -42);
    model.add(tube);
    const mouth = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.45, 8, 20), strip);
    mouth.position.set(x, 0, -45.1);
    model.add(mouth);
    launchers.push(new THREE.Vector3(x, 0, -47));
  }
  // engine block
  const aft = zCyl(13, 11, 8, 6, m.dark);
  aft.rotation.z = Math.PI / 6;
  aft.position.z = 32;
  model.add(aft);
  const flames = [];
  for (const [x, y] of [[0, 5.5], [-5, -3], [5, -3]]) {
    const nozzle = zCyl(2.6, 3.4, 3, 12, m.hull);
    nozzle.position.set(x, y, 37);
    model.add(nozzle);
    addFlame(model, x, y, 38.5, 2.6, 0xff3a2a, flames);
  }
  // dorsal and ventral fins
  for (const sy of [1, -1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 9, 15), m.dark);
    fin.position.set(0, sy * 17, 29);
    model.add(fin);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 15), strip);
    edge.position.set(0, sy * 21.6, 29);
    model.add(edge);
  }

  // --- reactor ring: spins around the hull, glowing core inside ---
  const core = new THREE.Mesh(new THREE.SphereGeometry(7.5, 24, 16), new THREE.MeshBasicMaterial({ color: hdr(0xff3048, 5) }));
  core.position.z = 6;
  model.add(core);
  const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: hdr(0xff2a3c, 1.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  coreGlow.scale.setScalar(38);
  coreGlow.position.z = 6;
  model.add(coreGlow);
  const ringPivot = new THREE.Group();
  ringPivot.position.z = 6;
  model.add(ringPivot);
  ringPivot.add(new THREE.Mesh(new THREE.TorusGeometry(29, 2.6, 8, 48), m.dark));
  ringPivot.add(new THREE.Mesh(new THREE.TorusGeometry(29, 0.9, 8, 64), strip));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(14, 1.6, 2.4), m.hull);
    spoke.position.set(Math.cos(a) * 22, Math.sin(a) * 22, 0);
    spoke.rotation.z = a;
    ringPivot.add(spoke);
    const pod = new THREE.Mesh(new THREE.BoxGeometry(4.5, 4.5, 7), plate);
    pod.position.set(Math.cos(a) * 29, Math.sin(a) * 29, 0);
    pod.rotation.z = a;
    ringPivot.add(pod);
  }

  // --- turrets, each covering its own face of the hull: six, and later fortresses add
  // pairs on the rear flanks, mid top/bottom and forward flanks (up to twelve) ---
  const barrelGeo = new THREE.CylinderGeometry(0.45, 0.55, 7, 8).rotateX(Math.PI / 2);
  const turrets = [];
  const mounts = [
    [0, 1, 0, -16], [0, 1, 0, 20], [0, -1, 0, -16], [0, -1, 0, 20], [1, 0, 0, -14], [-1, 0, 0, -14],
    [1, 0, 0, 22], [-1, 0, 0, 22], [0, 1, 0, -7], [0, -1, 0, -7], [1, 0, 0, -25], [-1, 0, 0, -25],
  ].slice(0, Math.max(6, Math.min(12, turretCount)));
  for (const [nx, ny, nz, z] of mounts) {
    const normal = new THREE.Vector3(nx, ny, nz);
    const surface = Math.abs(ny) > 0 ? 13 : 14.6;
    const base = normal.clone().multiplyScalar(surface).setZ(z);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.8, 3, 10), m.dark);
    ped.position.copy(base).addScaledVector(normal, 1.2);
    ped.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal);
    model.add(ped);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.3, 0.3, 6, 20), stripDim);
    ring.position.copy(base).addScaledVector(normal, 2.75);
    ring.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    model.add(ring);
    const stub = new THREE.Mesh(new THREE.DodecahedronGeometry(2.4, 0), ember);
    stub.position.copy(base).addScaledVector(normal, 3);
    stub.visible = false;
    model.add(stub);
    const head = new THREE.Group();
    head.position.copy(base).addScaledVector(normal, 5.4);
    head.scale.setScalar(1.35);
    model.add(head);
    const housing = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 5.4), plate);
    head.add(housing);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.dark);
    dome.position.y = 1.4;
    head.add(dome);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), strip);
    eye.position.set(0, 0.6, -2.75);
    head.add(eye);
    for (const bx of [-1.15, 1.15]) {
      const barrel = new THREE.Mesh(barrelGeo, m.dark);
      barrel.position.set(bx, 0, -5.6);
      head.add(barrel);
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.6, 8).rotateX(Math.PI / 2), strip);
      tip.position.set(bx, 0, -9.2);
      head.add(tip);
    }
    turrets.push({ local: head.position.clone(), normal, head, stub, ring, muzzle: 13 });
  }

  // spinal railgun: emitter in the prow and an aim line (telegraph) shown while it charges
  const emitter = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 10), new THREE.MeshBasicMaterial({ color: hdr(0xff2a3c, 3) }));
  emitter.position.z = -46;
  model.add(emitter);
  const emitterGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: hdr(0xff3a3a, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 }));
  emitterGlow.position.z = -46;
  emitterGlow.scale.setScalar(26);
  model.add(emitterGlow);
  const telegraph = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, -0.5),
    new THREE.MeshBasicMaterial({ color: hdr(0xff3a3a, 2.5), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  telegraph.position.z = -48;
  telegraph.scale.set(1, 1, 2600);
  telegraph.visible = false;
  telegraph.frustumCulled = false;
  group.add(telegraph);

  return { group, model, flames, mats: [m.hull, m.dark, plate], radius: 33, ringPivot, emitter, emitterGlow, telegraph, core, coreGlow, turrets, launchers, muzzles: [] };
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

// ---------------------------------------------------------------------------
// Space station — same design language as the player's interceptor:
// pale alloy hull, gunmetal structure, cyan light strips. The docking port is
// at the -Z end; a rotating habitat ring sits amidships.
// ---------------------------------------------------------------------------
function solarTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#0b1a3a';
  g.fillRect(0, 0, 256, 128);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const l = 30 + Math.random() * 18;
      g.fillStyle = `hsl(222, 60%, ${l}%)`;
      g.fillRect(x * 16 + 1, y * 16 + 1, 14, 14);
    }
  }
  g.strokeStyle = 'rgba(180,210,255,0.5)';
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, 255, 127);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function buildStation() {
  const group = new THREE.Group();
  const hull = new THREE.MeshStandardMaterial({ color: 0xd4dce8, metalness: 0.65, roughness: 0.32, envMapIntensity: 1.6 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x252c3a, metalness: 0.8, roughness: 0.4, envMapIntensity: 1.2 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x061624, metalness: 1, roughness: 0.05, emissive: 0x0b6a8a, emissiveIntensity: 0.45 });
  const accent = new THREE.MeshBasicMaterial({ color: hdr(0x5ef2ff, 3) });
  const accentDim = new THREE.MeshBasicMaterial({ color: hdr(0x5ef2ff, 1.3) });
  const warm = new THREE.MeshBasicMaterial({ color: hdr(0xffa040, 2.6) });
  const panel = new THREE.MeshStandardMaterial({ map: solarTexture(), metalness: 0.55, roughness: 0.3, emissive: 0x0a1630, envMapIntensity: 1.8 });
  const zCyl = (rt, rb, len, seg, mat) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, seg).rotateX(Math.PI / 2), mat);

  // --- spine ---
  const spine = zCyl(4.5, 4.5, 96, 16, hull);
  group.add(spine);
  for (let z = -36; z <= 36; z += 12) {
    const band = zCyl(5.3, 5.3, 1.6, 16, dark);
    band.position.z = z;
    group.add(band);
    const strip = zCyl(5.4, 5.4, 0.25, 16, accentDim);
    strip.position.z = z + 1.0;
    group.add(strip);
  }

  // --- command module (hexagonal, glazed) ---
  const cmd = zCyl(11, 11, 14, 6, hull);
  cmd.position.z = -24;
  group.add(cmd);
  const cmdGlass = zCyl(11.25, 11.25, 2.6, 6, glass);
  cmdGlass.position.z = -24;
  group.add(cmdGlass);
  for (const z of [-31.2, -16.8]) {
    const cap = zCyl(11.4, 11.4, 0.6, 6, accent);
    cap.position.z = z;
    group.add(cap);
  }
  const nose = zCyl(4.5, 11, 6, 6, dark);
  nose.position.z = -34;
  group.add(nose);

  // --- eight docking clamps (one per pilot): four on a cross-shaped mount and four further
  // out on a diagonal one, each with its own approach lights ---
  for (const [w, h] of [[34, 3.2], [3.2, 34]]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(w, h, 4), dark);
    beam.position.z = -39;
    group.add(beam);
    const beamStrip = new THREE.Mesh(new THREE.BoxGeometry(w > h ? w + 0.2 : 0.3, w > h ? 0.3 : h + 0.2, 0.3), accentDim);
    beamStrip.position.set(w > h ? 0 : 1.7, w > h ? 1.7 : 0, -41);
    group.add(beamStrip);
  }
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(48, 3.2, 4), dark);
    beam.position.z = -37;
    beam.rotation.z = a;
    group.add(beam);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(48.2, 0.3, 0.3), accentDim);
    strip.position.set(-Math.sin(a) * 1.7, Math.cos(a) * 1.7, -39);
    strip.rotation.z = a;
    group.add(strip);
  }
  const guides = [];
  const guideMat = new THREE.SpriteMaterial({ map: getGlowTexture(), color: hdr(0x5ef2ff, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
  const clampMat = new THREE.MeshBasicMaterial({ color: hdr(0x6dff9a, 3) });
  const clamps = [];
  const D = 16.5;   // the diagonal clamps sit further out so their collars clear the cross ones
  for (const [x, y] of [[-12, 0], [12, 0], [0, 12], [0, -12], [D, D], [-D, D], [-D, -D], [D, -D]]) {
    const arm = zCyl(2.8, 3.6, 12, 12, dark);
    arm.position.set(x, y, -46);
    group.add(arm);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(3.8, 0.7, 10, 32), hull);
    collar.position.set(x, y, -52.3);
    group.add(collar);
    const collarGlow = new THREE.Mesh(new THREE.TorusGeometry(3.8, 0.2, 8, 32), accent);
    collarGlow.position.set(x, y, -53.1);
    group.add(collarGlow);
    // four clamp jaws that close around a docked ship's nose
    for (let j = 0; j < 4; j++) {
      const a = (j / 4) * Math.PI * 2 + Math.PI / 4;
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 4.2), hull);
      jaw.position.set(x + Math.cos(a) * 4.1, y + Math.sin(a) * 4.1, -54.6);
      jaw.lookAt(x, y, -60);
      group.add(jaw);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 0.6), dark);
      tip.position.set(x + Math.cos(a) * 3.3, y + Math.sin(a) * 3.3, -56.6);
      group.add(tip);
    }
    // status light: green = free, amber = occupied
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), clampMat.clone());
    // sits just beside its collar (above the side clamps, beside the top/bottom ones)
    light.position.set(x && y ? x : x ? x : 4.8, x && y ? y + 4.8 : x ? 4.8 : y, -52.3);
    group.add(light);
    for (let i = 0; i < 6; i++) {   // (6 rings each keeps the sprite count sane with 8 clamps)
      for (const [gx, gy] of [[5, 0], [-5, 0], [0, 5], [0, -5]]) {
        const sp = new THREE.Sprite(guideMat.clone());
        sp.position.set(x + gx, y + gy, -60 - i * 12);
        sp.scale.setScalar(1.4);
        sp.userData.i = i;
        group.add(sp);
        guides.push(sp);
      }
    }
    clamps.push({
      light,
      portLocal: new THREE.Vector3(x, y, -53.5),
      dockedShipLocal: new THREE.Vector3(x, y, -56.9),
      exitLocal: new THREE.Vector3(x, y, -68),
    });
  }

  // --- rotating habitat ring ---
  const ring = new THREE.Group();
  ring.position.z = 6;
  group.add(ring);
  ring.add(new THREE.Mesh(new THREE.TorusGeometry(38, 3.4, 16, 120), hull));
  const windows = new THREE.Mesh(new THREE.TorusGeometry(41.3, 0.4, 6, 120), accentDim);
  ring.add(windows);
  for (const off of [-2.6, 2.6]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(38, 0.25, 6, 120), accent);
    rim.position.z = off;
    ring.add(rim);
  }
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(2.4, 31, 2.4), dark);
    spoke.position.set(Math.cos(a) * 20, Math.sin(a) * 20, 0);
    spoke.rotation.z = a - Math.PI / 2;
    ring.add(spoke);
    const pod = new THREE.Mesh(new THREE.BoxGeometry(8, 5, 9), hull);
    pod.position.set(Math.cos(a + Math.PI / 4) * 38, Math.sin(a + Math.PI / 4) * 38, 0);
    pod.rotation.z = a + Math.PI / 4;
    ring.add(pod);
  }
  const hub = zCyl(8, 8, 9, 16, dark);
  ring.add(hub);
  const hubGlow = zCyl(8.15, 8.15, 0.6, 16, accent);
  ring.add(hubGlow);

  // --- solar arrays ---
  for (const s of [1, -1]) {
    const boom = new THREE.Mesh(new THREE.BoxGeometry(62, 1.2, 1.2), dark);
    boom.position.set(s * 33, 0, 30);
    group.add(boom);
    for (const px of [20, 44]) {
      for (const pz of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(20, 0.3, 11), panel);
        p.position.set(s * px, 0, 30 + pz * 6.4);
        group.add(p);
      }
    }
    const tipLight = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(s > 0 ? 0x20ff60 : 0xff2030, 5) }));
    tipLight.position.set(s * 64, 0, 30);
    tipLight.userData.beacon = true;
    group.add(tipLight);
  }

  // --- radiators ---
  for (const s of [1, -1]) {
    const rad = new THREE.Mesh(new THREE.BoxGeometry(0.4, 24, 9), hull);
    rad.position.set(0, s * 17, 40);
    group.add(rad);
    const radStrip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 22, 0.3), warm);
    radStrip.position.set(0, s * 17, 40);
    group.add(radStrip);
  }

  // --- drive section ---
  const drive = zCyl(6.5, 8, 9, 16, dark);
  drive.position.z = 50;
  group.add(drive);
  const nozzleGlow = new THREE.Mesh(new THREE.CircleGeometry(5.6, 24), new THREE.MeshBasicMaterial({ color: hdr(0x3fb8ff, 1.6) }));
  nozzleGlow.position.z = 54.6;
  group.add(nozzleGlow);

  // --- station-keeping thrusters (fire toward the hole to hold the slightly slow orbit) ---
  const keepers = [];
  for (const sx of [1, -1]) {
    for (const z of [-24, 50]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(3, 3.4, 4), dark);
      pod.position.set(sx * (z < 0 ? 11.6 : 8.4), 0, z);
      group.add(pod);
      const pivot = new THREE.Group();
      pivot.position.set(sx * (z < 0 ? 13.2 : 10), 0, z);
      pivot.rotation.y = sx * Math.PI / 2;   // flame +Z -> ±X
      group.add(pivot);
      const list = [];
      addFlame(pivot, 0, 0, 0, 1.1, 0x7fd8ff, list);
      keepers.push({ ...list[0], dir: new THREE.Vector3(sx, 0, 0) });
    }
  }

  // --- antenna dish on the command module ---
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 12, 6), dark);
  mast.position.set(0, 16, -24);
  group.add(mast);
  const dish = new THREE.Mesh(new THREE.SphereGeometry(5, 20, 10, 0, Math.PI * 2, 0, 0.65), hull);
  dish.material = hull.clone();
  dish.material.side = THREE.DoubleSide;
  dish.position.set(0, 22, -24);
  dish.rotation.x = Math.PI;
  group.add(dish);
  const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.7, 8, 6), new THREE.MeshBasicMaterial({ color: hdr(0xffffff, 6) }));
  strobe.position.set(0, 22.6, -24);
  strobe.userData.strobe = true;
  group.add(strobe);

  // a soft light so the ship looks lit while docked
  const lamp = new THREE.PointLight(0x9fe8ff, 600, 140, 2);
  lamp.position.set(0, 10, -60);
  group.add(lamp);

  const beacons = [];
  group.traverse((o) => { if (o.userData.beacon || o.userData.strobe) beacons.push(o); });

  return {
    group, ring, guides, beacons, keepers,
    clamps,
  };
}

// ---------------------------------------------------------------------------
// Salvageable wreck: a tumbling cluster of scorched hull plates with a
// pulsing green salvage beacon.
// ---------------------------------------------------------------------------
const wreckGeos = [
  new THREE.TetrahedronGeometry(1.2), new THREE.BoxGeometry(2.2, 0.4, 1.4),
  new THREE.OctahedronGeometry(0.9), new THREE.BoxGeometry(1.2, 0.3, 2.6),
];
for (const g of wreckGeos) g.userData.shared = true;

export function buildWreck(glowHex) {
  const group = new THREE.Group();
  const scorched = new THREE.MeshStandardMaterial({ color: 0x3a343c, metalness: 0.7, roughness: 0.6, flatShading: true });
  const ember = new THREE.MeshStandardMaterial({ color: 0x2a2024, metalness: 0.5, roughness: 0.7, flatShading: true, emissive: new THREE.Color(glowHex), emissiveIntensity: 1.6 });
  const n = 5 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(wreckGeos[i % wreckGeos.length], i % 3 === 0 ? ember : scorched);
    m.position.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 4);
    m.rotation.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    m.scale.setScalar(0.7 + Math.random() * 0.9);
    group.add(m);
  }
  const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: getGlowTexture(), color: hdr(0x6dff9a, 3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  beacon.scale.setScalar(7);
  group.add(beacon);
  return { group, beacon, ember };
}
