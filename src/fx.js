import * as THREE from 'three';
import { RS, gravK } from './physics.js';

// ---------------------------------------------------------------------------
// Bolts. Every projectile is a gravitating body: it inherits the shooter's
// orbital velocity and its path bends around the black hole.
// ---------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _z = new THREE.Vector3(0, 0, 1);

export class BoltPool {
  constructor(scene, { max = 400, color, radius = 0.13, length = 5, glowRadius = 0.45 }) {
    this.max = max;
    this.length = length;
    this.pos = new Float32Array(max * 3);
    this.prev = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.dmg = new Float32Array(max);
    this.active = new Uint8Array(max);
    this.count = 0;
    this.cursor = 0;

    const core = new THREE.CylinderGeometry(radius, radius, 1, 6).rotateX(Math.PI / 2);
    const glow = new THREE.CylinderGeometry(glowRadius, glowRadius * 0.6, 1, 8).rotateX(Math.PI / 2);
    this.core = new THREE.InstancedMesh(core, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(6) }), max);
    this.glow = new THREE.InstancedMesh(glow, new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(0.9), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }), max);
    for (const m of [this.core, this.glow]) {
      m.frustumCulled = false;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
    }
  }

  spawn(p, v, life, dmg) {
    for (let n = 0; n < this.max; n++) {
      const i = (this.cursor + n) % this.max;
      if (!this.active[i]) {
        this.cursor = (i + 1) % this.max;
        this.active[i] = 1;
        this.pos[i * 3] = this.prev[i * 3] = p.x;
        this.pos[i * 3 + 1] = this.prev[i * 3 + 1] = p.y;
        this.pos[i * 3 + 2] = this.prev[i * 3 + 2] = p.z;
        this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
        this.life[i] = life;
        this.dmg[i] = dmg;
        return i;
      }
    }
    return -1;
  }

  clear() {
    this.active.fill(0);
  }

  /** Physics step. targets: [{pos, radius, alive}], onHit(target, point, dmg, boltVel) */
  step(dt, targets, onHit) {
    const P = this.pos, V = this.vel, Q = this.prev;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const o = i * 3;
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      // leapfrog with Paczyński–Wiita gravity, inlined for speed
      for (let h = 0; h < 2; h++) {
        const x = P[o], y = P[o + 1], z = P[o + 2];
        const k = gravK(x, y, z) * dt * 0.5;
        V[o] += x * k; V[o + 1] += y * k; V[o + 2] += z * k;
        if (h === 0) { P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt; }
      }
      this.life[i] -= dt;
      const r2 = P[o] * P[o] + P[o + 1] * P[o + 1] + P[o + 2] * P[o + 2];
      // inside the photon sphere a bolt is captured
      if (this.life[i] <= 0 || r2 < 2.25 * RS * RS) { this.active[i] = 0; continue; }

      // swept sphere test against targets
      const ax = Q[o], ay = Q[o + 1], az = Q[o + 2];
      const sx = P[o] - ax, sy = P[o + 1] - ay, sz = P[o + 2] - az;
      const sl2 = sx * sx + sy * sy + sz * sz || 1e-6;
      for (let t = 0; t < targets.length; t++) {
        const tg = targets[t];
        if (!tg.alive) continue;
        const cx = tg.pos.x - ax, cy = tg.pos.y - ay, cz = tg.pos.z - az;
        let u = (cx * sx + cy * sy + cz * sz) / sl2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const dx = ax + sx * u - tg.pos.x, dy = ay + sy * u - tg.pos.y, dz = az + sz * u - tg.pos.z;
        if (dx * dx + dy * dy + dz * dz < tg.radius * tg.radius) {
          this.active[i] = 0;
          _p.set(ax + sx * u, ay + sy * u, az + sz * u);
          _d.set(V[o], V[o + 1], V[o + 2]);
          onHit(tg, _p, this.dmg[i], _d);
          break;
        }
      }
    }
  }

  /** Orient each bolt along its velocity relative to the viewer, so streaks read correctly. */
  updateVisuals(viewerVel) {
    let n = 0;
    for (let i = 0; i < this.max; i++) {
      if (!this.active[i]) continue;
      const o = i * 3;
      _d.set(this.vel[o] - viewerVel.x, this.vel[o + 1] - viewerVel.y, this.vel[o + 2] - viewerVel.z);
      const sp = _d.length();
      if (sp < 1e-3) _d.set(0, 0, 1); else _d.divideScalar(sp);
      _q.setFromUnitVectors(_z, _d);
      _p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]);
      const fade = Math.min(1, this.life[i] * 4);
      _s.set(fade, fade, this.length);
      _m.compose(_p, _q, _s);
      this.core.setMatrixAt(n, _m);
      _s.set(fade, fade, this.length * 1.4);
      _m.compose(_p, _q, _s);
      this.glow.setMatrixAt(n, _m);
      n++;
    }
    this.core.count = this.glow.count = n;
    this.core.instanceMatrix.needsUpdate = true;
    this.glow.instanceMatrix.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Particles: one big additive point cloud. Optionally gravitating, so explosion
