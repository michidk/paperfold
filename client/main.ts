import * as THREE from 'three'
import { DT, PredictedFlight, type ServerState } from '../shared/flight'
import type {
  Design,
  Flap,
  Fold,
  PlaneModel,
  Quat,
  Side,
  State,
  Vec2,
  Vec3,
} from '../shared/plane'
import {
  angleOn,
  buildPlane,
  D2R,
  DEFAULT_DESIGN,
  foldProblem,
  G,
  launchQuat,
  launchState,
  lineX,
  onSide,
  planeStats,
  RULES,
  restPose,
  SHEET,
  STEER_PITCH,
  STEER_ROLL,
  sanitizeDesign,
  trimFlap,
} from '../shared/plane'
import { selfIntersects } from '../shared/selfhit'
import { moversAt } from '../shared/traffic'
import { type PathPoint, TRIAL, type Trial, telemetry } from '../shared/trial'
import type { Solid, WindZone } from '../shared/world'
import {
  BLOCK,
  BREEZE,
  CELL,
  CITY,
  GRID,
  gustAt,
  spawnPoint,
  surfaceAt,
  TOWER,
  WIND_CYCLE,
  WIND_ZONES,
  windAt,
  worldTime,
  zoneWind,
} from '../shared/world'

// Elements the page always has; a missing one is a bug in index.html, so fail loudly.
const $ = <T extends Element = HTMLElement>(id: string) => {
  const el = document.querySelector<T>(`#${id}`)
  if (!el) throw new Error(`#${id} is missing from the page`)
  return el
}
const ctx2d = (c: HTMLCanvasElement) => {
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('2D canvas is unavailable')
  return ctx
}
// The game server: PAPERFOLD_SERVER at build time when the client is hosted elsewhere (GitHub Pages), else this site.
const serverUrl = (path: string) =>
  new URL(path, import.meta.env.PAPERFOLD_SERVER || location.origin)
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      /* private mode */
    }
  },
}

let invertPitch = store.get('paperfold.invertPitch') === 'true'
const pitchOptions = [
  ...document.querySelectorAll<HTMLInputElement>('[data-invert-pitch]'),
]
function syncPitchOptions() {
  for (const input of pitchOptions) input.checked = invertPitch
  $('steerHint').textContent = invertPitch
    ? 'W/↑ pull up · S/↓ dive · A/D or ←/→ bank'
    : 'S/↓ pull up · W/↑ dive · A/D or ←/→ bank'
}
for (const input of pitchOptions)
  input.addEventListener('change', () => {
    invertPitch = input.checked
    store.set('paperfold.invertPitch', String(invertPitch))
    syncPitchOptions()
  })
syncPitchOptions()

// ---------- renderer & toon look ----------
const renderer = new THREE.WebGLRenderer({
  canvas: $<HTMLCanvasElement>('gl'),
  antialias: true,
  logarithmicDepthBuffer: true, // 3 cm near plane + km-scale city
  stencil: true, // plane shadows draw each pixel once
})
const COARSE = matchMedia('(pointer: coarse)').matches // a touch screen: phones and tablets
renderer.setPixelRatio(Math.min(devicePixelRatio, COARSE ? 1.5 : 2)) // phones: fewer pixels, steadier frame rate
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x9fd8ff)
scene.fog = new THREE.Fog(0xd4efff, 140, 560) // same as the sky at the horizon, so far things melt into it
const camera = new THREE.PerspectiveCamera(65, 1, 0.03, 1500)
// The city canvas is full-screen in game, and moves into the workshop's live panel as a follow cam.
function resize() {
  const c = $('gl'),
    w = c.clientWidth || innerWidth,
    h = c.clientHeight || innerHeight
  renderer.setSize(w, h, false)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
addEventListener('resize', resize)
resize()

const gradientMap = new THREE.DataTexture(
  new Uint8Array([95, 175, 255]),
  3,
  1,
  THREE.RedFormat,
)
gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter
gradientMap.needsUpdate = true
const toon = (
  color: number,
  extra: THREE.MeshToonMaterialParameters & { flatShading?: boolean } = {},
) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra })
const lineMat = new THREE.LineBasicMaterial({ color: 0x2b2b3a })
scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.5))
const sun = new THREE.DirectionalLight(0xffffff, 2.2)
sun.position.set(120, 200, 80)
scene.add(sun)

// ---------- city ----------
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(3000, 3000),
  toon(0x707784),
)
ground.rotation.x = -Math.PI / 2
scene.add(ground)

const m4 = new THREE.Matrix4(),
  q0 = new THREE.Quaternion(),
  v1 = new THREE.Vector3(),
  v2 = new THREE.Vector3()
function instanced<T>(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  items: T[],
  fn: (it: T) => number[],
) {
  const mesh = new THREE.InstancedMesh(geo, mat, items.length)
  items.forEach((it, i) => {
    const [x, y, z, sx, sy, sz, color] = fn(it)
    mesh.setMatrixAt(i, m4.compose(v1.set(x, y, z), q0, v2.set(sx, sy, sz)))
    mesh.setColorAt(i, new THREE.Color(color))
  })
  scene.add(mesh)
  return mesh
}
const unitBox = new THREE.BoxGeometry(1, 1, 1)

// See-through: buildings and trees between the camera and the plane it is watching fade out with a
// screen-door dither, as in afterhours. Pixels drop out in a 4x4 Bayer pattern instead of blending, so
// depth stays right and nothing needs sorting. solidVis holds 1 (solid) down to FADED per CITY.solids entry.
const NB = CITY.buildings.length,
  FADED = 0.2,
  DITHER_R = 0.6
const solidVis = new Float32Array(CITY.solids.length).fill(1)
const ditherSync: (() => void)[] = [] // copy solidVis into each mesh's own visibility attribute
function ditherable<M extends THREE.Material>(mat: M) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader =
      'attribute float aVis;\nvarying float vVis;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vVis = aVis;',
      )
    sh.fragmentShader =
      `varying float vVis;
float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
` +
      sh.fragmentShader.replace(
        'void main() {',
        'void main() {\n  if (vVis < bayer4(gl_FragCoord.xy)) discard;',
      )
  }
  mat.customProgramCacheKey = () => 'dither'
  return mat
}
// A per-instance (or per-vertex) visibility attribute that follows solidVis through owner[i].
function visAttribute(
  geo: THREE.BufferGeometry,
  owner: ArrayLike<number>,
  perInstance: boolean,
) {
  const attr = new (
    perInstance ? THREE.InstancedBufferAttribute : THREE.BufferAttribute
  )(new Float32Array(owner.length).fill(1), 1)
  attr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('aVis', attr)
  ditherSync.push(() => {
    for (let i = 0; i < owner.length; i++) attr.array[i] = solidVis[owner[i]]
    attr.needsUpdate = true
  })
}
const range = (n: number, from = 0) =>
  Int32Array.from({ length: n }, (_, i) => from + i)
// Pavements and parks are flush with the street: physics treats them as ground, so a raised slab would hide planes that land there.
const SLAB = 0.01,
  SLAB_W = BLOCK + 4 // pavement and park slabs, a little above the street
instanced(unitBox, toon(0xffffff), CITY.blocks, (b) => [
  b.x,
  SLAB / 2,
  b.z,
  SLAB_W,
  SLAB,
  SLAB_W,
  b.park ? 0x8fd27a : 0xdcd6c8,
])
// What a landed plane rests on as drawn here: roofs and trees from the shared city, plus the slabs.
const groundAt = (x: number, z: number) =>
  Math.max(
    surfaceAt(x, z),
    CITY.blocks.some(
      (b) => Math.abs(x - b.x) < SLAB_W / 2 && Math.abs(z - b.z) < SLAB_W / 2,
    )
      ? SLAB
      : 0,
  )
visAttribute(
  instanced(
    unitBox.clone(),
    ditherable(toon(0xffffff)),
    CITY.buildings,
    (b) => [
      (b.x0 + b.x1) / 2,
      b.y1 / 2,
      (b.z0 + b.z1) / 2,
      b.x1 - b.x0,
      b.y1,
      b.z1 - b.z0,
      b.color ?? 0xffffff, // every building has one
    ],
  ).geometry,
  range(NB),
  true,
)
{
  // ink outlines on every building edge, one draw call
  const pts: number[] = []
  for (const b of CITY.buildings) {
    const xs = [b.x0, b.x1],
      ys = [0, b.y1],
      zs = [b.z0, b.z1]
    const c = (a: number) => [xs[a & 1], ys[(a >> 1) & 1], zs[(a >> 2) & 1]]
    for (let a = 0; a < 8; a++)
      for (let bit = 0; bit < 3; bit++)
        if (!(a & (1 << bit))) pts.push(...c(a), ...c(a | (1 << bit)))
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  visAttribute(
    g,
    Int32Array.from({ length: pts.length / 3 }, (_, v) => Math.floor(v / 24)),
    false,
  ) // 12 edges a building
  scene.add(
    new THREE.LineSegments(
      g,
      ditherable(new THREE.LineBasicMaterial({ color: 0x2b2b3a })),
    ),
  )
}
const crown = new THREE.ConeGeometry(1.8, 1, 7).translate(0, 0.5, 0)
const trunk = new THREE.CylinderGeometry(0.25, 0.3, 1, 6).translate(0, 0.5, 0)
visAttribute(
  instanced(crown, ditherable(toon(0xffffff)), CITY.trees, (t) => [
    t.x,
    t.h * 0.3,
    t.z,
    1,
    t.h * 0.7,
    1,
    0x4caf6a,
  ]).geometry,
  range(CITY.trees.length, NB),
  true,
)
visAttribute(
  instanced(trunk, ditherable(toon(0xffffff)), CITY.trees, (t) => [
    t.x,
    0,
    t.z,
    1,
    t.h * 0.3,
    1,
    0x8d6748,
  ]).geometry,
  range(CITY.trees.length, NB),
  true,
)
// ---------- scenery: only for looks, never part of the physics ----------
const decorRng = (start: number) => {
  let seed = start
  return () => {
    // small seeded random, so every player sees the same city
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
{
  // sky: a soft gradient dome that follows the camera
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(1200, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x5fb4ef) },
        horizon: { value: new THREE.Color(0xd4efff) },
      },
      vertexShader:
        'varying float h; void main() { h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform vec3 top; uniform vec3 horizon; varying float h; void main() { gl_FragColor = vec4(mix(horizon, top, smoothstep(0.0, 0.5, h)), 1.0); }',
    }),
  )
  sky.renderOrder = -1
  sky.onBeforeRender = (_r, _sc, cam) => sky.position.copy(cam.position)
  scene.add(sky)
  scene.background = null
}
{
  // windows on every wall, one draw call; a few are lit
  const rnd = decorRng(99),
    items: {
      x: number
      y: number
      z: number
      rotY: number
      lit: boolean
      bi: number
    }[] = [],
    H = 1.5,
    W = 1.2,
    FLOOR = 3.2
  CITY.buildings.forEach((b, bi) => {
    const faces: ['x' | 'z', number, Vec2, number][] = [
      // [fixed axis value, along-axis range, normal]
      ['x', b.x0 - 0.03, [b.z0, b.z1], -1],
      ['x', b.x1 + 0.03, [b.z0, b.z1], 1],
      ['z', b.z0 - 0.03, [b.x0, b.x1], -1],
      ['z', b.z1 + 0.03, [b.x0, b.x1], 1],
    ]
    for (const [axis, at, [lo, hi], n] of faces) {
      const cols = Math.max(1, Math.floor((hi - lo - 1.5) / 2.6)),
        step = (hi - lo) / cols
      for (let y = 2.4; y + H / 2 < b.y1 - 1; y += FLOOR)
        for (let c = 0; c < cols; c++) {
          const u = lo + step * (c + 0.5)
          items.push({
            x: axis === 'x' ? at : u,
            y,
            z: axis === 'z' ? at : u,
            rotY: axis === 'x' ? (n * Math.PI) / 2 : n > 0 ? 0 : Math.PI,
            lit: rnd() < 0.12,
            bi,
          })
        }
    }
  })
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(W, H),
    ditherable(toon(0xffffff)),
    items.length,
  )
  visAttribute(
    mesh.geometry,
    Int32Array.from(items, (w) => w.bi),
    true,
  ) // windows fade with their building
  const rot = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0),
    one = new THREE.Vector3(1, 1, 1)
  items.forEach((w, i) => {
    mesh.setMatrixAt(
      i,
      m4.compose(v1.set(w.x, w.y, w.z), rot.setFromAxisAngle(up, w.rotY), one),
    )
    mesh.setColorAt(i, new THREE.Color(w.lit ? 0xffe9a8 : 0x4e6e96))
  })
  scene.add(mesh)
}
{
  // dashed lane markings down the middle of every street
  const dashes: [number, number, boolean?][] = [],
    half = (GRID + 0.5) * CELL
  for (let i = -GRID - 1; i <= GRID; i++) {
    const line = (i + 0.5) * CELL
    for (let a = -half; a < half; a += 4) {
      const off = ((a % CELL) + CELL) % CELL
      if (Math.abs(off - CELL / 2) < 6) continue // gap at the crossings
      dashes.push([line, a + 1], [a + 1, line, true])
    }
  }
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0xf4f1e6,
      polygonOffset: true,
      polygonOffsetFactor: -1,
    }),
    dashes.length,
  )
  dashes.forEach(([x, z, across], i) => {
    mesh.setMatrixAt(
      i,
      m4.compose(
        v1.set(x, 0.001, z),
        q0,
        v2.set(across ? 2 : 0.18, 1, across ? 0.18 : 2),
      ),
    )
  })
  scene.add(mesh)
}
// Clouds: puffy clusters drifting with the breeze high above the city.
const clouds: THREE.InstancedMesh[] = []
{
  const rnd = decorRng(7),
    puff = new THREE.IcosahedronGeometry(1, 1),
    mat = toon(0xffffff, { flatShading: true })
  for (let c = 0; c < 24; c++) {
    const n = 5 + Math.floor(rnd() * 5),
      mesh = new THREE.InstancedMesh(puff, mat, n)
    for (let i = 0; i < n; i++) {
      const r = 7 + rnd() * 9
      mesh.setMatrixAt(
        i,
        m4.compose(
          v1.set(
            (i - n / 2) * 7 + rnd() * 4,
            rnd() * 4 + (r - 7) * 0.4,
            rnd() * 10 - 5,
          ),
          q0,
          v2.set(r, r * 0.75, r),
        ),
      )
    }
    mesh.position.set(rnd() * 1300 - 650, 110 + rnd() * 70, rnd() * 1300 - 650)
    mesh.rotation.y = rnd() * Math.PI
    scene.add(mesh)
    clouds.push(mesh)
  }
}
function updateClouds(dt: number) {
  for (const c of clouds) {
    c.position.x += BREEZE[0] * 2.5 * dt
    c.position.z += BREEZE[2] * 2.5 * dt
    if (c.position.x > 650) c.position.x -= 1300 // wrap around the edge of the world
    if (c.position.z > 650) c.position.z -= 1300
  }
}
{
  const pad = new THREE.Mesh(
    new THREE.RingGeometry(2, 2.6, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  pad.rotation.x = -Math.PI / 2
  pad.position.y = TOWER.h + 0.02
  scene.add(pad)
}

// Windy crossroads: streaks of air blowing through, and a windsock showing which way it blows right now.
let windClock = worldTime() - performance.now() / 1000 // corrected to the server's clock on connect
const windNow = () =>
  (((performance.now() / 1000 + windClock) % WIND_CYCLE) + WIND_CYCLE) %
  WIND_CYCLE
// Cars and people: where shared/traffic puts them at the current world time, which the physics also
// uses, so a plane really does bounce off the car you see. Instanced: one draw call per part.
const traffic = (() => {
  const all = moversAt(0),
    people = all.filter((m) => m.kind === 'person').length,
    cars = all.length - people
  const part = (geo: THREE.BufferGeometry, color: number, n: number) => {
    const mesh = new THREE.InstancedMesh(geo, toon(color), n)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.frustumCulled = false
    scene.add(mesh)
    return mesh
  }
  const box = (w: number, h: number, d: number, x: number, y: number) =>
    new THREE.BoxGeometry(w, h, d).translate(x, y, 0)
  const meshes = {
    body: part(box(4, 0.7, 1.8, 0, 0.6), 0xffffff, cars),
    cabin: part(box(2.1, 0.55, 1.6, -0.3, 1.22), 0x2b3a55, cars),
    wheels: part(box(3, 0.4, 1.9, 0, 0.25), 0x22222a, cars),
    torso: part(
      new THREE.CylinderGeometry(0.2, 0.24, 1.25, 8).translate(0, 0.62, 0),
      0xffffff,
      people,
    ),
    head: part(
      new THREE.SphereGeometry(0.19, 10, 8).translate(0, 1.5, 0),
      0xffffff,
      people,
    ),
  }
  const skin = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac],
    turn = new THREE.Quaternion(),
    up = new THREE.Vector3(0, 1, 0),
    at = new THREE.Vector3(),
    one = new THREE.Vector3(1, 1, 1),
    m = new THREE.Matrix4()
  // Colours never change: set them once, in the same order moversAt lists everyone.
  let car = 0,
    person = 0
  for (const mover of all)
    if (mover.kind === 'car')
      meshes.body.setColorAt(car++, new THREE.Color(mover.color))
    else {
      meshes.torso.setColorAt(person, new THREE.Color(mover.color))
      meshes.head.setColorAt(
        person,
        new THREE.Color(skin[person % skin.length]),
      )
      person++
    }
  return (t: number) => {
    car = person = 0
    for (const mover of moversAt(t)) {
      turn.setFromAxisAngle(up, -mover.heading) // heading 0 faces +x, π/2 faces +z
      at.set((mover.x0 + mover.x1) / 2, 0, (mover.z0 + mover.z1) / 2)
      m.compose(at, turn, one)
      if (mover.kind === 'car') {
        for (const p of [meshes.body, meshes.cabin, meshes.wheels])
          p.setMatrixAt(car, m)
        car++
      } else {
        meshes.torso.setMatrixAt(person, m)
        meshes.head.setMatrixAt(person, m)
        person++
      }
    }
    for (const mesh of Object.values(meshes))
      mesh.instanceMatrix.needsUpdate = true
  }
})()

const STREAKS = 70,
  STREAK_W = 0.35
const winds = WIND_ZONES.map((zone) => {
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 7, 8),
    toon(0xdddddd),
  )
  pole.position.set(zone.x, 3.5, zone.z)
  const sock = new THREE.Group()
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 2.4, 12, 4, true),
    toon(0xff7b4a, { side: THREE.DoubleSide }),
  )
  cone.rotation.z = -Math.PI / 2 // tip along +x (downwind), wide end at the pole
  cone.position.x = 1.2
  sock.add(cone)
  sock.position.set(zone.x, 6.8, zone.z)
  scene.add(pole, sock)
  const pos = new Float32Array(STREAKS * 12),
    col = new Float32Array(STREAKS * 16),
    index: number[] = []
  for (let i = 0; i < STREAKS; i++)
    index.push(4 * i, 4 * i + 1, 4 * i + 2, 4 * i + 1, 4 * i + 3, 4 * i + 2)
  const geo = new THREE.BufferGeometry()
  geo.setAttribute(
    'position',
    new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage),
  )
  geo.setAttribute(
    'color',
    new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage),
  )
  geo.setIndex(index)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  mesh.frustumCulled = false
  scene.add(mesh)
  const streaks = Array.from({ length: STREAKS }, () => ({
    p: new THREE.Vector3(),
    age: 0,
    life: 0,
  }))
  streaks.forEach((s) => {
    spawnStreak(zone, s)
    s.age = Math.random() * s.life
  })
  return { zone, sock, geo, pos, col, streaks }
})
interface Streak {
  p: THREE.Vector3
  age: number
  life: number
}
function spawnStreak(zone: WindZone, s: Streak) {
  const a = Math.random() * Math.PI * 2,
    r = Math.sqrt(Math.random()) * zone.r * 0.95
  s.p.set(
    zone.x + Math.cos(a) * r,
    1 + Math.random() * 40,
    zone.z + Math.sin(a) * r,
  )
  s.age = 0
  s.life = 1.2 + Math.random() * 1.6
}
const wv = new THREE.Vector3(),
  side = new THREE.Vector3(),
  toCam = new THREE.Vector3()
