# Event Horizon

A 3D space-combat game built with three.js where the whole fight takes place in orbit around a black hole.

## Run it

```bash
./serve.sh
```

Then open http://localhost:8000. You need Python 3 (preinstalled on macOS). The page loads three.js from a CDN, so it needs an internet connection.

To use a different port: `./serve.sh 8080`.

The **GRAPHICS** button on the main menu (and in the pause menu, mid-run) cycles three presets:

| Preset | Render resolution | Black hole ray-march steps | Anti-aliasing |
|---|---|---|---|
| HIGH | 1.5× (capped at the display's) | full | 4× |
| MEDIUM | 1.0× | ~30% fewer | 4× |
| LOW | 0.7× | ~50% fewer | 2× |

## MK2 ship and the tech tree

Once **Missile Racks** and **Hull Plating** are both maxed, the station's upgrade list offers **UPGRADE TO MK2 SHIP** for 300 scrap (crew-priced in multiplayer, and shared like every upgrade). The MK2 has **+50% engine power** and a refitted look (wingtip nacelles, gold trim), and it keeps every upgrade you've bought.

After that, the upgrade list is replaced by the **MK2 tech tree**: 77 nodes in four branches. Your existing upgrades are the first tiers of their chains. Click a node to see what it does and what it needs, then **BUY**.

- **Weapons:** Cannon Overcharge to VI · Smart Ammo I–II (I: bolts 25% faster and 40% farther, about 1.4 km, with a wider, gravity-aware aim assist; II: an aim assist that snaps on from about twice as far off the crosshair, 600 scrap) · Rapid Cyclers (+15% fire rate) · Heat Sinks (−20% heat per shot) · **Railgun** ◆ (hold right mouse to charge, release to fire a hitscan slug, 700 m range; 8 scrap a shot; 4 s cooldown) · Railgun Coils I–V (+300 m railgun range each, up to 2.2 km) · Slug Foundry I–IV (each shot costs 1 scrap less, down to 4) · Capacitor Bank (faster charge) · Piercing Slug (hits everything in its path)
- **Missiles:** Missile Racks to V · Missile Boosters to IV · Quick Lock (40% faster locks) · Cluster Warheads (wider, harder blasts) · Missile Payload I–V (+30 m blast radius and +30% missile damage per level) · Auto-Rearm (a missile every 40 s)
- **Defense:** Hull Plating to IX · Shield Capacitors to V · Nanite Repair to VIII · Shield Matrix (+50 max shield per level) · Emergency Shield (refills your shield once per wave when your hull drops below 25%) · Reactive Armour (−40% from collisions, rams and mines)
- **Engineering:** Thruster Tuning (+15% engine power per level) · **Afterburner** ◆ (R: 3 s of double thrust, 15 s cooldown) · Salvage Magnet (+50% pickup range per level) · Scrap Refinery I–IV (+20% scrap per level; no prerequisite) · **Jump Drive** ◆ (Y: jump to the opposite point of your orbit; needs Afterburner and Scrap Refinery II)

The debug launcher has **MK2** and **MK2 + ALL TECH** presets for testing.

## Enemies after the first boss

New types join one at a time, and the first appearance of each gets a NEW CONTACT banner explaining it.

- **Hunting parties:** every 25 s of a wave (the first 10 s in), a third of it turns aggressive for 25 s. Shoot down the whole party and the next one comes straight away: those hostiles hunt you from any range, close in faster and fight from closer in, so a few are always on you but never the whole wave. You get "⚠ N HOSTILES CLOSING IN". In multiplayer the third is shared evenly between the pilots out flying, each taking the hostiles nearest them. (Not the Dreadnought, mines, seekers or the Aegis.)
- **Last hostiles:** once a wave is down to fewer than eight hostiles (nothing left to warp in), everything left hunts the nearest pilot for good ("⚠ LAST HOSTILES HUNTING YOU"), Aegis included, so a wave can't stall. **Overtime:** 8 minutes into a wave, everything left goes into a frenzy ("⚠ WAVE OVERTIME · EVERY HOSTILE IS IN A FRENZY"): 70% more thrust, closing in up to 2.8× faster, fighting from much closer in, and firing (or laying mines) 60% faster. Seekers always chase from any range.

- **Seekers** no longer come in waves on their own. **Wardens** (the pink gunships, wave 3+, announced with a NEW CONTACT banner) launch them: each warden launches one as it warps in, then a seeker drone about every 15 s at a pilot it can see within 1 km (at most two of its own in flight), and keeps its cannon. You get a "⚠ WARDEN LAUNCHED A SEEKER" notice. The Dreadnought launches them too. Launched seekers leave no wreck. From wave 14 they're Seeker MK2s.

- **Lancer (wave 6+):** a beam sniper that keeps its distance. A faint green aim line tracks you while it charges. When the line starts flashing it has **locked**, and about a second later it fires an instant 36-damage beam. The last lancer left in a wave fires 40% more often. It aims at where you'll be if you keep coasting, so thrust *across* its aim line during the lock to dodge. Thrusting straight toward or away from it doesn't help. The hole blocks the beam.
- **Sower (wave 8+):** a slow, armoured mine-layer that flings proximity mines out behind it every couple of seconds (up to 16 per sower). Each mine is thrown sideways onto its own slightly different orbit, so a sower's minefield spreads out over hundreds of metres. Mines arm after 1.5 s, blink faster when you're close, and go off within about 80 m, with a blast reaching 130 m (up to 24 damage). Shoot them from further out; each is worth 25 points. Leftover mines fizzle when the wave ends and never block it.
- **Aegis (wave 11+):** unarmed. Every ship within 260 m of it is tethered to it and takes 90% less damage, shown as a violet bubble and SHIELDED on its marker. Kill it first.

Their wrecks are worth 20 (lancer), 25 (sower) and 30 (aegis) scrap.

## The Dreadnought (every 5th wave)

On waves 5, 10, 15 and so on, an enemy fortress warps in with a smaller escort than usual, and comes hunting.

- **It pursues you.** It closes on the nearest pilot at up to about 55 m/s and settles about 550 m away, matching your orbit. It accelerates more slowly than your ship, so you can outrun it, and it keeps clear of the hole.
- **Armour:** 280 hull, plus 30% more on each later appearance and ×crew size in multiplayer. Its health bar sits at the top of the screen.
- **Six turrets** (later Dreadnoughts add two more each appearance: 8, 10, then 12), each covering its own side of the hull (top, bottom, port, starboard), firing 4-round bursts out to 1300 m. The hull and the hole block their aim. Destroying one is worth 250 points.
- **Railgun:** like a lancer's but much heavier and wider. A thick red aim line from its nose tracks you, flashes when it locks, then fires a 60-damage beam about a second later that hits anything within 8 m of the line. Thrust hard across the line to dodge; the HUD warns "DREADNOUGHT RAILGUN CHARGING" and "BEAM LOCKED".
- **Seeker launcher:** seekers are flung out to the sides, swing wide and curve in on you from the flanks rather than head-on. A pair (one per tube) every 6–8 s whenever a pilot is within 2.2 km and in sight; in multiplayer one seeker per pilot in reach instead. Each later Dreadnought adds one more seeker to every volley (up to three more). Up to two volleys' worth can be out at once. Below half hull it launches 40% more often, with up to three volleys out ("⚠ DREADNOUGHT CRIPPLED · SEEKER LAUNCHES QUICKEN"). You get a "SEEKERS LAUNCHED" alert, then "⚠ SEEKER INBOUND · 640 m" with a beep that speeds up as one closes. Launched seekers leave no wreck.
- **Launch bay:** while a pilot is within 2.2 km and in sight, a raider launches from its flank every 12 s ("⚠ DREADNOUGHT LAUNCHED A RAIDER"), up to six of its own at once. These leave wrecks like any raider.
- **Lock range:** your missiles lock onto it from 2000 m (double the usual), and aiming anywhere on the hull counts.
- **Intercept:** with a Dreadnought on the field, B chases it down and holds you 600 m off, then hands control back.
- **Ramming** it just bounces you off and hurts.
- **Destroying it** is worth 3000 points and leaves a hulk worth 250 scrap.

## Debug launch

DEBUG LAUNCH on the main menu starts a solo run at any wave (1–30) with any upgrade levels and starting scrap. It has a one-click preset for the wave-5 boss. Debug runs don't count toward your best score.

## Difficulty

Pick it on the main menu, above LAUNCH:

| | Enemies per wave | Enemy damage | Missiles per wave |
|---|---|---|---|
| Easy | −30% | −35% | 3 |
| Normal | standard | standard | 2 |
| Hard | +35% | +30% | 1 |

**Custom:** pick CUSTOM to open an editor with four sliders: **enemy count, enemy damage, enemy health and upgrade prices**. The sliders cover 50–150%, and the number boxes take anything from 10–1000% (count and health) or 0–1000% (damage and prices). Two switches sit under the sliders: **First person view**, and **Easier Dreadnought**, which shuts its raider launch bay and stops its seeker volleys speeding up once it's below half hull. Custom keeps Normal's 2 missiles, and your settings are remembered. Click CUSTOM again to edit them. In multiplayer the host's custom numbers apply to everyone.

**Custom → ADVANCED** opens a second set of sliders (standard values in brackets):

- **Enemy spawns:** raiders, wardens, lancers, sowers and aegis, each 0–500% of the usual number per wave (100%)
- **Dreadnought:** arrives every 0–15 waves, 0 = never (5) · hull strength 25–500% (100%) · turret fire rate 25–400% (100%) · turret burst 1–10 shots (3)
- **Enemy behaviour:** speed, how fast they close in, 25–300% (100%) · thrust 25–300% (100%) · hunting party every 5–120 s (25 s) · hunting party size 0–100% of the wave, 0 = none (33%)
- **Enemy weapons:** raider fire rate 25–400% and burst 1–10 (3) · warden fire rate and burst (1) · warden seeker launch every 3–60 s (15 s) · lancer fire rate · sower mine rate (all rates 100%)
- **World:** station orbit speed 100–167 m/s (145)

Type in a number box to go past the end of its slider: up to 2000% for spawns and rates, 1000% for speed and thrust, 50-shot bursts, 5000% Dreadnought hull, a boss every 100 waves, 600 s intervals and a 300 m/s station. RESET ADVANCED puts just these back. The difficulty line shows "advanced tuning" when any of them differ from standard.

Enemy counts stack with crew scaling in multiplayer. Enemy damage covers their cannon fire, seeker rams and collisions with enemy ships. The black hole's tides and the accretion disk hurt the same on every setting. Each difficulty keeps its own best score. In multiplayer the host picks the difficulty in the waiting room and everyone flies with it.

## Multiplayer (up to 8 pilots)

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

- **Co-op waves that scale with the crew:** each extra pilot up to four adds +100% hostiles (2 pilots 2×, 3 pilots 3×, 4 pilots 4×) and makes upgrades 60% pricier (1.6×, 2.2×, 2.8×). Pilots five to eight count half each (8 pilots: 6× hostiles, 4× prices), which keeps big rooms playable and the host's upload manageable. The host's game runs the enemies and everyone sees the same ones. Each enemy hunts whichever pilot is closest.
- **Fair hits:** each pilot's game decides whether enemy fire hits *their own* ship. Your hits on enemies go to the host, which applies the damage and credits the kill (and its score) to whoever made it.
- **Shared economy:** wrecks appear for everyone and can be salvaged once. Scrap goes into one pool, and upgrades apply to every ship. Repairs and rearming use the shared pool but only fix your own ship.
- **Eight docking clamps:** each pilot has their own (four on the cross-shaped mount, four further out on the diagonals), and a clamp's light turns amber when it's occupied.
- **Low lag:** ships and enemies are predicted with the same orbital physics between updates, so they stay smooth at internet latencies.
- If a guest leaves, the flight carries on with the waves rescaled for who's left. If the host leaves, everyone else carries on solo.
- **No free respawns:** when you're shot down you watch your wingmates. Click to switch who you follow. To bring you back, a living pilot docks at Kepler Station and spends **100 shared scrap** on your revive; you come back docked in your clamp. If every pilot is down at once, the run is over.
- Pausing doesn't stop the shared world.
- **To load the game from another computer on your network** without setting it up there, start the host's server with `./serve.sh --lan` and open the address it prints. The game can also be published with GitHub Pages: in the repo's Settings → Pages, choose *Deploy from a branch* → `main` / root. Then anyone can play from the link.

## Controls

| Input | Action |
| --- | --- |
| Mouse or T / F / G / H | Steer (T = up, F = left, G = down, H = right) |
| W / S, ↑ / ↓, or I / K | Main thruster / retro thruster |
| A / D, ← / →, or J / L | Strafe left / right |
| Space / Shift | Thrust up / down |
| Z / C | Roll |
| Left click, Ctrl, or 5 (including numpad) | Fire cannons (hold) |
| E | Start a missile lock (keep the target near the crosshair for 1.5 s) |
| Q | Fire a homing missile once locked (2 per wave on Normal, refilled each wave) |
| B | Docking assist: the autopilot flies the rendezvous (any thrust key cancels). With a Dreadnought alive it parks you 600 m behind it instead |
| F | Undock from the station |
| Right mouse or 7 (including numpad) | Railgun (MK2 tech): hold to charge, release to fire |
| 6 (including numpad) | Middle click (no in-game action) |
| R | Afterburner (MK2 tech): 3 s of double engine power |
| Y | Jump Drive (MK2 tech): jump to the opposite point of your orbit, halfway round the hole (45 s cooldown) |
| N | Call the next wave early |
| , / . | Time warp between waves: slower / faster through 1×, 2×, 3×, 5×, 10×. Only when no hostiles are around; it drops back to 1× 10 s before the next wave, or if any pilot is hit. In multiplayer it's shared: any pilot can change it, unless the host ticked HOST-ONLY TIME WARP in the waiting room |
| P | Show / hide the performance counter: FPS, average and worst frame time, CPU time per frame, render resolution |
| Esc | Pause |

## Between waves

- After each wave you get **2 minutes** before the next one. A countdown sits at the top of the screen, with alarms at 60, 30 and 10 seconds.
- Destroyed ships leave **wrecks** on the orbit they died on. Fly within 75 m of one to salvage its scrap: raider 12, warden 35, lancer 20, sower 25, aegis 30, Dreadnought 250. Wrecks disappear after 2 minutes.
- **Every run starts at Kepler Station:** your ship sits in its docking clamp (your own clamp in multiplayer), and the clamps release it after a couple of seconds (or press F to launch at once). The first wave arrives 10 s in (12 s in multiplayer).
- **Kepler Station** holds a high orbit: 2,500 m at 145 m/s, a lap every ~1.8 minutes. That's a little slower than a free orbit up there (~167 m/s), so station-keeping thrusters burn continuously; you can see them firing toward the hole. Undocking puts you on the free orbit that matches its circle, so you drift gently ahead of it. It's marked in green. Get within 300 m of it while moving under 40 m/s relative to it and you dock automatically. When you're close, the HUD shows your range and relative speed, plus green markers for your velocity relative to the station; burn toward ⊗ to match its speed.
- **Docking assist (B):** twice a second the autopilot simulates candidate plans against the station's future path (burn-and-coast transfers, and powered pursuits that fly straight at it or swing round the hole first) and flies whichever reaches docking range soonest while staying well clear of the hole. In tests it docked from a 1,100 m combat orbit in 20–43 s (31 s on average). The Dreadnought intercept uses the same planner.
- **Salvage drones:** spare missiles can collect scrap. Aim at a wreck and press E (a quicker, green lock), then Q. The drone scoops up the wreck and hops on to any others within 1.5 km. Any missile that passes through a wreck collects it.
- While docked you can spend scrap on:
  - Cannon Overcharge: +25% cannon damage per level
  - Missile Racks: +1 missile per wave
  - Missile Boosters: +30% missile thrust and top speed, and +200 m lock range per level (1000 m base; doubled against the Dreadnought)
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
- From a 1,100 m orbit, falling in takes about 10 s of continuous reverse thrust.
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
- `favicon.svg`: the tab icon (a little black hole)
- `src/net.js`: multiplayer links (LAN: PeerJS / WebRTC; REMOTE: WebSocket to the host's relay), room codes, clock sync
- `serve.py`: local web server, plus the REMOTE relay and Cloudflare tunnel (`--remote`)
- `src/remote.js`: the other pilot: physics-based prediction and smoothing
- `src/ships.js`: procedural ship models
- `src/fx.js`: bolts, particles, trails, space dust
- `src/hud.js`: HUD markers, bars and notices
- `src/radar3d.js`: the 3D holographic orbital radar (turns with your view)
- `src/audio.js`: synthesized sound effects
