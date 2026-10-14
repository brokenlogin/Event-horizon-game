import * as THREE from 'three';
import { RS, DISK_IN, DISK_OUT, ARENA_RADIUS } from './physics.js';
import { getGlowTexture } from './ships.js';

// ---------------------------------------------------------------------------
// Holographic 3D orbital plot. The sphere is the gravity wall; the black hole
// and its disk sit at the centre. The view turns with your camera, so what's
// on your left in the cockpit is on the left of the sphere. Each contact has a
// drop line to the disk plane so you can read its height at a glance.
// ---------------------------------------------------------------------------

const R = ARENA_RADIUS * 1.04;    // world radius mapped to the unit sphere
const K = 1 / R;
const MAX_CONTACTS = 64;
const COLORS = {
  raider: new THREE.Color(1.0, 0.3, 0.38),
  warden: new THREE.Color(1.0, 0.36, 0.94),
  seeker: new THREE.Color(1.0, 0.84, 0.29),
  dread: new THREE.Color(1.0, 0.15, 0.2),
  lancer: new THREE.Color(0.35, 1.0, 0.55),
  sower: new THREE.Color(1.0, 0.6, 0.2),
  mine: new THREE.Color(0.55, 0.3, 0.15),
  aegis: new THREE.Color(0.55, 0.5, 1.0),
  wreck: new THREE.Color(0.43, 1.0, 0.6),
  ally: new THREE.Color(1.0, 0.68, 0.29),
};

const _v = new THREE.Vector3();
const _tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.56);

function circlePoints(radius, segments, y = 0) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
  }
  return pts;
}

