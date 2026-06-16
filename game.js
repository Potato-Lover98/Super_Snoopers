// Super Snoopers — low-poly three.js arena shooter
// Engine + networking. Assets: assets/ak.fbx + PBR textures.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const HALF_PI = Math.PI / 2;
const VIEW_LAYER = 1;   // viewmodels live here; lit only by camera-rig lights

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CFG = {
  mag: 40,            // bullets per magazine
  reloadMs: 2200,
  fireRateMs: 95,
  damage: 18,
  moveSpeed: 60,      // accel units/s^2
  sprintMul: 1.7,
  damping: 10,        // velocity damping (higher = snappier stop)
  jumpSpeed: 9,
  gravity: 26,
  eyeHeight: 1.7,
  playerRadius: 0.4,
  arenaHalf: 130,     // huge arena
  stepUp: 0.75,       // max height a player can step/climb in one go
  netTickMs: 50,      // position broadcast interval
};

const TEX_DIR = './assets/';

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------
let renderer, scene, camera, controls, clock;
const colliders = [];          // {min,max} AABB boxes for buildings
let raycaster = new THREE.Raycaster();

// ---- Weapon definitions (4 slots) ----
// type: auto (hold to fire), semi (click), melee (swing), throw (lob bomb)
const WEAPONS = [
  { key:'ak', name:'AK-47', type:'auto', mag:40, fireMs:95, dmg:18, reloadMs:2200,
    fbx:'./assets/ak/ak.fbx',
    tex:{ map:'./assets/ak/AK_Base_color.png', normalMap:'./assets/ak/AK_Normal_OpenGL.png',
          metalnessMap:'./assets/ak/AK_Metallic.png', roughnessMap:'./assets/ak/AK_Roughness.png',
          aoMap:'./assets/ak/AK_Mixed_AO.png' },
    pos:[0.32,-0.34,-0.65], rot:[0,Math.PI,0], scale:0.9 },

  { key:'pistol', name:'TT-33', type:'semi', mag:8, fireMs:180, dmg:38, reloadMs:1300,
    fbx:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_2018.FBX',
    tex:{ map:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_BaseColor.png',
          normalMap:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_Normal.png',
          metalnessMap:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_Metallic.png',
          roughnessMap:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_Roughness.png',
          aoMap:'./assets/pistol/uploads_files_2127688_tt33_cgtrader/tt33_AO.png' },
    pos:[0.26,-0.30,-0.55], rot:[0, HALF_PI, 0], scale:0.5 },

  // scythe: shaft was lying flat across screen → stand it up pointing forward,
  // anchored bottom-right. Fine-tune live with the P adjust tool if needed.
  { key:'melee', name:'Scythe', type:'melee', dmg:55, swingMs:480, range:4.5,
    fbx:'./assets/melee/uploads_files_699850_Rwby_scythe_Materials.fbx',
    tex:{}, mat:{ color:0xd03030, metalness:0.6, roughness:0.4 },
    pos:[0.5,-0.5,-1.0], rot:[-6.221, 1.48, 1.65], scale:1.1 },

  { key:'bomb', name:'Grenade', type:'throw', count:3, dmg:80, radius:7,
    fbx:'./assets/bomb/mk2.fbx',
    tex:{ map:'./assets/bomb/mk2_basecolor.png',
          normalMap:'./assets/bomb/mk2_normal.png',
          metalnessMap:'./assets/bomb/mk2_metallic.png',
          roughnessMap:'./assets/bomb/mk2_roughness.png',
          aoMap:'./assets/bomb/mk2_ao.png' },
    pos:[0.28,-0.30,-0.5], rot:[0,Math.PI,0], scale:0.35 },
];
let curWeapon = 0;
let firing = false;            // left mouse held
let scoping = false;           // right mouse held (aim-down-sights)
const BASE_FOV = 75;
// per-weapon ADS: zoomed fov + viewmodel pull-to-center pose
const ADS = {
  ak:     { fov: 45, pos: [0.0, -0.18, -0.45] },
  pistol: { fov: 55, pos: [0.0, -0.16, -0.42] },
};
let meleeUntil = 0;            // timestamp melee swing ends

const player = {
  vel: new THREE.Vector3(),
  onGround: true,
  health: 100,
  alive: true,
  kills: 0, deaths: 0,
  lastShot: 0,
};
const keys = Object.create(null);

// dash
const dash = { energy: 1, cooldown: 3.0, lastDash: -10, active: 0 };

// mobile
const IS_TOUCH = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const touchMove = { x: 0, y: 0 };   // joystick vector (-1..1)

const grenades = [];           // live thrown projectiles {mesh,vel,fuse}
const tracers = [];            // visible bullet streaks {mesh,life}

let net = null;                // PeerJS networking layer (or null = offline)
let remotePlayers = new Map(); // id -> {mesh, name, target:{pos,rot}, health}
let myId = 'solo';
let myName = 'SuperSnooper';
let playerModelTemplate = null; // optional exported player mesh (.glb/.fbx)
let running = false, paused = false;
let spectator = false;         // AI-vs-AI: you walk around with no weapon
let botMode = false;
const bots = [];               // AI fighters {mesh,name,hp,pos,vel,...,llm}

// recoil state
let recoil = 0;
let camPunch = 0;       // current applied pitch offset (recovers to 0)
let camPunchApplied = 0; // how much we last added to camera.rotation.x
let flash;              // muzzle flash light

// ---- audio (Web Audio for low-latency overlapping SFX) ----
const SFX_FILES = {
  ak:     './assets/ak/ribhavagrawal-bulletshot-impact-sound-effect-230462.mp3',
  pistol: './assets/pistol/freesound_community-gun-shots-from-a-distance-7-96391.mp3',
  melee:  './assets/melee/54427377-sword-slash-476148.mp3',
  bomb:   './assets/bomb/daviddumaisaudio-grenade-explosion-14-190266.mp3',
};
let audioCtx = null;
const sfxBuffers = Object.create(null);

function initAudio() {
  if (audioCtx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audioCtx = new AC();
  for (const [key, url] of Object.entries(SFX_FILES)) {
    fetch(encodeURI(url))
      .then(r => r.arrayBuffer())
      .then(buf => audioCtx.decodeAudioData(buf))
      .then(decoded => { sfxBuffers[key] = decoded; })
      .catch(e => console.warn('sfx load failed:', key, e));
  }
}

function playSfx(key, volume = 1) {
  if (!audioCtx || !sfxBuffers[key]) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const src = audioCtx.createBufferSource();
  src.buffer = sfxBuffers[key];
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(audioCtx.destination);
  src.start(0);
}

// ===========================================================================
// BOOT  (init() is invoked at the very bottom, after all module-level
// let/const declarations are initialized — avoids temporal-dead-zone errors
// since init() runs animate() synchronously.)
// ===========================================================================
function init() {
  const canvas = document.getElementById('game');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fc6e0);
  scene.fog = new THREE.Fog(0x9fc6e0, 120, 360);

  camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(0, CFG.eyeHeight, 0);

  controls = new PointerLockControls(camera, document.body);
  scene.add(controls.getObject());
  camera.layers.enable(VIEW_LAYER);   // camera renders both world + viewmodel layers

  clock = new THREE.Clock();

  buildLights();
  setupViewLights();
  buildMap();

  addEventListener('resize', onResize);
  document.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (!running) return;
    if (e.code === 'KeyP') { toggleDevAdjust(); return; }
    if (devAdjust && handleDevKey(e.code)) { e.preventDefault(); return; }
    if (e.code === 'KeyR') reload();
    if (e.code === 'KeyX') doDash();
    if (e.code === 'Digit1') switchWeapon(0);
    if (e.code === 'Digit2') switchWeapon(1);
    if (e.code === 'Digit3') switchWeapon(2);
    if (e.code === 'Digit4') switchWeapon(3);
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });
  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || !running) return;
    // if not locked (just joined / resumed), first click re-locks instead of firing
    if (!controls.isLocked) { controls.lock(); return; }
    if (paused) return;
    initAudio();
    firing = true;
    primaryAction();          // immediate first action (semi/melee/throw fire once)
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) firing = false; if (e.button === 2) scoping = false; });
  document.addEventListener('mousedown', e => {
    if (e.button === 2 && running && !paused && controls.isLocked) scoping = true;
  });
  document.addEventListener('contextmenu', e => { if (running) e.preventDefault(); });  // no right-click menu
  addEventListener('wheel', e => {
    if (!running || paused || devAdjust) return;
    switchWeapon((curWeapon + (e.deltaY > 0 ? 1 : 3)) % 4);
  });
  // adjust-mode: hold X/Y/Z and drag the mouse to rotate that axis
  document.addEventListener('mousemove', e => {
    if (!devAdjust) return;
    const w = WEAPONS[curWeapon], g = w.group; if (!g) return;
    const d = (e.movementX || 0) * 0.01;
    if (keys['KeyX']) w.rot[0] += d;
    else if (keys['KeyY']) w.rot[1] += d;
    else if (keys['KeyZ']) w.rot[2] += d;
    else return;
    g.rotation.set(w.rot[0], w.rot[1], w.rot[2]);
    g.baseRot = g.rotation.clone(); w.baseRot = g.rotation.clone();
    showDevHud();
  });

  // ESC unlocks pointer → show in-game pause menu
  controls.addEventListener('unlock', () => { if (running) openPause(); });
  controls.addEventListener('lock', () => { closePause(); });

  camera.rotation.order = 'YXZ';      // yaw/pitch order for manual touch-look
  loadWeapons();      // async — loads all 4 viewmodels + textures
  loadPlayerModel();  // optional exported player mesh (.glb/.fbx)
  wireMenu();
  if (IS_TOUCH) setupMobile();
  animate();
}