function updateWind(dt: number) {
  const t = windNow()
  for (const w of winds) {
    const { dir, speed } = zoneWind(w.zone, t)
    w.sock.rotation.y = -dir // the sock streams downwind
    w.sock.rotation.z = -0.9 * (1 - Math.min(1, speed / 5)) // and droops when the wind drops
    w.streaks.forEach((s, i) => {
      s.age += dt
      const g = gustAt([s.p.x, s.p.y, s.p.z], t)
      wv.set(g[0], 0, g[2])
      const v = wv.length()
      if (s.age > s.life || v < 0.3) spawnStreak(w.zone, s)
      s.p.addScaledVector(wv, dt * 1.6) // drawn a little faster than the air, so the motion reads
      const len = 0.9 * v,
        alpha = 0.75 * Math.sin((Math.PI * s.age) / s.life) * Math.min(1, v / 2)
      wv.normalize()
      side
        .crossVectors(wv, toCam.subVectors(camera.position, s.p))
        .normalize()
        .multiplyScalar(STREAK_W / 2)
      const tail = [s.p.x - wv.x * len, s.p.y, s.p.z - wv.z * len]
      const quad = [
        [s.p.x + side.x, s.p.y + side.y, s.p.z + side.z],
        [s.p.x - side.x, s.p.y - side.y, s.p.z - side.z],
        [
          tail[0] + side.x * 0.3,
          tail[1] + side.y * 0.3,
          tail[2] + side.z * 0.3,
        ],
        [
          tail[0] - side.x * 0.3,
          tail[1] - side.y * 0.3,
          tail[2] - side.z * 0.3,
        ],
      ]
      quad.forEach((q, k) => {
        w.pos.set(q, (4 * i + k) * 3)
        w.col.set([1, 1, 1, k < 2 ? alpha : 0], (4 * i + k) * 4) // bright head, fading tail
      })
    })
    w.geo.attributes.position.needsUpdate = true
    w.geo.attributes.color.needsUpdate = true
  }
}

// Thermals: rising sparkles over the parks.
const thermals = CITY.thermals.map((t) => {
  const n = 120,
    pos = new Float32Array(n * 3),
    lift = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2,
      r = Math.sqrt(Math.random()) * t.r
    pos.set(
      [t.x + Math.cos(a) * r, Math.random() * 80, t.z + Math.sin(a) * r],
      i * 3,
    )
    lift[i] = t.u * (1 - (r * r) / (t.r * t.r)) + 0.5
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  scene.add(
    new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xfff1b8,
        size: 0.6,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    ),
  )
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(t.r, t.r, 80, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd27a,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  col.position.set(t.x, 40, t.z)
  scene.add(col)
  return { geo, pos, lift }
})

// ---------- paper planes ----------
// What the eye sees, not what flies: a fold flat at 180° is drawn open by a degree (paper has thickness),
// so its layers don't flicker through each other. steer = [pitch, roll] input, bending the flaps.
const openAngle = (a: number) => Math.max(-179, Math.min(179, a))
function drawnPlane(design: Design, [p, r]: readonly number[] = [0, 0]) {
  const d = sanitizeDesign(design)
  const folds = d.folds.map((f) => ({
    ...f,
    angle: openAngle(f.angle),
    ...(f.angleL !== undefined && { angleL: openAngle(f.angleL) }),
  }))
  return buildPlane(
    { ...d, folds },
    p * STEER_PITCH - r * STEER_ROLL,
    p * STEER_PITCH + r * STEER_ROLL,
  )
}
// Paint images hold both faces of the sheet side by side: the front (the side shown in the workshop) on
// the left half, the back on the right half, both in sheet coordinates. Every triangle is drawn twice,
// once per face, each facing its own way and reading its own half.
function planeGeometry(model: PlaneModel) {
  const { pos, uv } = model,
    P: number[] = [],
    U: number[] = []
  for (let v = 0; v < pos.length / 3; v += 3) {
    const at = (k: number) => [uv[(v + k) * 2], uv[(v + k) * 2 + 1]],
      [a, b, c] = [at(0), at(1), at(2)]
    // The front faces the viewer who sees the sheet unmirrored, i.e. where its uv runs counter-clockwise.
    const front =
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) > 0
        ? [0, 1, 2]
        : [0, 2, 1]
    for (const [half, order] of [
      [0, front],
      [0.5, [...front].reverse()],
    ] as [number, number[]][])
      for (const k of order) {
        P.push(pos[(v + k) * 3], pos[(v + k) * 3 + 1], pos[(v + k) * 3 + 2])
        U.push(half + at(k)[0] / 2, at(k)[1])
      }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3))
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2))
  g.computeVertexNormals()
  return g
}
function planeEdges(model: PlaneModel) {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(model.pos, 3))
  const edges = new THREE.EdgesGeometry(g, 15) // from one face only, or every crease between the faces would show
  g.dispose()
  return edges
}
type PlaneMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshToonMaterial>
function setPlaneGeometry(mesh: PlaneMesh, model: PlaneModel) {
  const edges = mesh.children[0] as THREE.LineSegments
  mesh.geometry.dispose()
  mesh.geometry = planeGeometry(model)
  edges.geometry.dispose()
  edges.geometry = planeEdges(model)
}
function planeMesh(model: PlaneModel, tex?: THREE.Texture | null): PlaneMesh {
  const mesh = new THREE.Mesh(
    planeGeometry(model),
    toon(0xffffff, { map: tex ?? null }),
  )
  if (!tex) mesh.material.color.set(0xfffdf6)
  mesh.add(new THREE.LineSegments(planeEdges(model), lineMat))
  return mesh
}
// Shadows: each plane's own triangles flattened onto the ground below it along the sun's direction.
// Crisp and cheap for any number of planes, where a shadow map could never resolve 30 cm of paper
// across the whole city. The stencil draws each pixel once, so the paper's overlapping layers don't darken.
const shadowMat = new THREE.MeshBasicMaterial({
  color: 0x1b1b2a,
  transparent: true,
  opacity: 0.3,
  depthWrite: false,
  side: THREE.DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -2,
  stencilWrite: true,
  stencilRef: 1,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilZPass: THREE.ReplaceStencilOp,
})
const toSun = sun.position.clone().normalize()
const flatten = new THREE.Matrix4(),
  shadowAt = new THREE.Vector3()
function addShadow(mesh: PlaneMesh) {
  const shadow = new THREE.Mesh(mesh.geometry, shadowMat)
  shadow.matrixAutoUpdate = false
  shadow.renderOrder = 1
  mesh.add(shadow)
  return shadow
}
// Call after the plane moves. The shadow is the plane's child, so its matrix undoes the plane's own.
function placeShadow(
  shadow: THREE.Mesh,
  mesh: PlaneMesh,
  ground: (x: number, z: number) => number = groundAt,
) {
  shadow.geometry = mesh.geometry // steering swaps the plane's geometry
  mesh.updateWorldMatrix(true, false)
  const p = mesh.getWorldPosition(shadowAt),
    kx = toSun.x / toSun.y,
    kz = toSun.z / toSun.y
  const h = p.y - ground(p.x, p.z),
    y = ground(p.x - kx * h, p.z - kz * h) + 0.003 // the ground where the shadow falls
  // (x, y, z) -> (x - kx (y - ground), ground, z - kz (y - ground))
  flatten.set(1, -kx, 0, kx * y, 0, 0, 0, y, 0, -kz, 1, kz * y, 0, 0, 0, 1)
  shadow.matrix
    .copy(mesh.matrixWorld)
    .invert()
    .multiply(flatten)
    .multiply(mesh.matrixWorld)
  shadow.matrixWorldNeedsUpdate = true
}
function disposePlane(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as Partial<THREE.Mesh<THREE.BufferGeometry, THREE.Material>>
    m.geometry?.dispose()
    if (o instanceof THREE.Sprite) o.material.map?.dispose() // name tags own their texture; plane paint is shared
    if (m.material !== lineMat && m.material !== shadowMat)
      m.material?.dispose?.()
  })
  obj.removeFromParent()
}
const texLoader = new THREE.TextureLoader()
const paintTextures = new Map<number, THREE.Texture>()
// Server planes have a paint flag and a PNG on the server; offline planes carry their paint as a data URL.
const paintUrl = (r: PlaneInfo) =>
  typeof r.paint === 'string'
    ? r.paint
    : r.paint
      ? serverUrl(`/paint/${r.id}.png`).href
      : ''
function paintTexture(info: PlaneInfo) {
  if (!info.paint) return null
  if (!paintTextures.has(info.id)) {
    const t = texLoader.load(paintUrl(info), () => {
      if (t.image.width > t.image.height) return
      // Older paint has one face only: repeat it so both faces show it, as they used to.
      Object.assign(t, { wrapS: THREE.RepeatWrapping, needsUpdate: true })
      t.repeat.x = 2
    })
    t.colorSpace = THREE.SRGBColorSpace
    t.anisotropy = renderer.capabilities.getMaxAnisotropy()
    paintTextures.set(info.id, t)
  }
  return paintTextures.get(info.id)
}

// ---------- workshop: folds & flaps, all on the sheet ----------
// Sheet metres (x from centre fold, y with nose = +L/2) <-> SVG millimetres (origin top-left).
const { L } = SHEET,
  HW = SHEET.W / 2
const toSvg = (x: number, y: number): Vec2 => [
  105 + x * 1000,
  L * 500 - y * 1000,
]
const toSheet = (X: number, Y: number): Vec2 => [
  (X - 105) / 1000,
  (L * 500 - Y) / 1000,
]
const RETIRED = { clip: false, trimLeft: 0, trimRight: 0 } // options the workshop no longer offers
let design = sanitizeDesign({ ...DEFAULT_DESIGN, ...RETIRED })
// What the workshop edits. Folds and flaps share one loose shape: the code reads only the fields of its kind.
type Kind = 'fold' | 'flap'
type Item = Fold & Flap
// kind, index i, and s: the half (1 right, -1 left) it was picked on.
interface Selection {
  kind: Kind
  i: number
  s: Side
}
let selected: Selection | null = null
const svg = $<SVGSVGElement>('folds')
let drawKind: Kind = 'fold' // what a line drawn on the sheet makes: a lengthwise 'fold' or a tail cut ('flap')
const HINTS: Record<Kind, string> = {
  fold: 'Draw a line along the paper to fold it. Click a fold to set its angle, drag it to move it. The fold nearest the centre is the wing root: about 84° down gives wings with a slight V.',
  flap: 'Draw a short line across the shaded tail zone to cut a flap free. Click a cut to bend its flap, drag it to move it.',
}
const foldHint = () => HINTS[drawKind]
const list = (kind: string) =>
  (kind === 'flap' ? design.flaps : design.folds) as Item[]
const listPatch = (kind: string, items: Item[]): Partial<Design> =>
  kind === 'flap' ? { flaps: items } : { folds: items }
const current = (): Item | null =>
  (selected && list(selected.kind)[selected.i]) ?? null
const halfOf = (): Side => current()?.side ?? (selected?.s || 1) // where the selected item's handles and popover go
const halves = (o: { side?: Side }): Side[] => (o.side ? [o.side] : [1, -1])
const most = (items: { side?: Side }[]) =>
  Math.max(
    ...([1, -1] as const).map((h) => items.filter((o) => onSide(o, h)).length),
  ) // the fuller half

// Visible part [t0, t1] of a line through the fold's two points inside the half-planes g(p) >= 0.
type Line = Pick<Fold, 'x1' | 'y1' | 'x2' | 'y2'>
type HalfPlane = (p: Vec2) => number
function clipLine(f: Line, gs: HalfPlane[]): Vec2 | null {
  let lo = -1e9,
    hi = 1e9
  for (const g of gs) {
    const g0 = g([f.x1, f.y1]),
      dg = g([f.x2, f.y2]) - g0
    if (Math.abs(dg) < 1e-12) {
      if (g0 < 0) return null
      continue
    }
    if (dg > 0) lo = Math.max(lo, -g0 / dg)
    else hi = Math.min(hi, -g0 / dg)
  }
  return lo < hi ? [lo, hi] : null
}
const at = (f: Line, t: number): Vec2 => [
  f.x1 + (f.x2 - f.x1) * t,
  f.y1 + (f.y2 - f.y1) * t,
]
const halfSheet: HalfPlane[] = [
  (p) => p[0],
  (p) => HW - p[0],
  (p) => p[1] + L / 2,
  (p) => L / 2 - p[1],
]
const wingArea = (): HalfPlane[] => [
  (p) => p[0],
  (p) => HW - p[0],
  (p) => p[1] + L / 2,
  (p) => L / 2 - (design.nose * p[0]) / HW - p[1],
]
function foldSegment(f: Line) {
  const t = clipLine(f, wingArea()) ?? clipLine(f, halfSheet)
  return (
    t && { a: at(f, t[0]), b: at(f, t[1]), active: !!clipLine(f, wingArea()) }
  )
}

// A stroke on the paper becomes a lengthwise fold or a tail cut, whichever is picked above the sheet.
interface Draft {
  kind: Kind
  item: Item
  problem?: string | null
}
function classify(from: Vec2, to: Vec2): Draft | null {
  const flip: Side = from[0] + to[0] < 0 ? -1 : 1 // drawn on the left wing: use its right-wing mirror
  const a: Vec2 = [from[0] * flip, from[1]],
    b: Vec2 = [to[0] * flip, to[1]]
  const one = design.mirror ? {} : { side: flip } // mirror off: only the half it was drawn on
  let dx = b[0] - a[0]
  const dy = Math.abs(b[1] - a[1]) < 1e-4 ? 1e-3 : b[1] - a[1] // a sideways stroke still folds along the sheet
  if (drawKind === 'fold') {
    const maxDx = Math.abs(dy) * Math.tan(RULES.maxTilt * D2R)
    dx = Math.max(-maxDx, Math.min(maxDx, dx))
    const line = { x1: a[0], y1: a[1], x2: a[0] + dx, y2: a[1] + dy }
    const t = clipLine(line, halfSheet) // run it the full length of the sheet
    if (!t) return null
    const [p, q] = [at(line, t[0]), at(line, t[1])]
    return {
      kind: 'fold',
      item: {
        x1: p[0],
        y1: p[1],
        x2: q[0],
        y2: q[1],
        angle: 45,
        ...one,
      } as Item,
    }
  }
  return {
    kind: 'flap',
    item: {
      x0: Math.min(a[0], b[0]),
      x1: Math.max(a[0], b[0]),
      y: (a[1] + b[1]) / 2,
      angle: 15,
      ...one,
    } as Item,
  }
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined
function notice(msg: string) {
  const h = $('toolHint')
  h.textContent = msg
  h.classList.add('warn')
  clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    h.textContent = foldHint()
    h.classList.remove('warn')
  }, 2800)
}
function ruleMessage(next: Design): string {
  if (most(next.folds) > RULES.maxFolds)
    return `Up to ${RULES.maxFolds} lengthwise folds per wing.`
  if (most(next.flaps) > RULES.maxFlaps)
    return `Up to ${RULES.maxFlaps} tail cuts per wing.`
  const ok: Fold[] = [],
    shared = (a: { side?: Side }, b: { side?: Side }) =>
      !a.side || !b.side || a.side === b.side
  for (const f of next.folds) {
    const why = foldProblem(
      f,
      ok.filter((o) => shared(o, f)),
      next,
    )
    if (why)
      return {
        tilt: `Lengthwise folds can lean at most ${RULES.maxTilt}°.`,
        centre: "Folds can't reach the centre fold.",
        cross: "Folds can't cross: the paper would tear.",
      }[why]
    ok.push(f)
  }
  const clean = sanitizeDesign({ ...next, flaps: [] }),
    placed: { x0: number; x1: number; side?: Side }[] = []
  for (const f of next.flaps) {
    const t = trimFlap(
      Math.max(0, Math.min(f.x0, f.x1)),
      Math.min(HW, Math.max(f.x0, f.x1)),
      f.y,
      clean.folds.filter((o) => shared(o, f)),
    )
    if (!t) return 'A cut flap needs at least 8 mm of wing between folds.'
    if (placed.some((o) => shared(o, f) && o.x0 < t.x1 && t.x0 < o.x1))
      return "Cuts can't overlap."
    placed.push({ ...t, side: f.side })
  }
  return "That doesn't fold."
}
// Apply an edit only if the folding rules keep every fold and flap; otherwise explain and keep the old design.
function designProblem(next: Design) {
  const clean = sanitizeDesign(next)
  if (
    clean.folds.length < next.folds.length ||
    clean.flaps.length < next.flaps.length
  )
    return ruleMessage(next)
  return selfIntersects(buildPlane(clean).pos)
    ? "The paper can't pass through itself."
    : null
}
function tryDesign(patch: Partial<Design>) {
  const next = { ...design, ...patch },
    problem = designProblem(next)
  if (problem) {
    notice(problem)
    syncWorkshop()
    return false
  } // syncWorkshop puts the sliders back
  setDesign(next)
  return true
}
const setItem = (sel: Selection, patch: Partial<Item>) =>
  tryDesign(
    listPatch(
      sel.kind,
      list(sel.kind).map((f, j) => (j === sel.i ? { ...f, ...patch } : f)),
    ),
  )

