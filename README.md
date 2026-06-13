# Super Snoopers

Low-poly browser arena shooter built with [three.js](https://threejs.org/) and peer-to-peer multiplayer via [PeerJS](https://peerjs.com/). No build step — pure static files.

## Play locally

Needs an HTTP server (the FBX/texture/audio files can't be `fetch`ed over `file://`):

```bash
./run.sh            # or: python3 -m http.server 8080
```

Open <http://localhost:8080>.

## Controls

**Desktop**
- **WASD** move · **Shift** sprint · **Space** jump · **X** dash
- **Mouse** look · **Left click** fire (hold for auto AK) · **Right click** scope (AK / pistol)
- **R** reload · **1–4** or scroll switch weapon · **Esc** pause / leave

**Mobile** — on-screen joystick (move), drag right side (look), circular **FIRE** / **JUMP** buttons (+ **R** / **X**), tap weapon slots to switch.

## Weapons
AK-47 (auto) · TT-33 (semi) · Scythe (melee) · MK2 Grenade (throwable).

## Multiplayer
- **Quick Match** — finds an open public room or hosts one (room id appears in the URL).
- **Play with Friends** — create a private room, share the code / URL; others join by code.

## Tech
`index.html` (UI + HUD) · `game.js` (engine, weapons, networking, mobile) · `assets/` (models, textures, sounds).
