// ---------------------------------------------------------------------------
// Peer-to-peer links between up to four copies of the game (WebRTC via PeerJS).
//
// Topology is a star: every guest connects directly to the host, and the host
// relays what the guests say to each other. PeerJS's free public broker
// (0.peerjs.com) is used only for the handshake; afterwards all traffic flows
// directly between the browsers. Each link has two data channels:
//   state  — unordered: ship / enemy snapshots, stale ones are simply dropped
//   events — reliable + ordered: everything else (fire, hits, kills, economy…)
//
// Every message carries `from`, the sender's pilot id (host = 0, guests 1–3).
// Clock: the host's clock is the reference. Guests measure their offset with
// NTP-style pings (best-of recent samples), so netTime() is shared.
// ---------------------------------------------------------------------------

export const PROTOCOL = 5;
export const MAX_PILOTS = 4;
const PREFIX = 'event-horizon-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_LEN = 5;
const PING_INTERVAL = 1.0;
const TIMEOUT = 5.0;
const CONNECT_TIMEOUT = 15000;
// guest messages the host forwards to the other guests
const RELAY = new Set(['s', 'f', 'd', 'emx']);

const nowSec = () => performance.now() / 1000;

function makeCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

class Link {
  constructor(peerId) {
    this.peerId = peerId;
    this.state = null;
    this.events = null;
    this.open = false;
    this.id = -1;          // pilot id of the far end (host side)
    this.lastRecv = 0;
    this.rtt = 0;
    this.pingTimer = 0;
  }
  owns(conn) { return conn === this.state || conn === this.events || !this.state || !this.events; }
}

class Net {
  constructor() {
    this.handlers = {};
    this.sim = { latency: 0, jitter: 0, loss: 0 };
    this._reset();
  }

  _reset() {
    this.role = null;          // 'host' | 'client'
    this.peer = null;
    this.code = '';
    this.myId = 0;
    this.links = new Map();    // peerId -> Link
    this.hostLink = null;      // guest side: the link to the host
    this.locked = false;       // host: room closed once the flight starts
    this.offset = 0;           // guests: add to the local clock to get the host clock
    this.samples = [];
    this.synced = false;
    this.connectTimer = null;
    this._joinResolve = null;
    this._joinReject = null;
  }