let draft: Draft | null = null // being drawn
function renderFolds() {
  const n = design.nose * 1000,
    zone = RULES.flapZone * 1000
  const line = (a: Vec2, b: Vec2, cls: string, extra = '') => {
    const [x1, y1] = toSvg(...a),
      [x2, y2] = toSvg(...b)
    return `<line class="${cls}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra}/>`
  }
  let s = `<rect class="zone" x="0" y="${297 - zone}" width="210" height="${zone}"/>`
  s += `<polygon class="flap" points="105,0 210,0 210,${n}"/><polygon class="flap" points="105,0 0,0 0,${n}"/>`
  s += `<line class="midline" x1="105" y1="0" x2="105" y2="297"/>`
  s += `<line class="base" x1="105" y1="0" x2="210" y2="${n}"/><line class="base" x1="105" y1="0" x2="0" y2="${n}"/>`
  // Line weight shows how far it is folded: hairline when flat, bold at the limit.
  const weight = (a: number, max: number) =>
    `style="stroke-width:${(0.6 + 2.6 * Math.min(1, Math.abs(a) / max)).toFixed(2)}"`
  const drawFold = (f: Fold, cls: string, hit: string) => {
    const seg = foldSegment(f)
    if (seg)
      for (const h of halves(f)) {
        const a = angleOn(f, h),
          p: Vec2 = [seg.a[0] * h, seg.a[1]],
          q: Vec2 = [seg.b[0] * h, seg.b[1]]
        s +=
          line(
            p,
            q,
            `fold ${a >= 0 ? 'up' : 'down'}${seg.active ? '' : ' inactive'} ${cls}`,
            weight(a, 90),
          ) + (hit ? line(p, q, 'hit', `${hit} data-s="${h}"`) : '')
      }
  }
  const drawFlap = (f: Flap, cls: string, hit: string) => {
    for (const h of halves(f)) {
      const a = angleOn(f, h)
      s += line(
        [f.x0 * h, f.y],
        [f.x1 * h, f.y],
        `fold ${a >= 0 ? 'up' : 'down'} ${cls}`,
        weight(a, RULES.maxFlapAngle),
      )
      for (const x of [f.x0, f.x1])
        if (x < HW - 1e-6)
          s += line([x * h, f.y], [x * h, -L / 2], `cut ${cls}`) // scissor cuts free the flap
      if (hit) {
        const [X0, Y0] = toSvg(h > 0 ? f.x0 : -f.x1, f.y)
        s += `<rect class="hit" x="${X0}" y="${Y0 - 3}" width="${(f.x1 - f.x0) * 1000}" height="${297 - Y0 + 3}" ${hit} data-s="${h}"/>`
      }
    }
  }
  design.folds.forEach((f, i) => {
    drawFold(
      f,
      selected?.kind === 'fold' && selected.i === i ? 'sel' : '',
      `data-kind="fold" data-i="${i}"`,
    )
  })
  design.flaps.forEach((f, i) => {
    drawFlap(
      f,
      selected?.kind === 'flap' && selected.i === i ? 'sel' : '',
      `data-kind="flap" data-i="${i}"`,
    )
  })
  if (draft)
    (draft.kind === 'fold' ? drawFold : drawFlap)(
      draft.item,
      `draft ${draft.problem ? 'bad' : 'ok'}`,
      '',
    ) // green if it works, blinking red if not
  const handles: [string, number, number][] = [['nose', 210, n]]
  const f = current(),
    hs = halfOf()
  if (f && selected?.kind === 'fold')
    handles.push(
      ['end1', ...toSvg(f.x1 * hs, f.y1)],
      ['end2', ...toSvg(f.x2 * hs, f.y2)],
    )
  if (f && selected?.kind === 'flap')
    handles.push(
      ['end1', ...toSvg(f.x0 * hs, f.y)],
      ['end2', ...toSvg(f.x1 * hs, f.y)],
    )
  // Small dots, with a bigger invisible ring around each so they stay easy to grab.
  for (const [h, x, y] of handles)
    s += `<circle class="handle ${h.startsWith('end') ? 'end' : ''}" cx="${x}" cy="${y}" r="3"/><circle class="grab" data-h="${h}" cx="${x}" cy="${y}" r="6"/>`
  s += `<text x="203" y="${Math.max(9, n - 5)}" text-anchor="end">nose</text>`
  s += `<text x="109" y="${297 - zone + 7}">cut zone</text>`
  svg.innerHTML = s
  positionPopover()
}

function positionPopover() {
  const f = current(),
    sel = selected,
    pop = $('foldPop')
  const mid: Vec2 | null =
    !f || !sel
      ? null
      : sel.kind === 'flap'
        ? [(f.x0 + f.x1) / 2, f.y]
        : (() => {
            const seg = foldSegment(f)
            return seg && [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2]
          })()
  pop.hidden = !mid
  if (!mid || !f || !sel) return
  const [X, Y] = toSvg(mid[0] * halfOf(), mid[1]),
    max = sel.kind === 'flap' ? RULES.maxFlapAngle : 180
  const split = f.angleL !== undefined
  // The fold nearest the centre on its half is the wing root: the keel is the strip inside it.
  const root =
    sel.kind === 'fold' &&
    halves(f).every((h) =>
      design.folds
        .filter((o) => onSide(o, h))
        .every((o) => lineX(o, 0) >= lineX(f, 0)),
    )
  $('foldKind').textContent =
    (sel.kind === 'flap'
      ? 'Tail cut (flap)'
      : root
        ? 'Wing root fold'
        : 'Lengthwise fold') +
    (f.side ? ` · ${f.side > 0 ? 'right' : 'left'} half` : '')
  $('foldDelete').textContent =
    sel.kind === 'flap' ? 'Delete cut' : 'Delete fold'
  $('foldSameRow').hidden = !!f.side
  $<HTMLInputElement>('foldSame').checked = !split
  $('foldAngleLRow').hidden = !split
  $('foldAngleName').textContent = split ? 'Right half' : 'Angle'
  const [min, top] = [-max, max]
  for (const [id, a] of [
    ['foldAngle', f.angle],
    ['foldAngleL', f.angleL ?? f.angle],
  ] as [string, number][]) {
    const input = $<HTMLInputElement>(id)
    Object.assign(input, { min, max: top, value: Math.round(a) }) // 0 in the middle: left folds down, right folds up
    fillRange(input)
    showAngle(a, $(`${id}Out`))
  }
  const sheetW = svg.clientWidth,
    half = pop.offsetWidth / 2 + 4 // keep the popover inside the sheet
  pop.style.left = `${Math.min(sheetW - half, Math.max(half, (X / 210) * sheetW))}px`
  pop.style.top = `${(Y / 297) * 100}%`
  pop.classList.toggle('above', Y > 170)
}

const svgPoint = (e: PointerEvent) => {
  const p = svg.createSVGPoint()
  p.x = e.clientX
  p.y = e.clientY
  const q = p.matrixTransform(svg.getScreenCTM()?.inverse())
  return toSheet(
    Math.max(0, Math.min(210, q.x)),
    Math.max(0, Math.min(297, q.y)),
  )
}
type Drag =
  | { kind: 'nose' | 'end1' | 'end2' }
  | { kind: 'draw'; from: Vec2; to?: Vec2 }
  | { kind: 'move'; from: Vec2; orig: Item; sign: number }
let drag: Drag | null = null
svg.addEventListener('pointerdown', (e) => {
  e.preventDefault() // no text selection or native drag while folding
  const p = svgPoint(e),
    { h, kind, i, s } = (e.target as SVGElement).dataset
  svg.setPointerCapture(e.pointerId)
  if (h) drag = { kind: h as 'nose' | 'end1' | 'end2' }
  else if (kind) {
    selected = {
      kind: kind as Kind,
      i: Number(i),
      s: Number(s) === -1 ? -1 : 1,
    }
    // Grabbing the mirrored copy on the left wing moves it like a mirror image.
    drag = {
      kind: 'move',
      from: p,
      orig: { ...(current() as Item) },
      sign: p[0] < 0 ? -1 : 1,
    }
    renderFolds()
  } else drag = { kind: 'draw', from: p }
})
svg.addEventListener('pointermove', (e) => {
  if (!drag) return
  const p = svgPoint(e),
    f = current()
  if (drag.kind === 'nose') tryDesign({ nose: L / 2 - p[1] })
  else if (drag.kind === 'draw') {
    drag.to = p
    draft = classify(drag.from, p)
    if (draft)
      draft.problem = designProblem({
        ...design,
        ...listPatch(draft.kind, [...list(draft.kind), draft.item]),
      })
    renderFolds()
  } else if (drag.kind === 'move') {
    const dx = (p[0] - drag.from[0]) * drag.sign,
      dy = p[1] - drag.from[1],
      o = drag.orig
    if (selected)
      setItem(
        selected,
        selected.kind === 'fold'
          ? { x1: o.x1 + dx, x2: o.x2 + dx }
          : { x0: o.x0 + dx, x1: o.x1 + dx, y: o.y + dy },
      )
  } else if (!selected || !f) return
  else if (selected.kind === 'fold') {
    // swing one end; the other end stays put
    const one = drag.kind === 'end1',
      other = one ? [f.x2, f.y2] : [f.x1, f.y1],
      y = one ? f.y1 : f.y2
    const maxDx = Math.abs(y - other[1]) * Math.tan(RULES.maxTilt * D2R)
    const x = Math.max(
      0,
      Math.min(
        HW,
        other[0] +
          Math.max(-maxDx, Math.min(maxDx, p[0] * halfOf() - other[0])),
      ),
    )
    setItem(selected, one ? { x1: x } : { x2: x })
  } else
    setItem(
      selected,
      drag.kind === 'end1'
        ? { x0: p[0] * halfOf(), y: p[1] }
        : { x1: p[0] * halfOf(), y: p[1] },
    )
})
svg.addEventListener('pointerup', () => {
  if (drag?.kind === 'draw') {
    const d = draft,
      stroke = drag.to
        ? Math.hypot(drag.to[0] - drag.from[0], drag.to[1] - drag.from[1])
        : 0
    if (d && stroke > 0.006) {
      // shorter strokes are clicks: they just deselect
      if (d.kind === 'flap' && d.item.y > -L / 2 + RULES.flapZone)
        notice('Cuts go in the shaded zone near the tail, so it moved there.')
      if (tryDesign(listPatch(d.kind, [...list(d.kind), d.item])))
        selected = {
          kind: d.kind,
          i: list(d.kind).length - 1,
          s: drag.from[0] < 0 ? -1 : 1,
        }
    } else selected = null
    draft = null
    renderFolds()
  }
  drag = null
})

function deleteSelected() {
  if (!selected) return
  const { kind, i } = selected
  selected = null
  setDesign(
    listPatch(
      kind,
      list(kind).filter((_, j) => j !== i),
    ),
  )
}
function showAngle(a: number, out: HTMLElement) {
  const r = Math.round(a)
  out.textContent = r > 0 ? `${r}° up` : r < 0 ? `${-r}° down` : 'flat'
  out.className = r > 0 ? 'up' : r < 0 ? 'down' : ''
}
const inputOf = (e: Event) => e.target as HTMLInputElement
$('foldAngle').addEventListener(
  'input',
  (e) => selected && setItem(selected, { angle: +inputOf(e).value }),
)
$('foldAngleL').addEventListener(
  'input',
  (e) => selected && setItem(selected, { angleL: +inputOf(e).value }),
)
$('foldSame').addEventListener(
  'change',
  (e) =>
    selected &&
    setItem(selected, {
      angleL: inputOf(e).checked ? undefined : current()?.angle,
    }),
)
$('foldDelete').onclick = deleteSelected
$('drawKind').addEventListener('click', (e) => {
  const kind = (e.target as HTMLElement).dataset.kind
  if (!kind) return
  drawKind = kind as Kind
  for (const b of $('drawKind').children)
    b.classList.toggle('on', b === e.target)
  $('toolHint').textContent = foldHint()
})
// Mirror off splits every fold and flap into a left and a right one, so each half can be shaped on its own.
$('mirrorFolds').onclick = () => {
  if (!design.mirror)
    return (
      tryDesign({ mirror: true }) &&
      notice('New folds go on both halves again.')
    )
  const split = (o: Item): Item[] =>
    o.side
      ? [o]
      : ([1, -1] as const).map((h) => {
          const { angleL, ...rest } = o
          return { ...rest, side: h, angle: angleOn(o, h) }
        })
  selected = null
  if (
    tryDesign({
      mirror: false,
      folds: list('fold').flatMap(split),
      flaps: list('flap').flatMap(split),
    })
  )
    notice(
      'Mirror off: each half is its own now, and new folds go only where you draw them.',
    )
}
$('clearFolds').onclick = () => {
  selected = null
  setDesign({ folds: [], flaps: [] })
}
// The default plane on blank paper: what the workshop opens with every time.
function freshPlane() {
  selected = null
  setDesign(DEFAULT_DESIGN)
  clearPaint()
}
$('resetDesign').onclick = () => {
  freshPlane()
  notice('Back to the default plane on blank paper.')
}
// A random plane that still follows the folding rules: sanitizeDesign drops anything that would not fold.
function randomDesign() {
  const r = (a: number, b: number) => a + Math.random() * (b - a),
    sign = () => (Math.random() < 0.7 ? 1 : -1)
  const keel = r(0.015, 0.045),
    folds: Fold[] = [
      {
        x1: keel,
        y1: L / 2,
        x2: keel,
        y2: -L / 2,
        angle: -Math.round(r(75, 94)),
      }, // wing root
    ]
  let x = keel + r(0.012, 0.035)
  for (
    let i = 0, n = Math.floor(r(0, 4));
    i < n && x < HW - 0.006;
    i++, x += r(0.009, 0.03)
  ) {
    const lean = r(-0.003, 0.003)
    folds.push({
      x1: x + lean,
      y1: L / 2,
      x2: x - lean,
      y2: -L / 2,
      angle: Math.round(r(15, 90)) * sign(),
    })
  }
  const flaps =
    Math.random() < 0.85
      ? [
          {
            x0: keel,
            x1: HW,
            y: -L / 2 + r(0.015, 0.04),
            angle: Math.round(r(4, 22)),
          },
        ]
      : []
  return {
    nose: r(0.06, 0.18),
    folds,
    flaps,
  }
}
function randomPaint() {
  clearPaint()
  const pick = () => COLORS[Math.floor(Math.random() * (COLORS.length - 1))] // any colour but paper white
  for (let i = 0, n = 2 + Math.floor(Math.random() * 3); i < n; i++) {
    pctx.fillStyle = pick()
    pctx.fillRect(
      0,
      Math.random() * paintCanvas.height,
      paintCanvas.width,
      (10 + Math.random() * 50) * PAINT_SCALE,
    )
  }
  if (Math.random() < 0.6) {
    // a pair of mirrored roundels
    pctx.fillStyle = pick()
    const k = PAINT_SCALE,
      rad = (15 + Math.random() * 25) * k,
      y = (250 + Math.random() * 250) * k,
      x = (60 + Math.random() * 80) * k
    for (const o of [0, FACE_W])
      for (const cx of [o + x, o + FACE_W - x]) {
        pctx.beginPath()
        pctx.arc(cx, y, rad, 0, Math.PI * 2)
        pctx.fill()
      }
  }
  paintTex.needsUpdate = true
}
$('randomDesign').onclick = () => {
  selected = null
  let d: ReturnType<typeof randomDesign>
  do d = randomDesign()
  while (selfIntersects(buildPlane(d).pos))
  setDesign(d)
  randomPaint()
  notice('A random plane! Throw it as it is, or tweak it first.')
}
window.addEventListener('keydown', (e) => {
  if (mode !== 'workshop' || (e.target as HTMLElement).tagName === 'INPUT')
    return
  if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected()
  if (e.key === 'Escape') {
    selected = null
    renderFolds()
  }
})

// Range inputs show their filled part.
// Signed sliders fill from 0 outwards: red when positive (up), blue when negative (down).
function fillRange(el: HTMLInputElement) {
  const at = (v: number) => `${((v - +el.min) / (+el.max - +el.min)) * 100}%`
  const from = Math.min(Math.max(0, +el.min), +el.max),
    v = +el.value
  el.style.setProperty('--from', at(Math.min(from, v)))
  el.style.setProperty('--to', at(Math.max(from, v)))
  el.style.setProperty('--fill', v < 0 ? 'var(--down)' : 'var(--accent)')
}
document.addEventListener('input', (e) => {
  if ((e.target as HTMLInputElement).type === 'range') fillRange(inputOf(e))
})

let previewModel = buildPlane(design)
function setDesign(patch: Partial<Design>) {
  design = sanitizeDesign({ ...design, ...patch, ...RETIRED })
  if (selected && selected.i >= list(selected.kind).length) selected = null
  previewModel = buildPlane(design)
  const drawn = drawnPlane(design)
  setPlaneGeometry(preview, drawn)
  if (mode !== 'landed') setPlaneGeometry(desk.plane, drawn)
  syncWorkshop()
}
function syncWorkshop() {
  renderFolds()
  $('foldCount').textContent =
    `${most(design.folds)}/${RULES.maxFolds} folds · ${most(design.flaps)}/${RULES.maxFlaps} cuts${design.mirror ? '' : ' per wing'}`
  Object.assign($('mirrorFolds'), {
    textContent: design.mirror ? '⇋ Mirrored' : '⇋ Mirror off',
  }).classList.toggle('on', design.mirror)
  $('mirrorFolds').setAttribute('aria-pressed', String(design.mirror))
  $<HTMLButtonElement>('clearFolds').disabled =
    !design.folds.length && !design.flaps.length
  const st = planeStats(previewModel)
  $('stats').innerHTML =
    `<span>Span ${(st.span * 100).toFixed(1)} cm</span><span>Wing ${(st.area * 1e4).toFixed(0)} cm²</span>
    <span>Mass ${(st.mass * 1000).toFixed(1)} g</span><span title="Geometric balance estimate; use a test throw to assess flight">Balance ${(st.margin * 100).toFixed(1)}%</span>`
}

