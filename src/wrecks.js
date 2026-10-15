import * as THREE from 'three';
import { integrate } from './physics.js';
import { buildWreck } from './ships.js';

// ---------------------------------------------------------------------------
// Salvage. A destroyed ship leaves a wreck that stays on the orbit it died on.
// Fly within COLLECT_RANGE to salvage its scrap. Wrecks fade after 2 minutes.
// ---------------------------------------------------------------------------

export const SCRAP_VALUE = { raider: 12, seeker: 8, warden: 35, dread: 150, lancer: 20, sower: 25, aegis: 30 };
export const COLLECT_RANGE = 75;
const WRECK_LIFE = 120;
const GLOW = { raider: 0xff4a2a, seeker: 0xffb030, warden: 0xc040ff, dread: 0xff2a3c, lancer: 0x3dff8a, sower: 0xff8a2a, aegis: 0x7a6bff };

const _v = new THREE.Vector3();

export class WreckSystem {
  constructor(scene, particles) {
    this.scene = scene;
    this.particles = particles;
    this.list = [];
    this.onCollect = null;   // (wreck, collectedBy: 'ship' | 'missile') => void
  }

  spawn(enemy) {
    const built = buildWreck(GLOW[enemy.type] || 0xff6020);
    this.scene.add(built.group);
    const w = {
      id: enemy.netId,          // shared with the enemy it came from, so all pilots agree on it
      type: enemy.type,
      value: SCRAP_VALUE[enemy.type] || 10,
      pos: enemy.pos.clone(),
      vel: enemy.vel.clone(),
      spin: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.6),
      life: WRECK_LIFE,
      built,
      alive: true,
      radius: enemy.type === 'dread' ? 16 : 4,
    };
    if (enemy.type === 'dread') built.group.scale.setScalar(4.5);   // the fortress leaves a hulk
    built.group.position.copy(w.pos);
    this.list.push(w);
    return w;
  }

  physics(h) {
    for (const w of this.list) {
      if (!w.alive) continue;
      if (!integrate(w.pos, w.vel, null, h)) this._remove(w);
    }
  }

  /** Salvages a wreck: motes stream toward the collector, then onCollect fires. */
  collect(w, toPos, toVel, by) {
    if (!w.alive) return;
    this._salvageFx(w, toPos, toVel);
    if (this.onCollect) this.onCollect(w, by);
    this._remove(w);
  }

  update(dt, time, player, canCollect, range = COLLECT_RANGE) {
    for (const w of this.list) {
      if (!w.alive) continue;
      w.life -= dt;
      if (w.life <= 0) { this._remove(w); continue; }
      const g = w.built.group;
      g.position.copy(w.pos);
      g.rotation.x += w.spin.x * dt; g.rotation.y += w.spin.y * dt; g.rotation.z += w.spin.z * dt;
      const pulse = 0.55 + 0.45 * Math.sin(time * 5 + w.pos.x);
      const fading = w.life < 15 ? ((time * 4) % 1 < 0.5 ? 0.25 : 1) : 1;
      w.built.beacon.material.opacity = pulse * fading;
      w.built.ember.emissiveIntensity = 0.6 + 1.2 * Math.max(0, w.life / WRECK_LIFE);
      // occasional smoulder
      if (Math.random() < dt * 6) {
        this.particles.emit(w.pos.x, w.pos.y, w.pos.z, w.vel.x + (Math.random() - 0.5) * 3, w.vel.y + (Math.random() - 0.5) * 3, w.vel.z + (Math.random() - 0.5) * 3,
          0.7, 0.3, 0.1, 0.8, 2.4, 0.8, false);
      }
      if (canCollect && w.pos.distanceTo(player.pos) < range) this.collect(w, player.pos, player.vel, 'ship');
    }
    this.list = this.list.filter((w) => w.alive);
  }

  _salvageFx(w, toPos, toVel) {
    // a stream of green motes pulled toward the ship
    for (let i = 0; i < 40; i++) {
      const s = 0.4 + Math.random() * 0.6;
      _v.subVectors(toPos, w.pos).multiplyScalar(s * 2.2);
      this.particles.emit(
        w.pos.x + (Math.random() - 0.5) * 6, w.pos.y + (Math.random() - 0.5) * 6, w.pos.z + (Math.random() - 0.5) * 6,
        toVel.x + _v.x, toVel.y + _v.y, toVel.z + _v.z,
        0.3, 1.6, 0.6, 1.2, 0.2, 0.45, false,
      );
    }
  }

  _remove(w) {
    w.alive = false;
    this.scene.remove(w.built.group);
    w.built.group.traverse((o) => { if (o.material) o.material.dispose(); });
  }

  byId(id) { return this.list.find((w) => w.alive && w.id === id) || null; }

  /** Remove without salvage effects (someone else picked it up). */
  removeById(id) {
    const w = this.byId(id);
    if (w) { this._remove(w); this.list = this.list.filter((x) => x.alive); }
    return w;
  }

  clear() {
    for (const w of this.list) this._remove(w);
    this.list.length = 0;
  }
}