// ---------------------------------------------------------------------------
// MOBILE: left joystick (move), right drag (look), FIRE/JUMP/R/X buttons
// ---------------------------------------------------------------------------
function setupMobile() {
  document.getElementById('mobile').classList.add('on');
  const $ = id => document.getElementById(id);

  // joystick
  const joy = $('joy'), knob = $('joy-knob');
  let joyId = null, cx = 0, cy = 0, R = 55;
  const joyStart = e => {
    const t = e.changedTouches[0]; joyId = t.identifier;
    const r = joy.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    joyMove(e); e.preventDefault();
  };
  const joyMove = e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyId) continue;
      let dx = t.clientX - cx, dy = t.clientY - cy;
      const d = Math.hypot(dx, dy) || 1;
      if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px,${dy}px)`;
      touchMove.x = dx / R; touchMove.y = dy / R;
      e.preventDefault();
    }
  };
  const joyEnd = e => {
    for (const t of e.changedTouches) if (t.identifier === joyId) {
      joyId = null; touchMove.x = touchMove.y = 0; knob.style.transform = '';
    }
  };
  joy.addEventListener('touchstart', joyStart, { passive: false });
  joy.addEventListener('touchmove', joyMove, { passive: false });
  joy.addEventListener('touchend', joyEnd);
  joy.addEventListener('touchcancel', joyEnd);

  // look (drag on right zone)
  const look = $('look-zone');
  let lookId = null, lx = 0, ly = 0;
  look.addEventListener('touchstart', e => {
    const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY; e.preventDefault();
  }, { passive: false });
  look.addEventListener('touchmove', e => {
    for (const t of e.changedTouches) {
      if (t.identifier !== lookId) continue;
      const dx = t.clientX - lx, dy = t.clientY - ly; lx = t.clientX; ly = t.clientY;
      camera.rotation.y -= dx * 0.005;
      camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - dy * 0.005, -1.5, 1.5);
      e.preventDefault();
    }
  }, { passive: false });
  look.addEventListener('touchend', e => { for (const t of e.changedTouches) if (t.identifier === lookId) lookId = null; });

  // buttons
  const press = (id, down, up) => {
    const el = $(id);
    el.addEventListener('touchstart', e => { down(); e.preventDefault(); }, { passive: false });
    el.addEventListener('touchend', e => { if (up) up(); e.preventDefault(); }, { passive: false });
  };
  press('btn-shoot', () => { if (running) { firing = true; primaryAction(); } }, () => { firing = false; });
  press('btn-jump',  () => { keys['Space'] = true; }, () => { keys['Space'] = false; });
  press('btn-reload', () => { if (running) reload(); });
  press('btn-dash',   () => { if (running) doDash(); });

  // tap weapon slots to switch
  document.querySelectorAll('.slot').forEach(s => {
    s.style.pointerEvents = 'auto';
    s.addEventListener('touchstart', e => { switchWeapon(+s.dataset.slot); e.preventDefault(); }, { passive: false });
  });
}

// Load the rigged player mannequin (Walking.fbx — has a built-in walk clip).
// Falls back to player.glb / player.fbx, else the procedural mannequin.
// playerModelTemplate = { object, animations } when loaded.
function loadPlayerModel() {
  const fbx = new FBXLoader();
  const setFromFbx = obj => { playerModelTemplate = { object: normalizePlayer(obj), animations: obj.animations || [] }; };
  fbx.load('./assets/player/Walking.fbx', setFromFbx, undefined, () => {
    fbx.load('./assets/player/player.fbx', setFromFbx, undefined, () => {
      new GLTFLoader().load('./assets/player/player.glb',
        gltf => { playerModelTemplate = { object: normalizePlayer(gltf.scene), animations: gltf.animations || [] }; },
        undefined, () => {/* none — keep procedural */});
    });
  });
}

function normalizePlayer(obj) {
  const size = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(size);
  const h = size.y || 1;
  obj.scale.setScalar(2.0 / h);           // ~2 units tall
  obj.updateMatrixWorld(true);            // apply scale before re-measuring
  const box = new THREE.Box3().setFromObject(obj);
  obj.position.y -= box.min.y;            // feet on ground (y=0)
  obj.traverse(o => { if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.frustumCulled = false; } });
  return obj;
}

function genName() {
  return 'SuperSnooper' + (1 + Math.floor(Math.random() * 998));
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

// ===========================================================================
// LIGHTING
// ===========================================================================
function buildLights() {
  const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x4a5a3a, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
  sun.position.set(40, 80, 30);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const s = 150;
  sun.shadow.camera.left = -s; sun.shadow.camera.right = s;
  sun.shadow.camera.top = s; sun.shadow.camera.bottom = -s;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
}

// dedicated lights for the viewmodel layer — so the harsh world directional
// sun no longer hits the FBX guns. Attached to camera, follows the view.
function setupViewLights() {
  const amb = new THREE.HemisphereLight(0xffffff, 0x888888, 1.15);
  amb.layers.set(VIEW_LAYER);
  camera.add(amb);
  const key = new THREE.DirectionalLight(0xffffff, 1.2);
  key.position.set(0.5, 0.8, 1);     // from front-upper, in camera space
  key.layers.set(VIEW_LAYER);
  camera.add(key);
  const fill = new THREE.DirectionalLight(0xbfd0ff, 0.5);
  fill.position.set(-0.6, -0.2, 0.5);
  fill.layers.set(VIEW_LAYER);
  camera.add(fill);
}

// ===========================================================================
// MAP — low poly arena
// ===========================================================================
function buildMap() {
  // ground
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(CFG.arenaHalf * 2, CFG.arenaHalf * 2),
    new THREE.MeshStandardMaterial({ color: 0x6f8f4f, roughness: 1 })
  );
  ground.rotation.x = -HALF_PI;
  ground.receiveShadow = true;
  scene.add(ground);

  const A = CFG.arenaHalf;

  // perimeter walls (tall so nobody escapes the arena)
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: .9 });
  const H = 12, T = 3;
  [[0,H/2,-A,A*2,H,T],[0,H/2,A,A*2,H,T],[-A,H/2,0,T,H,A*2],[A,H/2,0,T,H,A*2]]
    .forEach(([x,y,z,w,h,d]) => addBox(x,y,z,w,h,d,wallMat));

  // SEEDED rng → the random map is identical for every player (multiplayer-safe)
  const rnd = mulberry32(0x5009A1);
  const rand = (a, b) => a + (b - a) * rnd();
  const palette = [0xc94c4c, 0xd9a441, 0x4c7fc9, 0x5bc06b, 0xb47ad0, 0xe0e0e0, 0xff8a5b, 0x46c2c2];
  const placed = [];

  const tryPlace = (w, d, gap) => {
    for (let t = 0; t < 40; t++) {
      const x = rand(-A + 18, A - 18), z = rand(-A + 18, A - 18);
      if (Math.hypot(x, z) < 16) continue;                 // keep spawn area open
      let ok = true;
      for (const p of placed) {
        if (Math.abs(x - p.x) < (w + p.w) / 2 + gap && Math.abs(z - p.z) < (d + p.d) / 2 + gap) { ok = false; break; }
      }
      if (ok) { placed.push({ x, z, w, d }); return { x, z }; }
    }
    return null;
  };

  // climbable buildings (with a staircase to a walkable roof)
  for (let i = 0; i < 30; i++) {
    const w = rand(11, 22), d = rand(11, 22), h = rand(5, 14);
    const p = tryPlace(w, d, 22); if (!p) continue;
    const mat = new THREE.MeshStandardMaterial({ color: palette[Math.floor(rnd() * palette.length)], roughness: .85, flatShading: true });
    addBox(p.x, h / 2, p.z, w, h, d, mat, true);
    addBox(p.x, h + 0.25, p.z, w + 1, 0.5, d + 1, new THREE.MeshStandardMaterial({ color: 0x2b2f38, flatShading: true }), false); // roof trim
    addStairs(p.x, p.z, w, d, h, Math.floor(rnd() * 4));   // climb to the roof
  }

  // tall landmark towers (not climbable — visual variety / sightline blockers)
  for (let i = 0; i < 6; i++) {
    const w = rand(9, 15), d = rand(9, 15), h = rand(20, 34);
    const p = tryPlace(w, d, 24); if (!p) continue;
    const mat = new THREE.MeshStandardMaterial({ color: palette[Math.floor(rnd() * palette.length)], roughness: .8, flatShading: true });
    addBox(p.x, h / 2, p.z, w, h, d, mat, true);
    addBox(p.x, h + 0.4, p.z, w + 1.5, 0.8, d + 1.5, new THREE.MeshStandardMaterial({ color: 0x23262e, flatShading: true }), false);
  }

  // cover crates scattered around
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x9c6b3f, roughness: 1, flatShading: true });
  for (let i = 0; i < 48; i++) {
    const x = rand(-A + 10, A - 10), z = rand(-A + 10, A - 10);
    if (Math.hypot(x, z) < 10) continue;
    const s = rand(1.8, 3.2);
    addBox(x, s / 2, z, s, s, s, crateMat, true);
  }
}

// small deterministic PRNG so the procedural map matches across all clients
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// build a solid staircase from the ground up to a building's roof, on one side
function addStairs(bx, bz, bw, bd, h, side) {
  const rise = 0.6, depth = 0.85;
  const n = Math.ceil(h / rise);
  const stepW = Math.min(bw, bd) * 0.55;
  const mat = new THREE.MeshStandardMaterial({ color: 0x6c7280, roughness: .9, flatShading: true });
  let dx = 0, dz = 0, faceX = bx, faceZ = bz;
  if (side === 0) { dz = 1; faceZ = bz + bd / 2; }
  else if (side === 1) { dz = -1; faceZ = bz - bd / 2; }
  else if (side === 2) { dx = 1; faceX = bx + bw / 2; }
  else { dx = -1; faceX = bx - bw / 2; }
  for (let i = 0; i < n; i++) {
    const top = (i + 1) * rise;                 // solid block, top is the tread
    const dist = (n - i - 0.5) * depth;         // farthest+lowest → nearest+highest (roof)
    const cx = faceX + dx * dist, cz = faceZ + dz * dist;
    const w = dx ? depth : stepW;
    const d = dz ? depth : stepW;
    addBox(cx, top / 2, cz, w, top, d, mat, true);
  }
}

function addBox(x, y, z, w, h, d, mat, collide = true) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true; mesh.receiveShadow = true;
  scene.add(mesh);
  if (collide) {
    colliders.push({
      min: new THREE.Vector3(x - w/2, y - h/2, z - d/2),
      max: new THREE.Vector3(x + w/2, y + h/2, z + d/2),
      mesh,
    });
  }
  return mesh;
}

// ===========================================================================
// WEAPONS — load all 4 viewmodels, swap on switch
// ===========================================================================
function loadWeapons() {
  scene.add(camera);                 // ensure camera (and attached viewmodels) is in scene
  // init runtime ammo state
  WEAPONS.forEach(w => {
    w.ammo = w.mag != null ? w.mag : (w.count != null ? w.count : 0);
    w.reloading = false;
    w.group = null; w.mixer = null; w.reloadAction = null; w.baseRot = null; w.swingAction = null;
  });
  const loader = new FBXLoader();
  const tl = new THREE.TextureLoader();
  const srgb = t => { if (t) t.colorSpace = THREE.SRGBColorSpace; return t; };

  WEAPONS.forEach((w, idx) => {
    // build material from provided textures (paths may contain spaces/parens → encodeURI)
    let mat;
    if (w.tex && w.tex.map) {
      const o = {};
      o.map = srgb(tl.load(encodeURI(w.tex.map)));
      if (w.tex.normalMap)     o.normalMap = tl.load(encodeURI(w.tex.normalMap));
      if (w.tex.metalnessMap)  o.metalnessMap = tl.load(encodeURI(w.tex.metalnessMap));
      if (w.tex.roughnessMap)  o.roughnessMap = tl.load(encodeURI(w.tex.roughnessMap));
      if (w.tex.aoMap)         o.aoMap = tl.load(encodeURI(w.tex.aoMap));
      o.metalness = 1.0; o.roughness = 1.0;
      mat = new THREE.MeshStandardMaterial(o);
    } else {
      mat = new THREE.MeshStandardMaterial(w.mat || { color: 0x999999, metalness: .5, roughness: .5 });
    }

    // INSTANT placeholder so hands show immediately; real FBX swaps in when ready
    const g = new THREE.Group();
    const ph = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x3a3a3a, metalness: .4, roughness: .6 }));
    ph.name = '__placeholder';
    g.add(ph);
    g.rotation.set(w.rot[0], w.rot[1], w.rot[2]);
    g.position.set(w.pos[0], w.pos[1], w.pos[2]);
    g.visible = (idx === curWeapon);
    g.baseRot = g.rotation.clone();
    g.traverse(o => o.layers.set(VIEW_LAYER));
    camera.add(g);
    w.group = g; w.baseRot = g.rotation.clone();

    loader.load(encodeURI(w.fbx), (fbx) => {
      fbx.traverse(o => {
        if (o.isMesh) {
          o.material = mat;
          o.castShadow = true;
          o.frustumCulled = false;
          if (o.geometry && !o.geometry.attributes.uv2 && o.geometry.attributes.uv)
            o.geometry.setAttribute('uv2', o.geometry.attributes.uv);
        }
      });

      // find the main (largest) mesh — used for centering and stray cleanup
      let main = null, mainVol = -1;
      const meshes = [];
      fbx.traverse(o => { if (o.isMesh) meshes.push(o); });
      const boxOf = m => new THREE.Box3().setFromObject(m);
      for (const m of meshes) {
        const s = new THREE.Vector3(); boxOf(m).getSize(s);
        const vol = s.x * s.y * s.z;
        if (vol > mainVol) { mainVol = vol; main = m; }
      }
      // drop stray detached parts (e.g. the pistol's floating bullet)
      if (w.cleanStray && main) {
        const mainBox = boxOf(main);
        const mc = mainBox.getCenter(new THREE.Vector3());
        const ms = mainBox.getSize(new THREE.Vector3());
        const reach = Math.max(ms.x, ms.y, ms.z) * 1.2;
        for (const m of meshes) {
          if (m === main) continue;
          const c2 = boxOf(m).getCenter(new THREE.Vector3());
          if (c2.distanceTo(mc) > reach) m.visible = false;  // hide far stray
        }
      }

      // normalize size from the MAIN mesh so a stray doesn't shrink the gun
      const refBox = (w.cleanStray && main) ? boxOf(main) : new THREE.Box3().setFromObject(fbx);
      const size = refBox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      fbx.scale.setScalar((w.scale || 0.9) / maxDim);
      fbx.updateMatrixWorld(true);

      // recenter on the main mesh
      const c = (w.cleanStray && main)
        ? boxOf(main).getCenter(new THREE.Vector3())
        : new THREE.Box3().setFromObject(fbx).getCenter(new THREE.Vector3());
      fbx.position.sub(c);

      // swap placeholder → real model (group already attached to camera)
      const old = g.getObjectByName('__placeholder');
      if (old) g.remove(old);
      g.add(fbx);
      fbx.layers.set(VIEW_LAYER);
      fbx.traverse(o => o.layers.set(VIEW_LAYER));
      w._model = fbx;   // keep textured model to clone for world projectiles (bomb)

      // animations: reload / swing
      if (fbx.animations && fbx.animations.length) {
        w.mixer = new THREE.AnimationMixer(fbx);
        const rel = fbx.animations.find(c => /reload/i.test(c.name));
        if (rel) { w.reloadAction = w.mixer.clipAction(rel); w.reloadAction.setLoop(THREE.LoopOnce); w.reloadAction.clampWhenFinished = true; }
        const sw = fbx.animations.find(c => /(swing|slash|attack)/i.test(c.name)) || fbx.animations[0];
        if (sw && w.type === 'melee') { w.swingAction = w.mixer.clipAction(sw); w.swingAction.setLoop(THREE.LoopOnce); w.swingAction.clampWhenFinished = true; }
      }
    }, undefined, (err) => {
      console.error('weapon load failed (keeping placeholder):', w.key, err);
    });
  });

  // load bar not needed — hands appear instantly via placeholders
  const wrap = document.getElementById('loadbar-wrap');
  if (wrap) wrap.style.display = 'none';
}

function activeGroup() { return WEAPONS[curWeapon].group; }

// scoping only on guns that have an ADS profile (ak / pistol)
function scopeActive() { return scoping && player.alive && !!ADS[WEAPONS[curWeapon].key]; }

// smooth FOV zoom toward the scoped value (or back to normal)
function updateScope(dt) {
  const target = scopeActive() ? ADS[WEAPONS[curWeapon].key].fov : BASE_FOV;
  if (Math.abs(camera.fov - target) < 0.05) { camera.fov = target; return; }
  camera.fov += (target - camera.fov) * Math.min(1, dt * 14);
  camera.updateProjectionMatrix();
}

// ---- live viewmodel adjust tool (press P in-game) ----
// I/K rot.x  J/L rot.y  U/O rot.z  arrows pos x/z  PgUp/Dn pos y  -/= scale
let devAdjust = false;
function handleDevKey(code) {
  const w = WEAPONS[curWeapon], g = w.group; if (!g) return false;
  const R = 0.05, P = 0.02, S = 0.05;
  switch (code) {
    case 'KeyI': w.rot[0] += R; break;  case 'KeyK': w.rot[0] -= R; break;
    case 'KeyJ': w.rot[1] += R; break;  case 'KeyL': w.rot[1] -= R; break;
    case 'KeyU': w.rot[2] += R; break;  case 'KeyO': w.rot[2] -= R; break;
    case 'ArrowLeft': w.pos[0] -= P; break;  case 'ArrowRight': w.pos[0] += P; break;
    case 'ArrowUp': w.pos[2] -= P; break;     case 'ArrowDown': w.pos[2] += P; break;
    case 'PageUp': w.pos[1] += P; break;      case 'PageDown': w.pos[1] -= P; break;
    case 'Minus': w.scale = Math.max(0.05, w.scale - S); rebuildWeaponScale(w); break;
    case 'Equal': w.scale += S; rebuildWeaponScale(w); break;
    default: return false;
  }
  g.rotation.set(w.rot[0], w.rot[1], w.rot[2]);
  g.position.set(w.pos[0], w.pos[1], w.pos[2]);
  g.baseRot = g.rotation.clone(); w.baseRot = g.rotation.clone();
  showDevHud();
  return true;
}
function rebuildWeaponScale(w) {
  // re-normalize the inner model to the new target scale
  const fbx = w._model; if (!fbx) return;
  const box = new THREE.Box3().setFromObject(fbx);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) / (fbx.scale.x || 1) || 1;
  fbx.scale.setScalar(w.scale / maxDim);
}
function toggleDevAdjust() {
  devAdjust = !devAdjust;
  const panel = document.getElementById('dev');
  if (devAdjust) {
    panel.style.display = 'block';
    document.getElementById('dev-out').style.display = 'none';
    controls.unlock();          // free the mouse for dragging (won't open pause)
  } else {
    panel.style.display = 'none';
    controls.lock();
  }
  showDevHud();
}

function devSnippet(w) {
  const r = w.rot.map(v => +v.toFixed(3));
  const p = w.pos.map(v => +v.toFixed(3));
  return `pos:[${p.join(',')}], rot:[${r.join(',')}], scale:${+w.scale.toFixed(3)}`;
}

function showDevHud() {
  if (!devAdjust) return;
  const w = WEAPONS[curWeapon];
  document.getElementById('dev-values').textContent = `${w.key} → ${devSnippet(w)}`;
}

function switchWeapon(i) {
  if (spectator) return;        // no weapons while spectating AI duel
  if (i === curWeapon || i < 0 || i > 3) return;
  if (WEAPONS[i].type === 'throw' && WEAPONS[i].ammo <= 0) return;   // no bombs left → can't equip
  if (WEAPONS[curWeapon].group) WEAPONS[curWeapon].group.visible = false;
  curWeapon = i;
  if (WEAPONS[i].group) WEAPONS[i].group.visible = true;
  // cancel any in-progress reload visual text
  document.getElementById('reload-text').style.display = WEAPONS[i].reloading ? 'block' : 'none';
  updateWeaponHud();
}

function updateWeaponHud() {
  const w = WEAPONS[curWeapon];
  const count = document.getElementById('ammo-count');
  const max = document.getElementById('ammo-max');
  if (w.type === 'melee') { count.textContent = '∞'; max.textContent = ''; }
  else if (w.type === 'throw') { count.textContent = w.ammo; max.textContent = ' bombs'; }
  else { count.textContent = w.ammo; max.textContent = '/' + w.mag; }
  // slot squares
  document.querySelectorAll('.slot').forEach(s => {
    const slot = +s.dataset.slot;
    const ww = WEAPONS[slot];
    // bomb slot disappears from the bar when out of bombs
    if (ww.type === 'throw') s.style.display = ww.ammo > 0 ? '' : 'none';
    s.classList.toggle('active', slot === curWeapon);
    const amtEl = document.getElementById('amt-' + slot);
    if (amtEl) amtEl.textContent = ww.type === 'melee' ? '∞' : ww.ammo;
  });
}

// ===========================================================================
// SHOOTING
// ===========================================================================
// called once on mouse-down; dispatches by weapon type
function primaryAction() {
  if (spectator) return;        // AI-vs-AI spectator has no weapon
  const w = WEAPONS[curWeapon];
  if (!player.alive) return;
  if (w.type === 'melee') return meleeSwing();
  if (w.type === 'throw') return throwBomb();
  // semi fires one shot here; auto's first shot too (autoFire handles held)
  fireBullet();
}

// auto weapons keep firing while held; called every frame from animate
function autoFire() {
  if (!firing || paused || spectator) return;
  const w = WEAPONS[curWeapon];
  if (w.type === 'auto') fireBullet();
}

function fireBullet() {
  const w = WEAPONS[curWeapon];
  if (!player.alive || w.reloading) return;
  const now = performance.now();
  if (now - player.lastShot < w.fireMs) return;
  if (w.ammo <= 0) { reload(); return; }
  player.lastShot = now;
  w.ammo--;
  updateWeaponHud();
  recoil = Math.min(recoil + 0.025, 0.08);
  muzzleFlash();
  playSfx(w.key, 0.6);          // ak / pistol gunshot
  if (w.ammo === 0) reload();

  // hitscan vs remote players — raycast the whole avatar mesh (full body:
  // head, torso, limbs all count), fall back to the AABB if needed.
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  let nearest = null, nearDist = Infinity, hitId = null, hitPoint = null;
  for (const [id, rp] of remotePlayers) {
    if (rp.dead) continue;
    let d = -1, pt = null;
    const hits = raycaster.intersectObject(rp.mesh, true);
    if (hits.length) { d = hits[0].distance; pt = hits[0].point; }
    else {
      const p = new THREE.Vector3();
      if (raycaster.ray.intersectBox(rp.box, p)) { d = camera.position.distanceTo(p); pt = p; }
    }
    if (d > 0 && d < nearDist && !wallBlocks(d)) { nearDist = d; nearest = rp; hitId = id; hitPoint = pt.clone(); }
  }
  // visual endpoint: enemy → wall → far
  let end;
  if (nearest) end = hitPoint;
  else {
    const wallHit = raycaster.intersectObjects(colliders.map(c => c.mesh), false);
    end = wallHit.length ? wallHit[0].point : camera.position.clone().addScaledVector(raycaster.ray.direction, 120);
  }
  spawnTracer(end);

  if (nearest) {
    hitMarker();
    if (net) net.send({ t: 'hit', target: hitId, dmg: w.dmg });
  }
}

// visible bullet streak from muzzle to impact, fades fast
function spawnTracer(end) {
  const muzzle = new THREE.Vector3(0.18, -0.12, -1.1);
  camera.localToWorld(muzzle);
  const geo = new THREE.BufferGeometry().setFromPoints([muzzle, end]);
  const mat = new THREE.LineBasicMaterial({ color: 0xfff2a0, transparent: true, opacity: 1 });
  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  scene.add(line);
  tracers.push({ mesh: line, life: 0.07 });

  const spark = new THREE.PointLight(0xffd070, 3, 4);
  spark.position.copy(end); scene.add(spark);
  tracers.push({ mesh: spark, life: 0.06, light: true });
}

function updateTracers(dt) {
  for (let i = tracers.length - 1; i >= 0; i--) {
    const t = tracers[i];
    t.life -= dt;
    if (t.light) t.mesh.intensity = Math.max(0, t.mesh.intensity - dt * 60);
    else t.mesh.material.opacity = Math.max(0, t.life / 0.07);
    if (t.life <= 0) {
      scene.remove(t.mesh);
      if (t.mesh.geometry) t.mesh.geometry.dispose();
      if (t.mesh.material) t.mesh.material.dispose();
      tracers.splice(i, 1);
    }
  }
}

function meleeSwing() {
  const w = WEAPONS[curWeapon];
  const now = performance.now();
  if (now < meleeUntil) return;          // already swinging
  meleeUntil = now + w.swingMs;
  playSfx('melee', 0.8);                 // sword slash
  if (w.swingAction) { w.swingAction.reset(); w.swingAction.timeScale = (w.swingAction.getClip().duration * 1000) / w.swingMs; w.swingAction.play(); }
  // hit check at mid-swing
  setTimeout(() => {
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    for (const [id, rp] of remotePlayers) {
      if (rp.dead) continue;
      // close-range full-body: distance to the avatar OR a ray hit within range
      const bodyDist = camera.position.distanceTo(
        new THREE.Vector3(rp.mesh.position.x, camera.position.y, rp.mesh.position.z));
      const hits = raycaster.intersectObject(rp.mesh, true);
      const rayHit = hits.length && hits[0].distance <= w.range;
      if ((rayHit || bodyDist <= w.range) && !wallBlocks(Math.min(bodyDist, w.range))) {
        hitMarker();
        if (net) net.send({ t: 'hit', target: id, dmg: w.dmg });
      }
    }
  }, w.swingMs * 0.4);
}

function throwBomb() {
  const w = WEAPONS[curWeapon];
  const now = performance.now();
  if (w.ammo <= 0) return;
  if (now - player.lastShot < 600) return;
  player.lastShot = now;
  w.ammo--;
  updateWeaponHud();

  // spawn projectile from camera, lob forward — uses the actual bomb FBX
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const start = camera.position.clone().addScaledVector(dir, 0.8);
  const mesh = makeBombMesh();
  mesh.position.copy(start); scene.add(mesh);
  const vel = dir.clone().multiplyScalar(26); vel.y += 6;
  const spin = new THREE.Vector3(8, 5, 3);
  grenades.push({ mesh, vel, spin, fuse: 1.6, dmg: w.dmg, radius: w.radius, mine: true });
  if (net) net.send({ t: 'bomb', x: start.x, y: start.y, z: start.z, vx: vel.x, vy: vel.y, vz: vel.z, radius: w.radius });

  // out of bombs → slot vanishes, swap to AK
  if (w.ammo <= 0) { firing = false; switchWeapon(0); updateWeaponHud(); }
}

// clone the loaded bomb FBX for a world-space projectile (fallback to sphere)
function makeBombMesh() {
  const bomb = WEAPONS[3];
  if (bomb._model) {
    const m = bomb._model.clone(true);
    // viewmodel was normalized to ~0.35 units; scale up for a readable world grenade
    const size = new THREE.Vector3();
    new THREE.Box3().setFromObject(m).getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    m.scale.multiplyScalar(0.6 / maxDim);
    m.traverse(o => { if (o.isMesh) o.castShadow = true; o.layers.set(0); });  // world layer (lit by sun)
    const wrap = new THREE.Group(); wrap.add(m);
    return wrap;
  }
  return new THREE.Mesh(new THREE.SphereGeometry(0.25, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2f3a1e, metalness: .6, roughness: .5, flatShading: true }));
}

function updateGrenades(dt) {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.vel.y -= CFG.gravity * dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    if (g.spin) { g.mesh.rotation.x += g.spin.x * dt; g.mesh.rotation.y += g.spin.y * dt; g.mesh.rotation.z += g.spin.z * dt; }
    if (g.mesh.position.y < 0.25) { g.mesh.position.y = 0.25; g.vel.y *= -0.4; g.vel.x *= 0.6; g.vel.z *= 0.6; }
    g.fuse -= dt;
    if (g.fuse <= 0) { explode(g); scene.remove(g.mesh); grenades.splice(i, 1); }
  }
}

function explode(g) {
  // explosion sound — quieter the farther it is from the player
  const dist = controls.getObject().position.distanceTo(g.mesh.position);
  playSfx('bomb', Math.max(0.15, 1 - dist / 60));
  // visual flash
  const light = new THREE.PointLight(0xffaa33, 12, g.radius * 3);
  light.position.copy(g.mesh.position); scene.add(light);
  const ring = new THREE.Mesh(new THREE.SphereGeometry(g.radius, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xff7722, transparent: true, opacity: .5 }));
  ring.position.copy(g.mesh.position); scene.add(ring);
  let life = 0.4;
  const fade = () => { life -= 0.05; ring.material.opacity = life; light.intensity = life * 30;
    if (life > 0) requestAnimationFrame(fade); else { scene.remove(ring); scene.remove(light); } };
  fade();
  // own grenade: damage nearby enemies
  if (g.mine) {
    for (const [id, rp] of remotePlayers) {
      const d = rp.mesh.position.distanceTo(g.mesh.position);
      if (d <= g.radius) {
        const dmg = Math.round(g.dmg * (1 - d / g.radius));
        if (dmg > 0 && net) net.send({ t: 'hit', target: id, dmg });
      }
    }
  }
  // splash on self regardless of owner
  const dSelf = controls.getObject().position.distanceTo(g.mesh.position);
  if (dSelf <= g.radius) takeDamage(Math.round(g.dmg * (1 - dSelf / g.radius) * 0.6), g.fromId || 'bomb');
}

// gory player-death burst (visual + sound), no damage
function deathExplosion(pos) {
  const dist = controls.getObject().position.distanceTo(pos);
  playSfx('bomb', Math.max(0.2, 1 - dist / 60));
  const light = new THREE.PointLight(0xff5522, 14, 22);
  light.position.copy(pos); scene.add(light);
  const ring = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10),
    new THREE.MeshBasicMaterial({ color: 0xff6a2a, transparent: true, opacity: .8 }));
  ring.position.copy(pos); scene.add(ring);
  // chunky debris bits flying out
  const bits = [];
  for (let i = 0; i < 14; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xc94c4c, flatShading: true }));
    b.position.copy(pos).y += 1;
    b.userData.v = new THREE.Vector3((Math.random()*2-1)*8, Math.random()*9 + 3, (Math.random()*2-1)*8);
    scene.add(b); bits.push(b);
  }
  let life = 1.0;
  const step = () => {
    const dt = 0.033; life -= dt;
    ring.scale.setScalar(1 + (1 - life) * 6); ring.material.opacity = Math.max(0, life * 0.8);
    light.intensity = Math.max(0, life * 14);
    for (const b of bits) { b.userData.v.y -= 26 * dt; b.position.addScaledVector(b.userData.v, dt); b.rotation.x += 0.3; b.rotation.y += 0.2; }
    if (life > 0) requestAnimationFrame(step);
    else { scene.remove(ring); scene.remove(light); bits.forEach(b => scene.remove(b)); }
  };
  step();
}

function wallBlocks(maxDist) {
  const meshes = colliders.map(c => c.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  return hits.length && hits[0].distance < maxDist;
}

function reload() {
  const w = WEAPONS[curWeapon];
  if (w.type === 'melee' || w.type === 'throw') return;
  if (w.reloading || w.ammo === w.mag || !player.alive) return;
  w.reloading = true;
  w.reloadStart = performance.now();     // drives the goofy spin
  document.getElementById('reload-text').style.display = 'block';
  if (w.reloadAction && w.mixer) {
    w.reloadAction.reset();
    w.reloadAction.timeScale = (w.reloadAction.getClip().duration * 1000) / w.reloadMs;
    w.reloadAction.play();
  }
  setTimeout(() => {
    w.ammo = w.mag;
    w.reloading = false;
    if (curWeapon === WEAPONS.indexOf(w)) document.getElementById('reload-text').style.display = 'none';
    updateWeaponHud();
  }, w.reloadMs);
}

function muzzleFlash() {
  if (!flash) {
    flash = new THREE.PointLight(0xffaa33, 0, 8);
    flash.position.set(0.3, -0.2, -1.4);
    camera.add(flash);
  }
  flash.intensity = 6;
  recoilKick();
}
function recoilKick() {
  // add to a recoverable punch (capped) instead of permanently tilting camera
  camPunch = Math.min(camPunch + 0.018 + Math.random() * 0.006, 0.06);
}

// applied each frame: undo last punch, decay it, re-apply — recovers smoothly
// and never fights mouse-look pitch.
function updateRecoil(dt) {
  camera.rotation.x -= camPunchApplied;     // undo previous frame's punch
  camPunch -= camPunch * Math.min(1, dt * 9); // ease back toward 0
  if (camPunch < 0.0005) camPunch = 0;
  camera.rotation.x += camPunch;            // re-apply current punch
  camPunchApplied = camPunch;
}

// ===========================================================================
// MOVEMENT + COLLISION
// ===========================================================================
function updateMovement(dt) {
  if (!player.alive) return;
  const obj = controls.getObject();

  // damping (smooth deceleration)
  player.vel.x -= player.vel.x * CFG.damping * dt;
  player.vel.z -= player.vel.z * CFG.damping * dt;
  player.vel.y -= CFG.gravity * dt;

  let fwd = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  let side = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
  // joystick adds in (up = forward)
  fwd = THREE.MathUtils.clamp(fwd - touchMove.y, -1, 1);
  side = THREE.MathUtils.clamp(side + touchMove.x, -1, 1);
  const sprint = keys['ShiftLeft'] ? CFG.sprintMul : 1;

  // camera-relative directions (flattened)
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir); dir.y = 0; dir.normalize();
  const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();

  const accel = CFG.moveSpeed * sprint;
  if (fwd) player.vel.addScaledVector(dir, fwd * accel * dt);
  if (side) player.vel.addScaledVector(right, side * accel * dt);

  if (keys['Space'] && player.onGround) { player.vel.y = CFG.jumpSpeed; player.onGround = false; }

  // stash last move dir for dash (default forward if standing still)
  player._moveDir = (fwd || side)
    ? new THREE.Vector3().addScaledVector(dir, fwd).addScaledVector(right, side).normalize()
    : dir.clone();

  // integrate w/ axis-separated collision
  const pos = obj.position;
  moveAxis(pos, 'x', player.vel.x * dt);
  moveAxis(pos, 'z', player.vel.z * dt);

  // vertical
  pos.y += player.vel.y * dt;
  const floor = groundHeightAt(pos.x, pos.z, pos.y - CFG.eyeHeight) + CFG.eyeHeight;
  if (pos.y <= floor) { pos.y = floor; player.vel.y = 0; player.onGround = true; }
  else player.onGround = false;

  // arena clamp
  const A = CFG.arenaHalf - 1.5;
  pos.x = THREE.MathUtils.clamp(pos.x, -A, A);
  pos.z = THREE.MathUtils.clamp(pos.z, -A, A);

  // viewmodel sway / recoil recover
  const g = activeGroup();
  const w = WEAPONS[curWeapon];
  if (g && w.baseRot) {
    recoil = Math.max(0, recoil - dt * 0.4);
    const t = clock.elapsedTime;
    const moving = (fwd || side) ? 1 : 0;
    const bobX = Math.sin(t * 10) * 0.004 * moving * sprint;
    const bobY = Math.abs(Math.cos(t * 10)) * 0.004 * moving * sprint;
    g.position.x = w.pos[0] + bobX;
    g.position.y = w.pos[1] + bobY - recoil * 0.3;
    g.position.z = w.pos[2] + recoil * 0.4;
    g.rotation.x = w.baseRot.x - recoil * 1.2;
    g.rotation.y = w.baseRot.y;
    g.rotation.z = w.baseRot.z;

    // goofy reload spin — 3 fast flips, settles back to base when done
    if (w.reloading && w.reloadStart != null) {
      const rp = Math.min(1, (performance.now() - w.reloadStart) / w.reloadMs);
      const ease = 1 - Math.pow(1 - rp, 2);          // fast then slow
      g.rotation.x = w.baseRot.x + ease * Math.PI * 2 * 3;  // ends on a full multiple → normal
    }

    // aim-down-sights: pull weapon toward center (damped bob already low)
    const ads = scopeActive() ? ADS[w.key] : null;
    if (ads) {
      const a = Math.min(1, dt * 12);
      g.position.x += (ads.pos[0] - g.position.x) * a;
      g.position.y += (ads.pos[1] - g.position.y) * a;
      g.position.z += (ads.pos[2] - g.position.z) * a;
    }

    // procedural slash arc for melee while swinging
    if (w.type === 'melee') {
      const now = performance.now();
      const left = meleeUntil - now;
      if (left > 0) {
        const p = 1 - left / w.swingMs;            // 0..1 through swing
        const arc = Math.sin(p * Math.PI);          // ease in/out
        // sweep blade forward-and-across (flipped so the front leads)
        g.rotation.z = w.baseRot.z - arc * 2.2;
        g.rotation.x = w.baseRot.x + arc * 0.9;
        g.position.x = w.pos[0] + arc * 0.25;
        g.position.z = w.pos[2] - arc * 0.35;       // lunge forward
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DASH (poxel-style) — burst of speed along current move dir, energy recharges
// ---------------------------------------------------------------------------
function doDash() {
  if (!player.alive || dash.energy < 1) return;
  dash.energy = 0;
  dash.active = 0.18;                      // brief dash window
  const d = player._moveDir || new THREE.Vector3(0, 0, -1);
  player.vel.addScaledVector(d, 38);       // impulse
}

function updateDash(dt) {
  if (dash.energy < 1) dash.energy = Math.min(1, dash.energy + dt / dash.cooldown);
  if (dash.active > 0) dash.active = Math.max(0, dash.active - dt);
  const fill = document.getElementById('dash-fill');
  if (fill) {
    fill.style.width = (dash.energy * 100) + '%';
    fill.classList.toggle('ready', dash.energy >= 1);
  }
}

function moveAxis(pos, axis, delta) {
  const old = pos[axis];
  pos[axis] += delta;
  const r = CFG.playerRadius;
  const py0 = pos.y - CFG.eyeHeight, py1 = pos.y;
  for (const c of colliders) {
    if (pos.x + r > c.min.x && pos.x - r < c.max.x &&
        pos.z + r > c.min.z && pos.z - r < c.max.z &&
        py1 > c.min.y && py0 < c.max.y) {
      // climbable if the surface is only a small step above the feet (stairs);
      // otherwise it's a wall → block.
      if (c.max.y - py0 > CFG.stepUp) { pos[axis] = old; player.vel[axis] = 0; return; }
    }
  }
}

// highest surface under the player that's reachable with a single step-up
function groundHeightAt(x, z, feetY) {
  let h = 0;
  const r = CFG.playerRadius;
  for (const c of colliders) {
    if (x + r > c.min.x && x - r < c.max.x && z + r > c.min.z && z - r < c.max.z) {
      const top = c.max.y;
      if (top > h && top <= feetY + CFG.stepUp) h = top;   // step / roof we can stand on
    }
  }
  return h;
}

// ===========================================================================
// REMOTE PLAYERS (low-poly snooper avatar)
// ===========================================================================
// per-player color so snoopers are distinguishable
function colorFor(id) {
  let h = 0; const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return new THREE.Color(`hsl(${h},65%,55%)`);
}

function makeAvatar(name, id) {
  const g = new THREE.Group();

  if (playerModelTemplate) {
    const model = skeletonClone(playerModelTemplate.object);  // skinned-safe clone
    g.add(model);
    g.userData.tagY = 2.3;
    // per-clone walk animation
    const clips = playerModelTemplate.animations;
    if (clips && clips.length) {
      const mixer = new THREE.AnimationMixer(model);
      const walk = clips.find(c => /walk|run|move/i.test(c.name)) || clips[0];
      const action = mixer.clipAction(walk);
      action.play(); action.setEffectiveWeight(1); action.paused = true; // idle until moving
      g.userData.mixer = mixer;
      g.userData.walk = action;
    }
  } else {
    // detailed low-poly mannequin
    const col = colorFor(id || name);
    const skin = new THREE.MeshStandardMaterial({ color: col, roughness: .8, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f38, roughness: .9, flatShading: true });
    const part = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; g.add(m); return m; };

    part(new THREE.CapsuleGeometry(0.34, 0.7, 4, 10), skin, 0, 1.05, 0);          // torso
    part(new THREE.BoxGeometry(0.46, 0.46, 0.46), dark, 0, 1.72, 0);              // head
    // snout + eyes (snooper face)
    const snout = part(new THREE.BoxGeometry(0.22, 0.18, 0.26), dark, 0, 1.66, 0.28);
    part(new THREE.SphereGeometry(0.07, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111 }), 0, 1.62, 0.42);
    // floppy ears
    const earMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.7), flatShading: true });
    const e1 = part(new THREE.BoxGeometry(0.14, 0.5, 0.12), earMat, -0.28, 1.7, 0); e1.rotation.z = -0.5;
    const e2 = part(new THREE.BoxGeometry(0.14, 0.5, 0.12), earMat, 0.28, 1.7, 0); e2.rotation.z = 0.5;
    // arms
    const a1 = part(new THREE.CapsuleGeometry(0.12, 0.5, 4, 8), skin, -0.46, 1.05, 0); a1.rotation.z = 0.25;
    const a2 = part(new THREE.CapsuleGeometry(0.12, 0.5, 4, 8), skin, 0.46, 1.05, 0); a2.rotation.z = -0.25;
    // legs
    part(new THREE.CapsuleGeometry(0.14, 0.5, 4, 8), dark, -0.16, 0.4, 0);
    part(new THREE.CapsuleGeometry(0.14, 0.5, 4, 8), dark, 0.16, 0.4, 0);
    g.userData.legs = true;
    g.userData.tagY = 2.35;
  }

  // nametag
  const cv = document.createElement('canvas'); cv.width = 300; cv.height = 70;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.roundRect(0, 0, 300, 70, 14); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 30px Segoe UI, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(name || 'SuperSnooper', 150, 46);
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  tag.position.y = g.userData.tagY; tag.scale.set(1.9, 0.45, 1); g.add(tag);
  tag.raycast = () => {};   // nametag isn't a hit target
  g.userData.tag = tag;

  scene.add(g);
  return g;
}

function addRemote(id, name) {
  if (id === myId || id == null) return;   // never spawn a ghost of yourself
  if (remotePlayers.has(id)) return;
  const mesh = makeAvatar(name, id);
  remotePlayers.set(id, {
    mesh, name: name || 'SuperSnooper', health: 100, dead: false, kills: 0,
    target: { x: 0, y: 0, z: 0, ry: 0 },
    box: new THREE.Box3(),
  });
  renderLeaderboard();
}
function setRemoteName(id, name) {
  const rp = remotePlayers.get(id);
  if (!rp || !name || rp.name === name) return;
  rp.name = name;
  // redraw nametag
  const tag = rp.mesh.userData.tag;
  if (tag) {
    const cv = document.createElement('canvas'); cv.width = 300; cv.height = 70;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath(); ctx.roundRect(0, 0, 300, 70, 14); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 30px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(name, 150, 46);
    tag.material.map.dispose();
    tag.material.map = new THREE.CanvasTexture(cv);
  }
}
function removeRemote(id) {
  const rp = remotePlayers.get(id);
  if (rp) { scene.remove(rp.mesh); remotePlayers.delete(id); renderLeaderboard(); }
}

// FFA leaderboard (top-right) — all players sorted by kills
function renderLeaderboard() {
  const rows = document.getElementById('lb-rows');
  const cnt = document.getElementById('lb-count');
  if (!rows) return;
  const list = botMode
    ? bots.map(b => ({ name: b.name, kills: b.kills, me: false }))
    : [{ name: myName, kills: player.kills, me: true }];
  if (!botMode) for (const rp of remotePlayers.values()) list.push({ name: rp.name, kills: rp.kills || 0, me: false });
  list.sort((a, b) => b.kills - a.kills);
  if (cnt) cnt.textContent = botMode ? 'DUEL' : `${list.length}/${MAX_PLAYERS}`;
  rows.innerHTML = list.slice(0, MAX_PLAYERS).map(p =>
    `<div class="lb-row${p.me ? ' me' : ''}"><span class="nm">${escapeHtml(p.name)}</span><span class="kc">${p.kills}</span></div>`
  ).join('');
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }
// dead snooper vanishes until respawn
function setRemoteDead(id, dead) {
  const rp = remotePlayers.get(id);
  if (rp) { rp.dead = dead; rp.mesh.visible = !dead; }
}

function lerpRemotes(dt) {
  for (const rp of remotePlayers.values()) {
    const m = rp.mesh;
    if (rp.dead) continue;
    const k = Math.min(1, dt * 12);
    const moved = Math.abs(rp.target.x - m.position.x) + Math.abs(rp.target.z - m.position.z) > 0.01;
    m.position.x += (rp.target.x - m.position.x) * k;
    m.position.z += (rp.target.z - m.position.z) * k;
    // GROUND the avatar to the (identical, seeded) map surface under it → no
    // levitation, and the hitbox lines up with what's drawn.
    const surf = surfaceYAt(rp.target.x, rp.target.z, rp.target.y);
    m.position.y += (surf - m.position.y) * k;
    m.rotation.y += (rp.target.ry - m.rotation.y) * k;
    // rigged walk animation: run mixer, play only while moving (no manual bob)
    if (m.userData.mixer) {
      if (m.userData.walk) m.userData.walk.paused = !moved;
      m.userData.mixer.update(dt);
    }
    // full-body hitbox, generous, centered on the avatar
    rp.box.setFromCenterAndSize(
      new THREE.Vector3(m.position.x, m.position.y + 1.2, m.position.z),
      new THREE.Vector3(1.5, 2.5, 1.5)
    );
  }
}

// highest map surface under (x,z) the player is plausibly standing on
function surfaceYAt(x, z, hintY) {
  let h = 0;
  const r = 0.5;
  for (const c of colliders) {
    if (x + r > c.min.x && x - r < c.max.x && z + r > c.min.z && z - r < c.max.z) {
      const top = c.max.y;
      if (top > h && top <= (hintY || 0) + 1.4) h = top;
    }
  }
  return h;
}

// ===========================================================================
// NETWORK BROADCAST
// ===========================================================================
let lastTick = 0;
function netTick() {
  if (!net) return;
  const now = performance.now();
  if (now - lastTick < CFG.netTickMs) return;
  lastTick = now;
  const p = controls.getObject().position;
  net.send({
    t: 'pos',
    x: p.x, y: p.y - CFG.eyeHeight, z: p.z,
    ry: camera.rotation.y + Math.PI,  // facing
    name: myName,                     // self-heal names for late joiners
    kills: player.kills,              // for the FFA leaderboard
  });
}

function nameFor(id) {
  if (id === myId) return myName;
  const rp = remotePlayers.get(id);
  return rp ? rp.name : (id ? 'SuperSnooper' : 'enemy');
}

// ===========================================================================
// DAMAGE / DEATH
// ===========================================================================
function takeDamage(dmg, fromId) {
  if (!player.alive) return;
  player.health -= dmg;
  flashDamage();
  if (player.health <= 0) {
    player.health = 0; player.alive = false; player.deaths++;
    updateHud();
    addKillFeed(`${nameFor(fromId)} ☠ ${myName}`);
    deathExplosion(controls.getObject().position.clone());  // you explode
    if (net) net.send({ t: 'died', by: fromId });
    setTimeout(respawn, 5000);                              // respawn after 5s
  }
  updateHud();
}
function respawn() {
  player.health = 100; player.alive = true;
  WEAPONS.forEach(w => {
    w.reloading = false;
    w.ammo = w.mag != null ? w.mag : (w.count != null ? w.count : 0);
  });
  dash.energy = 1;
  document.getElementById('reload-text').style.display = 'none';
  const a = CFG.arenaHalf - 8;
  controls.getObject().position.set((Math.random()*2-1)*a, CFG.eyeHeight + 0.1, (Math.random()*2-1)*a);
  player.vel.set(0,0,0);
  updateHud();
  if (net) net.send({ t: 'spawn', name: myName });
}

// ===========================================================================
// HUD
// ===========================================================================
function updateHud() {
  document.getElementById('health-fill').style.width = player.health + '%';
  document.getElementById('sb-kills').textContent = player.kills;
  document.getElementById('sb-deaths').textContent = player.deaths;
  updateWeaponHud();
  renderLeaderboard();
}
function addKillFeed(txt) {
  const f = document.getElementById('killfeed');
  const d = document.createElement('div'); d.textContent = txt; f.prepend(d);
  setTimeout(() => d.remove(), 4000);
}
function hitMarker() {
  const h = document.getElementById('hitmark');
  h.style.opacity = '1'; setTimeout(() => h.style.opacity = '0', 90);
}
function flashDamage() {
  document.body.animate([{ boxShadow: 'inset 0 0 120px 40px rgba(255,0,0,.6)' }, { boxShadow: 'inset 0 0 0 0 transparent' }],
    { duration: 350 });
}
function shortId(id) { return id ? String(id).slice(0, 4) : 'enemy'; }

// ===========================================================================
// MAIN LOOP
// ===========================================================================
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (running && !paused) {
    updateMovement(dt);
    updateRecoil(dt);
    updateDash(dt);
    updateScope(dt);
    autoFire();
    updateGrenades(dt);
    updateTracers(dt);
    lerpRemotes(dt);
    if (botMode) updateBots(dt);
    netTick();
  }
  for (const w of WEAPONS) if (w.mixer) w.mixer.update(dt);
  if (flash && flash.intensity > 0) flash.intensity = Math.max(0, flash.intensity - dt * 40);
  renderer.render(scene, camera);
}

// ===========================================================================
// GAME START / PAUSE / LEAVE
// ===========================================================================
function startGame() {
  spectator = false; botMode = false; clearBots();
  document.getElementById('slots').style.display = '';
  document.getElementById('ammo').style.display = '';
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  myName = genName();                 // fresh random SuperSnooper#
  document.getElementById('roomtag').dataset.name = myName;
  initAudio();                        // create/resume audio on this gesture
  running = true;
  respawn();
  updateHud();
  if (!IS_TOUCH) controls.lock();     // mobile uses manual touch-look, no pointer lock
}

function openPause() {
  if (!running || devAdjust) return;   // dev adjust unlocks the pointer too — don't pause
  paused = true;
  firing = false;
  const roomEl = document.getElementById('pause-room');
  const code = net && net.roomId ? net.roomId : null;
  if (code) {
    document.getElementById('pause-room-code').textContent = code;
    roomEl.style.display = 'block';
    document.getElementById('pause-info').textContent =
      `Room ${code} · ${remotePlayers.size + 1} player(s) · share the URL to invite`;
  } else {
    roomEl.style.display = 'none';
    document.getElementById('pause-info').textContent = 'Practice mode (offline)';
  }
  document.getElementById('pause').style.display = 'flex';
}
function closePause() {
  paused = false;
  document.getElementById('pause').style.display = 'none';
  document.getElementById('pause-room').style.display = 'none';
}
function leaveGame() {
  if (net) {
    try {
      net.send({ t: 'bye' });
      stopHeartbeat();
      if (net.host && net.ns === PUB && net.roomId) mmPost('leave', { code: net.roomId });
      net.peer.destroy();
    } catch (e) {}
    net = null;
  }
  for (const id of [...remotePlayers.keys()]) removeRemote(id);
  clearBots(); botMode = false; spectator = false;
  document.getElementById('slots').style.display = '';   // restore weapon HUD
  document.getElementById('ammo').style.display = '';
  running = false; paused = false;
  closePause();
  document.getElementById('hud').style.display = 'none';
  document.getElementById('overlay').style.display = 'flex';
  setRoomUrl(null);
  // reset menu to main
  ['menu-friends','menu-host','menu-ai'].forEach(m => document.getElementById(m).style.display = 'none');
  document.getElementById('menu-main').style.display = 'block';
  document.getElementById('main-status').textContent = '';
}

// reflect the active room in the address bar (?room=CODE)
function setRoomUrl(code) {
  const url = new URL(location.href);
  if (code) url.searchParams.set('room', code);
  else url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

// ===========================================================================
// NETWORKING — PeerJS rooms
// Mesh topology: room = host peer id "snoop-XXXXX". Everyone connects to host;
// host relays. Quick match probes random room codes for a joinable one.
// ===========================================================================
// Two separate namespaces so Quick-Match (random probing) can NEVER stumble
// into a private friends room. PUB = quick pool, PRIV = friends-only codes.
const PUB  = 'snoopers-pub-v2-';
const PRIV = 'snoopers-priv-v2-';
const MAX_PLAYERS = 5;
const MM_API = '/api/rooms';                 // serverless matchmaking (Vercel)
const RELAY = new Set(['pos', 'hit', 'bomb', 'died', 'spawn']);  // host forwards these

// ---- matchmaking server calls ----
async function mmFind() {
  try { const r = await fetch(MM_API + '?action=find'); if (!r.ok) return null; const j = await r.json(); return j.code || null; }
  catch { return null; }
}
function mmPost(action, extra) {
  try { fetch(MM_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) }).catch(() => {}); }
  catch {}
}
function roomCount() { return net ? net.conns.size + 1 : 1; }   // peers + self
function mmBeat() { if (net && net.host && net.ns === PUB && net.roomId) mmPost('heartbeat', { code: net.roomId, count: roomCount() }); }
function startHeartbeat() { stopHeartbeat(); mmBeat(); if (net) net._beat = setInterval(mmBeat, 5000); }
function stopHeartbeat() { if (net && net._beat) { clearInterval(net._beat); net._beat = null; } }

function makeNet() {
  return {
    peer: null, host: false, conns: new Map(), roomId: null, ns: null, _beat: null,
    send(msg) { msg.from = myId; for (const c of this.conns.values()) if (c.open) c.send(msg); },
    sendTo(id, msg) { const c = this.conns.get(id); if (c && c.open) { msg.from = myId; c.send(msg); } },
    sendExcept(exceptId, msg) { for (const [id, c] of this.conns) if (id !== exceptId && c.open) c.send(msg); },
  };
}

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Star topology: clients connect only to the host; the host relays player
// events to everyone else. Simple + reliable for ≤5 players, and the cap is
// trivially enforced (the host counts its connections).
function handleNetData(conn, data) {
  const from = data.from || conn.peer;
  if (from === myId) return;
  if (net && net.host && RELAY.has(data.t)) net.sendExcept(conn.peer, data);  // relay

  switch (data.t) {
    case 'hello':
      addRemote(from, data.name); setRemoteName(from, data.name); renderLeaderboard();
      break;
    case 'pos': {
      let rp = remotePlayers.get(from);
      if (!rp) { addRemote(from, data.name); rp = remotePlayers.get(from); }
      else if (data.name) setRemoteName(from, data.name);
      if (rp) {
        rp.target.x = data.x; rp.target.y = data.y; rp.target.z = data.z; rp.target.ry = data.ry;
        rp.kills = data.kills || 0;
        if (rp.dead) setRemoteDead(from, false);
      }
      renderLeaderboard();
      break;
    }
    case 'hit':
      if (data.target === myId) takeDamage(data.dmg, from);
      break;
    case 'spawn':
      addRemote(from, data.name); setRemoteName(from, data.name); setRemoteDead(from, false);
      break;
    case 'bomb': {
      const mesh = makeBombMesh();
      mesh.position.set(data.x, data.y, data.z); scene.add(mesh);
      grenades.push({ mesh, vel: new THREE.Vector3(data.vx, data.vy, data.vz), spin: new THREE.Vector3(8,5,3), fuse: 1.6, dmg: 0, radius: data.radius, mine: false, fromId: from });
      break;
    }
    case 'died': {
      const rp = remotePlayers.get(from);
      if (rp) deathExplosion(rp.mesh.position.clone());   // enemy explodes
      setRemoteDead(from, true);                           // vanish until respawn
      if (data.by === myId) { player.kills++; updateHud(); addKillFeed(`${myName} ☠ ${nameFor(from)}`); }
      else addKillFeed(`${nameFor(data.by)} ☠ ${nameFor(from)}`);
      renderLeaderboard();
      break;
    }
    case 'bye':
      removeRemote(from); renderLeaderboard(); if (net && net.host) mmBeat();
      break;
  }
}

// ---- Host a room (ns = PUB for quick match, PRIV for friends) ----
function hostRoom(ns, onReady, onFail) {
  net = makeNet(); net.host = true; net.ns = ns;
  const code = genCode();
  net.roomId = code;
  const peer = new Peer(ns + code, { debug: 1 });
  net.peer = peer;
  peer.on('open', id => { myId = id; if (ns === PUB) startHeartbeat(); onReady(code); });
  peer.on('connection', conn => {
    conn.on('open', () => {
      if (net.conns.size >= MAX_PLAYERS - 1) {           // room full (self + 4)
        try { conn.send({ t: 'full' }); } catch (e) {}
        setTimeout(() => { try { conn.close(); } catch (e) {} }, 150);
        return;
      }
      net.conns.set(conn.peer, conn);
      conn.send({ t: 'welcome', name: myName, from: myId });
      mmBeat();
    });
    conn.on('data', d => handleNetData(conn, d));
    conn.on('close', () => { net.conns.delete(conn.peer); removeRemote(conn.peer); renderLeaderboard(); mmBeat(); });
    conn.on('error', () => {});
  });
  peer.on('error', err => {
    if (err.type === 'unavailable-id') hostRoom(ns, onReady, onFail);  // code taken, retry
    else onFail(err);
  });
}

// connect to a host id; resolves on 'welcome', fails on 'full' / timeout
function connectToHost(fullId, code, ns, onJoined, onFail) {
  const conn = net.peer.connect(fullId, { reliable: false });
  let done = false;
  conn.on('open', () => conn.send({ t: 'hello', name: myName, from: myId }));
  conn.on('data', d => {
    if (done) { handleNetData(conn, d); return; }
    if (d.t === 'full') { done = true; try { conn.close(); } catch (e) {} onFail('full'); return; }
    if (d.t === 'welcome') {
      done = true; net.ns = ns; net.roomId = code; net.conns.set(conn.peer, conn);
      addRemote(d.from || conn.peer, d.name); setRemoteName(d.from || conn.peer, d.name);
      onJoined(code);
      return;
    }
    handleNetData(conn, d);
  });
  conn.on('close', () => { net.conns.delete(conn.peer); removeRemote(conn.peer); });
  conn.on('error', () => {});
  setTimeout(() => { if (!done) { done = true; try { conn.close(); } catch (e) {} onFail('no-response'); } }, 4500);
}

// ---- Join by code — tries PRIV (friends) then PUB ----
function joinRoom(code, onJoined, onFail) {
  code = code.toUpperCase();
  net = makeNet(); net.host = false; net.roomId = code;
  const peer = new Peer(null, { debug: 1 });
  net.peer = peer;
  peer.on('open', () => {
    myId = peer.id;
    connectToHost(PRIV + code, code, PRIV, onJoined, e => {
      if (e === 'full') { onFail('full'); return; }
      connectToHost(PUB + code, code, PUB, onJoined, onFail);   // fall back to public
    });
  });
  peer.on('error', err => onFail(err.type || 'error'));
}

// ---- Quick match via the matchmaking server ----
function quickMatch(statusEl, onJoined) {
  net = makeNet(); net.host = false;
  const peer = new Peer(null, { debug: 1 });
  net.peer = peer;
  const hostNew = () => {
    statusEl.textContent = 'Creating a new room…';
    if (net.peer) net.peer.destroy();
    hostRoom(PUB, code => { setRoomTag('HOST ' + code); setRoomUrl(code); onJoined(); }, () => startSolo());
  };
  peer.on('open', async () => {
    myId = peer.id;
    statusEl.textContent = 'Finding a match…';
    const code = await mmFind();
    if (!code) return hostNew();
    statusEl.textContent = 'Joining room ' + code + '…';
    connectToHost(PUB + code, code, PUB,
      () => { setRoomTag('ROOM ' + code); setRoomUrl(code); onJoined(); },
      () => hostNew());     // full/dead → make our own
  });
  peer.on('error', () => startSolo());
}

function setRoomTag(txt) { const el = document.getElementById('roomtag'); el.dataset.room = txt; if (!devAdjust) el.textContent = txt; }

function startSolo() {
  net = null;
  setRoomTag('PRACTICE');
  // add a couple of dummy bots to shoot? keep simple: practice = empty arena
  startGame();
}

// ===========================================================================
// AI vs AI — two bots duel, you spectate unarmed
// ===========================================================================
function startAiVsAi(key1, key2) {
  net = null; botMode = true; spectator = true;
  clearBots();
  setRoomTag('AI vs AI');
  document.getElementById('overlay').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  document.getElementById('slots').style.display = 'none';   // no weapons
  document.getElementById('ammo').style.display = 'none';
  myName = 'Spectator';
  initAudio();
  running = true; paused = false;
  // hide all viewmodels
  WEAPONS.forEach(w => { if (w.group) w.group.visible = false; });
  // place spectator
  player.alive = true; player.health = 100;
  controls.getObject().position.set(0, CFG.eyeHeight + 0.1, 24);
  player.vel.set(0, 0, 0);
  // spawn two fighters
  spawnBot('Botzilla', 0xff5544, -20, key1);
  spawnBot('NeuralNinja', 0x44aaff, 20, key2);
  renderLeaderboard();
  if (!IS_TOUCH) controls.lock();
}

function spawnBot(name, color, x, apiKey) {
  const mesh = makeAvatar(name, name);
  mesh.position.set(x, 0, (Math.random() * 2 - 1) * 20);
  bots.push({
    mesh, name, color, hp: 100, dead: false, kills: 0,
    vel: new THREE.Vector3(), lastShot: 0, fireMs: 260, dmg: 16,
    strafe: Math.random() < 0.5 ? 1 : -1, nextStrafe: 0, nextTalk: 1500,
    llm: { key: (apiKey || '').trim() },
  });
}

function clearBots() {
  for (const b of bots) scene.remove(b.mesh);
  bots.length = 0;
}

function updateBots(dt) {
  const now = performance.now();
  const alive = bots.filter(b => !b.dead);
  for (const b of bots) {
    if (b.dead) continue;
    const target = alive.find(o => o !== b);
    const m = b.mesh;
    if (!target) { if (m.userData.walk) m.userData.walk.paused = true; if (m.userData.mixer) m.userData.mixer.update(dt); continue; }
    const tp = target.mesh.position;
    const dx = tp.x - m.position.x, dz = tp.z - m.position.z;
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist, nz = dz / dist;

    // movement: approach to ~16, strafe, keep spacing
    if (now > b.nextStrafe) { b.strafe *= -1; b.nextStrafe = now + 800 + Math.random() * 1400; }
    const speed = 9;
    let mvx = 0, mvz = 0;
    if (dist > 18) { mvx += nx; mvz += nz; }
    else if (dist < 9) { mvx -= nx; mvz -= nz; }
    mvx += -nz * b.strafe * 0.7; mvz += nx * b.strafe * 0.7;   // strafe perpendicular
    const ml = Math.hypot(mvx, mvz) || 1;
    m.position.x += (mvx / ml) * speed * dt;
    m.position.z += (mvz / ml) * speed * dt;
    const A = CFG.arenaHalf - 4;
    m.position.x = THREE.MathUtils.clamp(m.position.x, -A, A);
    m.position.z = THREE.MathUtils.clamp(m.position.z, -A, A);
    m.position.y = surfaceYAt(m.position.x, m.position.z, m.position.y + 0.5);
    m.rotation.y = Math.atan2(dx, dz);
    if (m.userData.walk) m.userData.walk.paused = false;
    if (m.userData.mixer) m.userData.mixer.update(dt);
    // hitbox
    b.boxMin = m.position;

    // shoot
    if (dist < 70 && now - b.lastShot > b.fireMs) {
      b.lastShot = now;
      const from = new THREE.Vector3(m.position.x, m.position.y + 1.5, m.position.z);
      const to = new THREE.Vector3(tp.x, tp.y + 1.3, tp.z);
      botTracer(from, to);
      playSfx('ak', Math.max(0.1, 0.4 - dist / 200));
      if (Math.random() < 0.55) botHit(target, b);   // accuracy
    }

    // periodic LLM "thought"/taunt
    if (b.llm.key && now > b.nextTalk) {
      b.nextTalk = now + 7000 + Math.random() * 6000;
      botThink(b, target, dist);
    } else if (!b.llm.key && now > b.nextTalk) {
      b.nextTalk = now + 1e9;   // no key → never talk
    }
  }
}

function botTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 1 }));
  line.frustumCulled = false; scene.add(line);
  tracers.push({ mesh: line, life: 0.06 });
}

function botHit(target, attacker) {
  target.hp -= attacker.dmg;
  if (target.hp <= 0) {
    target.hp = 0; target.dead = true; target.mesh.visible = false;
    attacker.kills++;
    deathExplosion(target.mesh.position.clone());
    addKillFeed(`${attacker.name} ☠ ${target.name}`);
    renderLeaderboard();
    setTimeout(() => {
      if (!botMode) return;
      const A = CFG.arenaHalf - 10;
      target.mesh.position.set((Math.random() * 2 - 1) * A, 0, (Math.random() * 2 - 1) * A);
      target.hp = 100; target.dead = false; target.mesh.visible = true;
      renderLeaderboard();
    }, 5000);
  }
}

// ---- LLM: each fighter "thinks" out loud (taunt). Robust: failures ignored ----
async function botThink(bot, target, dist) {
  const prompt = `You are ${bot.name}, a cocky low-poly arena bot dueling ${target.name} `
    + `(distance ${Math.round(dist)}, your HP ${bot.hp}). Reply with ONE short trash-talk line, max 8 words, no quotes.`;
  try {
    const txt = await callLLM(bot.llm.key, prompt);
    if (txt) addKillFeed(`${bot.name}: ${txt.replace(/^["']|["']$/g, '').slice(0, 60)}`);
  } catch (e) { /* CORS / bad key → silent, bot keeps fighting */ }
}

async function callLLM(key, prompt) {
  if (!key) return null;
  if (key.startsWith('sk-ant')) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 32, messages: [{ role: 'user', content: prompt }] }),
    });
    const j = await r.json();
    return j && j.content && j.content[0] && j.content[0].text;
  }
  // default: OpenAI-compatible
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 32, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  return j && j.choices && j.choices[0] && j.choices[0].message.content;
}

