import * as THREE from 'three';
import { occludedByHole } from './physics.js';

const $ = (id) => document.getElementById(id);
const _v = new THREE.Vector3();
const _cam = new THREE.Vector3();

export class HUD {
  constructor() {
    this.root = $('hud');
    this.el = {
      score: $('score'), wave: $('wave'), mult: $('mult'), hostiles: $('hostiles'),
      alt: $('t-alt'), vel: $('t-vel'), vc: $('t-vc'), pe: $('t-pe'), ap: $('t-ap'), per: $('t-per'), state: $('t-state'),
      shield: $('b-shield'), hull: $('b-hull'), heat: $('b-heat'),
      crosshair: $('crosshair'), hitmarker: $('hitmarker'), lead: $('leadpip'),
      prograde: $('prograde'), retrograde: $('retrograde'),
      peLabel: $('pe-label'), apLabel: $('ap-label'),
      warnings: $('warnings'), banner: $('banner'), bannerTitle: $('banner-title'), bannerSub: $('banner-sub'),
      popups: $('popups'), markers: $('markers'),
      lockring: $('lockring'), lockLabel: document.querySelector('#lockring .lr-label'), notice: $('notice'),
      mpWrap: document.querySelector('.missile-pips'), lockStatus: $('lock-status'),
      linkRow: $('link-row'), link: $('link'),
      scrap: $('scrap'), waveTimer: $('wave-timer'), stationMarker: $('station-marker'), stationLabel: document.querySelector('#station-marker .sm-label'),
      stationArrow: $('station-arrow'), relPro: $('rel-pro'), relRetro: $('rel-retro'), dockHint: $('dock-hint'),
      thF: $('th-f'), thL: $('th-l'), thR: $('th-r'), thU: $('th-u'), thD: $('th-d'),
    };
    this.radar = $('radar');
    this.markerPool = [];
    this.arrowPool = [];
    this.warnKeys = '';
    this.bannerTimer = null;
    this.hitTimer = null;
    this.lastScore = -1;
  }

  show(v) { this.root.classList.toggle('hidden', !v); }

  /** Project a world point. Returns {x, y, onScreen, behind}. */
  project(p, camera, out) {
    _v.copy(p).project(camera);
    _cam.copy(p).applyMatrix4(camera.matrixWorldInverse);
    out.behind = _cam.z > 0;
    out.x = (_v.x * 0.5 + 0.5) * innerWidth;
    out.y = (-_v.y * 0.5 + 0.5) * innerHeight;
    out.ndcX = _v.x; out.ndcY = _v.y;
    out.onScreen = !out.behind && Math.abs(_v.x) <= 1 && Math.abs(_v.y) <= 1;
    return out;
  }

  place(el, p, camera, keepIfBehind = false) {
    const s = this.project(p, camera, this._tmpP || (this._tmpP = {}));
    if (s.behind && !keepIfBehind) { el.style.display = 'none'; return false; }
    el.style.display = 'block';
    el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    el.style.left = '0'; el.style.top = '0';
    return true;
  }

  setScore(score, wave, mult, hostiles) {
    if (score !== this.lastScore) { this.el.score.textContent = score.toLocaleString(); this.lastScore = score; }
    this.el.wave.textContent = wave;
    this.el.mult.textContent = mult > 1 ? `×${mult}` : '';
    this.el.hostiles.textContent = hostiles;
  }

  setBars(shield, hull, heat, overheated) {
    this.el.shield.style.transform = `scaleX(${Math.max(0, shield)})`;
    this.el.hull.style.transform = `scaleX(${Math.max(0, hull)})`;
    this.el.hull.classList.toggle('low', hull < 0.3);
    this.el.heat.style.transform = `scaleX(${Math.max(0, heat)})`;
    this.el.heat.classList.toggle('over', overheated);
    this.el.crosshair.classList.toggle('overheat', overheated);
  }

