# Event Horizon

A 3D space-combat game built with three.js where the whole fight takes place in orbit around a black hole.

## Run it

```bash
./serve.sh
```

Then open http://localhost:8000. You need Python 3 (preinstalled on macOS). The page loads three.js from a CDN, so it needs an internet connection.

To use a different port: `./serve.sh 8080`.

## Enemies after the first boss

New types join one at a time, and the first appearance of each gets a NEW CONTACT banner explaining it.

- **Lancer (wave 6+):** a beam sniper that keeps its distance. A faint green aim line tracks you while it charges. When the line starts flashing it has **locked**, and about a second later it fires an instant 26-damage beam. It aims at where you'll be if you keep coasting, so thrust *across* its aim line during the lock to dodge. Thrusting straight toward or away from it doesn't help. The hole blocks the beam.
- **Sower (wave 8+):** a slow, armoured mine-layer that drops proximity mines behind it, so they drift along its orbit (up to 6 per sower). Mines arm after 1.5 s, blink faster when you're close, and blow up within about 26 m for up to 24 damage. Shooting one from a distance is safe and worth 25 points. Leftover mines fizzle when the wave ends and never block it.
- **Aegis (wave 11+):** unarmed. Every ship within 260 m of it is tethered to it and takes 65% less damage, shown as a violet bubble and SHIELDED on its marker. Kill it first.

Their wrecks are worth 20 (lancer), 25 (sower) and 30 (aegis) scrap.

## The Dreadnought (every 5th wave)

On waves 5, 10, 15 and so on, an enemy fortress warps in on a fixed, slightly inclined orbit at 1350 m, with a smaller escort than usual.

- **Armour:** 200 hull, plus 30% more on each later appearance and ×crew size in multiplayer. Its health bar sits at the top of the screen.
- **Six turrets**, each covering its own side of the hull (top, bottom, port, starboard). The hull and the hole block their aim. Destroying one is worth 250 points.
- **Seeker launcher** in the prow: whenever a pilot is within 1.5 km and in sight, it sends out a seeker drone every 7 seconds or so (at most 3 out at once, more with a bigger crew). Launched seekers leave no wreck.
- **Lock range:** your missiles lock onto it from 2000 m (double the usual), and aiming anywhere on the hull counts.
- **Intercept:** with a Dreadnought on the field, B flies you to a parking spot 600 m behind it on its own orbit, then hands control back.
- **Ramming** it just bounces you off and hurts.
- **Destroying it** is worth 3000 points and leaves a hulk worth 150 scrap.

## Debug launch

DEBUG LAUNCH on the main menu starts a solo run at any wave (1–30) with any upgrade levels and starting scrap. It has a one-click preset for the wave-5 boss. Debug runs don't count toward your best score.

## Difficulty

Pick it on the main menu, above LAUNCH:

| | Enemy damage | Missiles per wave |
|---|---|---|
| Easy | −35% | 3 |
| Normal | standard | 2 |
| Hard | +30% | 1 |

Enemy damage covers their cannon fire, seeker rams and collisions with enemy ships. The black hole's tides and the accretion disk hurt the same on every setting. Each difficulty keeps its own best score. In multiplayer the host picks the difficulty in the waiting room and everyone flies with it.

## Multiplayer (up to 4 pilots)

