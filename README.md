# Event Horizon

A 3D space-combat game built with three.js where the whole fight takes place in orbit around a black hole.

## Run it

```bash
./serve.sh
```

Then open http://localhost:8000. You need Python 3 (preinstalled on macOS). The page loads three.js from a CDN, so it needs an internet connection.

To use a different port: `./serve.sh 8080`.

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
| Esc | Pause |

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
- `src/ships.js`: procedural ship models
- `src/fx.js`: bolts, particles, trails, space dust
- `src/hud.js`: HUD and orbital radar
- `src/audio.js`: synthesized sound effects
