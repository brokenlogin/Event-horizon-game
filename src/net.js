// ---------------------------------------------------------------------------
// Peer-to-peer links between up to four copies of the game (WebRTC via PeerJS).
//
// Topology is a star: every guest talks to the host, and the host relays what
// the guests say to each other. Two ways to connect:
//   LAN    — direct WebRTC links (PeerJS; its free public broker 0.peerjs.com
//            is used only for the handshake). Best on the same network.
//   REMOTE — everyone connects to a relay server the host runs on their own
//            computer (serve.py --remote), reachable through a Cloudflare quick
//            tunnel. Works between any two networks.
// LAN links have two data channels: `state` (unordered: snapshots, stale ones
// are simply dropped) and `events` (reliable + ordered: everything else).
// REMOTE links carry both over one WebSocket.
//
// Every message carries `from`, the sender's pilot id (host = 0, guests 1–3).
// Clock: the host's clock is the reference. Guests measure their offset with
// NTP-style pings (best-of recent samples), so netTime() is shared.
// ---------------------------------------------------------------------------

export const PROTOCOL = 10;
export const MAX_PILOTS = 4;
const PREFIX = 'event-horizon-';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
const CODE_LEN = 5;
const PING_INTERVAL = 1.0;
const TIMEOUT = 5.0;
const CONNECT_TIMEOUT = 15000;
// guest messages the host forwards to the other guests
const RELAY = new Set(['s', 'f', 'd', 'rail']);

const nowSec = () => performance.now() / 1000;
const UNREACHABLE = 'Could not reach the host\'s server. Check the share code, and that the host\'s server window is still open (a brand-new one can take ~10 seconds to start answering).';

// Public STUN for LAN (WebRTC) links. PeerJS's own relay servers no longer
// exist, so the list is set explicitly; different networks should use REMOTE.
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const RELAY_OPEN_TIMEOUT = 12000;

/**
 * A REMOTE share code is the name of the host's Cloudflare quick tunnel
 * ("word-word-word-word"). Pasting the whole https://….trycloudflare.com link
 * works too, and "localhost:8000" connects to a relay on this machine (testing).
 * Returns { code, url } or null.
 */
