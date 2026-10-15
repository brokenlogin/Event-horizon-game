// ---------------------------------------------------------------------------
// Upgrades bought with salvaged scrap while docked at the station.
// ---------------------------------------------------------------------------

import { TECH, TECH_KEYS, MK2_COST, mk2Ready, techOwned } from './techtree.js';

export const UPGRADES = [
  { id: 'damage', name: 'CANNON OVERCHARGE', desc: '+25% cannon damage per level', costs: [30, 60, 100, 150] },
  { id: 'missileCap', name: 'MISSILE RACKS', desc: '+1 missile carried per wave', costs: [40, 80, 130] },
  { id: 'missileSpeed', name: 'MISSILE BOOSTERS', desc: '+30% missile thrust and top speed, +200 m lock range', costs: [35, 70, 120] },
  { id: 'shieldRegen', name: 'SHIELD CAPACITORS', desc: '+40% shield regen, shorter recharge delay', costs: [25, 50, 90, 140] },
  { id: 'hull', name: 'HULL PLATING', desc: '+25 maximum hull per level', costs: [35, 70, 110, 160] },
  { id: 'repair', name: 'NANITE REPAIR', desc: 'Hull repairs itself: +0.75% of max hull per second per level', costs: [45, 90, 140, 200] },
];

export function newUpgradeLevels() {
  const l = { mk2: 0 };
  for (const u of UPGRADES) l[u.id] = 0;
  for (const k of TECH_KEYS) if (!(k in l)) l[k] = 0;
  return l;
}

export const REPAIR_HP_PER_SCRAP = 4;
export const REARM_COST = 8;
export const REVIVE_COST = 100;

/** Price of the next level of an upgrade, with the crew-size multiplier applied. */
export function upgradeCost(u, lvl, mult = 1) {
  return lvl < u.costs.length ? Math.round(u.costs[lvl] * mult) : null;
}

const $ = (id) => document.getElementById(id);

/**
 * Docked UI. Callbacks: buy(id), repair(), rearm(), undock(), callWave()
 * view(): returns { scrap, levels, hull, maxHull, ammo, capacity, waveTimer, waveActive, hostiles, underAttack, costMult, dead: [{id, name}] }
 */