// ---------- workshop: paint ----------
const paintCanvas = $<HTMLCanvasElement>('paint'),
  pctx = ctx2d(paintCanvas)
const FACE_W = paintCanvas.width / 2 // front face on the left half, back face on the right
const PAINT_SCALE = FACE_W / 420 // the sheet is painted at 2x so the 3D preview stays sharp
const paintTex = new THREE.CanvasTexture(paintCanvas)
paintTex.colorSpace = THREE.SRGBColorSpace
paintTex.anisotropy = renderer.capabilities.getMaxAnisotropy() // stays crisp when seen at an angle
function clearPaint() {
  pctx.fillStyle = '#fffdf6'
  pctx.fillRect(0, 0, paintCanvas.width, paintCanvas.height)
  paintTex.needsUpdate = true
}
clearPaint()
// Older paint has one face only; it goes on both faces, the way those planes always looked.
function drawSheet(ctx: CanvasRenderingContext2D, img: HTMLImageElement) {
  const { width: w, height: h } = ctx.canvas
  if (img.width > img.height) ctx.drawImage(img, 0, 0, w, h)
  else for (const o of [0, w / 2]) ctx.drawImage(img, o, 0, w / 2, h)
}
const COLORS = [
  '#2b2b3a',
  '#ff6b6b',
  '#ef8354',
  '#ffd166',
  '#7fc8a9',
  '#4caf6a',
  '#8ecae6',
  '#3d5a80',
  '#cdb4db',
  '#fffdf6',
]
let brushColor = COLORS[1]
$('swatches').innerHTML =
  COLORS.map(
    (c) =>
      `<button style="background:${c}" data-c="${c}" aria-label="Color ${c}"></button>`,
  ).join('') +
  '<label class="custom" title="Pick your own colour"><input type="color" id="customColor" value="#7b61ff" aria-label="Custom colour"></label>'
function pickColor(c: string, el: Element | null) {
  brushColor = c
  for (const b of $('swatches').children) b.classList.toggle('on', b === el)
}
$('swatches').addEventListener('click', (e) => {
  const b = e.target as HTMLElement
  if (b.dataset.c) pickColor(b.dataset.c, b)
})
$('customColor').addEventListener('input', (e) => {
  const input = inputOf(e),
    label = input.parentElement as HTMLElement
  label.style.background = input.value
  pickColor(input.value, label)
})
$('swatches').children[1].classList.add('on')
// Which faces a stroke lands on: the front, the back, or both at once (like ink soaking through).
const paintFaces = () => (paintSide === 'both' ? [0, 1] : [face])
$('clearPaint').onclick = () => {
  pctx.fillStyle = '#fffdf6'
  for (const f of paintFaces())
    pctx.fillRect(f * FACE_W, 0, FACE_W, paintCanvas.height)
  paintTex.needsUpdate = true
}
let last: Vec2 | null = null,
  face = 0,
  paintSide = 'front',
  mirror = false
function showFace(f: number) {
  face = f
  $('sheet').dataset.face = f ? 'back' : 'front'
}
function setPaintSide(side: string) {
  paintSide = side
  showFace(side === 'back' ? 1 : 0) // painting both shows the front
  for (const b of $('paintSide').children)
    b.classList.toggle('on', (b as HTMLElement).dataset.side === side)
}
$('paintSide').addEventListener('click', (e) => {
  const side = (e.target as HTMLElement).dataset.side
  if (side) setPaintSide(side)
})
$('mirror').addEventListener('click', () => {
  mirror = !mirror
  $('mirror').classList.toggle('on', mirror)
  $('mirror').setAttribute('aria-pressed', String(mirror))
})
// Pointer position on the sheet as [x across the face, y], in face pixels. The back is seen from
// behind, so it shows mirrored (CSS) and x runs backwards across it.
const sheetPt = (e: PointerEvent): Vec2 => {
  const r = $('sheet').getBoundingClientRect(),
    fx = ((e.clientX - r.left) / r.width) * FACE_W
  return [
    face ? FACE_W - fx : fx,
    ((e.clientY - r.top) / r.height) * paintCanvas.height,
  ]
}
paintCanvas.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  last = sheetPt(e)
  paintCanvas.setPointerCapture(e.pointerId)
  stroke([last])
})
// Coalesced events carry every pointer sample since the last frame, so fast strokes stay smooth.
paintCanvas.addEventListener('pointermove', (e) => {
  if (last) stroke((e.getCoalescedEvents?.() ?? [e]).map(sheetPt))
})
paintCanvas.addEventListener('pointerup', () => {
  last = null
  paintTex.needsUpdate = true
})
let lastUpload = 0
function stroke(points: Vec2[]) {
  const from = last
  if (!from) return
  Object.assign(pctx, {
    strokeStyle: brushColor,
    lineWidth: +$<HTMLInputElement>('brush').value * PAINT_SCALE,
    lineCap: 'round',
    lineJoin: 'round',
  })
  for (const f of paintFaces()) {
    const o = f * FACE_W
    pctx.save()
    pctx.beginPath()
    pctx.rect(o, 0, FACE_W, paintCanvas.height)
    pctx.clip() // keep the brush off the other face
    pctx.beginPath()
    for (const flip of mirror ? [false, true] : [false]) {
      // mirror: also across the centre fold
      const at = ([x, y]: Vec2): Vec2 => [o + (flip ? FACE_W - x : x), y]
      pctx.moveTo(...at(from))
      for (const p of points) pctx.lineTo(...at(p))
    }
    pctx.stroke()
    pctx.restore()
  }
  last = points.at(-1) ?? null
  // Sending the big sheet to the GPU is the slow part, so the 3D preview catches up ten times a second.
  const now = performance.now()
  if (now - lastUpload > 100) {
    paintTex.needsUpdate = true
    lastUpload = now
  }
}
const toolTabs = document.querySelector('.tabs') as HTMLElement // Fold & cut / Paint
toolTabs.addEventListener('click', (e) => {
  const tool = (e.target as HTMLElement).dataset.tool
  if (!tool) return
  $('sheet').dataset.tool = tool
  for (const b of (e.currentTarget as HTMLElement).children)
    b.classList.toggle('on', b === e.target)
  $('paintTools').hidden = tool !== 'paint'
  $('toolHint').textContent =
    tool === 'paint'
      ? 'Paint the sheet, front and back. Grey corners fold inside the nose.'
      : foldHint()
  $('drawKind').hidden = tool === 'paint'
  if (tool === 'paint') {
    selected = null
    renderFolds()
    setPaintSide(paintSide)
  } else showFace(0) // folds are drawn on the front
  $('mirrorFolds').hidden = tool === 'paint' // paint has its own mirror
})