Everyone opens the game and clicks **MULTIPLAYER**, then sets a **callsign** (it's remembered). Pick a tab:

**LAN: same network.** One player clicks **HOST A GAME** and shares the 5-letter room code; the others type it and press **JOIN**. The browsers connect directly (WebRTC via [PeerJS](https://peerjs.com), whose free public service only makes the introduction), so there's nothing to install and the lag is lowest. It needs everyone on the same network.

**REMOTE: any networks.** The host runs a small relay on their own computer, reachable through a free Cloudflare quick tunnel. No account and no router setup.

1. **One-time, host only:**
   - **Python 3.** Macs usually have it; on Windows, get it from python.org.
   - **cloudflared:** `brew install cloudflared` on Mac, `winget install --id Cloudflare.cloudflared` on Windows.
   - **The game folder:** clone this repo, or download it as a ZIP.
2. **Each session, the host starts the relay:**
   - **Mac:** double-click `host-remote.command`, or run `./serve.sh --remote`.
   - **Windows:** double-click `host-remote.bat`.

   It prints a **share code** (words with dashes, new each session) and opens the game. Then press MULTIPLAYER → REMOTE → **HOST**. The code is filled in automatically when the game was opened from that window. Otherwise, paste it.
3. **Friends** open the game as usual (the GitHub Pages link is fine), go to MULTIPLAYER → REMOTE, paste the share code and press **JOIN**. They don't install anything.

Keep the relay window open while you play; closing it (or Ctrl+C) ends the session. All players' traffic passes through the host's computer and back out via Cloudflare. It's only a few KB/s, and the ping is a little higher than LAN.

Everyone waits in the room's pilot list until the host presses **START**. Once a flight has launched the room is closed to newcomers.

- **Co-op waves that scale with the crew:** each extra pilot adds +100% hostiles (2 pilots 2×, 3 pilots 3×, 4 pilots 4×) and makes upgrades 60% pricier (2 pilots 1.6×, 3 pilots 2.2×, 4 pilots 2.8×). The host's game runs the enemies and everyone sees the same ones. Each enemy hunts whichever pilot is closest.
- **Fair hits:** each pilot's game decides whether enemy fire hits *their own* ship. Your hits on enemies go to the host, which applies the damage and credits the kill (and its score) to whoever made it.
- **Shared economy:** wrecks appear for everyone and can be salvaged once. Scrap goes into one pool, and upgrades apply to every ship. Repairs and rearming use the shared pool but only fix your own ship.
- **Four docking clamps:** each pilot has their own, and a clamp's light turns amber when it's occupied.
- **Low lag:** ships and enemies are predicted with the same orbital physics between updates, so they stay smooth at internet latencies.
- If a guest leaves, the flight carries on with the waves rescaled for who's left. If the host leaves, everyone else carries on solo.
- **No free respawns:** when you're shot down you watch your wingmates. Click to switch who you follow. To bring you back, a living pilot docks at Kepler Station and spends **100 shared scrap** on your revive; you come back docked in your clamp. If every pilot is down at once, the run is over.
- Pausing doesn't stop the shared world.
- **To load the game from another computer on your network** without setting it up there, start the host's server with `./serve.sh --lan` and open the address it prints. The game can also be published with GitHub Pages: in the repo's Settings → Pages, choose *Deploy from a branch* → `main` / root. Then anyone can play from the link.

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
| Q | Fire a homing missile once locked (2 per wave on Normal, refilled each wave) |
| B | Docking assist: the autopilot flies the rendezvous (any thrust key cancels). With a Dreadnought alive it parks you 600 m behind it instead |
| F | Undock from the station |
| N | Call the next wave early |
| Esc | Pause |

## Between waves

- After each wave you get **2 minutes** before the next one. A countdown sits at the top of the screen, with alarms at 60, 30 and 10 seconds.
- Destroyed ships leave **wrecks** on the orbit they died on. Fly within 75 m of one to salvage its scrap: raider 12, seeker 8, warden 35, lancer 20, sower 25, aegis 30, Dreadnought 150. Wrecks disappear after 2 minutes.
- **Kepler Station** holds a high, slow orbit: 2,500 m at 100 m/s, a lap every ~2.6 minutes. That's slower than a free orbit up there (~167 m/s), so station-keeping thrusters burn continuously; you can see them firing toward the hole. It's marked in green. Get within 300 m of it while moving under 40 m/s relative to it and you dock automatically. When you're close, the HUD shows your range and relative speed, plus green markers for your velocity relative to the station; burn toward ⊗ to match its speed.
- **Docking assist (B):** the autopilot simulates candidate burns twice a second against the station's future path, flies the best transfer, then brakes in on final approach. In tests it docked from anywhere in the arena in about 25–100 s.
- **Salvage drones:** spare missiles can collect scrap. Aim at a wreck and press E (a quicker, green lock), then Q. The drone scoops up the wreck and hops on to any others within 1.5 km. Any missile that passes through a wreck collects it.
- While docked you can spend scrap on:
  - Cannon Overcharge: +25% cannon damage per level
  - Missile Racks: +1 missile per wave
  - Missile Boosters: +30% missile thrust and top speed
  - Shield Capacitors: faster shield regeneration
  - Hull Plating: +25 maximum hull per level
  - Nanite Repair: the hull repairs itself, +0.75% of max hull per second per level (up to 3%/s)
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
- `src/net.js`: multiplayer links (LAN: PeerJS / WebRTC; REMOTE: WebSocket to the host's relay), room codes, clock sync
- `serve.py`: local web server, plus the REMOTE relay and Cloudflare tunnel (`--remote`)
- `src/remote.js`: the other pilot: physics-based prediction and smoothing
- `src/ships.js`: procedural ship models
- `src/fx.js`: bolts, particles, trails, space dust
- `src/hud.js`: HUD markers, bars and notices
- `src/radar3d.js`: the 3D holographic orbital radar (turns with your view)
- `src/audio.js`: synthesized sound effects