  notice(text, color = '') {
    const n = this.el.notice;
    n.textContent = text;
    n.className = `show ${color}`;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { n.className = color; }, 1400);
  }

  setMissiles(ammo, capacity, lock, camera) {
    if (this._mpCap !== capacity) {
      this._mpCap = capacity;
      this.el.mpWrap.innerHTML = '<i></i>'.repeat(capacity);
    }
    Array.from(this.el.mpWrap.children).forEach((p, i) => p.classList.toggle('on', i < ammo));
    const st = this.el.lockStatus;
    const sal = lock.kind === 'salvage';
    st.textContent = lock.state === 'locked' ? (sal ? 'SALVAGE LOCK' : 'LOCKED') : lock.state === 'locking' ? `LOCK ${Math.round(lock.progress * 100)}%` : '';
    st.className = `lock-status${lock.state === 'locked' ? ' locked' : ''}`;
    const ring = this.el.lockring;
    if (lock.state === 'idle' || !lock.target) { ring.style.display = 'none'; return; }
    const s = this.project(lock.target.pos, camera, this._lp || (this._lp = {}));
    if (!s.onScreen) { ring.style.display = 'none'; return; }
    const size = lock.state === 'locked' ? 54 : 150 - 90 * lock.progress;
    ring.style.display = 'block';
    ring.style.left = `${s.x}px`;
    ring.style.top = `${s.y}px`;
    ring.style.width = ring.style.height = `${size}px`;
    ring.className = `${lock.state === 'locked' ? 'locked' : ''}${sal ? ' salvage' : ''}`;
    ring.firstElementChild.style.transform = lock.state === 'locked' ? '' : `rotate(${lock.progress * 270}deg)`;
    this.el.lockLabel.textContent = lock.state === 'locked' ? (sal ? 'SALVAGE · Q TO LAUNCH DRONE' : 'LOCK · Q TO FIRE') : (sal ? 'SALVAGE LOCK' : 'LOCKING');
  }

  setThrusters(f, l, r, u, d) {
    this.el.thF.classList.toggle('on', f); this.el.thL.classList.toggle('on', l);
    this.el.thR.classList.toggle('on', r); this.el.thU.classList.toggle('on', u); this.el.thD.classList.toggle('on', d);
  }

  setTelemetry(t) {
    const e = this.el;
    e.alt.textContent = `${t.alt.toFixed(0)} m`;
    e.vel.textContent = `${t.vel.toFixed(1)} m/s`;
    e.vc.textContent = `${t.vc.toFixed(1)} m/s`;
    e.pe.textContent = t.pe;
    e.pe.className = t.peClass;
    e.ap.textContent = t.ap;
    e.per.textContent = t.period;
    e.state.textContent = t.state;
    e.state.className = 'tel-state ' + t.stateClass;
  }

  setWarnings(list) {
    const key = list.map((w) => w.text).join('|');
    if (key === this.warnKeys) return;
    this.warnKeys = key;
    this.el.warnings.innerHTML = list.map((w) => `<div class="warning ${w.color}">${w.text}</div>`).join('');
  }

  banner(title, sub = '', duration = 2600) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.textContent = sub;
    this.el.banner.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.el.banner.classList.remove('show'), duration);
  }

  hideBanner() { this.el.banner.classList.remove('show'); clearTimeout(this.bannerTimer); }

  hitmarker(kill = false) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'kill');
    void h.offsetWidth;
    h.classList.add('show');
    if (kill) h.classList.add('kill');
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => h.classList.remove('show', 'kill'), kill ? 220 : 90);
  }

  popup(x, y, text, sub = '') {
    const d = document.createElement('div');
    d.className = 'popup';
    d.style.left = `${x}px`; d.style.top = `${y}px`;
    d.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.el.popups.appendChild(d);
    setTimeout(() => d.remove(), 1350);
  }

  clearPopups() { this.el.popups.innerHTML = ''; }

  // ---------------------------------------------------------------------
  // Target markers & off-screen arrows
  // ---------------------------------------------------------------------
  updateMarkers(enemies, camera, playerPos, lockedEnemy) {
    let mi = 0, ai = 0;
    const s = this._mp || (this._mp = {});
    for (const e of enemies) {
      if (!e.alive) continue;
      const ep = e.renderPos;
      this.project(ep, camera, s);
      const dist = ep.distanceTo(playerPos);
      if (s.onScreen) {
        let m = this.markerPool[mi];
        if (!m) {
          m = document.createElement('div');
          m.className = 'tmark';
          m.innerHTML = '<div class="box"></div><div class="hp"><i></i></div><div class="dist"></div>';
          this.el.markers.appendChild(m);
          m._hp = m.querySelector('.hp i');
          m._dist = m.querySelector('.dist');
          this.markerPool.push(m);
        }
        mi++;
        const size = e.def.boss
          ? THREE.MathUtils.clamp(26000 / Math.max(dist, 1), 60, 420)
          : THREE.MathUtils.clamp(2400 / Math.max(dist, 1), 22, 90);
        m.style.display = 'block';
        m.style.width = m.style.height = `${size}px`;
        m.style.left = `${s.x}px`; m.style.top = `${s.y}px`;
        const hidden = occludedByHole(camera.position, e.pos, 2.4);
        const cls = `tmark ${e.type}${e === lockedEnemy ? ' locked' : ''}${hidden ? ' occluded' : ''}`;
        if (m.className !== cls) m.className = cls;
        m._hp.style.width = `${(e.hp / (e.maxHp || e.def.hp)) * 100}%`;
        m._dist.textContent = hidden ? `${dist.toFixed(0)}m · BEHIND HOLE` : `${dist.toFixed(0)}m`;
      } else {
        let a = this.arrowPool[ai];
        if (!a) {
          a = document.createElement('div');
          this.el.markers.appendChild(a);
          this.arrowPool.push(a);
        }
        ai++;
        let x = s.ndcX, y = s.ndcY;
        if (s.behind) { x = -x; y = -y; }
        const ang = Math.atan2(y, x);
        const rx = innerWidth * 0.5 - 50, ry = innerHeight * 0.5 - 50;
        const px = innerWidth * 0.5 + Math.cos(ang) * rx;
        const py = innerHeight * 0.5 - Math.sin(ang) * ry;
        a.className = `edge-arrow ${e.type}`;
        a.style.display = 'block';
        a.style.left = `${px - 9}px`; a.style.top = `${py - 9}px`;
        a.style.transform = `rotate(${-ang + Math.PI / 2}rad)`;
        a.style.opacity = THREE.MathUtils.clamp(1.4 - dist / 900, 0.35, 1);
      }
    }
    for (let i = mi; i < this.markerPool.length; i++) this.markerPool[i].style.display = 'none';
    for (let i = ai; i < this.arrowPool.length; i++) this.arrowPool[i].style.display = 'none';
  }

  /** Dreadnought health bar (top centre). info: { hp, maxHp, turrets, total } or null. */
  setBoss(info) {
    const el = this._boss || (this._boss = {
      root: $('boss-bar'), fill: $('bb-fill'), turrets: $('bb-turrets'),
    });
    if (!info) { if (el.shown) { el.root.style.display = 'none'; el.shown = false; } return; }
    if (!el.shown) { el.root.style.display = 'block'; el.shown = true; }
    el.fill.style.transform = `scaleX(${Math.max(0, info.hp / info.maxHp)})`;
    const txt = info.turrets ? `TURRETS ${info.turrets} / ${info.total}` : 'TURRETS SILENCED';
    if (el.turrets.textContent !== txt) el.turrets.textContent = txt;
  }

  /** Small markers for dreadnought missiles and turrets. items: [{ pos, kind: 'missile' | 'missile me' | 'turret' }] */
  updateThreats(items, camera, playerPos) {
    const pool = this.threatPool || (this.threatPool = []);
    const s = this._tp || (this._tp = {});
    let n = 0;
    for (const it of items) {
      this.project(it.pos, camera, s);
      if (!s.onScreen) continue;
      let m = pool[n];
      if (!m) {
        m = document.createElement('div');
        m.innerHTML = '<i></i><span></span>';
        m._label = m.querySelector('span');
        this.el.markers.appendChild(m);
        pool.push(m);
      }
      n++;
      const cls = `threat-mark ${it.kind}`;
      if (m.className !== cls) m.className = cls;
      m.style.display = 'block';
      m.style.left = `${s.x}px`; m.style.top = `${s.y}px`;
      const label = it.kind === 'turret' ? '' : `${Math.round(it.pos.distanceTo(playerPos))}m`;
      if (m._label.textContent !== label) m._label.textContent = label;
    }
    for (let i = n; i < pool.length; i++) pool[i].style.display = 'none';
  }

  setAutopilot(s) {
    const el = this.el.autopilot || (this.el.autopilot = document.getElementById('autopilot'));
    if (!s) { el.style.display = 'none'; return; }
    const phase = s.mode === 'terminal' ? 'FINAL APPROACH' : (s.burning ? 'TRANSFER BURN' : 'COASTING TO INTERCEPT');
    const html = `DOCKING ASSIST · ${phase}<small>${s.dist.toFixed(0)} m · Δv ${s.rel.toFixed(0)} m/s · ETA ~${Math.max(1, Math.round(s.eta))} s · [B] OFF</small>`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.style.display = 'block';
  }

  /** Link quality readout; pass null to hide (single player). */
  setLink(rttSec) {
    const el = this.el;
    if (rttSec === null) { el.linkRow.classList.add('hidden'); return; }
    el.linkRow.classList.remove('hidden');
    const ms = Math.round(rttSec * 1000);
    const txt = rttSec > 0 ? `${ms} ms` : '…';
    if (el.link.textContent !== txt) el.link.textContent = txt;
    el.link.className = ms > 250 ? 'bad' : ms > 150 ? 'warn' : '';
  }

  /** Markers for the other pilots (on screen) or edge arrows (off screen). */
  updateAllies(list, camera, playerPos) {
    this._allyPool = this._allyPool || [];
    const s = this._ap || (this._ap = {});
    let i = 0;
    for (const r of list) {
      if (!r.present || !r.alive) continue;
      let m = this._allyPool[i];
      if (!m) {
        m = { mark: document.createElement('div'), arrow: document.createElement('div') };
        m.mark.className = 'ally-marker';
        m.mark.innerHTML = '<div class="am-box"></div><div class="am-label"></div>';
        m.label = m.mark.lastChild;
        m.arrow.className = 'edge-arrow ally';
        this.el.markers.append(m.mark, m.arrow);
        this._allyPool.push(m);
      }
      i++;
      this.project(r.renderPos, camera, s);
      const dist = r.renderPos.distanceTo(playerPos);
      if (s.onScreen) {
        m.mark.style.display = 'block';
        m.arrow.style.display = 'none';
        m.mark.style.left = `${s.x}px`;
        m.mark.style.top = `${s.y}px`;
        const txt = `${r.name}${r.docked ? ' · DOCKED' : ''} · ${dist.toFixed(0)} m`;
        if (m.label.textContent !== txt) m.label.textContent = txt;
      } else {
        m.mark.style.display = 'none';
        let x = s.ndcX, y = s.ndcY;
        if (s.behind) { x = -x; y = -y; }
        const ang = Math.atan2(y, x);
        m.arrow.style.display = 'block';
        m.arrow.style.left = `${innerWidth * 0.5 + Math.cos(ang) * (innerWidth * 0.5 - 50) - 9}px`;
        m.arrow.style.top = `${innerHeight * 0.5 - Math.sin(ang) * (innerHeight * 0.5 - 50) - 9}px`;
        m.arrow.style.transform = `rotate(${-ang + Math.PI / 2}rad)`;
      }
    }
    for (let k = i; k < this._allyPool.length; k++) this._allyPool[k].mark.style.display = this._allyPool[k].arrow.style.display = 'none';
  }

  setScrap(n) {
    if (this._scrap !== n) { this._scrap = n; this.el.scrap.textContent = n; }
  }

  /** Countdown between waves. */
  setWaveTimer(seconds, docked) {
    const el = this.el.waveTimer;
    if (seconds <= 0) { el.style.display = 'none'; return; }
    const t = Math.ceil(seconds);
    const txt = `NEXT WAVE ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const sub = docked ? '' : t > 6 ? '<small>DOCK TO UPGRADE · [B] DOCKING ASSIST · [N] CALL EARLY</small>' : '';
    const html = `${txt}${sub}`;
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.className = t <= 10 ? 'red' : t <= 30 ? 'orange' : '';
    el.style.display = 'block';
  }

  /** Station marker, relative-velocity markers and docking guidance. */
  updateStation(station, player, camera, opts) {
    const el = this.el;
    if (!opts.show) {
      for (const k of ['stationMarker', 'stationArrow', 'relPro', 'relRetro', 'dockHint']) el[k].style.display = 'none';
      return;
    }
    const s = this.project(station.pos, camera, this._sp || (this._sp = {}));
    const dist = station.pos.distanceTo(player.pos);
    const rel = station.relativeSpeed(player);
    if (s.onScreen) {
      el.stationMarker.style.display = 'block';
      el.stationMarker.style.left = `${s.x}px`;
      el.stationMarker.style.top = `${s.y}px`;
      el.stationMarker.classList.toggle('ready', opts.canDock);
      el.stationLabel.innerHTML = `KEPLER STATION<br>${dist.toFixed(0)} m · Δv ${rel.toFixed(0)} m/s`;
      el.stationArrow.style.display = 'none';
    } else {
      el.stationMarker.style.display = 'none';
      let x = s.ndcX, y = s.ndcY;
      if (s.behind) { x = -x; y = -y; }
      const ang = Math.atan2(y, x);
      const px = innerWidth * 0.5 + Math.cos(ang) * (innerWidth * 0.5 - 50);
      const py = innerHeight * 0.5 - Math.sin(ang) * (innerHeight * 0.5 - 50);
      el.stationArrow.style.display = 'block';
      el.stationArrow.style.left = `${px - 9}px`;
      el.stationArrow.style.top = `${py - 9}px`;
      el.stationArrow.style.transform = `rotate(${-ang + Math.PI / 2}rad)`;
    }
    // relative velocity markers within rendezvous range
    if (dist < 2500 && rel > 1) {
      const dir = (this._rd || (this._rd = new THREE.Vector3())).subVectors(player.vel, station.vel).normalize();
      const pt = this._rpt || (this._rpt = new THREE.Vector3());
      const p = this._rp || (this._rp = {});
      this.project(pt.copy(camera.position).addScaledVector(dir, 500), camera, p);
      this._showAt(el.relPro, p);
      this.project(pt.copy(camera.position).addScaledVector(dir, -500), camera, p);
      this._showAt(el.relRetro, p);
    } else {
      el.relPro.style.display = el.relRetro.style.display = 'none';
    }
    if (dist < opts.dockRange * 3) {
      const dOk = dist < opts.dockRange, vOk = rel < opts.dockSpeed;
      el.dockHint.innerHTML = opts.needsClearance
        ? 'CLEAR THE STATION TO RE-ARM DOCKING CLAMPS'
        : `DOCKING · RANGE <b class="${dOk ? '' : 'bad'}">${dist.toFixed(0)}</b> / ${opts.dockRange} m · Δv <b class="${vOk ? '' : 'bad'}">${rel.toFixed(0)}</b> / ${opts.dockSpeed} m/s<br><span style="opacity:.7">${opts.assist ? 'DOCKING ASSIST FLYING' : 'BURN TOWARD ⊗ TO MATCH ITS VELOCITY · OR PRESS [B]'}</span>`;
      el.dockHint.style.display = 'block';
    } else {
      el.dockHint.style.display = 'none';
    }
  }

  _showAt(e, s) {
    if (!s.onScreen) { e.style.display = 'none'; return; }
    e.style.display = 'block';
    e.style.left = `${s.x}px`;
    e.style.top = `${s.y}px`;
  }

  updateWrecks(wrecks, camera, playerPos, collectRange) {
    this._wpool = this._wpool || [];
    let i = 0;
    const s = this._wp || (this._wp = {});
    for (const w of wrecks) {
      if (!w.alive) continue;
      const d = w.pos.distanceTo(playerPos);
      if (d > 2600) continue;
      this.project(w.pos, camera, s);
      if (!s.onScreen) continue;
      let m = this._wpool[i];
      if (!m) {
        m = document.createElement('div');
        m.className = 'wreck-mark';
        this.el.markers.appendChild(m);
        this._wpool.push(m);
      }
      i++;
      m.style.display = 'block';
      m.style.left = `${s.x}px`;
      m.style.top = `${s.y}px`;
      m.className = `wreck-mark${d < collectRange * 2 ? ' near' : ''}${w.life < 15 ? ' expiring' : ''}`;
      const html = `<i></i>SCRAP ${w.value} · ${d.toFixed(0)}m`;
      if (m._html !== html) { m.innerHTML = html; m._html = html; }
    }
    for (let k = i; k < this._wpool.length; k++) this._wpool[k].style.display = 'none';
  }

  hideMarkers() {
    if (this._wpool) for (const m of this._wpool) m.style.display = 'none';
    for (const k of ['stationMarker', 'stationArrow', 'relPro', 'relRetro', 'dockHint', 'waveTimer']) this.el[k].style.display = 'none';
    if (this._allyPool) for (const m of this._allyPool) m.mark.style.display = m.arrow.style.display = 'none';
    const ap = document.getElementById('autopilot'); if (ap) ap.style.display = 'none';
    for (const m of this.markerPool) m.style.display = 'none';
    for (const a of this.arrowPool) a.style.display = 'none';
    for (const k of ['lead', 'prograde', 'retrograde', 'peLabel', 'apLabel', 'lockring']) this.el[k].style.display = 'none';
  }

}