export class Radar3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(canvas.clientWidth || 240, canvas.clientHeight || 240, false);
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    this.root = new THREE.Group();
    this.scene.add(this.root);
    this._build();
  }

  _lineMat(color, opacity) {
    return new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  }

  _build() {
    const root = this.root;
    const cyan = 0x5ef2ff;

    // translucent shell + graticule
    root.add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({
      color: cyan, transparent: true, opacity: 0.045, depthWrite: false, side: THREE.DoubleSide,
    })));
    const grat = [];
    for (const lat of [-60, -30, 30, 60]) {
      const phi = THREE.MathUtils.degToRad(lat);
      const pts = circlePoints(Math.cos(phi), 64, Math.sin(phi));
      for (let i = 0; i < pts.length - 1; i++) grat.push(pts[i], pts[i + 1]);
    }
    for (let m = 0; m < 12; m++) {
      const th = (m / 12) * Math.PI * 2;
      for (let i = 0; i < 32; i++) {
        const a0 = -Math.PI / 2 + (i / 32) * Math.PI, a1 = -Math.PI / 2 + ((i + 1) / 32) * Math.PI;
        grat.push(
          new THREE.Vector3(Math.cos(a0) * Math.cos(th), Math.sin(a0), Math.cos(a0) * Math.sin(th)),
          new THREE.Vector3(Math.cos(a1) * Math.cos(th), Math.sin(a1), Math.cos(a1) * Math.sin(th)),
        );
      }
    }
    root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grat), this._lineMat(cyan, 0.13)));

    // disk plane: equator + range rings every 500 m
    root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePoints(1, 96)), this._lineMat(cyan, 0.5)));
    for (let r = 500; r < R; r += 500) {
      root.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(circlePoints(r * K, 64)), this._lineMat(cyan, 0.1)));
    }

    // accretion disk + black hole
    const disk = new THREE.Mesh(new THREE.RingGeometry(DISK_IN * K, DISK_OUT * K, 64), new THREE.MeshBasicMaterial({
      color: 0xff9a40, transparent: true, opacity: 0.45, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    disk.rotation.x = -Math.PI / 2;
    root.add(disk);
    root.add(new THREE.Mesh(new THREE.SphereGeometry(RS * 2.6 * K, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000 })));
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xffb070, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(RS * 9 * K);
    root.add(halo);

    // station orbit + marker
    this.stationOrbit = new THREE.Line(new THREE.BufferGeometry(), this._lineMat(0x6dff9a, 0.45));
    root.add(this.stationOrbit);
    this.stationMark = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), new THREE.MeshBasicMaterial({ color: 0x6dff9a, wireframe: true }));
    root.add(this.stationMark);

    // player's predicted orbit
    this.orbitGeo = new THREE.BufferGeometry();
    this.orbitGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(720 * 3), 3));
    this.orbit = new THREE.Line(this.orbitGeo, this._lineMat(cyan, 0.85));
    this.orbit.frustumCulled = false;
    root.add(this.orbit);

    // player marker: an arrowhead pointing where the ship points
    const arrow = new THREE.ConeGeometry(0.035, 0.1, 4);
    arrow.rotateX(-Math.PI / 2);     // tip toward -Z, like the ship
    this.player = new THREE.Mesh(arrow, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    root.add(this.player);
    const pGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0x9ff4ff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    pGlow.scale.setScalar(0.14);
    this.player.add(pGlow);

    // contacts (enemies + wrecks) as glowing points, with drop lines to the disk plane
    this.ptsGeo = new THREE.BufferGeometry();
    this.ptsGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_CONTACTS * 3), 3));
    this.ptsGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX_CONTACTS * 3), 3));
    this.points = new THREE.Points(this.ptsGeo, new THREE.PointsMaterial({
      size: 11, sizeAttenuation: false, map: getGlowTexture(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.points.frustumCulled = false;
    root.add(this.points);
    this.dropGeo = new THREE.BufferGeometry();
    this.dropGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((MAX_CONTACTS + 1) * 6), 3));
    this.dropGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array((MAX_CONTACTS + 1) * 6), 3));
    this.drops = new THREE.LineSegments(this.dropGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false }));
    this.drops.frustumCulled = false;
    root.add(this.drops);
  }

  setStationOrbit(station) {
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const a = (i / 128) * Math.PI * 2;
      pts.push(_v.copy(station.u).multiplyScalar(Math.cos(a) * station.radius).addScaledVector(station.w, Math.sin(a) * station.radius).multiplyScalar(K).clone());
    }
    this.stationOrbit.geometry.dispose();
    this.stationOrbit.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  resize() {
    const w = this.canvas.clientWidth || 240, h = this.canvas.clientHeight || 240;
    this.renderer.setSize(w, h, false);
  }

  update(player, enemies, wrecks, station, pred, viewQuat, time, allies = []) {
    // camera turns with the player's view, raised ~32° so the disk plane reads as an ellipse
    this.camera.quaternion.copy(viewQuat).multiply(_tilt);
    this.camera.position.set(0, 0, 4.1).applyQuaternion(this.camera.quaternion);

    // player
    this.player.visible = player.alive;
    this.player.position.copy(player.pos).multiplyScalar(K);
    this.player.quaternion.copy(player.quat);

    // station
    this.stationMark.position.copy(station.pos).multiplyScalar(K);
    this.stationMark.rotation.y = time * 1.5;

    // predicted orbit
    const n = pred.count;
    const arr = this.orbitGeo.attributes.position.array;
    for (let i = 0; i < n * 3; i++) arr[i] = pred.positions[i] * K;
    this.orbitGeo.attributes.position.needsUpdate = true;
    this.orbitGeo.setDrawRange(0, n);
    this.orbit.material.color.set(pred.impact ? 0xff4d61 : 0x5ef2ff);

    // contacts + drop lines (player gets a drop line too)
    const P = this.ptsGeo.attributes.position.array, C = this.ptsGeo.attributes.color.array;
    const D = this.dropGeo.attributes.position.array, DC = this.dropGeo.attributes.color.array;
    let c = 0, d = 0;
    const addDrop = (p, col, s) => {
      D[d * 6] = p.x; D[d * 6 + 1] = p.y; D[d * 6 + 2] = p.z;
      D[d * 6 + 3] = p.x; D[d * 6 + 4] = 0; D[d * 6 + 5] = p.z;
      for (let k = 0; k < 2; k++) { DC[d * 6 + k * 3] = col.r * s; DC[d * 6 + k * 3 + 1] = col.g * s; DC[d * 6 + k * 3 + 2] = col.b * s; }
      d++;
    };
    const add = (pos, col, bright) => {
      if (c >= MAX_CONTACTS) return;
      _v.copy(pos).multiplyScalar(K);
      P[c * 3] = _v.x; P[c * 3 + 1] = _v.y; P[c * 3 + 2] = _v.z;
      C[c * 3] = col.r * bright; C[c * 3 + 1] = col.g * bright; C[c * 3 + 2] = col.b * bright;
      c++;
      addDrop(_v, col, 0.6 * bright);
    };
    const pulse = 0.85 + 0.2 * Math.sin(time * 6);
    for (const e of enemies) if (e.alive) add(e.renderPos, COLORS[e.type] || COLORS.raider, pulse);
    for (const w of wrecks) if (w.alive) add(w.pos, COLORS.wreck, w.life < 15 ? 0.4 : 0.8);
    for (const a of allies) if (a.present && a.alive) add(a.renderPos, COLORS.ally, 1.1);
    if (player.alive) addDrop(_v.copy(player.pos).multiplyScalar(K), new THREE.Color(0.6, 0.95, 1), 0.8);
    this.ptsGeo.setDrawRange(0, c);
    this.ptsGeo.attributes.position.needsUpdate = this.ptsGeo.attributes.color.needsUpdate = true;
    this.dropGeo.setDrawRange(0, d * 2);
    this.dropGeo.attributes.position.needsUpdate = this.dropGeo.attributes.color.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }
}