export function parseShareCode(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^(wss?|https?):\/\//, '').replace(/\/.*$/, '');
  const local = s.match(/^(localhost|127\.0\.0\.1)(:\d+)?$/);
  if (local) return { code: s, url: `ws://${s}/relay` };
  s = s.replace(/\.trycloudflare\.com$/, '');
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(s) || s.length > 80) return null;
  return { code: s, url: `wss://${s}.trycloudflare.com/relay` };
}

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
    this.route = '';       // 'direct' | 'relay' (LAN), 'remote'
    this.relayed = false;  // REMOTE: carried by the relay server's WebSocket
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
    this.mode = 'lan';         // 'lan' | 'remote'
    this.peer = null;
    this.ws = null;            // REMOTE: the WebSocket to the relay server
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
  /** Open a room. LAN by default; pass { remote: parseShareCode(...) } for REMOTE. */
  async host(opts = {}) {
    if (opts.remote) return this._hostRemote(opts.remote);
    this.close();
    this.role = 'host';
    this.myId = 0;
    const iceServers = ICE_SERVERS;
    return new Promise((resolve, reject) => {
      const attempt = (tries) => {
        const code = makeCode();
        const peer = new window.Peer(PREFIX + code, { debug: 0, config: { iceServers } });
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

  /** Join a room: a LAN room code, or { remote: parseShareCode(...) }. */
  async join(rawCode, opts = {}) {
    if (opts.remote) return this._joinRemote(opts.remote);
    this.close();
    this.role = 'client';
    const code = normalizeCode(rawCode);
    this.code = code;
    if (code.length !== CODE_LEN) throw `Room codes are ${CODE_LEN} characters.`;
    const iceServers = ICE_SERVERS;
    return new Promise((resolve, reject) => {
      const peer = new window.Peer({ debug: 0, config: { iceServers } });
      this.peer = peer;
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(msg); } else this._emit('error', msg); };
      peer.on('open', () => {
        const link = this.hostLink = new Link(PREFIX + code);
        this.links.set(link.peerId, link);
        this._attach(link, peer.connect(link.peerId, { label: 'state', reliable: false, serialization: 'json' }));
        this._attach(link, peer.connect(link.peerId, { label: 'events', reliable: true, serialization: 'json' }));
        this.connectTimer = setTimeout(() => {
          if (!this.connected) fail('Could not connect. LAN games need everyone on the same network. For different networks, use the REMOTE tab.');
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
      case 'webrtc': return 'The direct connection failed (WebRTC). LAN games need everyone on the same network. For different networks, use the REMOTE tab.';
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
        this._linkOpened(link);
        this._detectRoute(link);
      }
    });
    conn.on('data', (msg) => { if (link.owns(conn) && this.links.get(link.peerId) === link) this._recv(link, msg); });
    conn.on('close', () => { if (link.owns(conn)) this._dropLink(link, 'left the flight.'); });
    conn.on('error', () => { if (link.owns(conn)) this._dropLink(link, 'lost the link.'); });
  }

  _linkOpened(link) {
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

  // -------------------------------------------------------------------------
  // REMOTE: through the relay server (serve.py --remote)
  // -------------------------------------------------------------------------
  _openRelay(url) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch { reject('That share code does not look right.'); return; }
      const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(UNREACHABLE); }, RELAY_OPEN_TIMEOUT);
      ws.onopen = () => { clearTimeout(timer); resolve(ws); };
      ws.onerror = () => { clearTimeout(timer); reject(UNREACHABLE); };
    });
  }

  _relayOut(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  async _hostRemote(share) {
    this.close();
    this.role = 'host';
    this.mode = 'remote';
    this.myId = 0;
    const ws = await this._openRelay(share.url);
    if (this.role !== 'host' || this.mode !== 'remote') { ws.close(); throw 'Cancelled.'; }
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (!settled) {
          settled = true;
          if (m.t === 'hosted') { this.code = share.code; resolve(share.code); } else reject(m.why || 'The relay server refused to host.');
          return;
        }
        this._onRelay(m);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (!settled) { settled = true; reject('The relay server closed the connection.'); return; }
        for (const l of [...this.links.values()]) this._dropLink(l, 'lost the link.');
        this.ws = null;
        this._emit('error', 'Lost the connection to your relay server. Is its window still open?');
      };
      this._relayOut({ t: 'host' });
    });
  }

  async _joinRemote(share) {
    this.close();
    this.role = 'client';
    this.mode = 'remote';
    this.code = share.code;
    const ws = await this._openRelay(share.url);
    if (this.role !== 'client' || this.mode !== 'remote') { ws.close(); throw 'Cancelled.'; }
    this.ws = ws;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; reject(msg); } else this._emit('error', msg); };
      this._joinResolve = () => { if (!settled) { settled = true; resolve(share.code); } };
      this._joinReject = (msg) => fail(msg);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'joined') {
          const link = this.hostLink = new Link('host');
          link.relayed = true;
          link.route = 'remote';
          this.links.set(link.peerId, link);
          this._linkOpened(link);
          return;
        }
        if (m.t === 'error') { fail(m.why); return; }
        this._onRelay(m);
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        if (!settled) fail('The host\'s relay server closed the connection.');
        else if (this.hostLink) this._dropLink(this.hostLink, 'lost the link.');
      };
      this.connectTimer = setTimeout(() => {
        if (!this.connected) fail('Reached the host\'s server, but their game did not answer. Make sure they pressed HOST.');
      }, CONNECT_TIMEOUT);
      this._relayOut({ t: 'join' });
    });
  }

  _onRelay(m) {
    if (this.role === 'host') {
      if (m.t === 'peer-join') {
        if (this.locked || this.openLinks().length >= MAX_PILOTS - 1) {
          this._relayOut({ t: 'd', to: m.peer, m: { k: 'refused', why: this.locked ? 'That flight has already launched.' : 'That room is full (4 pilots).' } });
          setTimeout(() => this._relayOut({ t: 'kick', peer: m.peer }), 400);
          return;
        }
        const link = new Link(m.peer);
        link.relayed = true;
        link.route = 'remote';
        this.links.set(m.peer, link);
        this._linkOpened(link);
      } else if (m.t === 'peer-leave') {
        const link = this.links.get(m.peer);
        if (link) this._dropLink(link, 'left the flight.');
      } else if (m.t === 'd') {
        const link = this.links.get(m.from);
        if (link) this._recv(link, m.m);
      }
    } else if (m.t === 'd') {
      if (this.hostLink) this._recv(this.hostLink, m.m);
    } else if (m.t === 'closed') {
      if (this.hostLink) this._dropLink(this.hostLink, 'left the flight.');
    }
  }

  /** Find out whether a link runs directly or through the relay (for the lobby display). */
  async _detectRoute(link) {
    const pc = link.events && link.events.peerConnection;
    if (!pc || !pc.getStats) return;
    for (let tries = 0; tries < 5 && !link.route; tries++) {
      try {
        const stats = await pc.getStats();
        let pair = null;
        stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
        if (!pair) stats.forEach((r) => { if (!pair && r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
        if (pair) {
          const local = stats.get(pair.localCandidateId), remote = stats.get(pair.remoteCandidateId);
          const relayed = (local && local.candidateType === 'relay') || (remote && remote.candidateType === 'relay');
          link.route = relayed ? 'relay' : 'direct';
          this._emit('route', { id: link.id, route: link.route });
          return;
        }
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  routeOf(id) {
    const l = this.role === 'client' ? this.hostLink : this.openLinks().find((x) => x.id === id);
    return l ? l.route : '';
  }

  _dropLink(link, reason) {
    if (this.links.get(link.peerId) !== link) return;
    this.links.delete(link.peerId);
    for (const c of [link.state, link.events]) { try { c && c.close(); } catch { /* ignore */ } }
    if (link.relayed && this.role === 'host') this._relayOut({ t: 'kick', peer: link.peerId });
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
    try { this.ws && this.ws.close(); } catch { /* ignore */ }
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
    let deliver;
    if (link.relayed) {
      const out = this.role === 'host' ? { t: 'd', to: link.peerId, m: msg } : { t: 'd', m: msg };
      deliver = () => this._relayOut(out);
    } else {
      const c = link[channel];
      if (!c || !c.open) return;
      deliver = () => { if (c.open) c.send(msg); };
    }
    const { latency, jitter, loss } = this.sim;
    if (loss > 0 && channel === 'state' && Math.random() < loss) return;
    if (latency > 0 || jitter > 0) setTimeout(deliver, latency + Math.random() * jitter);
    else deliver();
  }

  /** Send to everyone (host) or to the host (guest). `to` limits a host message to one pilot id. */
  _send(channel, msg, to) {
    if (msg.from === undefined) msg.from = this.myId;
    if (this.role === 'client') { if (this.hostLink) this._sendOn(this.hostLink, channel, msg); return; }
    if (this.mode === 'remote' && to === undefined && !this.sim.latency && !this.sim.jitter && !this.sim.loss) {
      // one message for the relay to fan out, instead of one per guest
      if (this.openLinks().length) this._relayOut({ t: 'd', m: msg });
      return;
    }
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
