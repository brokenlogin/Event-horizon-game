import * as THREE from 'three';
import { RS, DISK_IN, DISK_OUT } from './physics.js';

// ---------------------------------------------------------------------------
// The black hole is drawn by a full-screen ray marcher. Every pixel's light ray
// is bent by integrating the Schwarzschild photon equation
//     x'' = -3/2 · Rs · h² · x / r⁵
// so the accretion disk, the stars and the nebula behind the hole are all
// gravitationally lensed (Einstein ring, the disk's far side arching over the
// top, the photon ring). The shader writes depth so ships correctly pass in
// front of / behind the disk and the shadow.
// ---------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */`
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
`;

const SKY_FRAG = /* glsl */`
varying vec3 vDir;
${NOISE_GLSL}
float fbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  vec3 galN = normalize(vec3(0.35, 1.0, 0.5));
  float gl = dot(d, galN);
  float band = exp(-gl * gl * 7.0);
  float n = fbm(d * 2.2);
  float n2 = fbm(d * 4.5 + n * 2.2);
  float dust = smoothstep(0.42, 0.7, fbm(d * 8.0 + 4.0));
  vec3 purple = vec3(0.13, 0.03, 0.24);
  vec3 teal   = vec3(0.01, 0.11, 0.21);
  vec3 rose   = vec3(0.34, 0.07, 0.16);
  vec3 neb = mix(purple, teal, smoothstep(0.3, 0.7, n2));
  neb = mix(neb, rose, smoothstep(0.55, 0.78, n) * 0.7);
  float density = pow(n2, 2.2) * (0.18 + band * 1.25);
  vec3 col = neb * density * 1.6;
  col += vec3(0.55, 0.5, 0.7) * band * 0.045 * (0.4 + n);
  col *= 1.0 - dust * band * 0.75;
  // faint unresolved star haze in the galactic band
  col += vec3(0.7, 0.75, 1.0) * pow(hash13(floor(d * 900.0)), 40.0) * band * 0.8;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BH_VERT = /* glsl */`
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const BH_FRAG = /* glsl */`
uniform vec3 uCamPos;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uViewProj;
uniform float uTime;
uniform samplerCube uSky;
uniform float uRs;
uniform float uDiskIn;
uniform float uDiskOut;
uniform float uPx;
uniform float uDiskGain;
uniform sampler3D uNoise;
uniform vec3 uNoiseMin;
uniform vec3 uNoiseInvSize;
varying vec2 vNdc;

${NOISE_GLSL}

// Same value noise as vnoise(), but the lattice hashes come from a baked 3D
// texture: sampling between two texels with the smoothstep weight lets the
// texture filter do the interpolation. One fetch instead of eight hashes.
float vnoiseT(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return texture(uNoise, (i - uNoiseMin + f + 0.5) * uNoiseInvSize).r;
}

float fbm4(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoiseT(p); p = p * 2.07 + vec3(3.1, 1.7, 5.3); a *= 0.5; }
  return s;
}

vec3 blackbody(float t) {
  t = clamp(t, 0.0, 2.2);
  vec3 c = vec3(0.9, 0.12, 0.02) * smoothstep(0.0, 0.35, t);
  c = mix(c, vec3(1.0, 0.45, 0.12), smoothstep(0.25, 0.65, t));
  c = mix(c, vec3(1.0, 0.82, 0.55), smoothstep(0.6, 1.05, t));
  c = mix(c, vec3(0.92, 0.95, 1.0), smoothstep(1.0, 1.5, t));
  c = mix(c, vec3(0.62, 0.75, 1.0), smoothstep(1.45, 2.2, t));
  return c;
}

