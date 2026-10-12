// ---------------------------------------------------------------------------
// Relay (TURN) server for multiplayer between different networks.
//
// Most of the time the game connects two browsers directly. Some networks
// (phone hotspots, many ISPs, school or work Wi-Fi) don't allow that, and the
// connection then has to go through a relay. PeerJS's free relay servers have
// shut down, so the game needs one of its own: a free Metered account works.
//
//   1. Sign up at https://dashboard.metered.ca/signup (free plan).
//   2. On the dashboard home page, copy your app name — it's the part before
//      ".metered.live" (e.g. for "eventhorizon.metered.live" it's "eventhorizon").
//   3. Under TURN Server → Credentials (or Developers), copy the
//      *credential* API key ("apiKey"). It's made for front-end code and can
//      only fetch relay credentials. Never put the account's secretKey here.
//
// Leave these empty to play without a relay (same Wi-Fi, and many home
// networks, still work).
// ---------------------------------------------------------------------------

export const TURN = {
  meteredApp: '',
  meteredApiKey: '',
  // Or any other TURN server(s), e.g.
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
  servers: [],
};
