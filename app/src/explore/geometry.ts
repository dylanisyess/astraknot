// Pure geometry for 3D Explore. No three.js import, so it is unit-testable and shared by
// the renderer. Renderer convention (SPEC.md, "3D Explore", item 2): a right-handed, Y-up
// local east-north-up frame at the modeled observer with
//   x = east, y = up, z = -north,
// so a direction with azimuth az (clockwise from north) and elevation el is
//   (cos el * sin az, sin el, -cos el * cos az).

export type Vec3 = [number, number, number];

const RAD = Math.PI / 180;

export function directionFromAzEl(azDeg: number, elDeg: number): Vec3 {
  const a = azDeg * RAD;
  const e = elDeg * RAD;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}

/** Inverse of directionFromAzEl for any non-zero vector: azimuth in [0, 360), elevation in [-90, 90]. */
export function azElFromVector(v: Vec3): { az: number; el: number } {
  const [x, y, z] = v;
  const az = ((Math.atan2(x, -z) / RAD) % 360 + 360) % 360;
  return { az, el: Math.atan2(y, Math.hypot(x, z)) / RAD };
}

export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Triangle indices for one exported grid level. MUST match pipeline/render_assets.py `triangles`:
 * cell (i, j) -> (v00, v01, v10) and (v10, v01, v11), vertex index = j * nx + i, cells inside
 * `hole` ([i0, i1, j0, j1), i.e. covered by the finer level) are skipped.
 * `flip` reverses the winding (used so that front faces point up; see orientUp).
 */
export function gridIndices(nx: number, ny: number, hole: [number, number, number, number] | null, flip = false): Uint32Array {
  let cells = (nx - 1) * (ny - 1);
  if (hole) cells -= (hole[1] - hole[0]) * (hole[3] - hole[2]);
  const out = new Uint32Array(cells * 6);
  let k = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      if (hole && i >= hole[0] && i < hole[1] && j >= hole[2] && j < hole[3]) continue;
      const v00 = j * nx + i;
      const v10 = v00 + 1;
      const v01 = v00 + nx;
      const v11 = v01 + 1;
      if (flip) {
        out[k++] = v00; out[k++] = v10; out[k++] = v01;
        out[k++] = v10; out[k++] = v11; out[k++] = v01;
      } else {
        out[k++] = v00; out[k++] = v01; out[k++] = v10;
        out[k++] = v10; out[k++] = v01; out[k++] = v11;
      }
    }
  }
  return out;
}

/** Does the unflipped winding of the grid produce downward (-y) face normals? Decided from the data. */
export function needsFlip(pos: Float32Array, nx: number): boolean {
  // first cell's first triangle (v00, v01, v10)
  const p = (v: number): Vec3 => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
  const a = p(0);
  const b = p(nx);
  const c = p(1);
  const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
  return n[1] < 0;
}

/**
 * Shade nested rings without seams: each ring's vertex normals at the shared boundary are
 * one-sided (computed from that ring's triangles only). Average them across the boundary.
 * `fine` / `coarse` are per-vertex normal arrays (xyz) of square grids with nf / nc vertices
 * per side; the fine square sits on coarse grid lines starting at coarse index `lo`, and one
 * coarse spacing is `r` fine spacings. Changes shading only, never positions.
 */
export function stitchNormals(fine: Float32Array, nf: number, coarse: Float32Array, nc: number, r: number, lo: number): void {
  const fineIdx: number[] = [];
  const last = nf - 1;
  for (let t = 0; t < nf; t++) {
    fineIdx.push(t, last * nf + t); // rows j = 0 and j = last
    if (t > 0 && t < last) fineIdx.push(t * nf, t * nf + last); // columns i = 0 and i = last
  }
  const cn = (i: number, j: number): Vec3 => {
    const k = 3 * (j * nc + i);
    return [coarse[k], coarse[k + 1], coarse[k + 2]];
  };
  const updates: { k: number; n: Vec3; ck: number | null }[] = [];
  for (const v of fineIdx) {
    const i = v % nf;
    const j = (v - i) / nf;
    const ci = lo + i / r;
    const cj = lo + j / r;
    const i0 = Math.floor(ci);
    const j0 = Math.floor(cj);
    const fi = ci - i0;
    const fj = cj - j0;
    const a = cn(i0, j0);
    const b = fi > 0 ? cn(i0 + 1, j0) : a;
    const c = fj > 0 ? cn(i0, j0 + 1) : a;
    const g: Vec3 = [0, 1, 2].map((q) => a[q] * (1 - fi - fj) + b[q] * fi + c[q] * fj) as Vec3;
    const k = 3 * v;
    const s: Vec3 = [fine[k] + g[0], fine[k + 1] + g[1], fine[k + 2] + g[2]];
    const L = Math.hypot(s[0], s[1], s[2]) || 1;
    updates.push({ k, n: [s[0] / L, s[1] / L, s[2] / L], ck: fi === 0 && fj === 0 ? 3 * (j0 * nc + i0) : null });
  }
  for (const u of updates) {
    fine.set(u.n, u.k);
    if (u.ck !== null) coarse.set(u.n, u.ck);
  }
}

/**
 * Box-average per-vertex normals of an n x n grid over +-radius vertices (separable), then
 * renormalize. Shading only: it softens the creases a bilinear 20 m DEM shows at pixel
 * boundaries. Positions, silhouette and skyline are unchanged.
 */
