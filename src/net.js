// ---------------------------------------------------------------------------
// Peer-to-peer link between two copies of the game (WebRTC via PeerJS).
//
// PeerJS's free public broker (0.peerjs.com) is used only for the handshake;
// after that all traffic flows directly between the two browsers. Two data
// channels are opened:
//   state  — unordered: ship snapshots ~20/s, stale ones are simply dropped
//   events — reliable + ordered: fire / death events, hello, clock pings
//
// Clock: the host's clock is the reference. The client measures the offset
// with NTP-style pings (median of recent samples), so netTime() is shared.
// ---------------------------------------------------------------------------

export const PROTOCOL = 2;
const PREFIX = 'event-horizon-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_LEN = 5;
const PING_INTERVAL = 1.0;
const TIMEOUT = 5.0;
const CONNECT_TIMEOUT = 15000;

const nowSec = () => performance.now() / 1000;

function makeCode() {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
}

class Net {
  constructor() {
    this.handlers = {};
    this._reset();
    this.sim = { latency: 0, jitter: 0, loss: 0 };
  }

  _reset() {
    this.role = null;          // 'host' | 'client'
    this.peer = null;
    this.code = '';
    this.remoteId = null;
    this.chan = { state: null, events: null };
    this.connected = false;
    this.offset = 0;           // add to local clock to get host clock (client only)
    this.rtt = 0;
    this.samples = [];
    this.synced = false;
    this.lastRecv = 0;
    this.pingTimer = 0;
    this.connectTimer = null;
    this._joinResolve = null;
  }

  get available() { return typeof window !== 'undefined' && typeof window.Peer === 'function'; }

  on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  _emit(type, data) { for (const fn of this.handlers[type] || []) fn(data); }

  /** Shared session clock, in seconds (host's clock). */
  netTime() { return nowSec() + (this.role === 'client' ? this.offset : 0); }

  // -------------------------------------------------------------------------
  // Hosting / joining
  // -------------------------------------------------------------------------
  host() {
    this.close(true);
    this.role = 'host';
    return new Promise((resolve, reject) => {
      const attempt = (tries) => {
        const code = makeCode();
        const peer = new window.Peer(PREFIX + code, { debug: 0 });
        this.peer = peer;
        peer.on('open', () => { this.code = code; resolve(code); });
        peer.on('connection', (conn) => {
          if (this.remoteId && conn.peer !== this.remoteId) { conn.close(); return; }   // room is full
          this.remoteId = conn.peer;
          this._attach(conn);
        });
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && tries < 5) { peer.destroy(); attempt(tries + 1); return; }
          if (!this.code) { reject(this._describe(err)); return; }
          this._emit('error', this._describe(err));
        });
        peer.on('disconnected', () => {
          // lost the broker; the direct link (if any) keeps working. Try to stay reachable.
          if (!this.connected && !peer.destroyed) peer.reconnect();
        });
      };
      attempt(0);
    });
  }

  join(rawCode) {
    this.close(true);
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
        this.remoteId = PREFIX + code;
        this._attach(peer.connect(this.remoteId, { label: 'state', reliable: false, serialization: 'json' }));
        this._attach(peer.connect(this.remoteId, { label: 'events', reliable: true, serialization: 'json' }));
        this.connectTimer = setTimeout(() => {
          if (!this.connected) fail('Could not open a direct link. One of your networks may block peer-to-peer connections — try the same Wi-Fi, or another network.');
        }, CONNECT_TIMEOUT);
      });
      this._joinResolve = () => { if (!settled) { settled = true; resolve(code); } };
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

  _attach(conn) {
    conn.on('open', () => {
      this.chan[conn.label === 'state' ? 'state' : 'events'] = conn;
      if (this.chan.state && this.chan.events && !this.connected) {
        this.connected = true;
        this.lastRecv = nowSec();
        clearTimeout(this.connectTimer);
        // quick burst of pings so the client's clock offset is good before play starts
        for (let i = 0; i < 6; i++) setTimeout(() => this._ping(), i * 120);
        if (this._joinResolve) { this._joinResolve(); this._joinResolve = null; }
        this._emit('connected');
      }
    });
    conn.on('data', (msg) => { if (this._isCurrent(conn)) this._recv(msg); });
    conn.on('close', () => { if (this._isCurrent(conn)) this._drop('The other pilot left.'); });
    conn.on('error', () => { if (this._isCurrent(conn)) this._drop('The link dropped.'); });
  }

  _isCurrent(conn) {
    // before 'open' the channel isn't registered yet; after a guest leaves its old channels are stale
    return conn.peer === this.remoteId && (!this.chan.state || !this.chan.events || this.chan.state === conn || this.chan.events === conn);
  }

  /** Host only: forget the current guest but keep the room code open for someone else. */
  dropGuest() {
    for (const c of Object.values(this.chan)) { try { c && c.close(); } catch { /* ignore */ } }
    this.chan = { state: null, events: null };
    this.remoteId = null;
    this.connected = false;
    this.samples = [];
    this.synced = false;
    this.rtt = 0;
  }

  _drop(reason) {
    if (!this.connected) return;
    this.connected = false;
    this._emit('disconnected', reason);
  }

  close(silent = false) {
    clearTimeout(this.connectTimer);
    const wasConnected = this.connected;
    this.connected = false;
    for (const c of Object.values(this.chan)) { try { c && c.close(); } catch { /* ignore */ } }
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    const handlers = this.handlers;
    const sim = this.sim;
    this._reset();
    this.handlers = handlers;
    this.sim = sim;
    if (wasConnected && !silent) this._emit('disconnected', 'Link closed.');
  }

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------
  _recv(msg) {
    this.lastRecv = nowSec();
    if (!msg || typeof msg !== 'object') return;
    if (msg.k === 'ping') { this._send('events', { k: 'pong', a: msg.a, b: this.netTime() }); return; }
    if (msg.k === 'pong') {
      const now = nowSec();
      const rtt = now - msg.a;
      this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
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
    this._emit(msg.k, msg);
  }

  _ping() { if (this.connected) this._send('events', { k: 'ping', a: nowSec() }); }

  _send(channel, msg) {
    const c = this.chan[channel];
    if (!c || !c.open) return;
    const { latency, jitter, loss } = this.sim;
    if (loss > 0 && channel === 'state' && Math.random() < loss) return;
    if (latency > 0 || jitter > 0) {
      setTimeout(() => { if (c.open) c.send(msg); }, latency + Math.random() * jitter);
    } else {
      c.send(msg);
    }
  }

  sendState(msg) { this._send('state', msg); }
  sendEvent(msg) { this._send('events', msg); }

  /** Debug: add artificial latency (ms), jitter (ms) and state-packet loss (0..1) to outgoing traffic. */
  simulate(opts = {}) { Object.assign(this.sim, { latency: 0, jitter: 0, loss: 0 }, opts); }

  /** Call every frame: pings for RTT/clock, and a heartbeat timeout. */
  update(dt) {
    if (!this.connected) return;
    this.pingTimer -= dt;
    if (this.pingTimer <= 0) { this.pingTimer = PING_INTERVAL; this._ping(); }
    if (nowSec() - this.lastRecv > TIMEOUT) this._drop('Lost contact with the other pilot.');
  }
}

export const net = new Net();