// debris drifts along the orbit and gets pulled into the hole.
// ---------------------------------------------------------------------------
export class Particles {
  constructor(scene, max = 9000) {
    this.max = max;
    this.cursor = 0;
    // index span that may hold live particles: update() only walks (and uploads) this range
    this.lo = max;
    this.hi = -1;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.flags = new Uint8Array(max);   // bit0 gravity
    this.drag = new Float32Array(max);
    this.baseCol = new Float32Array(max * 3);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 } },
      vertexShader: /* glsl */`
        attribute vec3 aColor; attribute float aSize; attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), 400.0);
          vColor = aColor; vAlpha = aAlpha;
          if (aAlpha <= 0.0) gl_PointSize = 0.0;
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vColor; varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, d);
          a *= a;
          gl_FragColor = vec4(vColor * a * vAlpha, 1.0);
        }`,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(px, py, pz, vx, vy, vz, r, g, b, s0, s1, life, gravity = false, drag = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    const o = i * 3;
    this.pos[o] = px; this.pos[o + 1] = py; this.pos[o + 2] = pz;
    this.vel[o] = vx; this.vel[o + 1] = vy; this.vel[o + 2] = vz;
    this.baseCol[o] = r; this.baseCol[o + 1] = g; this.baseCol[o + 2] = b;
    this.s0[i] = s0; this.s1[i] = s1;
    this.life[i] = this.maxLife[i] = life;
    this.flags[i] = gravity ? 1 : 0;
    this.drag[i] = drag;
    if (i < this.lo) this.lo = i;
    if (i > this.hi) this.hi = i;
  }

  update(dt) {
    if (this.hi < this.lo) return;           // nothing alive: no work, no upload
    const P = this.pos, V = this.vel;
    const lo = this.lo, hi = this.hi;
    let newLo = this.max, newHi = -1;
    for (let i = lo; i <= hi; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) { this.alpha[i] = 0; } continue; }
      if (i < newLo) newLo = i;
      newHi = i;
      this.life[i] -= dt;
      const o = i * 3;
      if (this.flags[i] & 1) {
        const x = P[o], y = P[o + 1], z = P[o + 2];
        const r = Math.sqrt(x * x + y * y + z * z);
        if (r < RS * 1.5) { this.life[i] = 0; this.alpha[i] = 0; continue; }
        const k = gravK(x, y, z) * dt;
        V[o] += x * k; V[o + 1] += y * k; V[o + 2] += z * k;
      }
      if (this.drag[i] > 0) {
        const f = Math.exp(-this.drag[i] * dt);
        V[o] *= f; V[o + 1] *= f; V[o + 2] *= f;
      }
      P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      const a = this.life[i] <= 0 ? 0 : (1 - t) * (1 - t);
      this.alpha[i] = a;
      // cool from white-hot toward base colour
      const heat = Math.max(0, 1 - t * 3);
      this.col[o] = this.baseCol[o] + heat * 0.45;
      this.col[o + 1] = this.baseCol[o + 1] + heat * 0.3;
      this.col[o + 2] = this.baseCol[o + 2] + heat * 0.15;
    }
    // upload only the span we touched (it includes particles that just died, so their alpha reaches 0)
    const g = this.geometry.attributes;
    const n = hi - lo + 1;
    for (const [attr, size] of [[g.position, 3], [g.aColor, 3], [g.aSize, 1], [g.aAlpha, 1]]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * size, n * size);
      attr.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, newHi >= 0 ? hi + 1 : 0);
    this.lo = newLo;
    this.hi = newHi;
    // a particle emitted after this pass widens the span again in emit()
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    const g = this.geometry.attributes;
    g.aAlpha.clearUpdateRanges();
    g.aAlpha.needsUpdate = true;
    this.geometry.setDrawRange(0, 0);
    this.lo = this.max;
    this.hi = -1;
  }
}

// ---------------------------------------------------------------------------
// Camera-facing ribbon trails (engine wakes)
// ---------------------------------------------------------------------------
const _t = new THREE.Vector3();
const _side = new THREE.Vector3();
const _toCam = new THREE.Vector3();