vec4 diskSample(vec3 p, vec3 rd) {
  float r = length(p.xz);
  float inner = smoothstep(uDiskIn * 0.9, uDiskIn * 1.15, r);
  float outer = 1.0 - smoothstep(uDiskOut * 0.45, uDiskOut, r);
  float edge = inner * outer;
  if (edge <= 0.001) return vec4(0.0);

  // Keplerian differential rotation; two phase-shifted layers cross-fade so the
  // texture never winds up into noise.
  float ang = atan(p.z, p.x);
  float omega = 0.75 * pow(uDiskIn / r, 1.5);
  const float P = 16.0;
  float ph1 = fract(uTime / P);
  float ph2 = fract(uTime / P + 0.5);
  float w = 1.0 - abs(2.0 * ph1 - 1.0);
  float a1 = ang + omega * ph1 * P;
  float a2 = ang + omega * ph2 * P;
  float rr = r * 1.7 / uRs;
  float n1 = fbm4(vec3(rr, cos(a1) * 2.6, sin(a1) * 2.6));
  float n2 = fbm4(vec3(rr, cos(a2) * 2.6, sin(a2) * 2.6));
  float n = mix(n2, n1, w);
  float lanes = 0.55 + 0.45 * sin(r * 8.4 / uRs + n * 7.0);

  float dens = edge * (0.25 + 1.6 * n * n) * mix(0.6, 1.15, lanes);

  // temperature profile of a thin disk (Shakura–Sunyaev shape)
  float x = uDiskIn / r;
  float T = 1.75 * pow(x, 0.75) * pow(max(1.0 - 0.9 * sqrt(x), 0.02), 0.25);

  // relativistic Doppler beaming + gravitational redshift
  vec3 vdir = normalize(vec3(p.z, 0.0, -p.x));
  float beta = sqrt(uRs / (2.0 * r));
  float gam = inversesqrt(1.0 - beta * beta);
  float cosT = dot(vdir, -normalize(rd));
  float D = 1.0 / (gam * (1.0 - beta * cosT));
  float g = D * sqrt(max(1.0 - uRs / r, 0.0));

  vec3 col = blackbody(T * g * 1.15) * pow(g, 2.4) * T * T * 2.1 * (0.35 + n) * uDiskGain;
  float alpha = clamp(dens * 1.15, 0.0, 1.0);
  return vec4(col * alpha, alpha);
}

vec3 starLayer(vec3 d, float scale, float density, float bright) {
  vec3 p = d * scale;
  vec3 cell = floor(p);
  vec3 h = hash33(cell);
  if (h.x > density) return vec3(0.0);
  vec3 sp = normalize(cell + 0.3 + 0.4 * hash33(cell + 17.17));
  vec3 q = sp * scale - cell;
  if (any(lessThan(q, vec3(0.18))) || any(greaterThan(q, vec3(0.82)))) return vec3(0.0);
  if (dot(d, sp) < 0.0) return vec3(0.0);
  float s = length(cross(d, sp));
  float sig = uPx * 0.8;
  float b = exp(-s * s / (sig * sig));
  float mag = pow(h.y, 6.0) * bright + 0.012;
  vec3 tint = mix(vec3(1.0, 0.72, 0.5), vec3(0.62, 0.78, 1.0), h.z);
  tint = mix(tint, vec3(1.0), 0.45);
  return tint * b * mag * 2.2;
}

vec3 skyColor(vec3 d) {
  vec3 c = textureCube(uSky, d).rgb * 0.7;
  c += starLayer(d, 150.0, 0.07, 0.6);
  c += starLayer(d, 70.0, 0.07, 2.0);
  c += starLayer(d, 28.0, 0.08, 6.0);
  return c;
}