const preview = planeMesh(drawnPlane(design), paintTex) // held on the tower while aiming
// While picking the direction: a flat arrow under the plane, pointing where it will fly.
const aimArrow = (() => {
  const shape = new THREE.Shape(
    [
      [0.3, -0.06],
      [1.6, -0.06],
      [1.6, -0.22],
      [2.3, 0],
      [1.6, 0.22],
      [1.6, 0.06],
      [0.3, 0.06],
    ].map(([x, z]) => new THREE.Vector2(x, z)),
  )
  const g = new THREE.ShapeGeometry(shape)
  g.rotateX(Math.PI / 2) // the shape's y becomes the world's z
  const arrow = new THREE.Mesh(
    g,
    new THREE.MeshBasicMaterial({
      color: 0xff6b6b,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  arrow.visible = false
  scene.add(arrow)
  return arrow
})()
scene.add(preview)

// Workshop preview: its own little renderer and scene, separate from the city.
const desk = {
  renderer: new THREE.WebGLRenderer({
    canvas: $<HTMLCanvasElement>('deskView'),
    antialias: true,
    alpha: true,
  }),
  scene: new THREE.Scene(),
  camera: new THREE.PerspectiveCamera(32, 1, 0.01, 10),
  plane: planeMesh(drawnPlane(design), paintTex),
  yaw: 0.7,
  pitch: 0.42,
  drag: null as Vec2 | null,
}
desk.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
desk.scene.add(desk.plane, new THREE.HemisphereLight(0xffffff, 0xb9ae95, 1.7))
{
  const key = new THREE.DirectionalLight(0xffffff, 2)
  key.position.set(1, 2, 1.5)
  desk.scene.add(key)
}
const deskView = $<HTMLCanvasElement>('deskView'),
  deskHome = deskView.parentElement as HTMLElement
// Put a landed plane on the turntable, or null for the workshop design.
function showOnDesk(rec: PlaneRecord | null) {
  setPlaneGeometry(desk.plane, drawnPlane(rec ? rec.design : design))
  const tex = rec ? paintTexture(rec) : paintTex
  Object.assign(desk.plane.material, { map: tex, needsUpdate: true })
  desk.plane.material.color.set(tex ? 0xffffff : 0xfffdf6)
}
deskView.addEventListener('pointerdown', (e) => {
  desk.drag = [e.clientX, e.clientY]
  deskView.setPointerCapture(e.pointerId)
  e.preventDefault()
})
deskView.addEventListener('pointermove', (e) => {
  if (!desk.drag) return
  desk.yaw -= (e.clientX - desk.drag[0]) * 0.01
  desk.pitch = Math.max(
    -1.2,
    Math.min(1.2, desk.pitch + (e.clientY - desk.drag[1]) * 0.01),
  )
  desk.drag = [e.clientX, e.clientY]
})
deskView.addEventListener('pointerup', () => {
  desk.drag = null
})
function renderDesk(dt: number) {
  const w = deskView.clientWidth,
    h = deskView.clientHeight
  if (!w || !h) return
  const pr = desk.renderer.getPixelRatio() // resize on any change, or a stale buffer gets stretched and blurry
  if (
    deskView.width !== Math.round(w * pr) ||
    deskView.height !== Math.round(h * pr)
  ) {
    desk.renderer.setSize(w, h, false)
    desk.camera.aspect = w / h
    desk.camera.updateProjectionMatrix()
  }
  if (!desk.drag) desk.yaw += dt * 0.35
  const r = 0.5
  desk.camera.position.set(
    Math.cos(desk.yaw) * Math.cos(desk.pitch) * r,
    Math.sin(desk.pitch) * r,
    Math.sin(desk.yaw) * Math.cos(desk.pitch) * r,
  )
  desk.camera.lookAt(0, 0, 0)
  desk.renderer.render(desk.scene, desk.camera)
}
syncWorkshop()

// ---------- landed planes & live flights ----------
interface LiveFlight {
  info: PlaneInfo
  mesh: PlaneMesh
  label: THREE.Sprite
  trails: Contrail[]
  shadow: THREE.Mesh
  tp: THREE.Vector3
  tq: THREE.Quaternion
  v: THREE.Vector3
  steer: readonly number[]
  at: number
  seen: boolean
}
const landedPlanes = new Map<
  number,
  { rec: PlaneRecord; group: THREE.Group; label: THREE.Sprite }
>()
const flights = new Map<number, LiveFlight>()
const flightOf = (id: number | null) =>
  id === null ? undefined : flights.get(id)
let myFlightId: number | null = null
const hue = (s: string) =>
  [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7) / 360

const tmpV = new THREE.Vector3()
function addLanded(rec: PlaneRecord) {
  if (landedPlanes.has(rec.id)) return
  const group = new THREE.Group()
  const model = drawnPlane(rec.design),
    mesh = planeMesh(model, paintTexture(rec))
  mesh.quaternion.set(...rec.q)
  // Lift it clear of the ground: the server rests planes on the street level and its model may differ
  // slightly from this one (bent flaps, older physics), so the lowest corner could end up underground.
  let low = Infinity
  for (let i = 0; i < model.pos.length; i += 3)
    low = Math.min(
      low,
      tmpV
        .set(model.pos[i], model.pos[i + 1], model.pos[i + 2])
        .applyQuaternion(mesh.quaternion).y,
    )
  const y = Math.max(rec.p[1], groundAt(rec.p[0], rec.p[2]) + 0.002 - low)
  const label = makeLabel(
    `${rec.name} · ${rec.dist} m`,
    new THREE.Color().setHSL(hue(rec.name), 0.8, 0.55),
  )
  label.position.y = 0.3
  group.add(mesh, label)
  group.position.set(rec.p[0], y, rec.p[2])
  scene.add(group)
  placeShadow(addShadow(mesh), mesh)
  landedPlanes.set(rec.id, { rec, group, label })
}
// Name tag that keeps the same on-screen size; drawn on a canvas, with a dot in the pilot's colour.
// With a second line (flying planes) it is a marker you can spot from across the city: name, then metres.
const LABEL_RANGE = 120 // metres; farther tags of landed planes are hidden so the city does not fill up with text
const TAG_FONT = '700 34px "Baloo 2", system-ui, sans-serif',
  SUB_FONT = '600 28px "Baloo 2", system-ui, sans-serif'
function drawTag(
  c: HTMLCanvasElement,
  text: string,
  color: THREE.Color,
  sub?: string,
) {
  const ctx = ctx2d(c)
  ctx.clearRect(0, 0, c.width, c.height)
  ctx.fillStyle = '#fffdf6'
  ctx.strokeStyle = '#2b2b3a'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.roundRect(2, 2, c.width - 4, c.height - 4, 24)
  ctx.fill()
  ctx.stroke()
  ctx.fillStyle = `#${color.getHexString()}`
  ctx.beginPath()
  ctx.arc(28, 28, 9, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#2b2b3a'
  ctx.textBaseline = 'middle'
  ctx.font = TAG_FONT
  ctx.fillText(text, 46, 30)
  if (sub !== undefined) {
    ctx.font = SUB_FONT
    ctx.fillStyle = '#5a5a6e'
    ctx.fillText(sub, 46, 70)
  }
}
function makeLabel(text: string, color: THREE.Color, sub?: string) {
  const c = document.createElement('canvas'),
    ctx = ctx2d(c)
  ctx.font = TAG_FONT
  let w = ctx.measureText(text).width
  ctx.font = SUB_FONT
  if (sub !== undefined) w = Math.max(w, ctx.measureText('8888 m').width) // room for the distance to grow
  c.width = Math.ceil(w) + 70
  c.height = sub === undefined ? 56 : 96
  drawTag(c, text, color, sub)
  const map = new THREE.CanvasTexture(c)
  map.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map,
      sizeAttenuation: false,
      depthTest: sub === undefined,
    }),
  )
  const h = 0.02 * (c.height / 56) // fraction of the view height
  sprite.scale.set((h * c.width) / c.height, h, 1)
  sprite.center.set(0.5, 0) // sits on top of the plane instead of through it
  sprite.userData = { text, color, sub }
  return sprite
}
function setLabelSub(sprite: THREE.Sprite, sub: string) {
  const u = sprite.userData,
    map = sprite.material.map as THREE.CanvasTexture
  if (u.sub === sub) return
  u.sub = sub
  drawTag(map.image, u.text, u.color, sub)
  map.needsUpdate = true
}
// Contrails: a soft ribbon off each wingtip, slim behind the plane and widening and fading as it ages,
// like smoke. It never gets thinner than a couple of pixels, so far-off flights stay visible.
// Other planes' contrails last TRAIL_LIFE seconds; yours stays whole until you throw again.
const TRAIL_LIFE = 30,
  TRAIL_FADE = 8, // seconds of fading at the end of a contrail's life
  TRAIL_STEP = 0.2, // metres between kept points; the newest point follows the wingtip
  REPLAY_OWNER = -1
const trailShared = { uNow: { value: 0 }, uPixel: { value: 0.001 } }
const TRAIL_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute float aTime;
uniform float uNow;
uniform float uPixel; // world size of one pixel at distance 1
uniform float uLife; // 0: never fades
varying float vSide;
varying float vAlpha;
void main() {
  float age = max(uNow - aTime, 0.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 dir = (modelViewMatrix * vec4(aNext - aPrev, 0.0)).xyz;
  vec3 across = cross(dir, mv.xyz);
  across = dot(across, across) > 1e-16 ? normalize(across) : vec3(1.0, 0.0, 0.0);
  float spread = 0.015 + 0.035 * min(age, 12.0); // metres: smoke widens as it ages
  float width = max(spread, 2.5 * uPixel * -mv.z);
  mv.xyz += across * aSide * width * 0.5;
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  vSide = aSide;
  float life = uLife > 0.0 ? clamp((uLife - age) / ${TRAIL_FADE.toFixed(1)}, 0.0, 1.0) : 1.0;
  vAlpha = life * mix(0.85, 0.3, min(age / 12.0, 1.0)) * smoothstep(0.0, 0.08, age);
}`
const TRAIL_FRAG = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
varying float vSide;
varying float vAlpha;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - smoothstep(0.15, 1.0, abs(vSide))));
}`
interface Contrail {
  owner: number // flight id, or REPLAY_OWNER
  tip: THREE.Vector3 // in the plane's frame
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  pts: THREE.Vector3[]
  times: number[] // seconds (performance.now) each point was flown
  cap: number // points the buffers hold
  ended: boolean // its plane is gone
}
const contrails = new Set<Contrail>()
const keeps = (c: Contrail) =>
  c.owner === myFlightId || c.owner === REPLAY_OWNER
function makeContrails(owner: number, model: PlaneModel, name: string) {
  let lo = 0,
    hi = 0 // wingtips = outermost vertices
  for (let i = 2; i < model.pos.length; i += 3) {
    if (model.pos[i] < model.pos[lo + 2]) lo = i - 2
    if (model.pos[i] > model.pos[hi + 2]) hi = i - 2
  }
  const color = new THREE.Color(0xffffff).lerp(
    new THREE.Color().setHSL(hue(name), 0.85, 0.6),
    0.35,
  )
  return [lo, hi].map((i) => {
    const mesh = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.ShaderMaterial({
        vertexShader: TRAIL_VERT,
        fragmentShader: TRAIL_FRAG,
        uniforms: {
          ...trailShared,
          uColor: { value: color },
          uLife: { value: TRAIL_LIFE },
        },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    mesh.frustumCulled = false
    scene.add(mesh)
    const c: Contrail = {
      owner,
      tip: new THREE.Vector3(model.pos[i], model.pos[i + 1], model.pos[i + 2]),
      mesh,
      pts: [],
      times: [],
      cap: 0,
      ended: false,
    }
    contrails.add(c)
    return c
  })
}
// Buffers for `cap` points: two vertices each, one either side of the ribbon.
function allocate(c: Contrail, cap: number) {
  const g = new THREE.BufferGeometry(),
    v = cap * 2,
    side = new Float32Array(v),
    index = new Uint32Array(Math.max(0, cap - 1) * 6)
  for (let i = 0; i < v; i++) side[i] = i % 2 ? 1 : -1
  for (let i = 0; i < cap - 1; i++)
    index.set(
      [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2],
      i * 6,
    )
  for (const name of ['position', 'aPrev', 'aNext'])
    g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(v * 3), 3))
  g.setAttribute('aTime', new THREE.BufferAttribute(new Float32Array(v), 1))
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  c.mesh.geometry.dispose()
  c.mesh.geometry = g
  c.cap = cap
}
// Write points from..to-1 (and the neighbours whose prev/next they are) and upload just those.
function writeTrail(c: Contrail, from: number, to: number) {
  const n = c.pts.length,
    g = c.mesh.geometry,
    lo = Math.max(0, from - 1),
    hi = Math.min(n, to + 1)
  const attr = (name: string) => g.getAttribute(name) as THREE.BufferAttribute
  const pos = attr('position'),
    prev = attr('aPrev'),
    next = attr('aNext'),
    time = attr('aTime')
  for (let i = lo; i < hi; i++) {
    const p = c.pts[i] as THREE.Vector3,
      a = c.pts[Math.max(0, i - 1)] as THREE.Vector3,
      b = c.pts[Math.min(n - 1, i + 1)] as THREE.Vector3
    for (const v of [2 * i, 2 * i + 1]) {
      pos.setXYZ(v, p.x, p.y, p.z)
      prev.setXYZ(v, a.x, a.y, a.z)
      next.setXYZ(v, b.x, b.y, b.z)
      time.setX(v, c.times[i] ?? 0)
    }
  }
  for (const [a, size] of [
    [pos, 3],
    [prev, 3],
    [next, 3],
    [time, 1],
  ] as const) {
    a.addUpdateRange(lo * 2 * size, (hi - lo) * 2 * size)
    a.needsUpdate = true
  }
  g.setDrawRange(0, Math.max(0, n - 1) * 6)
}
function extendContrails(cs: Contrail[], plane: THREE.Object3D, now: number) {
  plane.updateMatrixWorld()
  for (const c of cs) {
    const p = plane.localToWorld(c.tip.clone()),
      n = c.pts.length,
      before = c.pts[n - 2]
    if (n >= 2 && before && before.distanceTo(p) < TRAIL_STEP) {
      c.pts[n - 1] = p // the newest point follows the wingtip until the next one is due
      c.times[n - 1] = now
      writeTrail(c, n - 1, n)
      continue
    }
    c.pts.push(p)
    c.times.push(now)
    if (c.pts.length > c.cap) {
      allocate(c, Math.max(64, c.cap * 2))
      writeTrail(c, 0, c.pts.length)
    } else writeTrail(c, n, n + 1)
  }
}
function disposeContrails(cs: Contrail[]) {
  for (const c of cs) {
    disposePlane(c.mesh)
    contrails.delete(c)
  }
}
// Each frame: age everything on the GPU, and drop points older than their life.
function updateContrails(now: number) {
  trailShared.uNow.value = now
  trailShared.uPixel.value =
    (2 * Math.tan((camera.fov * Math.PI) / 360)) /
    Math.max(1, renderer.domElement.clientHeight)
  for (const c of contrails) {
    const keep = keeps(c)
    c.mesh.material.uniforms.uLife.value = keep ? 0 : TRAIL_LIFE
    // While your flight replays, its own contrail draws again from the start.
    c.mesh.visible = !(mode === 'replay' && c.owner === myFlightId)
    if (keep) continue
    let old = 0
    while (old < c.times.length && now - (c.times[old] ?? 0) > TRAIL_LIFE) old++
    if (c.ended && old >= c.pts.length) {
      disposeContrails([c])
      continue
    }
    if (old >= 16 || (old && old === c.pts.length)) {
      c.pts.splice(0, old)
      c.times.splice(0, old)
      writeTrail(c, 0, c.pts.length)
    }
  }
}

// ---------- replay of your last flight ----------
interface ReplaySample {
  t: number // seconds since the throw
  p: Vec3
  q: Quat
}
let recording: ReplaySample[] = []
let replay: {
  samples: ReplaySample[]
  mesh: PlaneMesh
  shadow: THREE.Mesh
  trails: Contrail[]
  t: number
  i: number
} | null = null
const replayVel = new THREE.Vector3(),
  replayQ = new THREE.Quaternion()
function startReplay() {
  if (!landedRec || recording.length < 2) return
  stopReplay()
  const model = drawnPlane(landedRec.design),
    mesh = planeMesh(model, paintTexture(landedRec))
  scene.add(mesh)
  replay = {
    samples: recording,
    mesh,
    shadow: addShadow(mesh),
    trails: makeContrails(REPLAY_OWNER, model, landedRec.name),
    t: 0,
    i: 0,
  }
  setMode('replay')
}
function stopReplay() {
  if (replay) {
    disposePlane(replay.mesh)
    disposeContrails(replay.trails)
  }
  replay = null
}
// Step the replay by dt (four times as fast with Shift held); false once it reaches the landing.
function stepReplay(dt: number) {
  if (!replay) return false
  const r = replay,
    s = r.samples,
    first = r.t === 0
  r.t += dt * (held('ShiftLeft', 'ShiftRight') ? 4 : 1)
  while (r.i < s.length - 2 && (s[r.i + 1]?.t ?? 0) <= r.t) r.i++
  const a = s[r.i],
    b = s[r.i + 1]
  if (!a || !b) return false
  const span = Math.max(b.t - a.t, 1e-6),
    k = Math.min(1, Math.max(0, (r.t - a.t) / span))
  r.mesh.position.set(...a.p).lerp(v1.set(...b.p), k)
  r.mesh.quaternion.set(...a.q).slerp(replayQ.set(...b.q), k)
  replayVel
    .set(...b.p)
    .sub(v1.set(...a.p))
    .divideScalar(span)
  placeShadow(r.shadow, r.mesh)
  extendContrails(r.trails, r.mesh, performance.now() / 1000)
  chase(r.mesh.position, replayVel, r.mesh.quaternion, dt, first)
  const dist = Math.hypot(r.mesh.position.x, r.mesh.position.z)
  $('replayTime').textContent = `${r.t.toFixed(0)} s · → ${dist.toFixed(0)} m`
  return r.t < (s.at(-1)?.t ?? 0)
}

function addFlight(info: PlaneInfo) {
  if (flights.has(info.id)) return
  const model = drawnPlane(info.design),
    mesh = planeMesh(model, paintTexture(info))
  mesh.visible = false
  // Flying planes always carry a marker, drawn over buildings, so far-off throws stay easy to spot.
  const label = makeLabel(
    info.name,
    new THREE.Color().setHSL(hue(info.name), 0.8, 0.55),
    '0 m',
  )
  label.visible = false
  label.renderOrder = 10
  scene.add(mesh, label)
  flights.set(info.id, {
    info,
    mesh,
    label,
    trails: makeContrails(info.id, model, info.name),
    shadow: addShadow(mesh),
    tp: new THREE.Vector3(),
    tq: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    steer: [0, 0],
    at: 0,
    seen: false,
  })
}
function removeFlight(id: number) {
  const f = flights.get(id)
  if (f) {
    disposePlane(f.mesh)
    disposePlane(f.label)
    for (const t of f.trails) t.ended = true // fades out on its own, or stays while it is yours
    flights.delete(id)
  }
}

// ---------- your own flight: simulated here, corrected by the server ----------
// The browser steps the same physics as the server, so steering reacts instantly. The server runs
// the official copy at our pace and streams its state; if ours drifts, we rewind to its state
// and replay our inputs. Other players only ever see the server's copy.
const MAX_CATCHUP = 250 // steps per frame, so a hiccup doesn't freeze the page
let local: {
  pred: PredictedFlight
  start: number
  lastProgress: number
} | null = null
function startLocal(m: { design: Design; state: State; t0: number }) {
  recording = []
  stopReplay()
  local = {
    pred: new PredictedFlight(m.design, m.state, m.t0),
    start: performance.now(),
    lastProgress: 0,
  }
}
function stepLocal(now: number, steer: readonly number[]) {
  if (!local) return
  const sim = local.pred.sim,
    target = Math.min(
      sim.n + MAX_CATCHUP,
      Math.floor((now - local.start) / 1000 / DT),
    )
  local.pred.stepTo(target, steer, (i) =>
    wsSend({ t: 'steer', pitch: i.p, roll: i.r, at: i.at }),
  )
  if (now - local.lastProgress > 50) {
    local.lastProgress = now
    wsSend({ t: 'progress', at: sim.n })
  }
}
function reconcile(srv: ServerState) {
  if (!local) return
  // Behind the server (e.g. a background tab): realign our clock to its step.
  if (local.pred.reconcile(srv) === 'jump')
    local.start = performance.now() - srv.n * DT * 1000
}

function renderBoard() {
  const recs = [...landedPlanes.values()].map((x) => x.rec)
  const li = (r: PlaneRecord, text: string) =>
    `<li data-id="${r.id}">${escapeHtml(r.name)} · ${text}</li>`
  $('top').innerHTML =
    [...recs]
      .sort((a, b) => b.dist - a.dist)
      .slice(0, 5)
      .map((r) => li(r, `${r.dist} m`))
      .join('') || '<li>No planes yet</li>'
  $('recent').innerHTML = [...recs]
    .sort((a, b) => b.at - a.at)
    .slice(0, 6)
    .map((r) => li(r, WHERE[r.where] ?? r.where))
    .join('')
  renderMyPlanes()
}

// Your planes: thrown planes remembered in this browser as { id, at, archived? } (the landing time guards
// against a reset server reusing ids), plus drafts you duplicated, stored with their design and paint.
const readList = <T>(key: string): T[] => {
  try {
    const v = JSON.parse(store.get(key) ?? '[]')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
const myPlaneKeys = () =>
  readList<{ id: number; at: number; archived?: boolean }>('paperfold.mine')
function rememberMine(rec: PlaneRecord) {
  store.set(
    'paperfold.mine',
    JSON.stringify([...myPlaneKeys(), { id: rec.id, at: rec.at }].slice(-200)),
  )
}
interface SavedDraft {
  key: string
  at: number
  name: string
  design: Design
  paint: string
  archived?: boolean
}
let drafts = readList<SavedDraft>('paperfold.drafts')
const saveDrafts = () => store.set('paperfold.drafts', JSON.stringify(drafts))
function myPlanes() {
  const keys = myPlaneKeys()
  return keys
    .map((k) => landedPlanes.get(k.id)?.rec)
    .filter((r, i): r is PlaneRecord => !!r && r.at === keys[i].at)
    .sort((a, b) => b.at - a.at)
}
// One list of entries, newest first: { key, archived, title, sub, thumb, load(), duplicate() }.
function myEntries() {
  const keys = myPlaneKeys(),
    mine = myPlanes(),
    best = Math.max(0, ...mine.map((r) => r.dist))
  const planes = mine.map((r) => ({
    key: `p${r.id}`,
    at: r.at,
    archived: !!keys.find((k) => k.id === r.id)?.archived,
    title: `${r.dist} m${r.dist === best ? ' ★' : ''}`,
    sub: `${WHERE[r.where] ?? r.where} · ${ago(r.at)}`,
    thumb: paintUrl(r),
    design: r.design,
    name: `your ${r.dist} m plane`,
    draft: false,
  }))
  const copies = drafts.map((d) => ({
    key: d.key,
    at: d.at,
    archived: !!d.archived,
    title: escapeHtml(d.name),
    sub: `draft · ${ago(d.at)}`,
    thumb: d.paint,
    design: d.design,
    name: d.name,
    draft: true,
  }))
  return [...copies, ...planes].sort((a, b) => b.at - a.at)
}
const ICONS = {
  dup: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
  archive:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="3.5" rx="1"/><path d="M2.5 6v6.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6M6.5 9h3"/></svg>',
  restore:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.5M3 2v3h3"/></svg>',
}
function renderMyPlanes() {
  const entries = myEntries()
  const row = (
    e: ReturnType<typeof myEntries>[number],
  ) => `<li><button class="load" data-key="${e.key}" aria-label="Load ${e.draft ? e.title : e.name}">
      <span class="thumb">${e.thumb ? `<img src="${e.thumb}" alt="">` : ''}</span><span><b>${e.title}</b><small>${e.sub}</small></span></button>
    <button class="icon" data-act="dup" data-key="${e.key}" title="Duplicate as a new draft" aria-label="Duplicate">${ICONS.dup}</button>
    <button class="icon" data-act="${e.archived ? 'restore' : 'archive'}" data-key="${e.key}" title="${e.archived ? 'Restore' : 'Archive'}" aria-label="${e.archived ? 'Restore' : 'Archive'}">${ICONS[e.archived ? 'restore' : 'archive']}</button></li>`
  const active = entries.filter((e) => !e.archived),
    archived = entries.filter((e) => e.archived)
  $('myPlanes').innerHTML =
    active.map(row).join('') ||
    '<li class="hint">Planes you throw show up here. Click one to fold it again.</li>'
  $('myArchived').innerHTML = archived.map(row).join('')
  $('archivedCount').textContent = String(archived.length)
  $('archivedPlanes').hidden = !archived.length
}
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1
    ? 'just now'
    : m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`
}
// Paint as a data URL, so a draft keeps its look even if the server's copy goes away.
function paintDataUrl(src: string) {
  return new Promise<string>((resolve) => {
    if (!src || src.startsWith('data:')) return resolve(src || '')
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      Object.assign(c, { width: paintCanvas.width, height: paintCanvas.height })
      drawSheet(ctx2d(c), img)
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => resolve('')
    img.src = src
  })
}
$('mineCard').addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-key]')
  const entry = btn && myEntries().find((x) => x.key === btn.dataset.key)
  if (!entry) return
  const act = btn.dataset.act
  if (!act)
    return applyDesign(entry.design, entry.thumb, `Loaded ${entry.name}.`)
  if (act === 'dup') {
    drafts.unshift({
      key: `d${Date.now()}`,
      at: Date.now(),
      name: `Copy of ${entry.name.replace(/^your /, '')}`,
      design: entry.design,
      paint: await paintDataUrl(entry.thumb),
    })
    saveDrafts()
    notice('Duplicated. The copy is at the top of Your planes.')
  } else {
    const archived = act === 'archive'
    if (entry.draft)
      drafts = drafts.map((d) => (d.key === entry.key ? { ...d, archived } : d))
    else
      store.set(
        'paperfold.mine',
        JSON.stringify(
          myPlaneKeys().map((k) =>
            `p${k.id}` === entry.key ? { ...k, archived } : k,
          ),
        ),
      )
    if (entry.draft) saveDrafts()
  }
  renderMyPlanes()
})
function loadPlane(rec: PlaneRecord, message: string) {
  applyDesign(rec.design, paintUrl(rec), message)
}
function applyDesign(design: Design, paintSrc: string, message: string) {
  selected = null
  setDesign(design)
  clearPaint()
  if (paintSrc) {
    const img = new Image()
    img.onload = () => {
      drawSheet(pctx, img)
      paintTex.needsUpdate = true
    }
    img.src = paintSrc
  }
  notice(message)
}
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const WHERE: Record<string, string> = {
  street: 'in the street',
  roof: 'on a rooftop',
  tree: 'in a tree',
  tower: 'on the tower',
  car: 'on a passing car',
  person: "on someone's head",
  timeout: 'after a marathon flight',
}
$('board').addEventListener('click', (e) => {
  const rec = landedPlanes.get(
    Number((e.target as HTMLElement).dataset.id),
  )?.rec
  if (!rec) return
  setMode('explore')
  camera.position.set(rec.p[0] + 0.7, rec.p[1] + 0.5, rec.p[2] + 0.7)
  camera.lookAt(...rec.p)
  syncExploreAngles()
})

// ---------- network ----------
interface PlaneInfo {
  id: number
  name: string
  design: Design
  paint: boolean | string // offline planes carry their paint as a data URL
}
interface PlaneRecord extends PlaneInfo {
  p: Vec3
  q: Quat
  dist: number
  where: string
  time: number
  at: number
}
interface Player {
  name: string
  best: number
  flying: boolean
  flight: number | null
  status: string
  you: boolean
}
type ServerMessage =
  | { t: 'init'; landed: PlaneRecord[]; flights: PlaneInfo[]; time: number }
  | { t: 'players'; list: Player[] }
  | { t: 'mine'; id: number; design: Design; state: State; t0: number }
  | ({ t: 'launched' } & PlaneInfo)
  | { t: 'flights'; f: (ServerState & { id: number })[] }
  | { t: 'landed'; plane: PlaneRecord; ignored?: boolean }
type ClientMessage =
  | { t: 'hello'; name: string; pid: string }
  | {
      t: 'throw'
      design: Design
      power: number
      pitch: number
      yaw: number
      paint: string
    }
  | { t: 'steer'; pitch: number; roll: number; at: number }
  | { t: 'progress'; at: number }
  | { t: 'status'; status: string }
const ADJ = [
  'Swift',
  'Breezy',
  'Crumpled',
  'Lofty',
  'Dizzy',
  'Sunny',
  'Gusty',
  'Nimble',
  'Paper',
  'Lucky',
  'Sleepy',
  'Brave',
  'Zippy',
  'Fluffy',
  'Quiet',
  'Wobbly',
]
const NOUN = [
  'Heron',
  'Swallow',
  'Comet',
  'Kite',
  'Falcon',
  'Moth',
  'Glider',
  'Crane',
  'Sparrow',
  'Origami',
  'Pigeon',
  'Albatross',
  'Dart',
  'Puffin',
  'Breeze',
  'Owl',
]
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)]
const randomName = () => `${pick(ADJ)} ${pick(NOUN)}`
// Private id so the server can keep your best distance across reloads; never shown to other players.
const pid =
  store.get('paperfold.pid') ??
  [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
store.set('paperfold.pid', pid)
let ws: WebSocket | undefined,
  name = store.get('paperfold.name') || randomName()
const wsSend = (m: ClientMessage) =>
  ws?.readyState === 1 && ws.send(JSON.stringify(m))
function connect() {
  // An offline flight finishes here first: the server's init would clear it from the city.
  if (online === false && local) return setTimeout(connect, 2000)
  const url = serverUrl('/ws')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  ws = new WebSocket(url)
  ws.onopen = () => {
    setOnline(true)
    wsSend({ t: 'hello', name, pid })
    wsSend({ t: 'status', status: STATUS[mode] })
  }
  ws.onclose = () => {
    setOnline(false)
    setTimeout(connect, 5000)
  }
  ws.onmessage = (e) => {
    const m: ServerMessage = JSON.parse(e.data)
    if (m.t === 'init') {
      for (const { group } of landedPlanes.values()) disposePlane(group)
      landedPlanes.clear()
      for (const id of [...flights.keys()]) removeFlight(id)
      m.landed.forEach(addLanded)
      m.flights.forEach(addFlight)
      // Back online while looking at a plane that landed offline: keep it in the city meanwhile.
      if (landedRec && (mode === 'landed' || mode === 'replay')) {
        addLanded(landedRec)
        if (mode === 'landed') renderResults()
      }
      windClock = m.time - performance.now() / 1000 // the server's world time, for drawing the wind
      renderBoard()
    } else if (m.t === 'players') renderPlayers(m.list)
    else if (m.t === 'mine') {
      myFlightId = m.id
      startLocal(m)
      setMode('flying')
    } else if (m.t === 'launched') addFlight(m)
    else if (m.t === 'flights') {
      const now = performance.now()
      for (const s of m.f) {
        const f = flights.get(s.id)
        if (s.id === myFlightId && local) {
          reconcile(s)
          continue
        }
        if (!f) continue
        f.tp.set(...s.p)
        f.tq.set(...s.q)
        f.v.set(...s.v)
        f.at = now
        if (!f.seen) {
          f.seen = true
          f.mesh.visible = true
          f.mesh.position.copy(f.tp)
          f.mesh.quaternion.copy(f.tq)
        }
        if (s.s[0] !== f.steer[0] || s.s[1] !== f.steer[1]) {
          // show the elevons moving
          f.steer = s.s
          setPlaneGeometry(f.mesh, drawnPlane(f.info.design, s.s))
        }
      }
    } else if (m.t === 'landed') onLanded(m.plane, m.ignored)
  }
}
function onLanded(plane: PlaneRecord, ignored?: boolean) {
  removeFlight(plane.id)
  if (!ignored) {
    addLanded(plane)
    renderBoard()
  } // throws under 5 m don't stay in the city
  if (plane.id === myFlightId) {
    local = null
    if (!ignored) {
      rememberMine(plane)
      renderMyPlanes()
    }
    lookAt.set(...plane.p)
    showLanded(plane)
  } else if (mode === 'landed' && !ignored) renderResults()
}

// ---------- offline: without a server, throws fly and land in this browser only ----------
// Offline planes are kept in localStorage under negative ids, so they never meet the server's.
let online: boolean | null = null // unknown until the first connection attempt ends
const MIN_DIST = 5,
  MAX_FLIGHT_S = 180 // as on the server
const landedOffline = new Set<number>() // planes kept only in this browser
const offlinePlanes = () => readList<PlaneRecord>('paperfold.offline')
function setOnline(on: boolean) {
  if (on === online) return
  online = on
  document.body.classList.toggle('offline', !on)
  $('netBadge').hidden = false
  $('netBadge').textContent = on ? 'Online' : 'Offline'
  if (on)
    return console.info('[paperfold] connected to the server: online play')
  console.info(
    '[paperfold] server unreachable: offline play, flights and scores stay in this browser',
  )
  for (const { group } of landedPlanes.values()) disposePlane(group)
  landedPlanes.clear()
  for (const id of [...flights.keys()])
    if (!(id === myFlightId && local)) removeFlight(id) // your flight lands locally
  for (const rec of offlinePlanes()) {
    landedOffline.add(rec.id)
    addLanded(rec)
  }
  renderPlayers([])
  renderBoard()
}
function throwOffline() {
  const id = -Date.now(),
    jitter = () => Math.random() - 0.5 // nobody throws perfectly, as on the server
  const d = sanitizeDesign(design)
  const state = launchState(
    spawnPoint(yaw),
    yaw + jitter() * 0.05,
    pitchDeg * D2R + jitter() * 0.06,
    3 + power * 11,
    [jitter() * 2, jitter() * 2, jitter() * 2],
  )
  addFlight({ id, name, design: d, paint: paintCanvas.toDataURL('image/png') })
  myFlightId = id
  startLocal({ design: d, state, t0: windNow() })
  setMode('flying')
}
function landOffline() {
  const f = flightOf(myFlightId)
  if (!local || !f) return
  const sim = local.pred.sim
  if (!sim.s.p.every(Number.isFinite)) sim.s.p = spawnPoint(0)
  const L = sim.landing ?? {
    y: surfaceAt(sim.s.p[0], sim.s.p[2]),
    where: 'timeout',
  }
  const roll = (Math.random() < 0.5 ? -1 : 1) * (0.9 + Math.random() * 0.4)
  const { p, q } = restPose(sim.model, sim.s.q, sim.s.p, L.y, roll)
  const rec: PlaneRecord = {
    id: f.info.id,
    name,
    design: f.info.design,
    paint: f.info.paint,
    p: p.map((v) => Math.round(v * 1000) / 1000) as Vec3,
    q,
    dist: Math.round(Math.hypot(p[0], p[2])),
    where: L.where,
    time: Math.round(sim.n * DT),
    at: Date.now(),
  }
  const ignored = rec.dist < MIN_DIST
  if (!ignored) {
    const list = offlinePlanes()
    // shortcut: a full localStorage drops this plane's paint; move paint to IndexedDB if that bites.
    try {
      localStorage.setItem('paperfold.offline', JSON.stringify([...list, rec]))
    } catch {
      store.set(
        'paperfold.offline',
        JSON.stringify([...list, { ...rec, paint: false }]),
      )
    }
  }
  landedOffline.add(rec.id)
  onLanded(rec, ignored)
}

// ---------- live: who is online, and a follow cam on someone else's plane ----------
let players: Player[] = [],
  followId: number | null = null,
  followSnap = true
function renderPlayers(list = players) {
  players = list
  for (const el of document.querySelectorAll('.playingCount'))
    el.textContent = String(list.length)
  const html = list
    .map((p) => {
      const follow = p.flight != null && !p.you
      return (
        `<li class="${p.you ? 'you' : ''}${follow && p.flight === followId ? ' following' : ''}"${follow ? ` data-flight="${p.flight}" title="Watch this flight"` : ''}>` +
        `<span>${escapeHtml(p.name)}${p.you ? ' (you)' : ''}${p.flying ? ' ✈' : ''}<small>${doing(p)}</small></span><b>${p.best ? `${p.best} m` : '–'}</b></li>`
      )
    })
    .join('')
  for (const el of document.querySelectorAll('.playingList'))
    el.innerHTML = html
}
// What a player is up to, for the list: for a flight in the air, how far out it is right now.
const DOING: Record<string, string> = {
  arriving: 'just arrived',
  folding: 'folding a plane',
  aiming: 'on the tower, aiming',
  results: 'just landed',
  replay: 'watching a replay',
  exploring: 'exploring the city',
  watching: 'spectating',
  lab: 'testing in the lab',
}
function doing(p: Player) {
  const f = flightOf(p.flight)
  if (p.flying && f?.seen) {
    const at = f.mesh.position
    return `flying · ${Math.hypot(at.x, at.z).toFixed(0)} m out, ${at.y.toFixed(0)} m up${p.you ? '' : ' · watch ▸'}`
  }
  return p.flying ? 'just thrown' : (DOING[p.status] ?? '')
}
setInterval(() => renderPlayers(), 500) // keep the distances of flights in the air current
const liveFlights = () =>
  [...flights]
    .filter(([id, f]) => f.seen && id !== myFlightId)
    .map(([id]) => id)
function follow(id: number | null) {
  followId = id
  followSnap = true
  renderPlayers()
}
// Clicking someone in the air watches their flight full screen.
for (const list of document.querySelectorAll<HTMLElement>('.playingList'))
  list.addEventListener('click', (e) => {
    const id = Number(
      (e.target as HTMLElement).closest<HTMLElement>('[data-flight]')?.dataset
        .flight,
    )
    if (flights.has(id)) spectate(id)
  })
let watchedFrom: Mode = 'workshop' // where "Stop watching" goes back to
function spectate(id: number | null) {
  if (mode !== 'spectate') watchedFrom = mode
  follow(id)
  setMode('spectate')
}
$('watchLive').onclick = () => spectate(followId)
$('spectateNext').onclick = $('followNext').onclick = () => {
  const live = liveFlights()
  const at = followId === null ? -1 : live.indexOf(followId)
  follow(live[(at + 1) % live.length] ?? null)
}
$('stopWatching').onclick = () => setMode(watchedFrom)

// ---------- the lab: a clean test hall to see how a design flies on its own ----------
// No city, wind, steering or other players: the same throw from a 10 m platform every time, so designs
// can be compared run by run. Runs only in this browser.
const LAB_FLOOR_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
  #include <logdepthbuf_vertex>
}`
const LAB_FLOOR_FRAG = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uBase;
uniform vec3 uFine;
uniform vec3 uCoarse;
uniform vec3 uLine;
uniform vec3 uFog;
varying vec3 vWorld;
// 1 on a grid line of the given spacing, about px pixels wide, smoothly 0 beside it.
float lines(vec2 p, float spacing, float px) {
  vec2 c = p / spacing;
  vec2 d = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  return 1.0 - min(min(d.x, d.y) / px, 1.0);
}
void main() {
  #include <logdepthbuf_fragment>
  float dist = distance(cameraPosition.xz, vWorld.xz);
  vec3 col = uBase;
  col = mix(col, uFine, lines(vWorld.xz, 1.0, 1.0) * (1.0 - smoothstep(12.0, 45.0, dist)));
  col = mix(col, uCoarse, lines(vWorld.xz, 10.0, 1.5) * (1.0 - smoothstep(60.0, 170.0, dist)));
  float ahead = step(0.0, vWorld.x) * (1.0 - min(abs(vWorld.z) / max(1.5 * fwidth(vWorld.z), 0.03), 1.0));
  col = mix(col, uLine, ahead);
  col = mix(col, uFog, smoothstep(40.0, 200.0, dist));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`
const lab = (() => {
  const room = new THREE.Scene()
  room.background = new THREE.Color(0x0f131b)
  room.fog = new THREE.Fog(0x0f131b, 40, 200)
  room.add(new THREE.HemisphereLight(0xc8d6ff, 0x141a26, 1.5))
  const light = new THREE.DirectionalLight(0xffffff, 1.8)
  light.position.copy(sun.position)
  room.add(light)
  // The floor draws its own grid: 1 m lines, stronger every 10 m, and the red line straight ahead.
  // Lines are as wide as a pixel or two at any distance and fade out before they would shimmer.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(800, 800).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color(0x161c27) },
        uFine: { value: new THREE.Color(0x263043) },
        uCoarse: { value: new THREE.Color(0x3f4c66) },
        uLine: { value: new THREE.Color(0xff6b6b) },
        uFog: { value: new THREE.Color(0x0f131b) },
      },
      vertexShader: LAB_FLOOR_VERT,
      fragmentShader: LAB_FLOOR_FRAG,
    }),
  )
  room.add(floor)
  // Distance signs standing beside the line: always face the camera, so never upside down or smeared.
  const sign = (text: string, x: number) => {
    const c = document.createElement('canvas')
    c.width = 512
    c.height = 256
    const ctx = ctx2d(c)
    ctx.fillStyle = '#1f2738'
    ctx.strokeStyle = '#3f4c66'
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.roundRect(8, 48, 496, 160, 80)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#d6deec'
    ctx.font = '800 112px "Baloo 2", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 256, 134)
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map }))
    s.scale.set(1.6, 0.8, 1)
    s.position.set(x, 0.5, -2.5)
    room.add(s)
  }
  for (let x = 10; x <= 150; x += 10) sign(`${x} m`, x)

  // The camera circles the plane wherever it is: drag to orbit, scroll to zoom. It starts close
  // behind and to the right, a little above, so the plane fills the view and its glide angle shows.
  const START = { yaw: Math.atan2(0.9, -1.1), pitch: 0.24, dist: 1.46 },
    view = { ...START }
  const COLORS = [0xff6b6b, 0x5fa8ff, 0x4fd18b, 0xffc35c],
    KEEP = 3 // earlier runs kept as faint trails to compare against
  interface Run {
    n: number
    result: Trial
    trail: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>
    along: number[] // distance flown up to each path point, to reveal the trail as the plane goes
    color: string // its trail colour while it was the newest, kept for its card and the chart
  }
  const runs: Run[] = []
  let count = 0,
    plane: PlaneMesh | null = null,
    shadow: THREE.Mesh | null = null,
    flying: { run: Run; t: number; i: number } | null = null
  const floorAt = () => 0
  const worker = new Worker(new URL('./lab-worker.ts', import.meta.url), {
    type: 'module',
  })
  let busy = false
  function launch() {
    if (busy) return
    busy = true
    $<HTMLButtonElement>('labLaunch').disabled = true
    $('labLive').textContent = 'Simulating…'
    worker.postMessage({
      design,
      launch: {
        speed: +$<HTMLInputElement>('labSpeed').value,
        pitch: +$<HTMLInputElement>('labPitch').value,
      },
    })
  }
  worker.onmessage = ({
    data,
  }: MessageEvent<{ result?: Trial; error?: string }>) => {
    busy = false
    $<HTMLButtonElement>('labLaunch').disabled = false
    if (data.result) show(data.result)
    else
      $('labLive').textContent =
        data.error ?? 'This design could not be simulated.'
  }
  // Force arrows on the flying plane: lift, drag and weight, to one scale (weight = 25 cm).
  const arrows = (
    [
      [0x4fd18b, 'lift'],
      [0xff6b6b, 'drag'],
      [0x5fa8ff, 'weight'],
    ] as const
  ).map(([color]) => {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      0.1,
      color,
    )
    arrow.visible = false
    room.add(arrow)
    return arrow
  })
  const showForces = () => $<HTMLInputElement>('labForces').checked
  function placeArrows(pt: PathPoint | undefined, mass: number) {
    for (const a of arrows) a.visible = !!pt && showForces()
    if (!pt || !plane || !showForces()) return
    const scale = 0.25 / (mass * G),
      speed = Math.hypot(...pt.v) || 1,
      dir = new THREE.Vector3(...pt.v).divideScalar(speed),
      f = new THREE.Vector3(...pt.f),
      along = f.dot(dir),
      drag = dir.clone().multiplyScalar(along), // opposes the motion
      lift = f.clone().sub(drag)
    const set = (arrow: THREE.ArrowHelper, v: THREE.Vector3) => {
      const len = v.length() * scale
      arrow.position.copy(plane?.position ?? at)
      arrow.setDirection(v.clone().normalize())
      arrow.setLength(Math.max(len, 0.001), Math.min(0.05, len * 0.4), 0.025)
    }
    const [l, d, w] = arrows
    if (l && d && w) {
      set(l, lift)
      set(d, drag)
      set(w, new THREE.Vector3(0, -mass * G, 0))
    }
  }
  // The design itself, from the same model the physics flies.
  function facts() {
    const model = buildPlane(design),
      st = planeStats(model),
      cell = (name: string, value: string, hint: string) =>
        `<div title="${hint}"><dt>${name}</dt><dd>${value}</dd></div>`
    $('labFacts').innerHTML = [
      cell(
        'Mass',
        `${(st.mass * 1000).toFixed(1)} g`,
        'Paper used, folded layers included',
      ),
      cell('Span', `${(st.span * 100).toFixed(1)} cm`, 'Wingtip to wingtip'),
      cell(
        'Wing area',
        `${(st.area * 1e4).toFixed(0)} cm²`,
        'Area seen from above, overlapping layers counted once',
      ),
      cell(
        'Aspect ratio',
        model.aspectRatio.toFixed(2),
        'Span² ÷ area: higher means slender wings and less drag for the lift',
      ),
      cell(
        'Wing loading',
        `${((st.mass * G) / Math.max(st.area, 1e-6)).toFixed(1)} N/m²`,
        'Weight per wing area: lower glides slower and floats longer',
      ),
      cell(
        'Stability',
        `${(st.margin * 100).toFixed(1)} %`,
        'How far the centre of lift sits behind the centre of mass, as a share of the sheet length. Positive is stable; near zero it wobbles, negative it tumbles',
      ),
    ].join('')
  }
  // Height over distance for the kept runs, the newest one drawn as far as it has flown.
  function drawProfile() {
    const c = $<HTMLCanvasElement>('labProfile'),
      ctx = ctx2d(c),
      w = c.clientWidth * devicePixelRatio,
      h = c.clientHeight * devicePixelRatio,
      pad = 6 * devicePixelRatio
    c.width = w
    c.height = h
    ctx.clearRect(0, 0, w, h)
    const far = Math.max(20, ...runs.map((r) => r.result.distance)),
      top = Math.max(TRIAL.height, ...runs.map((r) => r.result.top))
    const x = (d: number) => pad + (d / far) * (w - 2 * pad),
      y = (alt: number) => h - pad - (alt / top) * (h - 2 * pad)
    ctx.strokeStyle = '#ffffff14'
    ctx.lineWidth = 1
    for (let d = 10; d < far; d += 10) {
      ctx.beginPath()
      ctx.moveTo(x(d), pad)
      ctx.lineTo(x(d), h - pad)
      ctx.stroke()
    }
    for (const r of runs) {
      const live = flying?.run === r,
        upto = live && flying ? flying.i + 1 : r.result.path.length
      ctx.strokeStyle = r.color
      ctx.globalAlpha = r === runs.at(-1) ? 1 : 0.5
      ctx.lineWidth = 2 * devicePixelRatio
      ctx.beginPath()
      r.result.path.slice(0, upto).forEach((pt, i) => {
        const d = Math.hypot(pt.p[0], pt.p[2])
        if (i) ctx.lineTo(x(d), y(pt.p[1]))
        else ctx.moveTo(x(d), y(pt.p[1]))
      })
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    $('labProfileScale').textContent =
      `${far.toFixed(0)} m wide · ${top.toFixed(0)} m high`
  }
  function readout(pt: PathPoint | undefined) {
    const t = pt && telemetry(pt),
      v = (x: number | null | undefined, unit: string, digits = 1) =>
        x === null || x === undefined ? '–' : `${x.toFixed(digits)}${unit}`
    const rows: [string, string][] = [
      ['Airspeed', v(t?.speed, ' m/s')],
      ['Sink rate', v(t?.sink, ' m/s')],
      ['Height', v(t?.height, ' m')],
      ['Distance', v(t?.distance, ' m')],
      ['Angle of attack', v(t?.aoa, '°', 0)],
      ['Pitch', v(t?.pitch, '°', 0)],
      ['Bank', v(t?.bank, '°', 0)],
      ['Lift', v(t && t.lift * 1000, ' mN', 0)],
      ['Drag', v(t && t.drag * 1000, ' mN', 0)],
      ['Lift ÷ drag', v(t?.ld, '', 1)],
    ]
    $('labTelemetry').innerHTML = rows
      .map(([k, x]) => `<div><dt>${k}</dt><dd>${x}</dd></div>`)
      .join('')
  }
  function show(result: Trial) {
    for (const r of runs) {
      r.trail.material.opacity = 0.35
      r.trail.material.color.set(0x5b6780)
    }
    while (runs.length > KEEP) disposePlane((runs.shift() as Run).trail)
    const pts = result.path.map((s) => new THREE.Vector3(...s.p)),
      segments = Math.max(1, pts.length - 1)
    const trail = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(pts),
        segments,
        0.025,
        6,
      ),
      new THREE.MeshBasicMaterial({
        color: COLORS[count % COLORS.length],
        transparent: true,
        opacity: 0.9,
      }),
    )
    trail.geometry.setDrawRange(0, 0) // revealed as the plane flies
    room.add(trail)
    const along = [0]
    for (let i = 1; i < pts.length; i++)
      along.push(
        (along[i - 1] ?? 0) +
          (pts[i] as THREE.Vector3).distanceTo(pts[i - 1] as THREE.Vector3),
      )
    const run = {
      n: ++count,
      result,
      trail,
      along,
      color: `#${trail.material.color.getHexString()}`,
    }
    runs.push(run)
    if (plane) disposePlane(plane)
    plane = planeMesh(drawnPlane(design), paintTex)
    shadow = addShadow(plane)
    room.add(plane)
    flying = { run, t: 0, i: 0 }
    renderRuns()
  }
  // Over the run after the launch: its best lift-to-drag ratio and steepest angle of attack.
  const settled = (r: Trial) => r.path.filter((pt) => pt.t > 0.5).map(telemetry)
  const bestLd = (r: Trial) => Math.max(0, ...settled(r).map((t) => t.ld ?? 0))
  const maxAoa = (r: Trial) =>
    Math.max(0, ...settled(r).map((t) => Math.abs(t.aoa)))
  // One card per run: distance and time, a small height-over-distance chart on a scale shared by
  // all the cards so they compare at a glance, and the numbers that explain the flight.
  function renderRuns() {
    const done = runs.filter((r) => flying?.run !== r),
      far = Math.max(10, ...done.map((r) => r.result.distance)),
      top = Math.max(TRIAL.height, ...done.map((r) => r.result.top))
    const W = 280,
      H = 44
    const chart = (r: Trial, color: string) => {
      const step = Math.max(1, Math.floor(r.path.length / 80)),
        pts = r.path
          .filter((_, i) => i % step === 0 || i === r.path.length - 1)
          .map(
            (pt) =>
              `${((Math.hypot(pt.p[0], pt.p[2]) / far) * W).toFixed(1)},${(H - 2 - (pt.p[1] / top) * (H - 4)).toFixed(1)}`,
          )
          .join(' ')
      return `<svg class="runChart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${H - 2}" x2="${W}" y2="${H - 2}"/><polyline points="${pts}" style="stroke:${color}"/></svg>`
    }
    const side = (z: number) =>
      Math.abs(z) < 0.05
        ? 'straight'
        : `${Math.abs(z).toFixed(1)} m ${z > 0 ? 'right' : 'left'}`
    const stat = (name: string, value: string, hint: string) =>
      `<div title="${hint}"><dt>${name}</dt><dd>${value}</dd></div>`
    const card = (run: Run, i: number, list: Run[]) => {
      const { n, result: r, color } = run
      const head = `<div class="runHead"><span class="runDot" style="background:${color}"></span><b>#${n}</b>`
      if (flying?.run === run)
        return `<li class="run live">${head}<span class="runAir">in the air…</span></div></li>`
      const before = list[i + 1] // the run before this one, if still listed
      const change =
        before && flying?.run !== before
          ? r.distance - before.result.distance
          : null
      return `<li class="run">${head}<span class="runDist">${r.distance.toFixed(1)} m</span><span class="runTime">${r.time.toFixed(1)} s</span>${
        change === null
          ? ''
          : `<span class="runChange ${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(1)} m</span>`
      }</div>${chart(r, color)}<dl class="runStats">${[
        stat(
          'Glide',
          r.glide === null ? '–' : `${r.glide.toFixed(1)} : 1`,
          'Metres forward per metre of height lost',
        ),
        stat(
          'Best lift ÷ drag',
          bestLd(r).toFixed(1),
          'Its most efficient moment in the air',
        ),
        stat(
          'Max angle of attack',
          `${maxAoa(r).toFixed(0)}°`,
          'Over about 15° the wing stalls; far beyond, it tumbles',
        ),
        stat('Drift', side(r.lateral), 'Where it ended up, sideways'),
        stat(
          'Speed',
          `${r.slowest.toFixed(1)}–${r.fastest.toFixed(1)} m/s`,
          'Slowest to fastest',
        ),
        stat(
          'Wobble',
          `${r.pitchRate.toFixed(0)}°/s`,
          'How much it pitches up and down; lower is steadier',
        ),
      ].join('')}</dl></li>`
    }
    const list = [...runs].reverse()
    $('labRuns').innerHTML =
      list.map(card).join('') ||
      '<li class="hint">No runs yet. Launch one to see how far it goes.</li>'
  }
  const at = new THREE.Vector3(),
    q = new THREE.Quaternion(),
    eye = new THREE.Vector3()
  // Play the current run back in real time; the camera keeps to the side to show the glide.
  function update(dt: number) {
    if (flying && plane && shadow) {
      const { run } = flying,
        path = run.result.path,
        segs = Math.max(1, path.length - 1)
      flying.t += dt
      while (
        flying.i < path.length - 2 &&
        (path[flying.i + 1]?.t ?? 0) <= flying.t
      )
        flying.i++
      const a = path[flying.i],
        b = path[flying.i + 1] ?? a
      if (a && b) {
        const k = Math.min(
          1,
          Math.max(0, (flying.t - a.t) / Math.max(b.t - a.t, 1e-6)),
        )
        plane.position.set(...a.p).lerp(at.set(...b.p), k)
        plane.quaternion.set(...a.q).slerp(q.set(...b.q), k)
        placeShadow(shadow, plane, floorAt)
        // The tube is split evenly by length, 6 sides of 2 triangles per segment: show what's flown.
        const total = run.along.at(-1) || 1,
          flown =
            (run.along[flying.i] ?? 0) +
            k *
              ((run.along[flying.i + 1] ?? total) - (run.along[flying.i] ?? 0))
        run.trail.geometry.setDrawRange(
          0,
          Math.ceil((flown / total) * segs) * 36,
        )
        const p = plane.position
        $('labLive').textContent =
          `${Math.hypot(p.x, p.z).toFixed(1)} m · ↑ ${p.y.toFixed(1)} m · ${flying.t.toFixed(1)} s`
        readout(k < 0.5 ? a : b)
        placeArrows(k < 0.5 ? a : b, run.result.mass)
        drawProfile()
      }
      if (flying.t >= (path.at(-1)?.t ?? 0)) {
        run.trail.geometry.setDrawRange(0, Number.POSITIVE_INFINITY)
        flying = null
        placeArrows(undefined, 0)
        renderRuns()
        drawProfile()
      }
    }
    const p = plane?.position ?? at.set(0, TRIAL.height, 0),
      flat = Math.cos(view.pitch) * view.dist
    eye.set(
      p.x + Math.cos(view.yaw) * flat,
      Math.max(0.15, p.y + Math.sin(view.pitch) * view.dist),
      p.z + Math.sin(view.yaw) * flat,
    )
    camera.position.lerp(eye, 1 - Math.exp(-dt * 12))
    camera.lookAt(p)
  }
  function orbit(dx: number, dy: number) {
    view.yaw += dx * 0.008
    view.pitch = Math.max(-1.2, Math.min(1.5, view.pitch + dy * 0.006))
  }
  function zoom(delta: number) {
    view.dist = Math.max(
      0.35,
      Math.min(40, view.dist * Math.exp(delta * 0.0015)),
    )
  }
  // Before a run, the plane waits at the launch point, tilted to the chosen angle.
  function ready() {
    if (flying) return
    if (plane) disposePlane(plane)
    plane = planeMesh(drawnPlane(design), paintTex)
    shadow = addShadow(plane)
    plane.position.set(0, TRIAL.height, 0)
    plane.quaternion.set(
      ...launchQuat(0, +$<HTMLInputElement>('labPitch').value * D2R),
    )
    room.add(plane)
    placeShadow(shadow, plane, floorAt)
  }
  function enter() {
    facts()
    readout(undefined)
    drawProfile()
    ready()
    Object.assign(view, START)
    camera.position.set(
      Math.cos(view.yaw) * Math.cos(view.pitch) * view.dist,
      TRIAL.height + Math.sin(view.pitch) * view.dist,
      Math.sin(view.yaw) * Math.cos(view.pitch) * view.dist,
    )
    renderRuns()
  }
  return { room, launch, update, enter, ready, orbit, zoom }
})()
$('labLaunch').onclick = () => lab.launch()
$('labStandard').onclick = () => {
  $<HTMLInputElement>('labSpeed').value = String(TRIAL.speed)
  $<HTMLInputElement>('labPitch').value = String(TRIAL.pitch)
  syncLabInputs()
  lab.ready()
}
function syncLabInputs() {
  $('labSpeedOut').textContent = `${$<HTMLInputElement>('labSpeed').value} m/s`
  $('labPitchOut').textContent = `${$<HTMLInputElement>('labPitch').value}°`
}
for (const id of ['labSpeed', 'labPitch'])
  $(id).addEventListener('input', () => {
    syncLabInputs()
    lab.ready()
  })
syncLabInputs()
$('toLab').onclick = () => {
  setMode('lab')
  lab.enter()
}
$('labBack').onclick = () => setMode('workshop')

// ---------- modes ----------
const PANELS = {
  start: 'start',
  workshop: 'workshop',
  aim: 'aim',
  flying: 'flightHud',
  replay: 'replayHud',
  landed: 'landed',
  explore: 'exploreHud',
  spectate: 'spectateHud',
  lab: 'labHud',
}
// What the player list says each player is doing.
const STATUS: Record<Mode, string> = {
  start: 'arriving',
  workshop: 'folding',
  aim: 'aiming',
  flying: 'flying',
  replay: 'replay',
  landed: 'results',
  explore: 'exploring',
  spectate: 'watching',
  lab: 'lab',
}
type Mode = keyof typeof PANELS
let mode: Mode = 'start'
function setMode(m: Mode) {
  mode = m
  wsSend({ t: 'status', status: STATUS[m] })
  for (const [k, id] of Object.entries(PANELS)) $(id).hidden = k !== m
  $('board').hidden =
    m === 'start' || m === 'workshop' || m === 'landed' || m === 'lab'
  preview.visible = m === 'aim'
  aimArrow.visible = m === 'aim' && aimStage === 0
  const host: HTMLElement = m === 'workshop' ? $('followView') : document.body
  if (gl.parentElement !== host) {
    host.prepend(gl)
    followSnap = true
  }
  $('inspect').hidden = m !== 'landed'
  $('labData').hidden = m !== 'lab'
  const deskHost = m === 'landed' ? $('inspectView') : deskHome
  if (deskView.parentElement !== deskHost) {
    deskHost.prepend(deskView)
    if (m !== 'landed') showOnDesk(null)
  }
  if (m === 'explore') syncExploreAngles()
}
const nameInput = $<HTMLInputElement>('name')
nameInput.value = name
$('reroll').onclick = () => {
  nameInput.value = randomName()
}
$('go').onclick = () => {
  name = nameInput.value.trim() || randomName()
  store.set('paperfold.name', name)
  wsSend({ t: 'hello', name, pid })
  freshPlane()
  setMode('workshop')
}
$('toRoof').onclick = $('retry').onclick = () => {
  aimStage = 0
  aimT = 0
  setMode('aim')
}
$('backWorkshop').onclick = () => setMode('workshop')
$('again').onclick = $('exploreBack').onclick = () => {
  freshPlane()
  setMode('workshop')
}
$('explore').onclick = () => setMode('explore')
$('watchReplay').onclick = startReplay
function endReplay() {
  stopReplay()
  if (landedRec) showLanded(landedRec)
}
$('skipReplay').onclick = endReplay
$('toCity').onclick = () => {
  camera.position.set(14, TOWER.h + 8, 14)
  camera.lookAt(0, TOWER.h - 10, 0)
  setMode('explore')
}
let landedRec: PlaneRecord | null = null
let viewRec: PlaneRecord | null = null // the plane the results camera and turntable are showing
const lookAt = new THREE.Vector3()
function showLanded(rec: PlaneRecord) {
  landedRec = rec
  $('watchReplay').hidden = recording.length < 2 // only the flight just flown in this tab
  setMode('landed')
  viewPlane(rec)
}
function viewPlane(rec: PlaneRecord) {
  viewRec = rec
  showOnDesk(rec)
  $('inspectCaption').textContent =
    rec === landedRec
      ? `Your plane · ${rec.dist} m · ${WHERE[rec.where] ?? rec.where}`
      : `${rec.name} · ${rec.dist} m · ${WHERE[rec.where] ?? rec.where}`
  $('copyDesign').hidden = rec === landedRec
  renderResults()
}
// Your rank with five planes either side, and the planes that landed closest to yours.
const RANK_STEP = 10
let rankWin: {
  id: number
  lo: number
  hi: number
  grew: string | null
} | null = null // { id, lo, hi, grew }: the slice of the leaderboard shown around your plane
function renderResults() {
  const me = landedRec
  if (!me) return
  const all = [...landedPlanes.values()]
    .map((x) => x.rec)
    .sort((a, b) => b.dist - a.dist || a.at - b.at)
  const rank = all.findIndex((r) => r.id === me.id)
  if (rank < 0) {
    // too short: the server did not keep it
    $('landedTitle').textContent = `${me.dist} m · too short to count`
    $('landedText').textContent =
      "Throws under 5 m don't stay in the city. Fold it again and give it another go!"
    $('rankList').innerHTML = $('nearList').innerHTML = ''
    $('landed').classList.add('short')
    return
  }
  $('landed').classList.remove('short')
  $('landedTitle').textContent = `${me.dist} m · #${rank + 1} of ${all.length}`
  $('landedText').textContent =
    `Your plane came to rest ${WHERE[me.where] ?? me.where} after ${me.time} s. ${landedOffline.has(me.id) ? 'It stays there in this browser.' : 'It stays there for everyone to find.'}`
  const row = (
    r: PlaneRecord,
    label: string,
    value: string,
  ) => `<li class="${r.id === me.id ? 'me' : ''}${r.id === viewRec?.id ? ' viewing' : ''}">
    <button data-view="${r.id}" aria-label="Go to ${escapeHtml(r.name)}'s plane"><span class="rank">${label}</span><span class="who">${r.id === me.id ? 'You' : escapeHtml(r.name)}</span><b>${value}</b></button></li>`
  // Five above and below to start; "Show more" widens the window one way, and the list scrolls.
  const fresh = rankWin?.id !== me.id
  if (fresh || !rankWin)
    rankWin = { id: me.id, lo: Math.max(0, rank - 5), hi: rank + 6, grew: null }
  const { lo, grew } = rankWin,
    hi = Math.min(all.length, rankWin.hi),
    list = $('rankList'),
    kept = list.scrollTop
  const more = (dir: string, n: number) =>
    `<li><button class="more" data-more="${dir}">Show ${n} more ${dir === 'up' ? 'above' : 'below'}</button></li>`
  list.innerHTML =
    (lo > 0 ? more('up', Math.min(RANK_STEP, lo)) : '') +
    all
      .slice(lo, hi)
      .map((r, i) => row(r, `#${lo + i + 1}`, `${r.dist} m`))
      .join('') +
    (hi < all.length ? more('down', Math.min(RANK_STEP, all.length - hi)) : '')
  rankWin.grew = null
  // Show what was just loaded, start centred on your plane, and otherwise stay put when others land.
  list.scrollTop =
    grew === 'up'
      ? 0
      : grew === 'down'
        ? list.scrollHeight
        : fresh
          ? (list.querySelector<HTMLElement>('.me')?.offsetTop ?? Number.NaN) -
              list.clientHeight / 2 || 0
          : kept
  const at = viewRec ?? me // nearby the plane you're looking at, yours included
  const gap = (r: PlaneRecord) => Math.hypot(r.p[0] - at.p[0], r.p[2] - at.p[2])
  const near = all
    .filter((r) => r.id !== at.id)
    .sort((a, b) => gap(a) - gap(b))
    .slice(0, 5)
  $('nearList').innerHTML =
    near.map((r) => row(r, '', `${Math.round(gap(r))} m away`)).join('') ||
    '<li class="hint">Nobody else has landed yet.</li>'
}
$('landed').addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const dir = target.closest<HTMLElement>('[data-more]')?.dataset.more
  if (dir && rankWin) {
    if (dir === 'up') rankWin.lo = Math.max(0, rankWin.lo - RANK_STEP)
    else rankWin.hi += RANK_STEP
    rankWin.grew = dir
    return renderResults()
  }
  const rec = landedPlanes.get(
    Number(target.closest<HTMLElement>('[data-view]')?.dataset.view),
  )?.rec
  if (rec) viewPlane(rec)
})
$('copyDesign').onclick = () => {
  if (!viewRec) return
  const rec = viewRec
  setMode('workshop')
  loadPlane(rec, `Loaded ${rec.name}'s ${rec.dist} m plane. Make it yours!`)
}

// ---------- input ----------
const keys = new Set<string>()
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLInputElement
  if (t.tagName === 'INPUT' && t.type !== 'range') return
  keys.add(e.code)
  if (
    ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
      e.code,
    )
  )
    e.preventDefault()
  if (e.code === 'Space' && mode === 'aim' && !e.repeat) lock()
})
window.addEventListener('keyup', (e) => keys.delete(e.code))
addEventListener('blur', () => keys.clear())
const held = (...codes: string[]) => Number(codes.some((c) => keys.has(c))) // 1 or 0, to add up axes