export class Trail {
  constructor(scene, { segments = 48, width = 0.6, color = 0x5ef2ff, interval = 0.02, fadeNear = 16 } = {}) {
    this.n = segments;
    this.width = width;
    this.interval = interval;
    this.timer = 0;
    this.points = [];
    this.scene = scene;
    this.intensity = 1;
    const verts = new Float32Array(segments * 2 * 3);
    const ages = new Float32Array(segments * 2);
    const idx = [];
    for (let i = 0; i < segments - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(verts, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAge', new THREE.BufferAttribute(ages, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uIntensity: { value: 1 }, uFadeNear: { value: fadeNear } },
      vertexShader: /* glsl */`attribute float aAge; uniform float uFadeNear; varying float vAge; varying float vFade;
        void main(){
          vAge = aAge;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFade = smoothstep(4.0, uFadeNear, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`uniform vec3 uColor; uniform float uIntensity; varying float vAge; varying float vFade;
        void main(){ float a = pow(clamp(1.0 - vAge, 0.0, 1.0), 2.2) * uIntensity * clamp(vFade, 0.0, 1.0); gl_FragColor = vec4(uColor * a, 1.0); }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  reset(p) {
    this.points.length = 0;
    for (let i = 0; i < this.n; i++) this.points.push(p.clone());
  }

  /** `drift`: optional velocity the trail's points move with (draws it in a moving frame). */
  update(dt, head, camPos, intensity, drift = null) {
    if (this.points.length === 0) this.reset(head);
    if (drift) for (const p of this.points) p.addScaledVector(drift, dt);
    this.timer += dt;
    if (this.timer >= this.interval) {
      this.timer = 0;
      const last = this.points.pop();
      last.copy(head);
      this.points.unshift(last);
    }
    this.points[0].copy(head);
    this.material.uniforms.uIntensity.value = intensity;
    const pos = this.geometry.attributes.position.array;
    const age = this.geometry.attributes.aAge.array;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const pa = this.points[Math.max(0, i - 1)];
      const pb = this.points[Math.min(n - 1, i + 1)];
      _t.subVectors(pa, pb);
      if (_t.lengthSq() < 1e-8) _t.set(0, 0, 1);
      _toCam.subVectors(camPos, p);
      _side.crossVectors(_t, _toCam);
      const l = _side.length();
      if (l > 1e-6) _side.multiplyScalar(1 / l); else _side.set(0, 1, 0);
      const a = i / (n - 1);
      const w = this.width * (1 - a * 0.7);
      pos[i * 6] = p.x + _side.x * w; pos[i * 6 + 1] = p.y + _side.y * w; pos[i * 6 + 2] = p.z + _side.z * w;
      pos[i * 6 + 3] = p.x - _side.x * w; pos[i * 6 + 4] = p.y - _side.y * w; pos[i * 6 + 5] = p.z - _side.z * w;
      age[i * 2] = age[i * 2 + 1] = a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAge.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Space dust: streaks fixed in the black hole's frame, wrapped around the
// camera in the shader. Gives a strong sense of your orbital velocity.
// ---------------------------------------------------------------------------
export function createDust(scene, count = 900, size = 260) {
  const pos = new Float32Array(count * 2 * 3);
  const end = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = Math.random() * size, y = Math.random() * size, z = Math.random() * size;
    for (let k = 0; k < 2; k++) {
      pos[(i * 2 + k) * 3] = x; pos[(i * 2 + k) * 3 + 1] = y; pos[(i * 2 + k) * 3 + 2] = z;
      end[i * 2 + k] = k;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3() }, uSize: { value: size }, uOpacity: { value: 1 } },
    vertexShader: /* glsl */`
      uniform vec3 uCam; uniform vec3 uVel; uniform float uSize;
      attribute float aEnd; varying float vA;
      void main() {
        vec3 wp = uCam + mod(position - uCam, uSize) - uSize * 0.5;
        wp -= uVel * 0.02 * aEnd;
        float d = length(wp - uCam);
        vA = (1.0 - smoothstep(uSize * 0.2, uSize * 0.5, d)) * smoothstep(3.0, 12.0, d) * (1.0 - aEnd * 0.85);
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`uniform float uOpacity; varying float vA;
      void main(){ gl_FragColor = vec4(vec3(0.65, 0.8, 1.0) * vA * 0.7 * uOpacity, 1.0); }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const lines = new THREE.LineSegments(g, mat);
  lines.frustumCulled = false;
  scene.add(lines);
  return { lines, uniforms: mat.uniforms };
}
