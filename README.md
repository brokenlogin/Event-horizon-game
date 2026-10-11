# Event Horizon

A 3D space-combat game built with three.js where the whole fight takes place in orbit around a black hole.

## Run it

```bash
./serve.sh
```

Then open http://localhost:8000. You need Python 3 (preinstalled on macOS). The page loads three.js from a CDN, so it needs an internet connection.

To use a different port: `./serve.sh 8080`.

## Multiplayer (2 pilots, preview)

Both players open the game and click **MULTIPLAYER**. Set your **callsign** (it's remembered). One player clicks **HOST A GAME** and shares the 5-letter room code; the other types it and presses **JOIN**. Both wait in the room's pilot list until the host presses **START**.

- **No server of your own.** The connection is peer-to-peer WebRTC (via [PeerJS](https://peerjs.com)). PeerJS's free public matchmaking service handles only the few-second handshake; after that, game traffic goes directly between the two computers.
- **Works on the same Wi-Fi and over the internet** for most home networks. Some strict networks (certain mobile hotspots, corporate or university Wi-Fi) block direct connections; the lobby will say so. Try another network.
- **Low lag:** the other ship is predicted with the same orbital physics between updates (20 per second), so it stays smooth even at internet latencies.
- **Free flight for now:** in multiplayer there are no waves yet, just both pilots, the station and each other's shots. Shots are visual only. You respawn 5 s after dying, and pausing doesn't stop the shared world.
- **Shared economy:** scrap goes into one pool and upgrades apply to both ships. The host's game keeps the books, and purchases from either pilot are announced on both screens. Repairs and rearming use the shared pool but only fix your own ship. (Scrap comes from wrecks, so multiplayer has no scrap source until enemies are synced.)
- **Twin docking clamps:** the station has two clamps, so both pilots can dock at once: the host uses the left one, the guest the right. A clamp's light turns amber when it's occupied.
- **To play from another computer on your network** without setting it up there, start the host's server with `./serve.sh --lan` and open the address it prints. The game can also be published with GitHub Pages: in the repo's Settings → Pages, choose *Deploy from a branch* → `main` / root. Then anyone can play from the link.

## Controls

| Input | Action |
| --- | --- |
| Mouse | Steer (pitch / yaw) |
| W / S | Main thruster / retro thruster |
| A / D | Strafe left / right |
| Space / Shift | Thrust up / down |
| Z / C | Roll |
| Left click | Fire cannons |
| E | Start a missile lock (keep the target near the crosshair for 1.5 s) |
| Q | Fire a homing missile once locked (2 per wave, refilled each wave) |
| B | Docking assist: the autopilot flies the rendezvous (any thrust key cancels) |
| F | Undock from the station |
| N | Call the next wave early |
| Esc | Pause |

## Between waves

- After each wave you get **2 minutes** before the next one. A countdown sits at the top of the screen, with alarms at 60, 30 and 10 seconds.
- Destroyed ships leave **wrecks** on the orbit they died on. Fly within 75 m of one to salvage its scrap: raider 12, seeker 8, warden 35. Wrecks disappear after 2 minutes.
- **Kepler Station** holds a high, slow orbit: 2,500 m at 100 m/s, a lap every ~2.6 minutes. That's slower than a free orbit up there (~167 m/s), so station-keeping thrusters burn continuously; you can see them firing toward the hole. It's marked in green. Get within 300 m of it while moving under 40 m/s relative to it and you dock automatically. When you're close, the HUD shows your range and relative speed, plus green markers for your velocity relative to the station; burn toward ⊗ to match its speed.
- **Docking assist (B):** the autopilot simulates candidate burns twice a second against the station's future path, flies the best transfer, then brakes in on final approach. In tests it docked from anywhere in the arena in about 25–100 s.
- **Salvage drones:** spare missiles can collect scrap. Aim at a wreck and press E (a quicker, green lock), then Q. The drone scoops up the wreck and hops on to any others within 1.5 km. Any missile that passes through a wreck collects it.
- While docked you can spend scrap on:
  - Cannon Overcharge: +25% cannon damage per level
  - Missile Racks: +1 missile per wave
  - Missile Boosters: +30% missile thrust and top speed
  - Shield Capacitors: faster shield regeneration
  - Hull Plating: +25 maximum hull per level
  - Hull repair and missile rearm
- **You can still be shot while docked.**

## Physics

- The black hole uses the Paczyński–Wiita pseudo-Newtonian potential `Φ = -GM / (r - Rs)`. It reproduces the innermost stable orbit and the plunge near the horizon.
- The hole sits inside a dense nuclear cluster, modelled as a cored isothermal halo `Φ = ½·V0²·ln(r² + Rc²)`. Its pull falls off only as about 1/r, so gravity stays strong across the arena and nothing can escape.
- The event horizon has a 150 m radius and blocks everything: bolts, missile locks and enemy fire. Use it as cover.
- Past 3,200 m an outer gravity wall pulls with the square of the overshoot (about 60 m/s² at +300 m) and hauls everything back. There's no edge damage.
- From the 1,100 m starting orbit, falling in takes about 10 s of continuous reverse thrust.
- The player, enemies, every bolt and the explosion debris are all integrated with symplectic leapfrog. Steps are subdivided near the hole.
- The cyan line is your predicted ballistic path, with periapsis and apoapsis marked.
- The black hole is ray-marched. Light rays follow the Schwarzschild photon equation, which lenses the accretion disk and the stars, and the disk has Doppler beaming.

## Files

- `src/physics.js`: gravity, integrator, trajectory prediction
- `src/blackhole.js`: lensing ray-marcher, accretion disk, sky
- `src/main.js`: game loop, player, waves, camera, post-processing
- `src/enemies.js`: enemy AI
- `src/missiles.js`: missile lock-on, guidance and detonation
- `src/station.js`: the orbital station and docking
- `src/wrecks.js`: salvageable wrecks and scrap
- `src/stationui.js`: upgrade definitions and the docked shop UI
- `src/net.js`: peer-to-peer link (PeerJS / WebRTC), room codes, clock sync
- `src/remote.js`: the other pilot: physics-based prediction and smoothing
- `src/ships.js`: procedural ship models
- `src/fx.js`: bolts, particles, trails, space dust
- `src/hud.js`: HUD markers, bars and notices
- `src/radar3d.js`: the 3D holographic orbital radar (turns with your view)
- `src/audio.js`: synthesized sound effects