export class StationUI {
  constructor(callbacks, view, audio) {
    this.cb = callbacks;
    this.view = view;
    this.audio = audio;
    this.root = $('station');
    this.list = $('st-upgrades');
    this.lastKey = '';
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b || b.disabled) return;
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === 'buy') this.cb.buy(b.dataset.id);
      else if (act === 'revive') this.cb.revive(Number(b.dataset.id));
      else if (this.cb[act]) this.cb[act]();
      this.render(true);
    });
    this.root.addEventListener('mouseover', (e) => {
      const b = e.target.closest('button');
      if (b && b !== this._hover && !b.disabled) { this._hover = b; audio.uiHover(); }
    });
  }

  show() { this.root.classList.remove('hidden'); this.render(true); }

  /** The MK2 ship: offered once Missile Racks and Hull Plating are both maxed. */
  mk2Offer(v) {
    const ready = mk2Ready(v.levels);
    const cost = Math.round(MK2_COST * (v.costMult || 1));
    const need = [];
    if (v.levels.missileCap < 3) need.push('MISSILE RACKS');
    if (v.levels.hull < 4) need.push('HULL PLATING');
    const btn = ready
      ? `<button class="st-buy mk2" data-act="buy" data-id="mk2" ${v.scrap < cost ? 'disabled' : ''}>${cost} <span>SCRAP</span></button>`
      : '<button class="st-buy" disabled>LOCKED</button>';
    return `<div class="st-item mk2${ready ? ' ready' : ''}"><div class="st-info"><div class="st-name">UPGRADE TO MK2 SHIP</div>`
      + '<div class="st-desc">+50% engine power · keeps your upgrades · unlocks the TECH TREE</div>'
      + (ready ? '' : `<div class="st-desc need">Max out ${need.join(' and ')} first</div>`) + `</div>${btn}</div>`;
  }
  hide() { this.root.classList.add('hidden'); }
  get visible() { return !this.root.classList.contains('hidden'); }

  render(force = false) {
    const v = this.view();
    // static-ish content: only rebuild when something purchasable changed
    const key = JSON.stringify([v.scrap, v.levels, Math.ceil(v.hull), v.maxHull, v.ammo, v.capacity, v.costMult, v.dead]);
    if (force || key !== this.lastKey) {
      this.lastKey = key;
      $('st-scrap').textContent = v.scrap;
      $('st-hull').textContent = `${Math.ceil(v.hull)} / ${v.maxHull}`;
      $('st-ammo').textContent = `${v.ammo} / ${v.capacity}`;
      if (v.levels.mk2) {
        // MK2: the tech tree replaces the upgrade list
        const owned = TECH.filter((n) => techOwned(v.levels, n)).length;
        this.list.innerHTML = `<div class="st-item mk2-owned"><div class="st-info"><div class="st-name">MK2 TECH TREE</div>`
          + `<div class="st-desc">${owned} / ${TECH.length} researched · weapons, missiles, defense, engineering</div></div>`
          + '<button class="st-buy" data-act="openTree">OPEN <span>TREE</span></button></div>';
      } else this.list.innerHTML = UPGRADES.map((u) => {
        const lvl = v.levels[u.id];
        const max = u.costs.length;
        const cost = upgradeCost(u, lvl, v.costMult || 1);
        const pips = Array.from({ length: max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('');
        const btn = cost === null
          ? '<button class="st-buy" disabled>MAXED</button>'
          : `<button class="st-buy" data-act="buy" data-id="${u.id}" ${v.scrap < cost ? 'disabled' : ''}>${cost} <span>SCRAP</span></button>`;
        return `<div class="st-item"><div class="st-info"><div class="st-name">${u.name}</div><div class="st-desc">${u.desc}</div><div class="st-pips">${pips}</div></div>${btn}</div>`;
      }).join('') + this.mk2Offer(v);
      // fallen wingmates (multiplayer)
      const rev = $('st-revive');
      const dead = v.dead || [];
      rev.classList.toggle('hidden', dead.length === 0);
      $('st-revive-list').innerHTML = dead.map((d) => `<div class="st-item"><div class="st-info"><div class="st-name">${d.name}</div><div class="st-desc">Destroyed — waiting for a revive</div></div><button class="st-buy revive" data-act="revive" data-id="${d.id}" ${v.scrap < REVIVE_COST ? 'disabled' : ''}>${REVIVE_COST} <span>SCRAP</span></button></div>`).join('');
      $('st-cost-note').textContent = v.costMult > 1 ? `CREW PRICING ×${v.costMult.toFixed(1)}` : '';
      const missing = Math.max(0, v.maxHull - v.hull);
      const repairCost = Math.ceil(missing / REPAIR_HP_PER_SCRAP);
      const rb = $('st-repair');
      rb.textContent = missing < 1 ? 'HULL INTACT' : `REPAIR HULL · ${repairCost} SCRAP`;
      rb.disabled = missing < 1 || v.scrap < 1;
      const need = v.capacity - v.ammo;
      const ab = $('st-rearm');
      ab.textContent = need <= 0 ? 'MISSILES FULL' : `REARM ${need} MISSILE${need > 1 ? 'S' : ''} · ${need * REARM_COST} SCRAP`;
      ab.disabled = need <= 0 || v.scrap < need * REARM_COST;
    }
    // live status line
    const w = $('st-wave');
    if (v.waveActive) {
      w.textContent = `⚠ WAVE IN PROGRESS · ${v.hostiles} HOSTILE${v.hostiles === 1 ? '' : 'S'}`;
      w.className = 'st-wave red';
    } else if (v.waveTimer > 0) {
      const t = Math.ceil(v.waveTimer);
      w.textContent = `NEXT WAVE IN ${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
      w.className = `st-wave${t <= 20 ? ' red' : t <= 45 ? ' orange' : ''}`;
    }
    $('st-alert').classList.toggle('hidden', !v.underAttack);
    $('btn-callwave').disabled = v.waveActive || v.waveTimer <= 6;
  }
}
