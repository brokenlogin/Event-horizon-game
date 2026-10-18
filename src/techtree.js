// ---------------------------------------------------------------------------
// MK2 tech tree. Buying the MK2 ship replaces the upgrade list with this tree.
//
// Every node is "level `lvl` of stat `key`", so ownership is simply
// levels[key] >= lvl. The original upgrades (Cannon Overcharge, Missile Racks…)
// are the first tiers of their chains, which is how MK2 keeps what you had.
// Levels live in the same shared object as before, so multiplayer sync and the
// shared economy need nothing new.
// ---------------------------------------------------------------------------

export const MK2_COST = 300;

export const BRANCHES = [
  { id: 'weapons', name: 'WEAPONS', color: '#ff7a5a', bx: 0, by: 0 },
  { id: 'missiles', name: 'MISSILES', color: '#ffad4a', bx: 1, by: 0 },
  { id: 'defense', name: 'DEFENSE', color: '#5ef2ff', bx: 0, by: 1 },
  { id: 'engineering', name: 'ENGINEERING', color: '#6dff9a', bx: 1, by: 1 },
];

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];
const nodes = [];
/** A chain of tiers of one stat, stacked down one lane. */
function chain(branch, lane, row0, key, name, desc, costs, firstReq = [], kind = 'stat') {
  costs.forEach((cost, i) => {
    const lvl = i + 1;
    nodes.push({
      id: `${key}${lvl}`, key, lvl, branch, lane, row: row0 + i, cost, kind,
      name: costs.length > 1 ? `${name} ${ROMAN[lvl]}` : name,
      desc,
      req: i === 0 ? firstReq : [`${key}${lvl - 1}`],
    });
  });
}

// --- weapons ---
chain('weapons', 0, 0, 'damage', 'CANNON OVERCHARGE', '+25% cannon damage', [30, 60, 100, 150, 220, 300]);
chain('weapons', 1, 2, 'rapid', 'RAPID CYCLERS', '+15% cannon fire rate', [120, 200], ['damage2']);
chain('weapons', 2, 3, 'heatsink', 'HEAT SINKS', '−20% cannon heat per shot', [100, 170], ['damage3']);
chain('weapons', 1, 4, 'railgun', 'RAILGUN', 'Ability: hold RIGHT MOUSE to charge, release to fire a hypervelocity slug down your sights (700 m; Railgun Coils extend it). Each shot costs 8 scrap', [250], ['damage4'], 'ability');
chain('weapons', 1, 5, 'railrange', 'RAILGUN COILS', '+300 m railgun range and lock range (700 m base, 2.2 km fully upgraded)', [120, 170, 230, 300, 380], ['railgun1']);
chain('weapons', 2, 5, 'railecon', 'SLUG FOUNDRY', 'Railgun shots cost 1 scrap less (8 base, 4 fully upgraded)', [100, 150, 210, 280], ['railgun1']);
chain('weapons', 3, 7, 'railcap', 'CAPACITOR BANK', 'Railgun charges 40% faster', [180], ['railgun1']);
chain('weapons', 3, 8, 'railpierce', 'PIERCING SLUG', 'Railgun shots punch through every target in their path', [220], ['railgun1']);
chain('weapons', 3, 5, 'smartammo', 'SMART AMMO', 'I: cannon bolts fly 25% faster and 40% farther (about 1.4 km), with a wider aim assist that also allows for gravity on long shots. II: the aim assist snaps on from about twice as far off the crosshair', [260, 600], ['damage5', 'heatsink2']);
// --- missiles ---
chain('missiles', 0, 0, 'missileCap', 'MISSILE RACKS', '+1 missile carried per wave', [40, 80, 130, 190, 260]);
chain('missiles', 1, 0, 'missileSpeed', 'MISSILE BOOSTERS', '+30% missile thrust and speed, +200 m lock range', [35, 70, 120, 180]);
chain('missiles', 2, 1, 'quicklock', 'QUICK LOCK', 'Missile locks complete 40% faster', [120], ['missileCap1']);
chain('missiles', 2, 2, 'cluster', 'CLUSTER WARHEADS', 'Missile blasts are twice as wide and hit 2.5× harder around the target', [160], ['missileSpeed2']);
chain('missiles', 3, 0, 'payload', 'MISSILE PAYLOAD', '+30 m missile blast radius and +30% missile damage (direct hits and blast)', [90, 150, 220, 300, 400]);
chain('missiles', 1, 4, 'autorearm', 'AUTO-REARM', 'Rebuilds a missile every 40 s, up to your rack capacity', [200], ['missileCap4']);
// --- defense ---
chain('defense', 0, 0, 'hull', 'HULL PLATING', '+25 maximum hull', [35, 70, 110, 160, 220, 300]);
chain('defense', 1, 0, 'shieldRegen', 'SHIELD CAPACITORS', '+40% shield regen, shorter recharge delay', [25, 50, 90, 140, 200]);
chain('defense', 2, 0, 'repair', 'NANITE REPAIR', 'Hull repairs itself: +0.75% of max hull per second', [45, 90, 140, 200, 270]);
chain('defense', 3, 2, 'shieldcap', 'SHIELD MATRIX', '+50 maximum shield', [150, 240], ['shieldRegen2']);
chain('defense', 3, 4, 'emergency', 'EMERGENCY SHIELD', 'Once per wave, refills your shield the moment your hull drops below 25%', [220], ['shieldcap2']);
chain('defense', 1, 5, 'armor', 'REACTIVE ARMOUR', '−40% damage from collisions, rams and mine blasts', [160], ['hull5']);
// --- engineering ---
chain('engineering', 0, 0, 'thrusters', 'THRUSTER TUNING', '+15% engine power', [140, 220]);
chain('engineering', 0, 2, 'afterburner', 'AFTERBURNER', 'Ability: press R for 3 s of double engine power (15 s cooldown)', [200], ['thrusters2'], 'ability');
chain('engineering', 1, 0, 'magnet', 'SALVAGE MAGNET', '+50% salvage pickup range', [80, 140]);
chain('engineering', 2, 0, 'refinery', 'SCRAP REFINERY', '+20% scrap from every wreck', [150, 250, 360, 480]);
chain('engineering', 0, 5, 'jumpdrive', 'JUMP DRIVE', 'Ability: press Y to jump to the opposite point of your orbit, halfway round the hole, keeping the speed you would have there (45 s cooldown)', [650], ['afterburner1', 'refinery2'], 'ability');