  get available() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }
  get isHost() { return this.role === 'host'; }
  /** Host: at least one guest linked. Guest: linked to the host. */
  get connected() { return this.role === 'host' ? this.openLinks().length > 0 : !!(this.hostLink && this.hostLink.open); }
  /** Round-trip time to show in the HUD: guests → host; host → slowest guest. */
  get rtt() {
    if (this.role === 'client') return this.hostLink ? this.hostLink.rtt : 0;
    return this.openLinks().reduce((m, l) => Math.max(m, l.rtt), 0);
  }
  openLinks() { return [...this.links.values()].filter((l) => l.open); }
  rttOf(id) { const l = this.openLinks().find((x) => x.id === id); return l ? l.rtt : 0; }

  on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  _emit(type, data) { for (const fn of this.handlers[type] || []) fn(data); }

  /** Shared session clock, in seconds (the host's clock). */
  netTime() { return nowSec() + (this.role === 'client' ? this.offset : 0); }

  // -------------------------------------------------------------------------
  // Hosting / joining
  // -------------------------------------------------------------------------
  host() {
    this.close();
    this.role = 'host';
    this.myId = 0;
    return new Promise((resolve, reject) => {
      const attempt = (tries) => {
        const code = makeCode();
        const peer = new window.Peer(PREFIX + code, { debug: 0 });
        this.peer = peer;
        peer.on('open', () => { this.code = code; resolve(code); });
        peer.on('connection', (conn) => {
          let link = this.links.get(conn.peer);
          if (!link) {
            const full = this.openLinks().length >= MAX_PILOTS - 1;
            if (this.locked || full) {
              conn.on('open', () => {
                conn.send({ k: 'refused', why: this.locked ? 'That flight has already launched.' : 'That room is full (4 pilots).' });
                setTimeout(() => conn.close(), 400);
              });
              return;
            }
            link = new Link(conn.peer);
            this.links.set(conn.peer, link);
          }
          this._attach(link, conn);
        });
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && tries < 5) { peer.destroy(); attempt(tries + 1); return; }
          if (!this.code) { reject(this._describe(err)); return; }
          if (err.type !== 'peer-unavailable') this._emit('error', this._describe(err));
        });
        peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
      };
      attempt(0);
    });
  }

  join(rawCode) {
    this.close();
    this.role = 'client';
    const code = normalizeCode(rawCode);
    this.code = code;
    return new Promise((resolve, reject) => {
      if (code.length !== CODE_LEN) { reject(`Room codes are ${CODE_LEN} characters.`); return; }
      const peer = new window.Peer({ debug: 0 });
      this.peer = peer;
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(msg); } else this._emit('error', msg); };
      peer.on('open', () => {
        const link = this.hostLink = new Link(PREFIX + code);
        this.links.set(link.peerId, link);
        this._attach(link, peer.connect(link.peerId, { label: 'state', reliable: false, serialization: 'json' }));
        this._attach(link, peer.connect(link.peerId, { label: 'events', reliable: true, serialization: 'json' }));
        this.connectTimer = setTimeout(() => {
          if (!this.connected) fail('Could not open a direct link. One of your networks may block peer-to-peer connections — try the same Wi-Fi, or another network.');
        }, CONNECT_TIMEOUT);
      });
      this._joinResolve = () => { if (!settled) { settled = true; resolve(code); } };
      this._joinReject = (msg) => fail(msg);
      peer.on('error', (err) => fail(this._describe(err)));
    });
  }

  _describe(err) {
    switch (err && err.type) {
      case 'peer-unavailable': return 'No game found with that code. Check it and make sure the host is still waiting.';
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'Could not reach the matchmaking service (0.peerjs.com). Check your internet connection.';
      case 'browser-incompatible': return 'This browser does not support WebRTC data channels.';
      case 'webrtc': return 'The direct connection failed (WebRTC). Your networks may block peer-to-peer traffic.';
      default: return `Connection error: ${(err && (err.type || err.message)) || err}`;
    }
  }

  _freeId() {
    const used = new Set(this.openLinks().map((l) => l.id));
    for (let i = 1; i < MAX_PILOTS; i++) if (!used.has(i)) return i;
    return -1;
  }

  _attach(link, conn) {
    conn.on('open', () => {
      link[conn.label === 'state' ? 'state' : 'events'] = conn;
      if (link.state && link.events && !link.open) {
        link.open = true;
        link.lastRecv = nowSec();
        if (this.role === 'host') {
          link.id = this._freeId();
          this._emit('join', { id: link.id });
        } else {
          clearTimeout(this.connectTimer);
          // quick burst of pings so the clock offset is good before play starts
          for (let i = 0; i < 6; i++) setTimeout(() => this._ping(link), i * 120);
          this._emit('connected');
        }
      }
    });
    conn.on('data', (msg) => { if (link.owns(conn) && this.links.get(link.peerId) === link) this._recv(link, msg); });
    conn.on('close', () => { if (link.owns(conn)) this._dropLink(link, 'left the flight.'); });
    conn.on('error', () => { if (link.owns(conn)) this._dropLink(link, 'lost the link.'); });
  }

  _dropLink(link, reason) {
    if (this.links.get(link.peerId) !== link) return;
    this.links.delete(link.peerId);
    for (const c of [link.state, link.events]) { try { c && c.close(); } catch { /* ignore */ } }
    if (!link.open) return;
    link.open = false;
    if (this.role === 'host') this._emit('leave', { id: link.id, reason });
    else this._emit('disconnected', reason === 'left the flight.' ? 'The host closed the room.' : 'Lost contact with the host.');
  }

  /** Guest: the host accepted us (called once 'welcome' arrives). */
  acceptedAs(id) {
    this.myId = id;
    if (this._joinResolve) { this._joinResolve(); this._joinResolve = null; }
  }

  /** Host: stop accepting new pilots (the flight has launched). */
  lockRoom(v = true) { this.locked = v; }

  close() {
    clearTimeout(this.connectTimer);
    for (const l of this.links.values()) for (const c of [l.state, l.events]) { try { c && c.close(); } catch { /* ignore */ } }
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    const { handlers, sim } = this;
    this._reset();
    this.handlers = handlers;
    this.sim = sim;
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  _recv(link, msg) {
    link.lastRecv = nowSec();
    if (!msg || typeof msg !== 'object') return;
    if (msg.k === 'ping') { this._sendOn(link, 'events', { k: 'pong', a: msg.a, b: this.netTime() }); return; }
    if (msg.k === 'pong') {
      const now = nowSec();
      const rtt = now - msg.a;
      link.rtt = link.rtt ? link.rtt * 0.7 + rtt * 0.3 : rtt;
      if (this.role === 'client') {
        this.samples.push({ off: msg.b + rtt / 2 - now, rtt });
        if (this.samples.length > 8) this.samples.shift();
        // prefer low-RTT samples: they bound the offset most tightly
        const best = [...this.samples].sort((x, y) => x.rtt - y.rtt).slice(0, Math.max(3, Math.ceil(this.samples.length / 2)));
        const offs = best.map((s) => s.off).sort((x, y) => x - y);
        this.offset = offs[Math.floor(offs.length / 2)];
        if (!this.synced && this.samples.length >= 3) { this.synced = true; this._emit('synced'); }
      }
      return;
    }
    if (msg.k === 'refused' && this.role === 'client') {
      const reject = this._joinReject;
      this._joinResolve = null;
      this._joinReject = null;
      if (reject) reject(msg.why);
      return;
    }
    if (this.role === 'host') {
      msg.from = link.id;
      if (RELAY.has(msg.k)) {
        const channel = msg.k === 's' ? 'state' : 'events';
        for (const l of this.openLinks()) if (l !== link) this._sendOn(l, channel, msg);
      }
    }
    this._emit(msg.k, msg);
  }

  _ping(link) { if (link.open) this._sendOn(link, 'events', { k: 'ping', a: nowSec() }); }

  _sendOn(link, channel, msg) {
    const c = link[channel];
    if (!c || !c.open) return;
    const { latency, jitter, loss } = this.sim;
    if (loss > 0 && channel === 'state' && Math.random() < loss) return;
    if (latency > 0 || jitter > 0) setTimeout(() => { if (c.open) c.send(msg); }, latency + Math.random() * jitter);
    else c.send(msg);
  }

  /** Send to everyone (host) or to the host (guest). `to` limits a host message to one pilot id. */
  _send(channel, msg, to) {
    if (msg.from === undefined) msg.from = this.myId;
    if (this.role === 'client') { if (this.hostLink) this._sendOn(this.hostLink, channel, msg); return; }
    for (const l of this.openLinks()) if (to === undefined || l.id === to) this._sendOn(l, channel, msg);
  }

  sendState(msg) { this._send('state', msg); }
  sendEvent(msg, to) { this._send('events', msg, to); }

  /** Debug: add artificial latency (ms), jitter (ms) and state-packet loss (0..1) to outgoing traffic. */
  simulate(opts = {}) { Object.assign(this.sim, { latency: 0, jitter: 0, loss: 0 }, opts); }

  /** Call every frame: pings for RTT/clock, and heartbeat timeouts. */
  update(dt) {
    const now = nowSec();
    for (const l of [...this.links.values()]) {
      if (!l.open) continue;
      l.pingTimer -= dt;
      if (l.pingTimer <= 0) { l.pingTimer = PING_INTERVAL; this._ping(l); }
      if (now - l.lastRecv > TIMEOUT) this._dropLink(l, 'timed out.');
    }
  }
}

export const net = new Net();