// Aiming goes in stages: 0 pick the direction, 1 lock the power, 2 lock the angle, 3 thrown.
let yaw = 0,
  aimStage = 0,
  aimT = 0,
  power = 0,
  pitchDeg = 0
// Drags on the city view, by pointer (mouse or each finger): 'look' turns the aim or the explore camera,
// 'steer' is a virtual stick while flying, 'move' (touch, left half of the screen) walks the explore camera.
const gl = $<HTMLCanvasElement>('gl'),
  pointers = new Map<
    number,
    {
      x0: number
      y0: number
      x: number
      y: number
      kind: string
      moved: boolean
    }
  >()
const STICK = 70 // pixels of drag for a full input
const stickAxis = (px: number) =>
  Math.round(Math.max(-1, Math.min(1, px / STICK)) * 4) / 4 // quarter steps: fewer inputs to send
const dragOf = (kind: string) =>
  [...pointers.values()].find((d) => d.kind === kind)
gl.addEventListener('pointerdown', (e) => {
  gl.setPointerCapture(e.pointerId)
  const kind =
    mode === 'flying'
      ? 'steer'
      : mode === 'explore' &&
          e.pointerType !== 'mouse' &&
          e.clientX < innerWidth / 2
        ? 'move'
        : 'look'
  pointers.set(e.pointerId, {
    x0: e.clientX,
    y0: e.clientY,
    x: e.clientX,
    y: e.clientY,
    kind,
    moved: false,
  })
  if (kind !== 'look')
    Object.assign($('stick').style, {
      left: `${e.clientX}px`,
      top: `${e.clientY}px`,
    })
  $('stick').hidden = kind === 'look'
})
gl.addEventListener('pointermove', (e) => {
  const d = pointers.get(e.pointerId)
  if (!d) return
  const mx = e.clientX - d.x,
    my = e.clientY - d.y // movementX is unreliable for touch, so track it ourselves
  d.x = e.clientX
  d.y = e.clientY
  if (Math.hypot(d.x - d.x0, d.y - d.y0) > 6) d.moved = true
  if (d.kind !== 'look') {
    const dx = Math.max(-STICK, Math.min(STICK, d.x - d.x0)),
      dy = Math.max(-STICK, Math.min(STICK, d.y - d.y0))
    $('stickKnob').style.transform = `translate(${dx}px, ${dy}px)`
    return
  }
  if (mode === 'aim' && aimStage === 0) yaw -= mx * 0.005
  if (mode === 'lab') lab.orbit(mx, my)
  if (mode === 'explore') {
    look.yaw -= mx * 0.004
    look.pitch = Math.max(-1.5, Math.min(1.5, look.pitch - my * 0.004))
  }
})
gl.addEventListener(
  'wheel',
  (e) => {
    if (mode !== 'lab') return
    e.preventDefault() // zoom the lab camera instead of scrolling the page
    lab.zoom(e.deltaY)
  },
  { passive: false },
)
function endPointer(e: PointerEvent) {
  const d = pointers.get(e.pointerId)
  pointers.delete(e.pointerId)
  if (d && d.kind !== 'look') {
    $('stick').hidden = true
    $('stickKnob').style.transform = ''
  }
  if (d && !d.moved && mode === 'aim' && e.type === 'pointerup') lock() // a tap locks
}
gl.addEventListener('pointerup', endPointer)
gl.addEventListener('pointercancel', endPointer)
function lock() {
  if (aimStage < 2) {
    aimStage++
    aimT = 0
    return
  }
  if (aimStage !== 2) return
  if (!online) {
    if (online === false) {
      aimStage = 3
      throwOffline()
    }
    return
  }
  if (ws?.readyState !== 1) return // the aim text says we're waiting for the server
  aimStage = 3
  $('aimText').textContent = 'Throwing…'
  wsSend({
    t: 'throw',
    design,
    power,
    pitch: pitchDeg,
    yaw,
    paint: paintCanvas.toDataURL('image/png'),
  })
}