export const TECH = nodes;
export const TECH_BY_ID = Object.fromEntries(nodes.map((n) => [n.id, n]));
/** Every stat key the tree uses (so new runs start them at 0). */
export const TECH_KEYS = [...new Set(nodes.map((n) => n.key))];

export const techOwned = (levels, n) => (levels[n.key] || 0) >= n.lvl;
/** Can this node be bought next (MK2 owned, prerequisites met, previous tier owned)? */
export function techUnlocked(levels, n) {
  if (!levels.mk2 || techOwned(levels, n)) return false;
  if ((levels[n.key] || 0) !== n.lvl - 1) return false;
  return n.req.every((id) => techOwned(levels, TECH_BY_ID[id]));
}
export const techCost = (n, mult = 1) => Math.round(n.cost * mult);
export const mk2Ready = (levels) => !levels.mk2 && levels.missileCap >= 3 && levels.hull >= 4;

// ---------------------------------------------------------------------------
// UI: a full-screen card over the station, four branch panels in a 2×2 grid.
// Click a node to see it; BUY buys it (so a stray click never spends scrap).
// ---------------------------------------------------------------------------
const NODE_W = 118, NODE_H = 60, LANE_W = 128, ROW_H = 80, HEAD_H = 34, PAD = 14;
const BLOCK_W = PAD * 2 + LANE_W * 4 - (LANE_W - NODE_W);
// each row of branches is as tall as its longest branch
const bandRows = (by) => 1 + Math.max(...nodes.filter((n) => BRANCHES.find((b) => b.id === n.branch).by === by).map((n) => n.row));
const blockH = (by) => HEAD_H + PAD + ROW_H * bandRows(by) - (ROW_H - NODE_H) + PAD;
const bandTop = (by) => (by === 0 ? 0 : blockH(0) + GAP);
const GAP = 22;

const $ = (id) => document.getElementById(id);
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function nodePos(n) {
  const b = BRANCHES.find((x) => x.id === n.branch);
  return {
    x: b.bx * (BLOCK_W + GAP) + PAD + n.lane * LANE_W,
    y: bandTop(b.by) + HEAD_H + PAD + n.row * ROW_H,
  };
}

export class TechTreeUI {
  /** cb: { buy(id) }, view(): { scrap, levels, costMult } */
  constructor(cb, view, audio) {
    this.cb = cb;
    this.view = view;
    this.audio = audio;
    this.root = $('techtree');
    this.canvas = $('tt-canvas');
    this.detail = $('tt-detail');
    this.selected = null;
    this.key = '';
    this.root.addEventListener('click', (e) => {
      e.stopPropagation();
      const node = e.target.closest('.tt-node');
      if (node) {
        // double-click a node to buy it (each click re-renders, so time the pair ourselves)
        const id = node.dataset.id;
        const now = performance.now();
        const twice = this.lastClick && this.lastClick.id === id && now - this.lastClick.t < 400;
        this.lastClick = twice ? null : { id, t: now };
        this.selected = id;
        if (twice) this.tryBuy(id);
        else audio.uiClick();
        this.render(true);
        return;
      }
      const buy = e.target.closest('#tt-buy');
      if (buy && !buy.disabled) { this.cb.buy(`tech:${this.selected}`); this.render(true); return; }
      if (e.target.closest('#tt-close') || e.target === this.root) this.close();
    });
  }

