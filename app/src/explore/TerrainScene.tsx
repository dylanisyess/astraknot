// 3D terrain scene for Explore (lazy-loaded; the only module that imports three.js).
//
// What this component may and may not do:
// - It draws the exported LOLA mesh, the authoritative 0.1° skyline profile, the fixed
//   modeled observer and Sun/Earth directions taken from the shared selected-time status.
// - It never computes visibility. Labels and styles come from `status` (status.ts). No
//   raycast, depth test, shadow or camera position changes any label or metric.
// - The camera is separate from the observer: the observer is always the origin (the
//   exported observer point); the eye view only rotates and changes FOV.
// - Lighting is a fixed illustrative light, not the modeled Sun.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import type { BodyStatus, SelectedStatus } from "../status";
import type { HorizonMode, SiteData } from "../types";
import { type Vec3, azDelta, directionFromAzEl, gridIndices, needsFlip, obliqueCamera, profileMask, smoothNormals, stitchNormals } from "./geometry";
import { type TerrainAsset, type TerrainAssetMeta, loadTerrainAsset, terrainMatchesSite } from "./terrainAsset";
import { MARKER_TEXT, markerState } from "./availability";
import { edgePoint } from "./geometry";
import { EXCEED_COLOR, OVERLAY_ALPHA, SLOPE_STOPS, type SlopeAsset, type TerrainLayer, hexRgb, overlayMode, thresholdCentideg } from "./slope";

export type CameraMode = "overview" | "eye";
export interface CameraCommand {
  /** "frame": overview framing of the 500 m assessed area (never sent by an overlay change). */
  kind: "reset" | "sun" | "earth" | "frame";
  n: number;
  /** Optional field of view for "look toward" in the observer view (deg). */
  fov?: number;
}
export type AssetState =
  | { state: "loading"; siteId: string }
  | { state: "ready"; siteId: string; meta: TerrainAssetMeta }
  | { state: "error"; siteId: string; message: string };

export interface SceneProps {
  site: SiteData;
  siteShort: string;
  mode: HorizonMode;
  status: SelectedStatus;
  camera: CameraMode;
  command: CameraCommand | null;
  /** Azimuth the default views face (the site's panorama centre, near its Earth direction). */
  lookAz: number;
  /** Default overview distance from the observer (m). */
  overviewDist: number;
  reducedMotion: boolean;
  onAssetState: (s: AssetState) => void;
  onFatal: (message: string) => void;
  onLook: (body: "sun" | "earth") => void;
  /** 5C terrain layer (Site overview only; the Horizon view keeps its presentation). */
  layer?: TerrainLayer;
  /** Screening asset of this site, or null while it is not loaded (Surface is drawn). */
  slope?: SlopeAsset | null;
  thresholdDeg?: number;
  /** Terrain inspection point (renderer frame), or null. Never the modeled observer. */
  inspection?: Vec3 | null;
  /** Clicking terrain in the overview reports the hit point here (only when enabled). */
  onInspect?: (p: Vec3) => void;
  inspectEnabled?: boolean;
  /** Ground-distance rings and the analysis boundary. */
  showRings?: boolean;
  /** Changes when HTML controls over the stage change size, so label layout is redone. */
  layoutKey?: string;
}

// GLSL for the 5C terrain layers (injected into the terrain's MeshStandardMaterial).
// The quantitative colors are applied AFTER lighting, tone mapping and the sRGB conversion,
// so a cell's color is the legend's sRGB color (at OVERLAY_ALPHA over the shaded surface)
// whatever the illustrative light does. Each DEM cell is one flat color (nearest cell).
const NS = SLOPE_STOPS.length;
const SLOPE_FRAG_HEAD = `
varying vec3 vSlopeLocal;
uniform int uSlopeMode; uniform sampler2D uSlopeTex; uniform vec3 uSlopeA; uniform vec3 uSlopeB; uniform vec2 uSlopeSize;
uniform float uThrC; uniform vec3 uStops[${NS}]; uniform float uStopDeg[${NS}]; uniform vec3 uExceed;
uniform float uRings; uniform float uRObs;
vec3 slopeRamp(float d) {
  d = clamp(d, uStopDeg[0], uStopDeg[${NS - 1}]);
  vec3 c = uStops[0];
  for (int k = 1; k < ${NS}; k++) {
    if (d >= uStopDeg[k - 1]) c = mix(uStops[k - 1], uStops[k], clamp((d - uStopDeg[k - 1]) / (uStopDeg[k] - uStopDeg[k - 1]), 0.0, 1.0));
  }
  return c;
}`;
// Texture values: 0.01 deg; -100 no data (in the footprint); -200 outside the footprint.
// The display is clipped to the exact 500 m ring (a smooth, restrained boundary). Cells are
// still assigned by their centre (pipeline/slope.py); a cell straddling the ring shows its
// value only inside the ring, and a centre-outside sliver inside the ring stays "not assessed".
const SLOPE_FRAG_FINAL = `
{
  vec2 cf = vec2(uSlopeA.x + uSlopeA.y * vSlopeLocal.x + uSlopeA.z * vSlopeLocal.z, uSlopeB.x + uSlopeB.y * vSlopeLocal.x + uSlopeB.z * vSlopeLocal.z);
  // ground distance on the 1737.4 km sphere from the observer's vertical (the footprint's definition)
  float gd = 1737400.0 * atan(length(vSlopeLocal.xz), uRObs + vSlopeLocal.y);
  float gw = fwidth(gd);
  if (uSlopeMode > 0) {
    vec2 cell = floor(cf + 0.5);
    float v = -200.0;
    if (cell.x >= 0.0 && cell.y >= 0.0 && cell.x < uSlopeSize.x && cell.y < uSlopeSize.y) v = texture2D(uSlopeTex, (cell + 0.5) / uSlopeSize).r;
    if (v < -150.0 || gd > 500.0) {
      gl_FragColor.rgb *= 0.6;   // outside the assessed area: dimmed, not assessed
    } else if (v < -50.0) {
      gl_FragColor.rgb = mix(vec3(0.03), vec3(0.18), step(0.5, fract((vSlopeLocal.x + vSlopeLocal.z) / 8.0)));  // no slope data
    } else if (uSlopeMode == 1) {
      // one flat color per 20 m cell (no borders, no interpolation between cells)
      gl_FragColor.rgb = mix(gl_FragColor.rgb, slopeRamp(v / 100.0), ${OVERLAY_ALPHA.toFixed(2)});
    } else if (v > uThrC) {
      gl_FragColor.rgb = mix(gl_FragColor.rgb, uExceed, ${OVERLAY_ALPHA.toFixed(2)});
    }
  }
  if (uRings > 0.5) {
    // drawn into the surface itself: exactly draped, no z-fighting, no protrusion
    float a500 = 1.0 - smoothstep(0.5, 1.4, abs(gd - 500.0) / max(gw, 1e-4));
    float dash = step(0.5, fract(atan(vSlopeLocal.x, -vSlopeLocal.z) * gd / 14.0));
    float a250 = (1.0 - smoothstep(0.3, 1.0, abs(gd - 250.0) / max(gw, 1e-4))) * dash;
    float a100 = (1.0 - smoothstep(0.3, 1.0, abs(gd - 100.0) / max(gw, 1e-4))) * dash;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95), max(0.7 * a500, 0.35 * max(a250, a100)));
  }
}`;