const look = { yaw: 0, pitch: 0 }
function syncExploreAngles() {
  const d = camera.getWorldDirection(v1)
  look.yaw = Math.atan2(-d.x, -d.z)
  look.pitch = Math.asin(d.y)
}

// ---------- per-frame ----------
let orbit = 0
// Chase camera just behind and above a plane, looking along its flight path.
function chase(
  p: THREE.Vector3,
  vel: THREE.Vector3,
  quat: THREE.Quaternion,
  dt: number,
  snap: boolean,
) {
  const dir =
    vel.lengthSq() > 0.01
      ? v2.copy(vel).normalize()
      : v2.set(1, 0, 0).applyQuaternion(quat)
  tmp
    .copy(p)
    .addScaledVector(dir, -0.75)
    .add(v1.set(0, 0.22, 0))
  tmp.y = Math.max(tmp.y, 0.25)
  if (snap) camera.position.copy(tmp)
  else camera.position.lerp(tmp, 1 - Math.exp(-dt * 14))
  camera.lookAt(tmp.copy(p).addScaledVector(dir, 0.6))
}
// The follow camera of the workshop's live view and of spectating: chase the followed flight, move on
// to another when it lands, and circle the tower while nobody is in the air.
function watchFlight(dt: number) {
  const live = liveFlights()
  const following = followId !== null && live.includes(followId)
  if (!following && (followId !== null || live.length)) follow(live[0] ?? null)
  const f = flightOf(followId)
  if (f) {
    chase(f.mesh.position, f.v, f.mesh.quaternion, dt, followSnap)
    followSnap = false
  } else {
    const a = orbit * 0.06
    camera.position.set(Math.cos(a) * 95, 70, Math.sin(a) * 95)
    camera.lookAt(0, 25, 0)
  }
  return f
}
const tmp = new THREE.Vector3()
function update(dt: number, now: number) {
  orbit += dt
  traffic(windNow())
  updateWind(dt)
  updateClouds(dt)
  for (const t of thermals) {
    for (let i = 0; i < t.lift.length; i++) {
      t.pos[i * 3 + 1] += t.lift[i] * dt * 2
      if (t.pos[i * 3 + 1] > 80) t.pos[i * 3 + 1] = 0
    }
    t.geo.attributes.position.needsUpdate = true
  }
  updateContrails(now / 1000)
  for (const { group, label } of landedPlanes.values())
    label.visible = camera.position.distanceTo(group.position) < LABEL_RANGE
  for (const [id, f] of flights) {
    if (id === myFlightId && local) continue // drawn from the local simulation below
    if (!f.seen) continue
    const age = Math.min(0.2, (now - f.at) / 1000)
    tmp.copy(f.tp).addScaledVector(f.v, age)
    const k = 1 - Math.exp(-dt * 14)
    f.mesh.position.lerp(tmp, k)
    f.mesh.quaternion.slerp(f.tq, k)
    extendContrails(f.trails, f.mesh, now / 1000)
    placeShadow(f.shadow, f.mesh)
    const p = f.mesh.position
    f.label.visible = true
    f.label.position.set(p.x, p.y + 0.3, p.z)
    setLabelSub(f.label, `${Math.hypot(p.x, p.z).toFixed(0)} m`)
  }

  if (mode === 'start') {
    camera.position.set(
      Math.cos(orbit * 0.05) * 110,
      75,
      Math.sin(orbit * 0.05) * 110,
    )
    camera.lookAt(0, 25, 0)
  } else if (mode === 'lab') {
    lab.update(dt)
  } else if (mode === 'spectate') {
    const f = watchFlight(dt)
    $('spectateNext').hidden = liveFlights().length < 2
    if (f) {
      const p = f.mesh.position
      $('spectateName').textContent = f.info.name
      $('spectateSpeed').textContent = `${f.v.length().toFixed(1)} m/s`
      $('spectateAlt').textContent = `↑ ${p.y.toFixed(1)} m`
      $('spectateDist').textContent = `→ ${Math.hypot(p.x, p.z).toFixed(0)} m`
    } else {
      $('spectateName').textContent = 'nobody yet. Waiting for a throw…'
      for (const id of ['spectateSpeed', 'spectateAlt', 'spectateDist'])
        $(id).textContent = ''
    }
  } else if (mode === 'workshop') {
    const f = watchFlight(dt)
    $('followNext').hidden = liveFlights().length < 2
    if (f) {
      const p = f.mesh.position
      $('followLabel').hidden = false
      $('followLabel').textContent =
        `${f.info.name} · ${Math.hypot(p.x, p.z).toFixed(0)} m out · ${p.y.toFixed(0)} m up`
    } else $('followLabel').hidden = true // just the tower view until someone throws
  } else if (mode === 'aim') {
    if (aimStage === 0)
      yaw += (held('KeyA', 'ArrowLeft') - held('KeyD', 'ArrowRight')) * dt * 1.2
    else if (aimStage < 3) {
      aimT += dt
      const osc = (aimT * 0.9) % 2,
        tri = osc < 1 ? osc : 2 - osc
      if (aimStage === 1) power = tri
      else pitchDeg = -20 + tri * 55
    }
    // Compass: 0° is the way the tower first faces, growing clockwise seen from above.
    const heading = ((((-yaw * 180) / Math.PI) % 360) + 360) % 360
    $('dirNeedle').style.transform = `rotate(${heading}deg)`
    $('dirVal').textContent = `${Math.round(heading)}°`
    $('powerBar').style.width = aimStage >= 1 ? `${power * 100}%` : '0%'
    $('angleBar').style.width =
      aimStage >= 2 ? `${((pitchDeg + 20) / 55) * 100}%` : '0%'
    $('angleVal').textContent = aimStage >= 2 ? `${Math.round(pitchDeg)}°` : ''
    for (const [i, id] of ['dirRow', 'powerRow', 'angleRow'].entries())
      $(id).classList.toggle('active', i === aimStage)
    aimArrow.visible = aimStage === 0
    if (aimStage === 0)
      $('aimText').textContent = COARSE
        ? 'Drag to pick a direction, then tap to lock it.'
        : 'Pick a direction: drag, A / D or ← / →. Click or Space to lock it.'
    else if (aimStage === 1) $('aimText').textContent = 'Now lock the power.'
    else if (aimStage === 2)
      $('aimText').textContent =
        online === false || ws?.readyState === 1
          ? 'Now lock the throw angle.'
          : 'Connecting to the server…'
    const sp = spawnPoint(yaw),
      fwd = [Math.cos(yaw), 0, -Math.sin(yaw)]
    preview.position.set(...sp)
    preview.quaternion.set(
      ...launchQuat(yaw, (aimStage >= 2 ? pitchDeg : 0) * D2R),
    )
    aimArrow.position.set(sp[0], sp[1] - 0.25, sp[2])
    aimArrow.rotation.y = yaw
    camera.position.set(
      sp[0] - fwd[0] * 0.75,
      sp[1] + 0.22,
      sp[2] - fwd[2] * 0.75,
    )
    camera.lookAt(sp[0] + fwd[0] * 6, sp[1] - 0.6, sp[2] + fwd[2] * 6)
  } else if (mode === 'flying') {
    const f = flightOf(myFlightId)
    const steer = [
      (held('KeyS', 'ArrowDown') - held('KeyW', 'ArrowUp')) *
        (invertPitch ? -1 : 1),
      held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft'),
    ]
    const stick = dragOf('steer')
    if (stick) {
      steer[0] = stickAxis(stick.y - stick.y0)
      steer[1] = stickAxis(stick.x - stick.x0)
    } // drag down pulls up
    if (local) {
      stepLocal(now, steer)
      if (
        online === false &&
        (local.pred.sim.landing ||
          local.pred.sim.n * DT > MAX_FLIGHT_S ||
          !local.pred.sim.s.p.every(Number.isFinite))
      )
        return landOffline()
      if (f) {
        const sim = local.pred.sim
        f.mesh.visible = f.seen = true
        f.mesh.position.set(...sim.s.p)
        f.mesh.quaternion.set(...sim.s.q)
        f.v.set(...sim.s.v)
        if (sim.steer[0] !== f.steer[0] || sim.steer[1] !== f.steer[1]) {
          f.steer = sim.steer
          setPlaneGeometry(f.mesh, drawnPlane(f.info.design, sim.steer))
        }
        extendContrails(f.trails, f.mesh, now / 1000)
        placeShadow(f.shadow, f.mesh)
        recording.push({ t: sim.n * DT, p: [...sim.s.p], q: [...sim.s.q] })
      }
    }
    if (f?.seen) {
      const p = f.mesh.position
      chase(p, f.v, f.mesh.quaternion, dt, false)
      $('hudSpeed').textContent = `${f.v.length().toFixed(1)} m/s`
      $('hudAlt').textContent = `↑ ${p.y.toFixed(1)} m`
      $('hudDist').textContent = `→ ${Math.hypot(p.x, p.z).toFixed(0)} m`
      if (local)
        $('hudTime').textContent = `${(local.pred.sim.n * DT).toFixed(0)} s`
      $('thermal').hidden = windAt([p.x, p.y, p.z])[1] < 0.4
      const g = gustAt([p.x, p.y, p.z], windNow())
      $('windy').hidden = Math.hypot(g[0], g[2]) < 1
    }
  } else if (mode === 'replay') {
    if (!stepReplay(dt)) endReplay()
  } else if (mode === 'landed' && viewRec) {
    const [x, y, z] = viewRec.p,
      a = orbit * 0.3,
      k = 1 - Math.exp(-dt * 2.5) // glide over, then circle
    camera.position.lerp(
      tmp.set(x + Math.cos(a) * 1.3, y + 0.7, z + Math.sin(a) * 1.3),
      k,
    )
    lookAt.lerp(tmp.set(x, y, z), k)
    camera.lookAt(lookAt)
  } else if (mode === 'explore') {
    camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ')
    const speed = (held('ShiftLeft', 'ShiftRight') ? 60 : 15) * dt
    camera.getWorldDirection(v1)
    v2.crossVectors(v1, camera.up).normalize()
    const mv = dragOf('move'),
      fwd = mv ? -stickAxis(mv.y - mv.y0) : 0,
      strafe = mv ? stickAxis(mv.x - mv.x0) : 0
    camera.position.addScaledVector(
      v1,
      (held('KeyW', 'ArrowUp') - held('KeyS', 'ArrowDown') + fwd) * speed,
    )
    camera.position.addScaledVector(
      v2,
      (held('KeyD', 'ArrowRight') - held('KeyA', 'ArrowLeft') + strafe) * speed,
    )
    camera.position.y = Math.max(
      0.3,
      camera.position.y + (held('KeyE') - held('KeyQ')) * speed,
    )
  }
}