// ===========================================================================
// MENU WIRING
// ===========================================================================
function wireMenu() {
  const $ = id => document.getElementById(id);
  const show = id => {
    ['menu-main','menu-friends','menu-host','menu-ai'].forEach(m => $(m).style.display = m === id ? 'block' : 'none');
  };
  const hasPeer = typeof Peer !== 'undefined';

  $('btn-solo').onclick = () => startSolo();

  // AI vs AI
  $('btn-ai').onclick = () => show('menu-ai');
  $('btn-back-ai').onclick = () => show('menu-main');
  $('btn-ai-start').onclick = () => {
    $('ai-status').textContent = 'Starting duel…';
    startAiVsAi($('ai-key1').value, $('ai-key2').value);
  };

  $('btn-play').onclick = () => {
    if (!hasPeer) { $('main-status').textContent = 'PeerJS not loaded — starting practice.'; return startSolo(); }
    $('btn-play').disabled = true;
    quickMatch($('main-status'), () => { $('btn-play').disabled = false; startGame(); });
  };

  $('btn-friends').onclick = () => { if (!hasPeer) { $('main-status').textContent='PeerJS not loaded.'; return; } show('menu-friends'); };
  $('btn-back1').onclick = () => show('menu-main');
  $('btn-back2').onclick = () => { if (net && net.peer) net.peer.destroy(); net = null; show('menu-main'); };

  $('btn-create').onclick = () => {
    $('friends-status').textContent = 'Creating room…';
    hostRoom(PRIV,
      code => { $('host-code').textContent = code; $('host-status').textContent = 'Waiting for players… (you can start now)'; setRoomTag('HOST ' + code); setRoomUrl(code); show('menu-host'); },
      err => { $('friends-status').textContent = 'Failed: ' + (err.type||err); }
    );
  };
  $('btn-host-start').onclick = () => startGame();

  const doJoin = (code) => {
    code = code.trim().toUpperCase();
    if (code.length < 4) { $('friends-status').textContent = 'Enter a valid room ID.'; return; }
    $('friends-status').textContent = 'Joining ' + code + '…';
    show('menu-friends');
    joinRoom(code,
      () => { setRoomTag('ROOM ' + code); setRoomUrl(code); startGame(); },
      err => { $('friends-status').textContent = (err==='no-response'?'Room not found / empty.':'Join failed: '+err); }
    );
  };
  $('btn-join').onclick = () => doJoin($('join-code').value);

  // pause menu buttons
  $('btn-resume').onclick = () => { closePause(); controls.lock(); };
  $('btn-leave').onclick = () => leaveGame();


  // auto-join if URL carries ?room=CODE (link shared by a friend)
  const urlRoom = new URL(location.href).searchParams.get('room');
  if (urlRoom && hasPeer) {
    $('join-code').value = urlRoom.toUpperCase();
    $('main-status').textContent = `Joining room ${urlRoom.toUpperCase()} from link…`;
    doJoin(urlRoom);
  }

  // leave cleanly
  addEventListener('beforeunload', () => { if (net) net.send({ t: 'bye' }); });
}

// ===========================================================================
// Kick everything off — last line so all module bindings are initialized.
// ===========================================================================
init();