// Nominal angular diameters (SPEC.md): the dataset holds no diameters.
export const SUN_DIAMETER_DEG = 0.53;
export const EARTH_DIAMETER_DEG = 1.9;
/** Shading normals are averaged over about this distance (m); geometry is untouched. */
export const SHADE_SMOOTH_M = 10;
const SKY_R = 90_000; // where sky annotations are placed (beyond every meshed vertex)
const CURTAIN_R = 80_000;
const RAY_LEN = 0.3; // overview ray length as a fraction of the camera distance
/** Default overview camera elevation: low enough that the true horizon is inside the 50° frame. */
export const OVERVIEW_ELEV_DEG = 16;
/** "Frame assessed area": the whole 500 m footprint (a user action only; overlays never move the camera). */
export const TERRAIN_ELEV_DEG = 42;
export const TERRAIN_DIST_M = 1650;
const COLORS = {
  sun: 0xf2b441,
  earth: 0x6ea8f0,
  terrain: 0x8f8d87,
  terrainSmooth: 0x6c6b67,
  curtain: 0x4b4a47,
  curtainSmooth: 0x353432,
  skyline: 0xeeece6,
  ref: 0x8f8d86,
  marker: 0xf4f3ef,
};
const ILLUSTRATIVE_LIGHT_DIR = directionFromAzEl(250, 20); // fixed, NOT the modeled Sun

interface EyePose { yaw: number; pitch: number; fov: number }