// Which point the camera is watching right now, if any: the free-flying explore camera sees everything solid.
function focusPoint() {
  if (mode === 'flying') {
    const f = flightOf(myFlightId)
    return f?.seen ? f.mesh.position : null
  }
  if (mode === 'replay') return replay?.mesh.position ?? null
  if (mode === 'workshop' || mode === 'spectate')
    return flightOf(followId)?.mesh.position ?? null
  if (mode === 'landed' && viewRec)
    return landedPlanes.get(viewRec.id)?.group.position ?? tmp.set(...viewRec.p)
  if (mode === 'aim') return preview.position
  return null
}
// Does the segment a -> b pass through solid box s (ground up to s.y1)? Slab test over t in [0, 1).
function blocks(a: THREE.Vector3, d: THREE.Vector3, s: Solid) {
  let lo = 0,
    hi = 0.97 // stop just short of the plane, so things behind it stay solid
  for (const [o, dir, min, max] of [
    [a.x, d.x, s.x0, s.x1],
    [a.y, d.y, 0, s.y1],
    [a.z, d.z, s.z0, s.z1],
  ]) {
    if (Math.abs(dir) < 1e-9) {
      if (o < min || o > max) return false
      continue
    }
    let t0 = (min - o) / dir,
      t1 = (max - o) / dir
    if (t0 > t1) [t0, t1] = [t1, t0]
    lo = Math.max(lo, t0)
    hi = Math.min(hi, t1)
    if (lo > hi) return false
  }
  return true
}
const ditherTarget = new Uint8Array(CITY.solids.length),
  rayD = new THREE.Vector3(),
  camRight = new THREE.Vector3(),
  camUp = new THREE.Vector3()
// Fade whatever covers the plane's silhouette: rays to its centre and to points DITHER_R around it.
function updateDither(dt: number) {
  ditherTarget.fill(0)
  const focus = focusPoint()
  if (focus) {
    camera.updateMatrixWorld()
    camRight.setFromMatrixColumn(camera.matrixWorld, 0)
    camUp.setFromMatrixColumn(camera.matrixWorld, 1)
    for (const [r, u] of [
      [0, 0],
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      rayD
        .copy(focus)
        .addScaledVector(camRight, r * DITHER_R)
        .addScaledVector(camUp, u * DITHER_R)
        .sub(camera.position)
      CITY.solids.forEach((s, i) => {
        if (!ditherTarget[i] && blocks(camera.position, rayD, s))
          ditherTarget[i] = 1
      })
    }
  }
  let changed = false
  for (let i = 0; i < solidVis.length; i++) {
    const goal = ditherTarget[i] ? FADED : 1,
      v = solidVis[i]
    if (v === goal) continue
    solidVis[i] =
      v < goal ? Math.min(goal, v + dt * 3) : Math.max(goal, v - dt * 3)
    changed = true
  }
  if (changed) for (const sync of ditherSync) sync()
}

const clock = new THREE.Clock()
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1)
  const c = renderer.domElement,
    pr = renderer.getPixelRatio()
  if (
    c.width !== Math.floor(c.clientWidth * pr) ||
    c.height !== Math.floor(c.clientHeight * pr)
  )
    resize()
  update(dt, performance.now())
  updateDither(dt)
  if (mode === 'workshop' || mode === 'landed') renderDesk(dt)
  renderer.render(mode === 'lab' ? lab.room : scene, camera) // full screen in game, the follow cam in the workshop
})
setMode('start')
// Name tags are drawn on canvases, so load the game font first (never block for long).
Promise.race([
  document.fonts.load('700 34px "Baloo 2"'),
  new Promise((r) => setTimeout(r, 1500)),
]).finally(connect)
