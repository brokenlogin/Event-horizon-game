// Fully synthesized sound — no audio assets.

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = this.ctx = new AC();

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -16;
    this.comp.ratio.value = 6;
    this.master = ctx.createGain();
    this.master.gain.value = 0.7;
    this.master.connect(this.comp).connect(ctx.destination);

    // shared noise buffer
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // engine rumble loop
    const thrustSrc = ctx.createBufferSource();
    thrustSrc.buffer = this.noise; thrustSrc.loop = true;
    this.thrustFilter = ctx.createBiquadFilter();
    this.thrustFilter.type = 'lowpass'; this.thrustFilter.frequency.value = 300; this.thrustFilter.Q.value = 1.5;
    this.thrustGain = ctx.createGain(); this.thrustGain.gain.value = 0;
    thrustSrc.connect(this.thrustFilter).connect(this.thrustGain).connect(this.master);
    thrustSrc.start();

    // RCS hiss
    const rcsSrc = ctx.createBufferSource();
    rcsSrc.buffer = this.noise; rcsSrc.loop = true; rcsSrc.loopStart = 0.5;
    const rcsF = ctx.createBiquadFilter(); rcsF.type = 'highpass'; rcsF.frequency.value = 2500;
    this.rcsGain = ctx.createGain(); this.rcsGain.gain.value = 0;
    rcsSrc.connect(rcsF).connect(this.rcsGain).connect(this.master);
    rcsSrc.start();

    // black hole drone
    this.droneGain = ctx.createGain(); this.droneGain.gain.value = 0.0;
    const droneF = ctx.createBiquadFilter(); droneF.type = 'lowpass'; droneF.frequency.value = 180;
    this.droneFilter = droneF;
    droneF.connect(this.droneGain).connect(this.master);
    for (const [f, type, g] of [[36.7, 'sawtooth', 0.35], [55.0, 'sine', 0.5], [36.9 * 1.5, 'triangle', 0.2]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = g;
      o.connect(og).connect(droneF); o.start();
    }
    // missile lock tone (steady warble while locked)
    this.lockGain = ctx.createGain(); this.lockGain.gain.value = 0;
    const lockOsc = ctx.createOscillator(); lockOsc.type = 'square'; lockOsc.frequency.value = 1760;
    const lockF = ctx.createBiquadFilter(); lockF.type = 'lowpass'; lockF.frequency.value = 2600;
    const lockLfo = ctx.createOscillator(); lockLfo.frequency.value = 12;
    const lockLfoG = ctx.createGain(); lockLfoG.gain.value = 60;
    lockLfo.connect(lockLfoG).connect(lockOsc.frequency);
    lockOsc.connect(lockF).connect(this.lockGain).connect(this.master);
    lockOsc.start(); lockLfo.start();

    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.13;
    const lfoG = ctx.createGain(); lfoG.gain.value = 60;
    lfo.connect(lfoG).connect(droneF.frequency); lfo.start();
  }

  _env(gainNode, t, peak, attack, decay) {
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.exponentialRampToValueAtTime(peak, t + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _pan(p) {
    const ctx = this.ctx;
    if (ctx.createStereoPanner) { const s = ctx.createStereoPanner(); s.pan.value = p; return s; }
    return ctx.createGain();
  }

  laser(pan = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.12);
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth';
    o2.frequency.setValueAtTime(760, t);
    o2.frequency.exponentialRampToValueAtTime(90, t + 0.15);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 3200;
    const g = ctx.createGain(); this._env(g, t, 0.09, 0.004, 0.13);
    const p = this._pan(pan);
    o.connect(f); o2.connect(f); f.connect(g).connect(p).connect(this.master);
    o.start(t); o2.start(t); o.stop(t + 0.2); o2.stop(t + 0.2);
  }

  enemyLaser(vol = 1, heavy = false) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(heavy ? 420 : 900, t);
    o.frequency.exponentialRampToValueAtTime(heavy ? 50 : 110, t + 0.22);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = heavy ? 500 : 1100; f.Q.value = 2;
    const g = ctx.createGain(); this._env(g, t, 0.12 * vol, 0.005, 0.22);
    o.connect(f).connect(g).connect(this.master);
    o.start(t); o.stop(t + 0.3);
  }

  /** Lancer charging: a short rising tick; `level` 0..1 is how far along the charge is. */
  chargeTick(level = 0, vol = 1, locked = false) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = locked ? 'square' : 'triangle';
    const f0 = 300 + level * 900;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f0 * 1.25, t + 0.07);
    const g = ctx.createGain(); this._env(g, t, (locked ? 0.07 : 0.05) * vol, 0.004, 0.08);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.12);
  }

  /** Lancer beam: a hard crack with a falling hiss. */
  beam(vol = 1) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(2200, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.35);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 4000;
    const g = ctx.createGain(); this._env(g, t, 0.16 * vol, 0.002, 0.35);
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + 0.4);
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 1800;
    const ng = ctx.createGain(); this._env(ng, t, 0.2 * vol, 0.002, 0.3);
    src.connect(nf).connect(ng).connect(this.master); src.start(t, Math.random()); src.stop(t + 0.35);
  }

  explosion(size = 1, vol = 1) {
    if (!this.ctx || vol < 0.02) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(2400 * Math.min(size, 1.5), t);
    f.frequency.exponentialRampToValueAtTime(70, t + 1.0 * size);
    const g = ctx.createGain(); this._env(g, t, 0.75 * vol, 0.01, 1.1 * size);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + 1.5 * size);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.6 * size);
    const og = ctx.createGain(); this._env(og, t, 0.8 * vol, 0.005, 0.7 * size);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + size);
  }

  hit(shield = true) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = shield ? 'bandpass' : 'lowpass'; f.frequency.value = shield ? 1800 : 600; f.Q.value = 1;
    const g = ctx.createGain(); this._env(g, t, shield ? 0.35 : 0.6, 0.003, shield ? 0.18 : 0.3);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + 0.4);
    const o = ctx.createOscillator(); o.type = shield ? 'sine' : 'square';
    o.frequency.setValueAtTime(shield ? 1200 : 180, t); o.frequency.exponentialRampToValueAtTime(shield ? 400 : 60, t + 0.15);
    const og = ctx.createGain(); this._env(og, t, 0.15, 0.003, 0.15);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.2);
  }

  hitConfirm() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(2400, t);
    const g = ctx.createGain(); this._env(g, t, 0.05, 0.002, 0.05);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.08);
  }

  beep(freq = 880, dur = 0.08, vol = 0.08, type = 'square') {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const g = ctx.createGain(); this._env(g, t, vol, 0.003, dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }

  uiHover() { this.beep(1400, 0.04, 0.03, 'sine'); }
  uiClick() { this.beep(700, 0.06, 0.06, 'triangle'); setTimeout(() => this.beep(1050, 0.08, 0.05, 'triangle'), 50); }

  warp() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(60, t); o.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
    const g = ctx.createGain(); this._env(g, t, 0.06, 0.3, 0.4);
    o.connect(f).connect(g).connect(this.master); o.start(t); o.stop(t + 0.8);
  }

  waveStart() {
    if (!this.ctx) return;
    [0, 0.12, 0.24].forEach((d, i) => setTimeout(() => this.beep([440, 554, 880][i], 0.25, 0.07, 'sawtooth'), d * 1000));
  }

  waveClear() {
    if (!this.ctx) return;
    [0, 0.1, 0.2, 0.3].forEach((d, i) => setTimeout(() => this.beep([523, 659, 784, 1046][i], 0.3, 0.06, 'triangle'), d * 1000));
  }

  pickup() {
    if (!this.ctx) return;
    [0, 0.07, 0.14].forEach((d, i) => setTimeout(() => this.beep([880, 1320, 1760][i], 0.12, 0.06, 'sine'), d * 1000));
  }

  purchase() {
    if (!this.ctx) return;
    this.beep(660, 0.08, 0.06, 'triangle');
    setTimeout(() => this.beep(990, 0.14, 0.06, 'triangle'), 70);
  }

  dockClamp() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const g = ctx.createGain(); this._env(g, t, 0.5, 0.005, 0.35);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + 0.5);
    const o = ctx.createOscillator(); o.type = 'square';
    o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(60, t + 0.25);
    const og = ctx.createGain(); this._env(og, t, 0.12, 0.005, 0.25);
    o.connect(og).connect(this.master); o.start(t); o.stop(t + 0.3);
  }

  alarm() {
    if (!this.ctx) return;
    [0, 0.25, 0.5].forEach((d) => setTimeout(() => {
      this.beep(740, 0.16, 0.07, 'sawtooth');
      setTimeout(() => this.beep(555, 0.16, 0.07, 'sawtooth'), 110);
    }, d * 1000));
  }

  setLockTone(on) {
    if (!this.ctx) return;
    this.lockGain.gain.setTargetAtTime(on ? 0.035 : 0, this.ctx.currentTime, 0.02);
  }

  missileLaunch() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 0.8;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
    f.frequency.exponentialRampToValueAtTime(500, t + 1.4);
    const g = ctx.createGain(); this._env(g, t, 0.55, 0.03, 1.4);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random()); src.stop(t + 1.6);
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(90, t); o.frequency.exponentialRampToValueAtTime(240, t + 0.5);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const og = ctx.createGain(); this._env(og, t, 0.18, 0.02, 0.6);
    o.connect(lp).connect(og).connect(this.master); o.start(t); o.stop(t + 0.7);
  }

  setEngine(thrust, rcs) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.thrustGain.gain.setTargetAtTime(0.03 + thrust * 0.32, t, 0.06);
    this.thrustFilter.frequency.setTargetAtTime(180 + thrust * 520, t, 0.08);
    this.rcsGain.gain.setTargetAtTime(rcs * 0.05, t, 0.04);
  }

  setDrone(proximity) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.droneGain.gain.setTargetAtTime(0.06 + proximity * 0.5, t, 0.3);
  }

  silenceEngine() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.thrustGain.gain.setTargetAtTime(0, t, 0.1);
    this.rcsGain.gain.setTargetAtTime(0, t, 0.1);
    this.lockGain.gain.setTargetAtTime(0, t, 0.02);
  }
}