export function smoothNormals(normals: Float32Array, n: number, radius: number): void {
  if (radius < 1) return;
  const tmp = new Float32Array(normals.length);
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        let sx = 0, sy = 0, sz = 0;
        for (let d = -radius; d <= radius; d++) {
          const t = Math.min(n - 1, Math.max(0, b + d));
          const k = 3 * (horizontal ? a * n + t : t * n + a);
          sx += src[k]; sy += src[k + 1]; sz += src[k + 2];
        }
        const k = 3 * (horizontal ? a * n + b : b * n + a);
        dst[k] = sx; dst[k + 1] = sy; dst[k + 2] = sz;
      }
    }
  };
  pass(normals, tmp, true);
  pass(tmp, normals, false);
  for (let k = 0; k < normals.length; k += 3) {
    const L = Math.hypot(normals[k], normals[k + 1], normals[k + 2]) || 1;
    normals[k] /= L; normals[k + 1] /= L; normals[k + 2] /= L;
  }
}

/** Elevations (deg) of the lower rows of the observer-view profile mask, down to nadir. */
export const MASK_ROWS_DEG = [-5, -30, -60, -89.5];

/**
 * Observer-view mask of everything at or below the exported skyline profile, as a band of
 * columns (one per profile azimuth) on a sphere of radius `r` around the observer:
 * row 0 is the profile itself, the remaining rows step down to nadir. Directions only.
 * The renderer uses it as a stencil: terrain is drawn only inside it and the Sun/Earth only
 * outside it, so the profile (the same one selectedTimeStatus uses) alone decides occlusion.
 * A column whose profile value (or its neighbour's) is unknown is omitted.
 */
export function profileMask(azimuthDeg: number[], elevationDeg: (number | null)[], r: number) {
  const n = azimuthDeg.length;
  const rows = 1 + MASK_ROWS_DEG.length;
  const pos = new Float32Array((n + 1) * rows * 3);
  const idx: number[] = [];
  const top: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const kk = k % n;
    const az = azimuthDeg[kk] + (k === n ? 360 : 0);
    const e = elevationDeg[kk];
    const els = [e ?? MASK_ROWS_DEG[0], ...MASK_ROWS_DEG.map((x) => Math.min(x, (e ?? x) - 0.01))];
    els.forEach((el, row) => pos.set(directionFromAzEl(az, el).map((c) => c * r), 3 * (k * rows + row)));
    if (e !== null) top.push(directionFromAzEl(az, e).map((c) => c * r) as Vec3);
    if (k < n && e !== null && elevationDeg[(k + 1) % n] !== null) {
      for (let row = 0; row + 1 < rows; row++) {
        const a = k * rows + row;
        const b = (k + 1) * rows + row;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
  }
  return { positions: pos, index: idx, rows, top };
}

/**
 * How a nominal disk of angular radius `radiusDeg` sits relative to the horizon, from the
 * center's instantaneous clearance (treats the horizon as locally flat at that azimuth).
 */
export function diskRelation(clearanceDeg: number | null, radiusDeg: number): "clear" | "straddles" | "hidden" | null {
  if (clearanceDeg === null) return null;
  if (clearanceDeg >= radiusDeg) return "clear";
  if (clearanceDeg <= -radiusDeg) return "hidden";
  return "straddles";
}

/** Length of the vector, for camera-distance scaling of screen-constant markers. */
export const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);

/** Point at distance d along an (az, el) direction from the observer (origin). */
export function along(azDeg: number, elDeg: number, d: number): Vec3 {
  const v = directionFromAzEl(azDeg, elDeg);
  return [v[0] * d, v[1] * d, v[2] * d];
}

/**
 * Overview camera position for a composed oblique view: placed `dist` from the target, at
 * `elevDeg` above the target's horizontal plane, on the side opposite the azimuth `lookAz`
 * (so the camera looks toward lookAz across the observer).
 */
export function obliqueCamera(lookAz: number, elevDeg: number, dist: number): Vec3 {
  return along(lookAz + 180, elevDeg, dist);
}

/** Yaw/pitch (degrees) for an eye-view camera looking along (az, el). */
export function lookAngles(azDeg: number, elDeg: number) {
  return { yaw: azDeg, pitch: elDeg };
}

/** Smallest signed difference b - a between two azimuths, in (-180, 180]. */
export function azDelta(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/**
 * Where a ray from (cx, cy) in screen direction (dx, dy) (y down) leaves an inset rectangle:
 * used to point at an off-screen body from inside the usable viewport.
 */
export function edgePoint(cx: number, cy: number, dx: number, dy: number, r: { left: number; right: number; top: number; bottom: number }) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tx = ux > 0 ? (r.right - cx) / ux : ux < 0 ? (r.left - cx) / ux : Infinity;
  const ty = uy > 0 ? (r.bottom - cy) / uy : uy < 0 ? (r.top - cy) / uy : Infinity;
  const t = Math.max(0, Math.min(tx, ty));
  const edge: "left" | "right" | "top" | "bottom" = tx <= ty ? (ux < 0 ? "left" : "right") : uy < 0 ? "top" : "bottom";
  return { x: cx + ux * t, y: cy + uy * t, edge };
}