void main() {
  vec4 vp = uInvProj * vec4(vNdc, 1.0, 1.0);
  vp /= vp.w;
  vec3 rd = normalize((uCamWorld * vec4(vp.xyz, 0.0)).xyz);
  vec3 ro = uCamPos;

  vec3 col = vec3(0.0);
  float alpha = 0.0;
  bool hasDepth = false;
  vec3 depthP = vec3(0.0);
  bool captured = false;
  vec3 dir = rd;

  float RINF = uRs * 16.0;
  float R2 = RINF * RINF;
  float tca = -dot(ro, rd);
  float d2 = dot(ro, ro) - tca * tca;
  bool inside = dot(ro, ro) < R2;

  if (inside || (d2 < R2 && tca > 0.0)) {
    vec3 p = inside ? ro : ro + rd * (tca - sqrt(R2 - d2));
    vec3 v = rd;
    vec3 hv = cross(p, v);
    float h2 = dot(hv, hv);
    float k = -1.5 * uRs * h2;
    // r and r⁵ carry over from the previous step's endpoint
    float r = length(p);
    float r5 = r * r * r * r * r;
    for (int i = 0; i < 260; i++) {
      float stp = clamp((r - uRs) * 0.11 + r * 0.018, uRs * 0.006, uRs * 1.2);
      vec3 vh = v + (k / r5) * p * (0.5 * stp);
      vec3 np = p + vh * stp;
      float nr = length(np);
      float nr5 = nr * nr * nr * nr * nr;
      v = vh + (k / nr5) * np * (0.5 * stp);

      if (p.y * np.y < 0.0) {
        float f = p.y / (p.y - np.y);
        vec3 hp = mix(p, np, f);
        vec4 dc = diskSample(hp, v);
        col += (1.0 - alpha) * dc.rgb;
        alpha += (1.0 - alpha) * dc.a;
        if (!hasDepth && alpha > 0.55) { hasDepth = true; depthP = hp; }
      }
      p = np;
      r = nr;
      r5 = nr5;
      if (nr < uRs) { captured = true; break; }
      if (nr > RINF && dot(p, v) > 0.0) break;
      if (alpha > 0.995) break;
    }
    if (captured && !hasDepth) { hasDepth = true; depthP = p; }
    dir = normalize(v);
  }

  vec3 sky = captured ? vec3(0.0) : skyColor(dir);
  vec3 outc = col + (1.0 - alpha) * sky;
  gl_FragColor = vec4(outc, 1.0);

  float depth = 1.0;
  if (hasDepth) {
    vec4 cp = uViewProj * vec4(depthP, 1.0);
    if (cp.w > 0.0) depth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
  }
  gl_FragDepth = depth;
}
`;

// ---------------------------------------------------------------------------
// Disk noise lattice. fbm4() samples value noise at
//   p0 = (r·1.7/Rs, 2.6·cos a, 2.6·sin a),  p(k+1) = 2.07·p(k) + (3.1, 1.7, 5.3)
// for four octaves, so the lattice points it can touch lie in a fixed box. We
// store hash13() at every one of them (computed in 32-bit float, like the GPU).
// ---------------------------------------------------------------------------
const f32 = Math.fround;
const fract32 = (x) => f32(x - Math.floor(x));
function hash13(x, y, z) {
  let a = fract32(f32(x * f32(0.1031))), b = fract32(f32(y * f32(0.1031))), c = fract32(f32(z * f32(0.1031)));
  const d = f32(f32(f32(a * f32(c + f32(31.32))) + f32(b * f32(b + f32(31.32)))) + f32(c * f32(a + f32(31.32))));
  a = f32(a + d); b = f32(b + d); c = f32(c + d);
  return fract32(f32(f32(a + b) * c));
}

function bakeDiskNoise() {
  let lo = [DISK_IN * 0.9 * 1.7 / RS, -2.6, -2.6];
  let hi = [DISK_OUT * 1.7 / RS, 2.6, 2.6];
  const min = [...lo], max = [...hi];
  const off = [3.1, 1.7, 5.3];
  for (let k = 1; k < 4; k++) {
    lo = lo.map((v, i) => v * 2.07 + off[i]);
    hi = hi.map((v, i) => v * 2.07 + off[i]);
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], lo[i]); max[i] = Math.max(max[i], hi[i]); }
  }
  const o = min.map((v) => Math.floor(v) - 1);
  const size = max.map((v, i) => Math.ceil(v) + 2 - o[i]);
  const [W, H, D] = size;
  const data = new Uint16Array(W * H * D);
  for (let z = 0; z < D; z++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) data[x + W * (y + H * z)] = THREE.DataUtils.toHalfFloat(hash13(x + o[0], y + o[1], z + o[2]));
    }
  }
  const tex = new THREE.Data3DTexture(data, W, H, D);
  tex.format = THREE.RedFormat;
  tex.type = THREE.HalfFloatType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return { tex, min: new THREE.Vector3(...o), invSize: new THREE.Vector3(1 / W, 1 / H, 1 / D) };
}

export function createBlackHole(renderer) {
  // --- bake the nebula into a cubemap once ---
  const cubeRT = new THREE.WebGLCubeRenderTarget(512, {
    type: THREE.HalfFloatType,
    generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter,
  });
  const cubeCam = new THREE.CubeCamera(1, 100, cubeRT);
  const skyScene = new THREE.Scene();
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: /* glsl */`varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
  });
  skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 64, 32), skyMat));
  cubeCam.update(renderer, skyScene);
  skyMat.dispose();

  const uniforms = {
    uCamPos: { value: new THREE.Vector3() },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uViewProj: { value: new THREE.Matrix4() },
    uTime: { value: 0 },
    uSky: { value: cubeRT.texture },
    uRs: { value: RS },
    uDiskIn: { value: DISK_IN },
    uDiskOut: { value: DISK_OUT },
    uPx: { value: 0.001 },
    uDiskGain: { value: 1.0 },
    uNoise: { value: null },
    uNoiseMin: { value: new THREE.Vector3() },
    uNoiseInvSize: { value: new THREE.Vector3() },
  };
  const noise = bakeDiskNoise();
  uniforms.uNoise.value = noise.tex;
  uniforms.uNoiseMin.value.copy(noise.min);
  uniforms.uNoiseInvSize.value.copy(noise.invSize);

  const material = new THREE.ShaderMaterial({
    vertexShader: BH_VERT,
    fragmentShader: BH_FRAG,
    uniforms,
    depthWrite: true,
    depthTest: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;

  const _vp = new THREE.Matrix4();

  function update(camera, time, heightPx) {
    camera.updateMatrixWorld();
    uniforms.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    uniforms.uCamWorld.value.copy(camera.matrixWorld);
    _vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniforms.uViewProj.value.copy(_vp);
    uniforms.uTime.value = time;
    uniforms.uPx.value = THREE.MathUtils.degToRad(camera.fov) / heightPx;
  }

  return { mesh, update, skyTexture: cubeRT.texture, uniforms };
}
