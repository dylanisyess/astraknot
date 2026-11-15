"""Coordinate-driven terrain source access. Offline sampling, explicit acquisition.

Adapters expose pixel_of(lat,lon), unit_at(i,j), value_m(i,j), sample(lat,lon),
resolution(lat), and provenance. Coordinates are ME/DE421 planetocentric/east.
PDS and SLDEM file identity comes from validated labels + SHA256 of actual bytes.
Registry order/priority is data, never a site-name condition.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import mmap
import subprocess
from pathlib import Path
import lola
import sldem
import terrain_horizon as th

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "pipeline/terrain_sources.json"
VERSION = "terrain-sampler-1"
FRAME = "MOON_ME_DE421"

class CoverageError(ValueError):
    pass

def normalize(lat, lon):
    lat, lon = float(lat), float(lon)
    if not math.isfinite(lat) or not -90 <= lat <= 90 or not math.isfinite(lon):
        raise ValueError("Latitude must be finite in [-90,90]; east longitude must be finite")
    return lat, lon % 360

def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(16 << 20), b""): h.update(b)
    return h.hexdigest()

class Source:
    def __init__(self, spec):
        self.spec, self.id, self.kind = spec, spec["id"], spec["adapter"]
        self.periodic = False
        if self.kind == "sldem_cylindrical":
            lbl = sldem.load_label(self.id, offline=True)
            self.lbl = lbl
            self.path = sldem.RAW_DIR / self.id / f"{self.id}.img"
            self.label_path = self.path.with_suffix(".lbl")
            self.width, self.height, self.scale = lbl.samples, lbl.lines, 1000.
            self.res, self.lpo, self.spo, self.center_lon = lbl.res, lbl.lpo, lbl.spo, lbl.center_lon
            self.bounds = [lbl.min_lat, lbl.max_lat, lbl.west_lon, lbl.east_lon]
            self.url = f"{sldem.BASE_URL}/{self.id}.img"
            self.typecode, self.expected = "f", lbl.expected_bytes
            self.nodata = None
        elif self.kind in ("pds_polar", "pds_cylindrical"):
            lbl = lola.load_label(self.id, "polar" if self.kind == "pds_polar" else "cylindrical")
            self.lbl = lbl
            f = lbl.fields
            if f.get("COORDINATE_SYSTEM_NAME") != "MEAN EARTH/POLAR AXIS OF DE421" or f.get("POSITIVE_LONGITUDE_DIRECTION") != "EAST" or abs(lbl.offset_m - th.R) > 1e-8:
                raise ValueError(f"{self.id}: incompatible frame, longitude convention or reference sphere")
            if lbl.sample_type != "LSB_INTEGER" or lbl.sample_bits != 16:
                raise ValueError(f"{self.id}: expected little-endian int16")
            self.path = lola.RAW_DIR / self.id.lower() / f"{self.id.lower()}.img"
            self.label_path = lola.LABEL_DIR / f"{self.id.lower()}.lbl"
            self.width, self.height, self.scale = lbl.samples, lbl.lines, lbl.scaling
            self.typecode, self.expected = "h", lbl.expected_bytes
            self.nodata = float(f["MISSING_CONSTANT"]) if "MISSING_CONSTANT" in f else None
            self.url = lbl.url
            if self.kind == "pds_cylindrical":
                self.res = lola._num(f["MAP_RESOLUTION"])
                self.lpo, self.spo = lola._num(f["LINE_PROJECTION_OFFSET"]), lola._num(f["SAMPLE_PROJECTION_OFFSET"])
                self.center_lon = lola._num(f["CENTER_LONGITUDE"])
                self.bounds = [lola._num(f["MINIMUM_LATITUDE"]), lola._num(f["MAXIMUM_LATITUDE"]), 0., self.width / self.res]
                self.periodic = abs(self.width / self.res - 360) < 1e-8
            else:
                if self.width != self.height or lola._num(f["CENTER_LATITUDE"]) != -90:
                    raise ValueError(f"{self.id}: this polar adapter requires square south-polar stereographic data")
                self.bounds = "actual projected raster bounds, including corner coverage; valid bilinear footprint excludes exterior neighbors"
        else:
            raise ValueError(f"Unsupported source adapter {self.kind}")
        if not self.path.exists() or self.path.stat().st_size != self.expected:
            raise CoverageError(f"Missing/wrong-size {self.id}: {self.path}; acquire with python pipeline/terrain_sources.py fetch {self.id}")
        self._f = self.path.open("rb")
        self._mm = mmap.mmap(self._f.fileno(), 0, access=mmap.ACCESS_READ)
        self.data = memoryview(self._mm).cast(self.typecode)
        self.digest = None

    def close(self):
        self.data.release(); self._mm.close(); self._f.close()

    def pixel_of(self, lat, lon):
        lat, lon = normalize(lat, lon)
        if self.kind == "pds_polar":
            if lat > 0: return -math.inf, -math.inf
            return lola.polar_inverse(self.lbl, lat, lon)
        # Choose the longitude equivalent nearest the centre of this tile.
        mid = (self.bounds[2] + self.bounds[3]) / 2
        lon = mid + ((lon - mid + 180) % 360 - 180)
        return self.spo + (lon - self.center_lon) * self.res + 1, self.lpo - lat * self.res + 1

    def unit_at(self, i, j):
        if self.kind == "pds_polar":
            lat, lon = lola.polar_forward(self.lbl, i, j)
        else:
            lat, lon = (self.lpo + 1 - j) / self.res, self.center_lon + (i - self.spo - 1) / self.res
        return th.unit(lat, lon)

    def value_m(self, i, j):
        if self.periodic: i = (i - 1) % self.width + 1
        if not 1 <= i <= self.width or not 1 <= j <= self.height: return None
        v = self.data[(j-1)*self.width+i-1]
        if not math.isfinite(v) or (self.nodata is not None and v == self.nodata): return None
        return v * self.scale

    def sample(self, lat, lon):
        i,j = self.pixel_of(lat,lon)
        if not math.isfinite(i) or not math.isfinite(j): return None
        a,b = math.floor(i),math.floor(j)
        q=[self.value_m(a,b),self.value_m(a+1,b),self.value_m(a,b+1),self.value_m(a+1,b+1)]
        if any(x is None for x in q): return None
        x,y=i-a,j-b
        return q[0]*(1-x)*(1-y)+q[1]*x*(1-y)+q[2]*(1-x)*y+q[3]*x*y

    def resolution(self,lat):
        if self.kind == "pds_polar":
            s=self.lbl.map_scale_m/lola.stereo_scale_factor(lat)
            return s,s
        ns=math.pi/180*th.R/self.res
        return abs(ns*math.cos(math.radians(lat))),ns

    def provenance(self):
        if self.digest is None: self.digest=sha(self.path)
        projection = ({k:getattr(self.lbl,k) for k in ("res","lpo","spo","center_lon","min_lat","max_lat","west_lon","east_lon")} if self.kind=="sldem_cylindrical" else self.lbl.fields)
        return dict(name=self.id, adapter=self.kind, sha256=self.digest, bytes=self.expected,
                    label_sha256=sha(self.label_path), file=self.path.relative_to(ROOT).as_posix(), url=self.url,
                    role="local and horizon" if self.spec.get("local") else "distant horizon only",
                    frame=FRAME, height_reference="metres above 1737400 m sphere", bounds=self.bounds,
                    nodata=self.nodata, nodata_rule="nonfinite or explicit sentinel is unknown; bilinear needs four valid pixels",
                    projection="south polar stereographic" if self.kind=="pds_polar" else "simple cylindrical",
                    projection_parameters=projection,raw_units="km" if self.kind=="sldem_cylindrical" else "scaled int16",scale_to_metres=self.scale,
                    registration="PDS/SLDEM label 1-based pixel centres; no half-pixel shift", priority=self.spec["priority"])

class Terrain:
    def __init__(self, registry=REGISTRY):
        self.registry=json.loads(Path(registry).read_text("utf-8"))
        self.sources=[]; self.missing=[]
        old=lola.OFFLINE; lola.OFFLINE=True
        try:
            for spec in sorted(self.registry["sources"],key=lambda x:x["priority"]):
                try: self.sources.append(Source(spec))
                except (FileNotFoundError,CoverageError,RuntimeError) as e: self.missing.append(str(e))
        finally: lola.OFFLINE=old

    def close(self):
        for s in self.sources: s.close()

    def sample(self,lat,lon,local=False):
        for source in self.sources:
            if local and (not source.spec.get("local") or max(source.resolution(lat))>100): continue
            h=source.sample(lat,lon)
            # Adjacent co-registered cylindrical tiles: obtain exterior neighbors
            # from the same format/resolution instead of inventing edge pixels.
            if h is None and source.kind != "pds_polar":
                fi,fj=source.pixel_of(lat,lon)
                if -0.5 <= fi <= source.width+1.5 and -0.5 <= fj <= source.height+1.5:
                    i,j=math.floor(fi),math.floor(fj);q=[]
                    for di,dj in ((0,0),(1,0),(0,1),(1,1)):
                        v=source.value_m(i+di,j+dj)
                        if v is None and not(1<=i+di<=source.width and 1<=j+dj<=source.height):
                            ll=th.latlon(source.unit_at(i+di,j+dj))
                            for neighbor in self.sources:
                                if neighbor is source or neighbor.kind!=source.kind or abs(neighbor.res-source.res)>1e-9:continue
                                ni,nj=neighbor.pixel_of(*ll)
                                if max(abs(ni-round(ni)),abs(nj-round(nj)))<1e-6:
                                    v=neighbor.value_m(round(ni),round(nj))
                                    if v is not None:break
                        q.append(v)
                    if all(v is not None for v in q):
                        x,y=fi-i,fj-j
                        h=q[0]*(1-x)*(1-y)+q[1]*x*(1-y)+q[2]*(1-x)*y+q[3]*x*y
            if h is not None:return h,source
        if abs(lat)<=60:
            lo=math.floor((lon%360)/45)*45;la=math.floor(lat/30)*30
            band=lambda v:f"{abs(v):02d}{'n' if v>=0 else 's'}"
            suggestion=f"Supply/register SLDEM2015 tile covering lat {la}..{la+30}, east lon {lo}..{lo+45} (e.g. 512 px/deg float tile; verify its actual PDS label/filename)"
        else:suggestion="Supply/register a polar or regional DEM with <=100 m pixels covering this point and its mesh/slope neighborhood"
        raise CoverageError(f"No {'local (<=100 m pixels)' if local else 'horizon'} terrain at latitude {lat:.8f}, east longitude {lon%360:.8f}. Cached footprints: {[s.id for s in self.sources]}. Missing sources: {self.missing}. {suggestion}; no flat substitute.")

    def sample_unit(self,p,local=False):return self.sample(*th.latlon(p),local=local)

def acquire(source_id):
    specs=json.loads(REGISTRY.read_text())["sources"]
    spec=next((s for s in specs if s["id"]==source_id),None)
    if not spec:raise ValueError("Source must be registered before acquisition")
    if spec["adapter"]=="sldem_cylindrical":
        d=sldem.RAW_DIR/source_id; filename=source_id; base=sldem.BASE_URL
        label=d/f"{filename}.lbl"
    else:
        d=lola.RAW_DIR/source_id.lower(); filename=source_id.lower()
        base=lola.POLAR_DIR if spec["adapter"]=="pds_polar" else lola.CYL_DIR
        label=lola.LABEL_DIR/f"{filename}.lbl"
    d.mkdir(parents=True,exist_ok=True);label.parent.mkdir(parents=True,exist_ok=True)
    if not label.exists():subprocess.run(["curl.exe","--fail","--location","--output",str(label),f"{base}/{filename}.lbl"],check=True)
    if spec["adapter"]=="sldem_cylindrical":expected=sldem.load_label(source_id,offline=True).expected_bytes
    else:expected=lola.load_label(source_id,"polar" if spec["adapter"]=="pds_polar" else "cylindrical").expected_bytes
    img=d/f"{filename}.img"; part=d/f"{filename}.img.part"
    if img.exists():
        if img.stat().st_size!=expected:raise ValueError(f"Existing {img} has wrong size; preserved for inspection")
    else:
        if not part.exists() or part.stat().st_size<expected:
            subprocess.run(["curl.exe","--fail","--location","--continue-at","-","--retry","3","--max-time","1200","--output",str(part),f"{base}/{filename}.img"],check=True)
        if part.stat().st_size!=expected:raise ValueError(f"Incomplete {part}: {part.stat().st_size}/{expected} bytes; rerun to resume")
        part.replace(img)
    meta=dict(url=f"{base}/{filename}.img",sha256=sha(img),bytes=expected,label_implied_bytes=expected,
              label_sha256=sha(label),certificate_verification=True)
    # Retain original download records; acquisition verification is a separate record.
    (d/"verified-source.json").write_text(json.dumps(meta,indent=2)+"\n")
    print(json.dumps(meta))

if __name__=="__main__":
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("action",choices=["fetch"]);ap.add_argument("source")
    args=ap.parse_args();acquire(args.source)