  /** Buy a node if it's next in line and affordable (same rules as the BUY button). */
  tryBuy(id) {
    const n = TECH_BY_ID[id];
    const v = this.view();
    if (!n || !techUnlocked(v.levels, n) || v.scrap < techCost(n, v.costMult)) return;
    this.cb.buy(`tech:${id}`);
  }

  get visible() { return !this.root.classList.contains('hidden'); }
  open() { this.root.classList.remove('hidden'); this.render(true); }
  close() { this.root.classList.add('hidden'); }

  render(force = false) {
    if (!this.visible) return;
    const v = this.view();
    const key = JSON.stringify([v.scrap, v.levels, v.costMult, this.selected]);
    if (!force && key === this.key) return;
    this.key = key;
    $('tt-scrap').textContent = v.scrap;
    const owned = TECH.filter((n) => techOwned(v.levels, n)).length;
    $('tt-count').textContent = `${owned} / ${TECH.length} RESEARCHED`;

    // connectors
    let paths = '';
    for (const n of TECH) {
      const to = nodePos(n);
      for (const id of n.req) {
        const from = nodePos(TECH_BY_ID[id]);
        const x1 = from.x + NODE_W / 2, y1 = from.y + NODE_H, x2 = to.x + NODE_W / 2, y2 = to.y;
        const my = (y1 + y2) / 2;
        const lit = techOwned(v.levels, TECH_BY_ID[id]);
        paths += `<path d="M${x1} ${y1} C${x1} ${my} ${x2} ${my} ${x2} ${y2}" class="${lit ? 'lit' : ''}"/>`;
      }
    }
    const W = BLOCK_W * 2 + GAP, H = blockH(0) + GAP + blockH(1);
    let html = `<svg class="tt-links" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${paths}</svg>`;
    for (const b of BRANCHES) {
      html += `<div class="tt-branch" style="left:${b.bx * (BLOCK_W + GAP)}px;top:${bandTop(b.by)}px;width:${BLOCK_W}px;height:${blockH(b.by)}px;--bc:${b.color}"><div class="tt-bname">${b.name}</div></div>`;
    }
    for (const n of TECH) {
      const p = nodePos(n);
      const b = BRANCHES.find((x) => x.id === n.branch);
      const own = techOwned(v.levels, n);
      const open = techUnlocked(v.levels, n);
      const cost = techCost(n, v.costMult);
      const state = own ? 'owned' : open ? (v.scrap >= cost ? 'ready' : 'poor') : 'locked';
      html += `<div class="tt-node ${state}${n.kind === 'ability' ? ' ability' : ''}${this.selected === n.id ? ' sel' : ''}" data-id="${n.id}" `
        + `style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px;--bc:${b.color}">`
        + `<div class="tt-nname">${esc(n.name)}</div><div class="tt-ncost">${own ? 'OWNED' : `${cost} SCRAP`}</div></div>`;
    }
    this.canvas.style.width = `${W}px`;
    this.canvas.style.height = `${H}px`;
    this.canvas.innerHTML = html;

    // detail strip
    const n = this.selected && TECH_BY_ID[this.selected];
    if (!n) {
      this.detail.innerHTML = '<span class="tt-hint">Select a node to see what it does, or double-click it to buy. Abilities are marked ◆.</span>';
      return;
    }
    const own = techOwned(v.levels, n), open = techUnlocked(v.levels, n), cost = techCost(n, v.costMult);
    const needs = n.req.filter((id) => !techOwned(v.levels, TECH_BY_ID[id])).map((id) => TECH_BY_ID[id].name);
    const status = own ? '<b class="ok">OWNED</b>'
      : open ? `<button id="tt-buy" class="btn small" ${v.scrap < cost ? 'disabled' : ''}>BUY · ${cost} SCRAP</button>`
        : `<span class="tt-need">REQUIRES ${needs.map(esc).join(', ')}</span>`;
    this.detail.innerHTML = `<div><div class="tt-dname">${n.kind === 'ability' ? '◆ ' : ''}${esc(n.name)}</div><div class="tt-ddesc">${esc(n.desc)}</div></div>${status}`;
  }
}