function eyeDefault(lookAz: number): EyePose {
  return { yaw: lookAz, pitch: 1, fov: 45 };
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function makeLine(points: Vec3[], color: number, width: number, opts: { dashed?: boolean; depthTest?: boolean; opacity?: number; dash?: [number, number] } = {}) {
  const g = new LineGeometry();
  g.setPositions(points.flat());
  const m = new LineMaterial({
    color,
    linewidth: width,
    dashed: !!opts.dashed,
    dashSize: opts.dash?.[0] ?? 1,
    gapSize: opts.dash?.[1] ?? 1,
    transparent: opts.opacity !== undefined && opts.opacity < 1,
    opacity: opts.opacity ?? 1,
    depthTest: opts.depthTest ?? true,
    depthWrite: false,
  });
  const l = new Line2(g, m);
  l.computeLineDistances();
  return l;
}

export default function TerrainScene(props: SceneProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const api = useRef<{
    render: () => void;
    setSite: (site: SiteData) => void;
    update: () => void;
    setCamera: (mode: CameraMode, animate: boolean) => void;
    command: (c: CameraCommand) => void;
    setSlope: (a: SlopeAsset | null) => void;
  } | null>(null);
  const [lost, setLost] = useState(false);

  // ---------------------------------------------------------------- one-time setup
  useEffect(() => {
    const host = hostRef.current!;
    const labelHost = labelsRef.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, stencil: true, powerPreference: "high-performance" });
    } catch (e) {
      propsRef.current.onFatal(`WebGL could not be started (${e instanceof Error ? e.message : String(e)}).`);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 1);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    const canvas = renderer.domElement;
    canvas.className = "scene-canvas";
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    host.prepend(canvas);

    const scene = new THREE.Scene();
    const overviewCam = new THREE.PerspectiveCamera(50, 1, 0.5, 600_000);
    const eyeCam = new THREE.PerspectiveCamera(62, 1, 0.05, 600_000);
    eyeCam.rotation.order = "YXZ";
    let activeCam: THREE.PerspectiveCamera = overviewCam;
    let camMode: CameraMode = "overview";

    // Illustrative lighting: one fixed key light and a soft fill. Not the modeled Sun.
    const key = new THREE.DirectionalLight(0xffffff, 2.3);
    key.position.set(...ILLUSTRATIVE_LIGHT_DIR);
    const fill = new THREE.HemisphereLight(0xc9ccd1, 0x1d1d1c, 0.42);
    scene.add(key, fill);

    const terrainMat = new THREE.MeshStandardMaterial({ color: COLORS.terrain, roughness: 1, metalness: 0 });
    // Observer view: the mesh is drawn only inside the profile mask (stencil == 1), so the
    // displayed horizon is the exported profile. Overview: no stencil test (the real mesh).
    terrainMat.stencilFunc = THREE.EqualStencilFunc;
    terrainMat.stencilRef = 1;
    terrainMat.stencilZPass = THREE.KeepStencilOp;
    // 5C terrain layers: slope / exceedance colors from the screening asset's DEM cells, mixed
    // into the diffuse color so the display lighting still shows the terrain's shape.
    // Site overview only; nothing here drives a status, a metric or the observer.
    const blank = new THREE.DataTexture(new Float32Array([-200]), 1, 1, THREE.RedFormat, THREE.FloatType);
    blank.needsUpdate = true;
    const SU = {
      uSlopeMode: { value: 0 },
      uSlopeTex: { value: blank as THREE.Texture },
      uSlopeA: { value: new THREE.Vector3() },
      uSlopeB: { value: new THREE.Vector3() },
      uSlopeSize: { value: new THREE.Vector2(1, 1) },
      uThrC: { value: 1500 },
      uStops: { value: SLOPE_STOPS.map((x) => new THREE.Vector3(...hexRgb(x.color))) },
      uStopDeg: { value: SLOPE_STOPS.map((x) => x.deg) },
      uExceed: { value: new THREE.Vector3(...hexRgb(EXCEED_COLOR)) }, // sRGB: applied after the color-space conversion
      uRings: { value: 0 },
      uRObs: { value: 1737400 },
    };
    terrainMat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, SU);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vSlopeLocal;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvSlopeLocal = position;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\n" + SLOPE_FRAG_HEAD)
        .replace("#include <colorspace_fragment>", "#include <colorspace_fragment>\n" + SLOPE_FRAG_FINAL);
    };
    terrainMat.customProgramCacheKey = () => "terrain-slope-2";
    const terrain = new THREE.Group();
    // No group renderOrder: three.js sorts by a group's order before an object's, which would
    // force the whole terrain after (or before) every sky object. Order is set per mesh instead.
    scene.add(terrain);
    let edgeLine: Line2 | null = null;
    let asset: TerrainAsset | null = null;

    // Overview annotations
    const overview = new THREE.Group();
    scene.add(overview);
    const ringGeo = new THREE.RingGeometry(0.72, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    const obsRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: COLORS.marker, depthTest: false, transparent: true, opacity: 0.95 }));
    obsRing.renderOrder = 20;
    const pin = makeLine([[0, 0, 0], [0, 1, 0]], COLORS.marker, 2, { depthTest: false });
    pin.renderOrder = 20;
    const north = makeLine([[0, 0, 0], [0, 0, -1]], COLORS.marker, 1.5, { depthTest: false, opacity: 0.75 });
    north.renderOrder = 20;
    // unit rays along +z; Object3D.lookAt turns +z toward the body direction
    const rays = {
      sun: makeLine([[0, 0, 0], [0, 0, 1]], COLORS.sun, 3, { depthTest: false, dash: [0.05, 0.035] }),
      earth: makeLine([[0, 0, 0], [0, 0, 1]], COLORS.earth, 3, { depthTest: false, dash: [0.05, 0.035] }),
    };
    rays.sun.renderOrder = rays.earth.renderOrder = 21;
    const refPlane = new THREE.Mesh(
      new THREE.CircleGeometry(1, 128).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xdcdad3, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
    );
    refPlane.renderOrder = 4;
    // terrain inspection point: a dashed pin, unlike the observer's solid pin
    const inspPin = makeLine([[0, 0, 0], [0, 1, 0]], 0xffffff, 1.6, { depthTest: false, dashed: true, dash: [0.12, 0.08] });
    inspPin.renderOrder = 22;
    overview.add(obsRing, pin, north, rays.sun, rays.earth, refPlane, inspPin);
    let slopeAsset: SlopeAsset | null = null;
    let ringsOn = false;
    const setSlope = (a: SlopeAsset | null) => {
      const prev = SU.uSlopeTex.value;
      if (prev !== blank) prev.dispose();
      SU.uSlopeTex.value = blank;
      slopeAsset = a;
      if (a) {
        const g = a.grid;
        const data = new Float32Array(g.nx * g.ny);
        for (let k = 0; k < data.length; k++) data[k] = g.state[k] === 1 ? (g.slope_centideg[k] as number) : g.state[k] === 2 ? -100 : -200;
        const tex = new THREE.DataTexture(data, g.nx, g.ny, THREE.RedFormat, THREE.FloatType);
        tex.minFilter = tex.magFilter = THREE.NearestFilter;
        tex.needsUpdate = true;
        SU.uSlopeTex.value = tex;
        SU.uSlopeA.value.set(...g.local_to_cell.a);
        SU.uSlopeB.value.set(...g.local_to_cell.b);
        SU.uSlopeSize.value.set(g.nx, g.ny);
        SU.uRObs.value = a.observer.observer_radius_m;
      }
      resize();
    };

    // Eye-view sky annotations (drawn by direction only; distance is irrelevant)
    const sky = new THREE.Group();
    scene.add(sky);
    // Restrained disk textures: symmetric limb shading; Earth gets a generic graticule.
    // No continents, clouds, orientation or phase are modeled.
    const diskTexture = (kind: "sun" | "earth") => {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const g = c.getContext("2d");
      if (!g) return null;
      const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      if (kind === "sun") {
        grad.addColorStop(0, "#ffe2a3");
        grad.addColorStop(0.75, "#f6bb4e");
        grad.addColorStop(1, "#e59a2c");
      } else {
        grad.addColorStop(0, "#7fb4f2");
        grad.addColorStop(0.8, "#5d97e6");
        grad.addColorStop(1, "#3f72bd");
      }
      g.fillStyle = grad;
      g.fillRect(0, 0, 256, 256);
      if (kind === "earth") {
        g.strokeStyle = "rgba(255,255,255,0.22)";
        g.lineWidth = 3;
        for (const f of [0.38, 0.7]) {
          g.beginPath();
          g.ellipse(128, 128, 128 * f, 128, 0, 0, Math.PI * 2);
          g.stroke();
          g.beginPath();
          g.ellipse(128, 128, 128, 128 * f, 0, 0, Math.PI * 2);
          g.stroke();
        }
        g.beginPath();
        g.moveTo(128, 0);
        g.lineTo(128, 256);
        g.moveTo(0, 128);
        g.lineTo(256, 128);
        g.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    };
    const disk = (color: number, diamDeg: number) => {
      const r = SKY_R * Math.tan((diamDeg / 2) * (Math.PI / 180));
      const map = diskTexture(color === COLORS.sun ? "sun" : "earth");
      const mat = new THREE.MeshBasicMaterial({ color: map ? 0xffffff : color, map, depthTest: false, depthWrite: false, toneMapped: false });
      // drawn only outside the profile mask (stencil != 1) in Terrain mode; see updateAnnotations
      mat.stencilFunc = THREE.NotEqualStencilFunc;
      mat.stencilRef = 1;
      mat.stencilZPass = THREE.KeepStencilOp;
      return new THREE.Mesh(new THREE.CircleGeometry(r, 96), mat);
    };
    const disks = { sun: disk(COLORS.sun, SUN_DIAMETER_DEG), earth: disk(COLORS.earth, EARTH_DIAMETER_DEG) };
    let curtain: THREE.Mesh | null = null;
    let skyline: Line2 | null = null;
    const zeroPts: Vec3[] = [];
    for (let k = 0; k <= 720; k++) zeroPts.push(directionFromAzEl(k * 0.5, 0).map((c) => c * CURTAIN_R) as Vec3);
    const zeroLine = makeLine(zeroPts, COLORS.ref, 1, { depthTest: false, dashed: true, dash: [900, 700], opacity: 0.8 });
    sky.add(disks.sun, disks.earth, zeroLine);

    const lineMats = (): LineMaterial[] => {
      const out: LineMaterial[] = [];
      scene.traverse((o) => {
        if (o instanceof Line2) out.push(o.material as LineMaterial);
      });
      return out;
    };

    // ---------------------------------------------------------------- HTML overlay labels
    const mk = (cls: string, html = "") => {
      const d = document.createElement("div");
      d.className = `scene-label ${cls}`;
      d.innerHTML = html;
      d.style.display = "none";
      labelHost.appendChild(d);
      return d;
    };
    // edge indicators for off-screen bodies: one button per body (its own name and action)
    function chip(b: "sun" | "earth") {
      const d = document.createElement("button");
      d.type = "button";
      d.className = `scene-label lbl-off lbl-${b}`;
      d.dataset.body = b;
      d.style.display = "none";
      d.addEventListener("click", () => propsRef.current.onLook(b));
      labelHost.appendChild(d);
      return d;
    }
    const lab = {
      observer: mk("lbl-observer"),
      north: mk("lbl-north", "N"),
      sun: mk("lbl-body lbl-sun"),
      earth: mk("lbl-body lbl-earth"),
      edge: mk("lbl-edge"),
      skyline: mk("lbl-skyline"),
      zero: mk("lbl-zero"),
      offSun: chip("sun"),
      offEarth: chip("earth"),
      inspect: mk("lbl-inspect", '<span class="insp-mark" aria-hidden="true"></span><span class="lbl-name">Terrain inspection point</span>'),
    };
    const ringLabels = [100, 250, 500].map((r) => ({ r, el: mk("lbl-ring", r === 500 ? "500 m · analysis area" : `${r} m`) }));
    const cardinals = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"].map((t, k) => ({ az: k * 45, el: mk(k % 2 ? "lbl-card minor" : "lbl-card", t) }));
    const hits = (["sun", "earth"] as const).map((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `scene-hit hit-${b}`;
      btn.style.display = "none";
      btn.addEventListener("click", () => propsRef.current.onLook(b));
      labelHost.appendChild(btn);
      return { b, btn };
    });

    // Overview body markers: enlarged directional annotations, not angular sizes. Placed at
    // the direction's vanishing point (camera position + direction x 200 km), so they never
    // shift against nearby terrain when the camera moves. Styled from the interval status.
    const GLOBE =
      '<svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14.5" class="g-body"/>' +
      '<ellipse cx="16" cy="16" rx="6" ry="14.5" class="g-line"/><ellipse cx="16" cy="16" rx="14.5" ry="5.5" class="g-line"/>' +
      '<path d="M16 1.5v29M1.5 16h29" class="g-line"/></svg>';
    const markers = (["sun", "earth"] as const).map((b) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `ov-marker mk-${b}`;
      btn.dataset.marker = b;
      btn.innerHTML = b === "sun" ? '<span class="mk-disk" aria-hidden="true"></span>' : GLOBE;
      btn.style.display = "none";
      btn.addEventListener("click", () => propsRef.current.onLook(b));
      labelHost.appendChild(btn);
      return { b, btn };
    });
    const v3 = new THREE.Vector3();
    const place = (el: HTMLElement, p: Vec3, w: number, h: number, cam: THREE.Camera): { x: number; y: number } | null => {
      v3.set(p[0], p[1], p[2]).project(cam);
      if (v3.z > 1 || v3.z < -1 || Math.abs(v3.x) > 1.4 || Math.abs(v3.y) > 1.4) {
        el.style.display = "none";
        return null;
      }
      const x = (v3.x * 0.5 + 0.5) * w;
      const y = (-v3.y * 0.5 + 0.5) * h;
      el.style.display = "";
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      return { x, y };
    };
    const screen = (p: Vec3, w: number, h: number, cam: THREE.Camera) => {
      v3.set(p[0], p[1], p[2]).project(cam);
      return { x: (v3.x * 0.5 + 0.5) * w, y: (-v3.y * 0.5 + 0.5) * h, front: v3.z <= 1 && v3.z >= -1 };
    };

    // ---------------------------------------------------------------- controls
    const controls = new OrbitControls(overviewCam, canvas);
    controls.enableDamping = false;
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = THREE.MathUtils.degToRad(86);
    controls.minDistance = 25;
    controls.target.set(0, 0, 0);
    controls.addEventListener("change", () => requestRender());
    let eye: EyePose = eyeDefault(propsRef.current.lookAz);
    const applyEye = () => {
      eyeCam.position.set(0, 0, 0); // the modeled observer; never moved
      eyeCam.rotation.set(THREE.MathUtils.degToRad(eye.pitch), THREE.MathUtils.degToRad(-eye.yaw), 0, "YXZ");
      eyeCam.fov = eye.fov;
      eyeCam.updateProjectionMatrix();
    };
    applyEye();

    let drag: { x: number; y: number; id: number } | null = null;
    // click (not drag) on terrain in the overview -> terrain inspection point
    let press: { x: number; y: number; t: number } | null = null;
    const raycaster = new THREE.Raycaster();
    const onClickUp = (e: PointerEvent) => {
      const p0 = press;
      press = null;
      const pr = propsRef.current;
      if (!p0 || camMode !== "overview" || !pr.inspectEnabled || !pr.onInspect || !asset) return;
      if (Math.hypot(e.clientX - p0.x, e.clientY - p0.y) > 5 || performance.now() - p0.t > 700) return;
      const r = canvas.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), overviewCam);
      const t0 = performance.now();
      const hit = raycaster.intersectObjects(terrain.children, false)[0];
      canvas.dataset.pickMs = (performance.now() - t0).toFixed(1);
      if (hit) pr.onInspect([hit.point.x, hit.point.y, hit.point.z]);
    };
    canvas.addEventListener("pointerup", onClickUp);
    const onDown = (e: PointerEvent) => {
      press = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (camMode !== "eye") return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || camMode !== "eye" || e.pointerId !== drag.id) return;
      const k = eye.fov / Math.max(1, canvas.clientHeight);
      eye.yaw = (((eye.yaw - (e.clientX - drag.x) * k) % 360) + 360) % 360;
      eye.pitch = THREE.MathUtils.clamp(eye.pitch + (e.clientY - drag.y) * k, -85, 85);
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      applyEye();
      requestRender();
    };
    const onUp = () => {
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (camMode !== "eye") return;
      e.preventDefault();
      eye.fov = THREE.MathUtils.clamp(eye.fov * Math.exp(e.deltaY * 0.0012), 6, 95);
      applyEye();
      requestRender();
    };
    const onKey = (e: KeyboardEvent) => {
      const step = e.shiftKey ? 10 : 2;
      if (camMode === "eye") {
        if (e.key === "ArrowLeft") eye.yaw = (eye.yaw - step + 360) % 360;
        else if (e.key === "ArrowRight") eye.yaw = (eye.yaw + step) % 360;
        else if (e.key === "ArrowUp") eye.pitch = Math.min(85, eye.pitch + step);
        else if (e.key === "ArrowDown") eye.pitch = Math.max(-85, eye.pitch - step);
        else if (e.key === "+" || e.key === "=") eye.fov = Math.max(6, eye.fov / 1.15);
        else if (e.key === "-" || e.key === "_") eye.fov = Math.min(95, eye.fov * 1.15);
        else return;
        e.preventDefault();
        applyEye();
        requestRender();
      } else {
        // orbit around the observer with the keyboard
        const off = overviewCam.position.clone().sub(controls.target);
        const sph = new THREE.Spherical().setFromVector3(off);
        if (e.key === "ArrowLeft") sph.theta -= THREE.MathUtils.degToRad(step * 2);
        else if (e.key === "ArrowRight") sph.theta += THREE.MathUtils.degToRad(step * 2);
        else if (e.key === "ArrowUp") sph.phi = Math.max(0.05, sph.phi - THREE.MathUtils.degToRad(step));
        else if (e.key === "ArrowDown") sph.phi = Math.min(controls.maxPolarAngle, sph.phi + THREE.MathUtils.degToRad(step));
        else if (e.key === "+" || e.key === "=") sph.radius = Math.max(controls.minDistance, sph.radius / 1.2);
        else if (e.key === "-" || e.key === "_") sph.radius = Math.min(controls.maxDistance, sph.radius * 1.2);
        else return;
        e.preventDefault();
        overviewCam.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
        overviewCam.lookAt(controls.target);
        requestRender();
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("keydown", onKey);

    // ---------------------------------------------------------------- animation (only while moving)
    let anim: { t0: number; dur: number; step: (f: number) => void } | null = null;
    const animate = (dur: number, step: (f: number) => void) => {
      if (propsRef.current.reducedMotion || dur <= 0) {
        step(1);
        anim = null;
        requestRender();
        return;
      }
      anim = { t0: performance.now(), dur, step };
      requestRender();
    };
    const overviewTo = (pos: THREE.Vector3, dur: number) => {
      const from = new THREE.Spherical().setFromVector3(overviewCam.position.clone().sub(controls.target));
      const to = new THREE.Spherical().setFromVector3(pos);
      let dTheta = to.theta - from.theta;
      dTheta = ((dTheta + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      controls.target.set(0, 0, 0);
      animate(dur, (f) => {
        const e = ease(f);
        const s = new THREE.Spherical(
          from.radius + (to.radius - from.radius) * e,
          from.phi + (to.phi - from.phi) * e,
          from.theta + dTheta * e,
        );
        overviewCam.position.setFromSpherical(s);
        overviewCam.lookAt(controls.target);
      });
    };
    const eyeTo = (target: EyePose, dur: number) => {
      const from = { ...eye };
      const dy = azDelta(from.yaw, target.yaw);
      animate(dur, (f) => {
        const e = ease(f);
        eye = { yaw: (((from.yaw + dy * e) % 360) + 360) % 360, pitch: from.pitch + (target.pitch - from.pitch) * e, fov: from.fov + (target.fov - from.fov) * e };
        applyEye();
      });
    };
    const overviewDefault = () => {
      const p = propsRef.current;
      return new THREE.Vector3(...obliqueCamera(p.lookAz, OVERVIEW_ELEV_DEG, p.overviewDist));
    };

    // ---------------------------------------------------------------- per-frame update
    const bodyLabel = (s: BodyStatus, name: string) => {
      const word = s.visible === null ? "Unknown" : s.visible ? "Visible" : "Not visible";
      const near = s.nearCrossing ? '<span class="lbl-near">near crossing</span>' : "";
      return `<span class="lbl-name">${name}</span><span class="lbl-state" data-state="${s.visible === null ? "unknown" : s.visible ? "on" : "off"}">${word}</span>${near}`;
    };

    const updateAnnotations = () => {
      const p = propsRef.current;
      const st = p.status;
      const smooth = p.mode === "smooth";
      const ready = terrainMatchesSite(asset, p.site.site.id);
      terrain.visible = ready;
      if (edgeLine) edgeLine.visible = ready && camMode === "overview";
      terrainMat.color.setHex(smooth ? COLORS.terrainSmooth : COLORS.terrain);
      overview.visible = camMode === "overview";
      sky.visible = camMode === "eye";
      refPlane.visible = smooth;
      // Observer view: the exported profile decides the displayed horizon and occlusion (stencil mask).
      const masked = camMode === "eye" && curtain !== null;
      if (curtain) {
        curtain.visible = camMode === "eye";
        (curtain.material as THREE.MeshBasicMaterial).color.setHex(smooth ? COLORS.curtainSmooth : COLORS.curtain);
      }
      terrainMat.stencilWrite = masked;
      // terrain layers: Site overview only, and only with this site's screening asset
      const slopeOk = slopeAsset !== null && slopeAsset.site.id === p.site.site.id && camMode === "overview";
      SU.uSlopeMode.value = overlayMode(p.layer ?? "surface", camMode, slopeAsset?.site.id ?? null, p.site.site.id);
      SU.uThrC.value = thresholdCentideg(p.thresholdDeg ?? 15);
      ringsOn = slopeOk && !!p.showRings;
      SU.uRings.value = ringsOn ? 1 : 0;
      inspPin.visible = camMode === "overview" && !!p.inspection;
      if (skyline) {
        skyline.visible = camMode === "eye" && !smooth;
      }
      // smooth: 0° is THE horizon (solid, bright); terrain: faint dashed reference
      const zm = zeroLine.material as LineMaterial;
      zm.dashed = !smooth;
      zm.color.setHex(smooth ? COLORS.skyline : COLORS.ref);
      zm.linewidth = smooth ? 1.6 : 1;
      zm.opacity = smooth ? 1 : 0.55;
      zm.needsUpdate = true;
      // bodies: occluded by curtain + mesh in terrain mode; always on top in smooth mode (0° model)
      for (const b of ["sun", "earth"] as const) {
        const s = st[b];
        const g = s.geometry;
        const known = g.azimuthDeg !== null && g.elevationDeg !== null;
        const dsk = disks[b];
        const ray = rays[b];
        dsk.visible = known;
        ray.visible = known;
        if (!known) continue;
        const d = directionFromAzEl(g.azimuthDeg!, g.elevationDeg!);
        dsk.position.set(d[0] * SKY_R, d[1] * SKY_R, d[2] * SKY_R);
        dsk.lookAt(0, 0, 0);
        // Terrain: after the mesh, only outside the profile mask (the mesh never hides a body).
        // Smooth: on top of everything; the 0° model ignores terrain.
        dsk.renderOrder = smooth ? 30 : 5;
        (dsk.material as THREE.MeshBasicMaterial).stencilWrite = !smooth && masked;
        const rm = ray.material as LineMaterial;
        rm.dashed = s.visible !== true;
        rm.opacity = s.visible === null ? 0.5 : 1;
        rm.transparent = true;
        rm.needsUpdate = true;
        ray.lookAt(d[0], d[1], d[2]);
      }
    };

    // Label layout only: edge chips are stacked or nudged clear of each other, the toolbar,
    // panels and labels; ring labels yield to everything. No direction or marker is moved.
    type Box = { l: number; t: number; r: number; b: number };
    const hit2 = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const resolveCollisions = (w: number, h: number, bodyLabels: HTMLElement[]) => {
      const hb = host.getBoundingClientRect();
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { l: r.left - hb.left, t: r.top - hb.top, r: r.right - hb.left, b: r.bottom - hb.top };
      };
      const shown = (el: HTMLElement) => el.style.display !== "none";
      const stage = { l: 0, t: 0, r: w, b: h };
      const obstacles = Array.from(document.querySelectorAll<HTMLElement>(".view-toolbar, .mission-panel, .right-col > .panel, .terrain-layers, .scene-legend, .event-card, .stage-note"))
        .filter((e) => e.offsetParent !== null)
        .map(box)
        .filter((r) => r.r > r.l && hit2(r, stage));
      // on-screen body labels step sideways off a panel (the marker itself never moves)
      for (const el of bodyLabels) {
        el.style.marginLeft = "0px";
        if (!shown(el)) continue;
        const r = box(el);
        const ob = obstacles.find((o) => hit2(r, o));
        if (ob) el.style.marginLeft = `${((ob.l + ob.r) / 2 > (r.l + r.r) / 2 ? ob.l - r.r - 4 : ob.r - r.l + 4).toFixed(0)}px`;
      }
      // the observer label takes the first clear spot: right of the pin, left of it, or below it
      if (shown(lab.observer) && camMode === "overview") {
        const others = [...bodyLabels, ...markers.map((m) => m.btn)].filter(shown).map(box);
        for (const tr of ["", "calc(-100% - 10px) -50%", "-50% 14px"]) {
          lab.observer.style.translate = tr;
          const o = box(lab.observer);
          if (!others.some((q) => hit2(o, q)) && !obstacles.some((q) => hit2(o, q))) break;
        }
      }
      const fixed: Box[] = [...obstacles];
      for (const el of [lab.observer, lab.inspect, ...bodyLabels, ...markers.map((m) => m.btn)]) if (shown(el)) fixed.push(box(el));
      for (const el of [lab.offSun, lab.offEarth]) {
        if (!shown(el)) continue;
        const bx = Number(el.dataset.bx);
        const by = Number(el.dataset.by);
        const side = el.dataset.side;
        let dx = 0;
        let dy = 0;
        el.style.transform = `translate(${bx.toFixed(0)}px, ${by.toFixed(0)}px)`;
        // Search small displacements (up to 8 rounds): each round takes the smallest move that clears
        // the current blocker and keeps the chip inside the stage band below the toolbar.
        const band = { l: 4, t: 56, r: w - 4, b: h - 4 };
        const inBand = (q: Box) => q.l >= band.l && q.t >= band.t && q.r <= band.r && q.b <= band.b;
        const clampIn = () => {
          const r = box(el);
          const cy = r.t < band.t ? band.t - r.t : r.b > band.b ? band.b - r.b : 0;
          const cx = r.l < band.l ? band.l - r.l : r.r > band.r ? band.r - r.r : 0;
          dx += cx;
          dy += cy;
          el.style.transform = `translate(${(bx + dx).toFixed(0)}px, ${(by + dy).toFixed(0)}px)`;
        };
        clampIn();
        for (let k = 0; k < 8; k++) {
          const r = box(el);
          const blocker = fixed.find((f) => hit2(r, f));
          if (!blocker) break;
          const moves: [number, number][] = [
            [blocker.l - r.r - 4, 0],
            [blocker.r - r.l + 4, 0],
            [0, blocker.t - r.b - 4],
            [0, blocker.b - r.t + 4],
          ];
          const ok = moves
            .map(([mx, my]) => ({ mx, my, q: { l: r.l + mx, t: r.t + my, r: r.r + mx, b: r.b + my } }))
            .filter((m) => inBand(m.q))
            .sort((p1, p2) => Math.abs(p1.mx) + Math.abs(p1.my) - (Math.abs(p2.mx) + Math.abs(p2.my)));
          // prefer a move that clears every fixed box; otherwise the smallest feasible one
          const best = ok.find((m) => !fixed.some((f) => hit2(m.q, f))) ?? ok[0];
          if (!best) break;
          dx += best.mx;
          dy += best.my;
          el.style.transform = `translate(${(bx + dx).toFixed(0)}px, ${(by + dy).toFixed(0)}px)`;
        }
        void side;
        el.dataset.shifted = dx || dy ? "true" : "false";
        fixed.push(box(el));
      }
      // the "N" letter is redundant with the north line: it yields to every other label
      if (shown(lab.north) && fixed.some((f) => hit2(box(lab.north), f))) lab.north.style.display = "none";
      else if (shown(lab.north)) fixed.push(box(lab.north));
      // ring labels are redundant with the legend: hide any that would touch another label or a panel
      for (const rl of ringLabels) {
        if (!shown(rl.el)) continue;
        const r = box(rl.el);
        if (r.l < 4 || r.r > w - 4 || r.t < 4 || r.b > h - 4 || fixed.some((f) => hit2(r, f))) rl.el.style.display = "none";
        else fixed.push(r);
      }
    };

    const updateOverlay = (w: number, h: number) => {
      const p = propsRef.current;
      const st = p.status;
      const cam = activeCam;
      const camDist = camMode === "overview" ? overviewCam.position.length() : 1;
      const eyeH = asset ? asset.meta.observer.eye_above_dem_surface_m : (p.site.terrain_horizon?.observer?.eye_above_dem_surface_m ?? p.site.site.observer_height_above_surface_m);
      const ov = camMode === "overview";
      // screen-constant overview markers
      if (ov) {
        const s = camDist;
        obsRing.scale.setScalar(s * 0.011);
        obsRing.position.set(0, -eyeH, 0);
        pin.scale.set(1, s * 0.07, 1);
        pin.position.set(0, -eyeH, 0);
        north.scale.setScalar(s * 0.16);
        north.position.set(0, -eyeH, 0);
        rays.sun.scale.setScalar(s * RAY_LEN);
        rays.earth.scale.setScalar(s * RAY_LEN);
        refPlane.scale.setScalar(Math.max(s * 1.5, 4000));
        place(lab.observer, [0, s * 0.07 - eyeH, 0], w, h, cam);
        lab.observer.innerHTML = `<span class="lbl-name">Modeled observer</span><span class="lbl-sub">eye ${eyeH.toFixed(2)} m above DEM surface</span>`;
        place(lab.north, [0, -eyeH, -s * 0.18], w, h, cam);
        // ring labels at the ring point facing the camera
        const camAz = (Math.atan2(cam.position.x, -cam.position.z) * 180) / Math.PI;
        for (const rl of ringLabels) {
          const ring = slopeAsset?.rings.find((x) => x.radius_m === rl.r);
          const off = rl.r === 500 ? 0 : rl.r === 250 ? 18 : -30; // stagger so labels never stack
          if (!ringsOn || !ring) {
            rl.el.style.display = "none";
            continue;
          }
          const n = ring.points.length;
          const q = ring.points[((Math.round(((camAz + off) / 360) * n) % n) + n) % n];
          place(rl.el, [q[0], q[1] + 1.2, q[2]], w, h, cam);
        }
        const ins = p.inspection;
        if (ins) {
          inspPin.position.set(ins[0], ins[1], ins[2]);
          inspPin.scale.set(1, s * 0.05, 1);
          place(lab.inspect, [ins[0], ins[1], ins[2]], w, h, cam);
        } else lab.inspect.style.display = "none";
      } else {
        lab.observer.style.display = "none";
        lab.north.style.display = "none";
        lab.inspect.style.display = "none";
        for (const rl of ringLabels) rl.el.style.display = "none";
      }
      // body labels
      const placed: { el: HTMLElement; x: number; y: number; gap: number; r: number }[] = [];
      for (const b of ["sun", "earth"] as const) {
        const s = st[b];
        const g = s.geometry;
        const el = lab[b];
        const off = b === "sun" ? lab.offSun : lab.offEarth;
        const hit = hits.find((x) => x.b === b)!.btn;
        const mk = markers.find((x) => x.b === b)!.btn;
        if (g.azimuthDeg === null || g.elevationDeg === null) {
          el.style.display = off.style.display = hit.style.display = mk.style.display = "none";
          continue;
        }
        const d = directionFromAzEl(g.azimuthDeg, g.elevationDeg);
        const name = b === "sun" ? "Sun" : "Earth";
        el.innerHTML = bodyLabel(s, name);
        el.dataset.near = s.nearCrossing ? "true" : "false";
        el.dataset.view = camMode;
        if (ov) {
          hit.style.display = "none";
          const ms = markerState(s);
          const cp = overviewCam.position;
          const far: Vec3 = [cp.x + d[0] * 200_000, cp.y + d[1] * 200_000, cp.z + d[2] * 200_000];
          const pt = screen(far, w, h, cam);
          // usable area: inside the side panels, below the toolbar, above the legend
          const side = w > 760 ? 330 : 28;
          // the marker button (about 30 px) must fit wholly inside that area, not just its centre
          const inView = pt.front && pt.x >= side + 18 && pt.x <= w - side - 18 && pt.y >= 64 && pt.y <= h - 60;
          mk.dataset.state = ms;
          mk.dataset.near = s.nearCrossing ? "true" : "false";
          mk.setAttribute("aria-label", `${name}: ${MARKER_TEXT[ms]}${s.nearCrossing ? " (near estimated crossing)" : ""}. View at horizon.`);
          mk.title = `${name} direction (marker enlarged for orientation). Click to view at the horizon.`;
          if (inView) {
            mk.style.display = "";
            mk.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
            el.style.display = "";
            el.innerHTML = `<span class="lbl-name">${name}</span><span class="lbl-state" data-state="${ms}">${MARKER_TEXT[ms]}</span>${s.nearCrossing ? '<span class="lbl-near">near crossing</span>' : ""}`;
            el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
            el.style.translate = "-50% 22px";
            placed.push({ el, x: pt.x, y: pt.y, gap: 22, r: 14 });
            off.style.display = "none";
          } else {
            mk.style.display = el.style.display = "none";
            // direction of the body relative to the view (camera space), pointed at from an inset edge
            v3.set(d[0], d[1], d[2]).applyQuaternion(overviewCam.quaternion.clone().invert());
            const e = edgePoint(w / 2, h / 2, v3.x, -v3.y, { left: side, right: w - side, top: 64, bottom: h - 60 });
            const arrow = e.edge === "left" ? "◀" : e.edge === "right" ? "▶" : e.edge === "top" ? "▲" : "▼";
            off.style.display = "";
            off.innerHTML = `${arrow} <span class="lbl-name">${name}</span> <span class="lbl-sub">${MARKER_TEXT[ms]}</span>`;
            off.setAttribute("aria-label", `${name} is off screen (${MARKER_TEXT[ms]}). View it at the horizon.`);
            off.dataset.bx = String(e.x);
            off.dataset.by = String(e.y);
            off.style.transform = `translate(${e.x.toFixed(0)}px, ${e.y.toFixed(0)}px)`;
            off.dataset.side = e.edge;
            off.dataset.body = b;
          }
        } else {
          mk.style.display = "none";
          const pt = screen([d[0] * SKY_R, d[1] * SKY_R, d[2] * SKY_R], w, h, cam);
          const inView = pt.front && pt.x >= 0 && pt.x <= w && pt.y >= 0 && pt.y <= h;
          if (inView) {
            // clickable ring: larger than, and visibly distinct from, the nominal disk
            const diam = b === "sun" ? SUN_DIAMETER_DEG : EARTH_DIAMETER_DEG;
            const px = (diam / eye.fov) * h;
            const ring = Math.max(34, px * 1.9 + 16);
            const at = place(el, [d[0] * SKY_R, d[1] * SKY_R, d[2] * SKY_R], w, h, cam);
            el.style.translate = `-50% calc(-100% - ${(ring / 2 + 5).toFixed(0)}px)`;
            if (at) placed.push({ el, x: at.x, y: at.y, gap: ring / 2 + 5, r: ring / 2 });
            hit.style.display = "";
            hit.style.width = hit.style.height = `${ring.toFixed(0)}px`;
            hit.style.transform = `translate(${(pt.x - ring / 2).toFixed(1)}px, ${(pt.y - ring / 2).toFixed(1)}px)`;
            hit.setAttribute("aria-label", `${name}: ${s.visible === null ? "Unknown" : s.visible ? "Visible" : "Not visible"}. Center the view on the ${name}.`);
            hit.dataset.state = s.visible === null ? "unknown" : s.visible ? "on" : "off";
            hit.dataset.near = s.nearCrossing ? "true" : "false";
            off.style.display = "none";
          } else {
            el.style.display = hit.style.display = "none";
            const dAz = azDelta(eye.yaw, g.azimuthDeg);
            const left = dAz < 0;
            off.style.display = "";
            off.innerHTML = `${left ? "◀ " : ""}<span class="lbl-name">${name}</span> ${Math.abs(dAz).toFixed(0)}°${left ? "" : " ▶"}`;
            const y = h - 150 - (b === "earth" ? 34 : 0);
            off.setAttribute("aria-label", `${name} is ${Math.abs(dAz).toFixed(0)}° to the ${left ? "left" : "right"}. Center the view on the ${name}.`);
            off.dataset.bx = String(left ? 12 : w - 12);
            off.dataset.by = String(y);
            off.style.transform = `translate(${left ? 12 : w - 12}px, ${y.toFixed(0)}px)`;
            off.dataset.side = left ? "left" : "right";
          }
        }
      }
      // two labels that would overlap: put the lower one beneath its marker instead
      if (placed.length === 2) {
        const [a, b] = placed;
        // labels sit above each marker; they collide when the markers are close on screen
        if (Math.abs(a.x - b.x) < 150 && Math.abs(a.y - b.y) < a.r + b.r + 30) {
          const low = a.y >= b.y ? a : b;
          const high = low === a ? b : a;
          if (ov) high.el.style.translate = "-50% calc(-100% - 20px)"; // above its marker
          else low.el.style.translate = `-50% ${low.gap.toFixed(0)}px`;
        }
      }
      // keep overview marker labels and markers clear of the observer label
      if (ov && lab.observer.style.display !== "none") {
        lab.observer.style.translate = "";
        // markers and edge chips both push the observer label aside (labels never move a marker)
        const hitsMarker = [...markers.map((m) => m.btn), lab.offSun, lab.offEarth].some((btn) => {
          if (btn.style.display === "none") return false;
          const a = btn.getBoundingClientRect();
          const o = lab.observer.getBoundingClientRect();
          return a.left < o.right && a.right > o.left && a.top < o.bottom && a.bottom > o.top;
        });
        if (hitsMarker) lab.observer.style.translate = "calc(-100% - 10px) -50%"; // to the left of the pin
        const ob = lab.observer.getBoundingClientRect();
        for (const q of placed) {
          const r = q.el.getBoundingClientRect();
          if (r.left < ob.right && r.right > ob.left && r.top < ob.bottom && r.bottom > ob.top) q.el.style.translate = "-50% calc(-100% - 20px)";
        }
      }
      resolveCollisions(w, h, placed.map((q) => q.el));
      // eye-view references
      if (!ov) {
        for (const c of cardinals) {
          const pt = screen(directionFromAzEl(c.az, 0).map((x) => x * SKY_R) as Vec3, w, h, cam);
          if (!pt.front || pt.x < 8 || pt.x > w - 8 || pt.y < 0 || pt.y > h) c.el.style.display = "none";
          else {
            c.el.style.display = "";
            c.el.style.transform = `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`;
          }
        }
        const smooth = p.mode === "smooth";
        // label the lines where they are farthest (in azimuth) from both bodies
        const bodyAz = (["sun", "earth"] as const).map((b) => st[b].geometry.azimuthDeg).filter((x): x is number => x !== null);
        const half = (eye.fov * Math.max(1, w / Math.max(1, h))) / 2;
        const cands = [-0.42, -0.25, -0.08, 0.1, 0.27, 0.42].map((f) => (eye.yaw + f * half + 360) % 360);
        const score = (a: number) => Math.min(999, ...bodyAz.map((x) => Math.abs(azDelta(a, x))));
        const ranked = [...cands].sort((x, y) => score(y) - score(x));
        const az = ranked[0];
        // the 0° label also keeps clear of the cardinal letters drawn just below that line
        const cardGap = (a: number) => Math.min(...[0, 45, 90, 135, 180, 225, 270, 315].map((c) => Math.abs(azDelta(a, c))));
        const azZero = [...ranked.slice(1)].sort((x, y) => Math.min(score(y), cardGap(y) * 3) - Math.min(score(x), cardGap(x) * 3))[0];
        const roomy = w >= 700; // on narrow screens the legend explains the lines instead
        const prof = p.site.terrain_horizon?.horizon;
        if (!smooth && prof && roomy) {
          const k = Math.round(az * 10) % prof.azimuth_deg.length;
          const e = prof.elevation_deg[k];
          if (e !== null) {
            place(lab.skyline, directionFromAzEl(az, e).map((x) => x * CURTAIN_R) as Vec3, w, h, cam);
            lab.skyline.innerHTML = "Skyline · exported 0.1° profile (used for status)";
          } else lab.skyline.style.display = "none";
        } else lab.skyline.style.display = "none";
        if (smooth && roomy) {
          place(lab.zero, directionFromAzEl(azZero, 0).map((x) => x * CURTAIN_R) as Vec3, w, h, cam);
          lab.zero.innerHTML = "0° reference horizon · Smooth model (terrain ignored)";
        } else lab.zero.style.display = "none";
        lab.zero.dataset.mode = p.mode;
        lab.edge.style.display = "none";
      } else {
        for (const c of cardinals) c.el.style.display = "none";
        lab.skyline.style.display = "none";
        lab.zero.style.display = "none";
        lab.edge.style.display = "none"; // the mesh edge is explained in the legend
      }
    };

    // ---------------------------------------------------------------- render on demand
    let raf = 0;
    let frames = 0;
    let disposed = false;
    const frame = () => {
      raf = 0;
      if (disposed) return;
      if (anim) {
        const f = Math.min(1, (performance.now() - anim.t0) / anim.dur);
        anim.step(f);
        if (f >= 1) anim = null;
      }
      const w = host.clientWidth;
      const h = host.clientHeight;
      const t0 = performance.now();
      updateAnnotations();
      renderer.render(scene, activeCam);
      updateOverlay(w, h);
      // lightweight self-measurement (CPU time of one on-demand frame), read by browser checks
      frames++;
      canvas.dataset.frames = String(frames);
      canvas.dataset.frameMs = (performance.now() - t0).toFixed(2);
      canvas.dataset.camPos = overviewCam.position.toArray().map((x) => x.toFixed(2)).join(",");
      if (anim) raf = requestAnimationFrame(frame);
    };
    function requestRender() {
      if (!raf && !disposed) raf = requestAnimationFrame(frame);
    }

    const resize = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      renderer.setSize(w, h, false);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      for (const c of [overviewCam, eyeCam]) {
        c.aspect = w / h;
        c.updateProjectionMatrix();
      }
      const dpr = renderer.getPixelRatio();
      for (const m of lineMats()) m.resolution.set(w * dpr, h * dpr);
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    const onLost = (e: Event) => {
      e.preventDefault();
      setLost(true);
    };
    canvas.addEventListener("webglcontextlost", onLost);

    // ---------------------------------------------------------------- site switching
    let abort: AbortController | null = null;
    const clearTerrain = () => {
      for (const m of [...terrain.children]) {
        terrain.remove(m);
        (m as THREE.Mesh).geometry.dispose();
      }
      if (edgeLine) {
        overview.remove(edgeLine);
        edgeLine.geometry.dispose();
        (edgeLine.material as LineMaterial).dispose();
        edgeLine = null;
      }
      asset = null;
    };
    const buildProfile = (site: SiteData) => {
      if (curtain) {
        sky.remove(curtain);
        curtain.geometry.dispose();
        (curtain.material as THREE.Material).dispose();
        curtain = null;
      }
      if (skyline) {
        sky.remove(skyline);
        skyline.geometry.dispose();
        (skyline.material as LineMaterial).dispose();
        skyline = null;
      }
      const prof = site.terrain_horizon?.horizon;
      if (!prof) return;
      // Profile mask: everything at or below the exported skyline, as directions (geometry.ts).
      const mask = profileMask(prof.azimuth_deg, prof.elevation_deg, CURTAIN_R);
      const pts = mask.top;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(mask.positions, 3));
      g.setIndex(mask.index);
      const cm = new THREE.MeshBasicMaterial({ color: COLORS.curtain, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
      // drawn first: fills the profile silhouette where the mesh is lower, and writes stencil 1
      cm.stencilWrite = true;
      cm.stencilFunc = THREE.AlwaysStencilFunc;
      cm.stencilRef = 1;
      cm.stencilZPass = THREE.ReplaceStencilOp;
      curtain = new THREE.Mesh(g, cm);
      curtain.renderOrder = 2;
      skyline = makeLine(pts, COLORS.skyline, 1.6, { depthTest: false });
      skyline.renderOrder = 40;
      sky.add(curtain, skyline);
      resize();
    };
    const setSite = (site: SiteData) => {
      abort?.abort();
      clearTerrain();
      buildProfile(site);
      const id = site.site.id;
      propsRef.current.onAssetState({ state: "loading", siteId: id });
      // reset both cameras to this site's composed defaults
      eye = eyeDefault(propsRef.current.lookAz);
      applyEye();
      overviewCam.position.copy(overviewDefault());
      overviewCam.lookAt(0, 0, 0);
      controls.maxDistance = propsRef.current.overviewDist * 6;
      requestRender();
      const ac = new AbortController();
      abort = ac;
      loadTerrainAsset(import.meta.env.BASE_URL, site, ac.signal)
        .then((a) => {
          if (ac.signal.aborted || disposed || propsRef.current.site.site.id !== id) return;
          for (const lv of a.levels) {
            const g = new THREE.BufferGeometry();
            g.setAttribute("position", new THREE.BufferAttribute(lv.positions, 3));
            const h = lv.meta.hole_cells;
            g.setIndex(new THREE.BufferAttribute(gridIndices(lv.meta.nx, lv.meta.ny, h, needsFlip(lv.positions, lv.meta.nx)), 1));
            g.computeVertexNormals();
            // shading only: soften bilinear pixel creases over about one 20 m DEM pixel
            smoothNormals(g.getAttribute("normal").array as Float32Array, lv.meta.nx, Math.max(1, Math.round(SHADE_SMOOTH_M / lv.meta.spacing_m)));
            g.computeBoundingSphere();
            const m = new THREE.Mesh(g, terrainMat);
            m.renderOrder = 3;
            terrain.add(m);
          }
          // average one-sided normals across ring boundaries (shading only; positions unchanged)
          const meshes = terrain.children as THREE.Mesh[];
          for (let li = 0; li + 1 < a.levels.length; li++) {
            const f = a.levels[li].meta;
            const c = a.levels[li + 1].meta;
            const nf = meshes[li].geometry.getAttribute("normal") as THREE.BufferAttribute;
            const nc = meshes[li + 1].geometry.getAttribute("normal") as THREE.BufferAttribute;
            stitchNormals(nf.array as Float32Array, f.nx, nc.array as Float32Array, c.nx, c.spacing_m / f.spacing_m, Math.round((c.half_width_m - f.half_width_m) / c.spacing_m));
            nf.needsUpdate = nc.needsUpdate = true;
          }
          // outline of the meshed extent (outer level boundary), drawn in the overview
          const lv = a.levels[a.levels.length - 1];
          const n = lv.meta.nx;
          const P = lv.positions;
          const ring: Vec3[] = [];
          const stepE = Math.max(1, Math.floor(n / 64));
          const at = (i: number, j: number): Vec3 => {
            const k = 3 * (j * n + i);
            return [P[k], P[k + 1] + 4, P[k + 2]];
          };
          for (let i = 0; i < n; i += stepE) ring.push(at(i, 0));
          for (let j = 0; j < n; j += stepE) ring.push(at(n - 1, j));
          for (let i = n - 1; i > 0; i -= stepE) ring.push(at(i, n - 1));
          for (let j = n - 1; j > 0; j -= stepE) ring.push(at(0, j));
          ring.push(at(0, 0));
          edgeLine = makeLine(ring, 0xbdbab2, 1.2, { dashed: true, dash: [400, 300], opacity: 0.85 });
          overview.add(edgeLine);
          asset = a;
          resize();
          propsRef.current.onAssetState({ state: "ready", siteId: id, meta: a.meta });
          requestRender();
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted || disposed) return;
          propsRef.current.onAssetState({ state: "error", siteId: id, message: e instanceof Error ? e.message : String(e) });
          requestRender();
        });
    };

    const setCamera = (mode: CameraMode, anim: boolean) => {
      void anim;
      camMode = mode;
      activeCam = mode === "eye" ? eyeCam : overviewCam;
      controls.enabled = mode === "overview";
      canvas.setAttribute(
        "aria-label",
        mode === "eye"
          ? "Observer view from the fixed modeled observer. Drag or use arrow keys to look around; mouse wheel or plus/minus changes the field of view."
          : "Orbit overview of the terrain around the modeled observer. Drag or use arrow keys to orbit; mouse wheel or plus/minus zooms.",
      );
      canvas.dataset.camera = mode;
      requestRender();
    };

    const command = (c: CameraCommand) => {
      const p = propsRef.current;
      const dur = 650;
      if (c.kind === "frame") {
        if (camMode === "overview") overviewTo(new THREE.Vector3(...obliqueCamera(p.lookAz, TERRAIN_ELEV_DEG, TERRAIN_DIST_M)), dur);
        return;
      }
      if (c.kind === "reset") {
        if (camMode === "eye") eyeTo(eyeDefault(p.lookAz), dur);
        else overviewTo(overviewDefault(), dur);
        return;
      }
      const g = p.status[c.kind].geometry;
      if (g.azimuthDeg === null || g.elevationDeg === null) return;
      if (camMode === "eye") eyeTo({ yaw: g.azimuthDeg, pitch: g.elevationDeg, fov: c.fov ?? Math.min(eye.fov, c.kind === "sun" ? 24 : 30) }, dur);
      else {
        const r = overviewCam.position.length();
        overviewTo(new THREE.Vector3(...obliqueCamera(g.azimuthDeg, 22, r)), dur);
      }
    };

    api.current = { render: requestRender, setSite, update: requestRender, setCamera, command, setSlope };
    setCamera(propsRef.current.camera, false);
    setSite(propsRef.current.site);
    resize();

    return () => {
      disposed = true;
      abort?.abort();
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerup", onClickUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("keydown", onKey);
      canvas.removeEventListener("webglcontextlost", onLost);
      clearTerrain();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      terrainMat.dispose();
      renderer.dispose();
      canvas.remove();
      labelHost.replaceChildren();
      api.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- prop-driven updates
  const siteId = props.site.site.id;
  useEffect(() => {
    api.current?.setSite(propsRef.current.site);
  }, [siteId]);
  useEffect(() => {
    api.current?.setCamera(props.camera, true);
  }, [props.camera]);
  useEffect(() => {
    if (props.command) api.current?.command(props.command);
  }, [props.command]);
  useEffect(() => {
    api.current?.update();
  }, [props.status, props.mode, props.layer, props.thresholdDeg, props.inspection, props.showRings, props.layoutKey]);
  const slopeForSite = props.slope && props.slope.site.id === siteId ? props.slope : null;
  useEffect(() => {
    api.current?.setSlope(slopeForSite);
  }, [slopeForSite, siteId]);

  return (
    <div className="scene-host" ref={hostRef} data-site={siteId} data-camera={props.camera}>
      <div className="scene-labels" ref={labelsRef} aria-hidden="false" />
      {lost && (
        <div className="scene-message scene-error" role="alert">
          <strong>The 3D view lost its graphics context.</strong>
          <span>Status, controls and Analysis are unaffected.</span>
          <button type="button" onClick={() => propsRef.current.onFatal("The graphics context was lost.")}>Restart 3D view</button>
        </div>
      )}
    </div>
  );
}
