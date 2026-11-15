"""Reusable offline preparation: observer, terrain skyline, render mesh and slope.

  python pipeline/prepare_site.py --config pipeline/config.json --site apollo17-lm
  python pipeline/prepare_site.py --id smoke-point --name "Study point" --lat 20.25 --lon 30.8 --frame MOON_ME_DE421 --observer-height 1 --start 2026-12-01T00:00:00Z --end 2026-12-02T00:00:00Z --step-seconds 600

Artifacts are built/resumed under data/prepared/<fingerprint>. complete.json is
written LAST after validation; the public catalog is never changed by this command.
"""
from __future__ import annotations
import argparse
from concurrent.futures import ProcessPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import time
import uuid

import sites
import terrain_horizon as th
import terrain_sources as ts
import render_assets as render
import slope as slope_lib
import visibility as vis

VERSION="coordinate-terrain-1"
PARAMS=dict(azimuth_step_deg=.1,near_step_m=5.,near_limit_m=2000.,mid_step_m=25.,mid_limit_m=30000.,far_step_m=100.,max_search_m=500000.,h_max_m=10873.,mesh_half_width_m=1920.,screening_radius_m=500.)

def atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_name(path.name+f".{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(value,ensure_ascii=False,separators=(",",":"),allow_nan=False)+"\n","utf-8",newline="\n")
    os.replace(tmp,path)

def fingerprint(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":"),allow_nan=False).encode()).hexdigest()

def local_unit(frame,x,z):
    # Gnomonic local grid, z=-north; exact sphere geometry, no polar-grid assumptions.
    p=tuple(frame.u[k]+frame.e[k]*x/th.R-frame.n[k]*z/th.R for k in range(3))
    n=math.sqrt(sum(v*v for v in p));return tuple(v/n for v in p)

def point(terrain,frame,x,z,local=True):
    p=local_unit(frame,x,z);h,source=terrain.sample_unit(p,local=local)
    return frame.local(tuple((th.R+h)*v for v in p)),h,source

def distances(params,refine=False):
    # Halve every segment's radial step for convergence, keeping the first sample.
    factor=2 if refine else 1
    near,mid,far=(params[k]/factor for k in ("near_step_m","mid_step_m","far_step_m"))
    for first,last,step in ((5.,params["near_limit_m"],near),(params["near_limit_m"]+mid,params["mid_limit_m"],mid),(params["mid_limit_m"]+far,params["max_search_m"],far)):
        for k in range(int(round((last-first)/step))+1):yield first+k*step

def ray(terrain,site,az,params=PARAMS,refine=False):
    frame=render.Frame(site["latitude_deg"],site["longitude_deg_east"],th.R+site["horizons_site_altitude_km"]*1000)
    a=math.radians(az);v=tuple(math.cos(a)*frame.n[k]+math.sin(a)*frame.e[k] for k in range(3))
    best=-math.inf;setting=None;marks={};transitions=[];previous=None
    for d in distances(params,refine):
        q=d/th.R;c,s=math.cos(q),math.sin(q)
        for limit in (50000,100000,200000,400000):
            if d>=limit and str(limit) not in marks:marks[str(limit)]=None if setting is None else math.degrees(math.atan(best))
        if (th.R+params["h_max_m"])*c-frame.r_obs < best*(th.R+params["h_max_m"])*s:
            return dict(azimuth_deg=az,status="stopped",elevation_deg=math.degrees(math.atan(best)),end_distance_m=d,setting=setting,extent_lower_bounds_deg=marks,transitions=transitions)
        p=tuple(c*frame.u[k]+s*v[k] for k in range(3));lat,lon=th.latlon(p)
        try:h,source=terrain.sample(lat,lon)
        except ts.CoverageError as e:return dict(azimuth_deg=az,status="unavailable",elevation_deg=None,end_distance_m=d,reason=str(e),extent_lower_bounds_deg=marks)
        if source.id!=previous:
            if previous is not None:transitions.append(dict(distance_m=d,latitude_deg=lat,longitude_deg_east=lon,from_source=previous,to_source=source.id))
            previous=source.id
        value=((th.R+h)*c-frame.r_obs)/((th.R+h)*s)
        if value>best:
            best=value;setting=dict(distance_m=d,height_m=h,lat_deg=lat,lon_deg_east=lon,source=source.id)
    return dict(azimuth_deg=az,status="insufficient_extent",elevation_deg=None,end_distance_m=params["max_search_m"],extent_lower_bounds_deg=marks)

_WORK={}
def init_worker(registry,site,params,folder):
    _WORK.update(terrain=ts.Terrain(registry),site=site,params=params,folder=Path(folder))

def compute_ray(az):
    p=_WORK["folder"]/f"ray-{round(az*10):04d}.json"
    if p.exists():
        try:
            saved=json.loads(p.read_text());r=saved["ray"]
            assert saved["sha256"]==fingerprint(r)
            assert r["azimuth_deg"]==az and r["status"]=="stopped" and math.isfinite(r["elevation_deg"])
            return r
        except (ValueError,AssertionError,KeyError):pass
    r=ray(_WORK["terrain"],_WORK["site"],az,_WORK["params"])
    atomic_json(p,dict(ray=r,sha256=fingerprint(r)));return r

def make_horizon(site,observer,rays,provenance,checks,params):
    names=[p["name"] for p in provenance]
    el=[round(r["elevation_deg"],5) for r in rays]
    stops=sorted(r["end_distance_m"]/1000 for r in rays)
    near=next(p for p in provenance if p["name"]==observer["surface_source"])
    pixels={p["name"]:p["resolution_at_site_m"][1] for p in provenance}
    # Put the actual local surface source first for labels/capability metadata.
    pixels={near["name"]:max(near["resolution_at_site_m"]),**{k:v for k,v in pixels.items() if k!=near["name"]}}
    horizon=dict(model="terrain",azimuth_deg=[r["azimuth_deg"] for r in rays],elevation_deg=el,
        observer_height_above_surface_m=site["observer_height_above_surface_m"],interpolation="linear_periodic",
        processing_notes=f"Coordinate-driven {VERSION}. Airless body-centre visibility from one fixed observer; exact spherical curvature. Search extent: per-ray global-height stopping rule, bound {params['h_max_m']} m above 1737.4 km sphere. Source priority and bilinear valid-pixel selection from registry. No missing terrain replaced by zero. Radial and source-resolution limitations are in checks. Mesh never controls Horizon-view visibility.",
        search_extent=dict(h_max_m=params["h_max_m"],unknown_azimuths=0,stop_distance_km_min_median_max=[stops[0],stops[len(stops)//2],stops[-1]]),
        resolution=dict(azimuth_step_deg=params["azimuth_step_deg"],radial_step_m=[params["near_step_m"],params["far_step_m"]],radial_step_change_km=params["mid_limit_m"]/1000,radial_segments=[dict(to_km=params["near_limit_m"]/1000,step_m=params["near_step_m"]),dict(to_km=params["mid_limit_m"]/1000,step_m=params["mid_step_m"]),dict(to_km=params["max_search_m"]/1000,step_m=params["far_step_m"])],first_sample_m=5,dem_pixel_m=pixels,near_dem_pixel_m_at_site=max(near["resolution_at_site_m"])))
    def col(key,scale=1):return [r["setting"][key]*scale for r in rays]
    return dict(horizon=horizon,observer=observer,products=[{**p,"content":"heights","map_scale_m_at_pole":max(p["resolution_at_site_m"])} for p in provenance],
        setting_points=dict(note="Terrain point setting each sampled skyline; shot counts not assessed by this generic path",products=names,distance_km=col("distance_m",.001),height_m=col("height_m"),lat_deg=col("lat_deg"),lon_deg_east=col("lon_deg_east"),product_index=[names.index(r["setting"]["source"]) for r in rays],shot_count=[None]*len(rays)),checks=checks,visibility_method=vis.METHOD)

def make_mesh(terrain,site,observer,source,folder,block,workers,params):
    frame=render.Frame(site["latitude_deg"],site["longitude_deg_east"],observer["observer_radius_m"])
    native_spacing=max(20,int(math.ceil(max(source.resolution(site["latitude_deg"]))/5)*5))
    # Resolve the bilinear surface more finely without adding measured detail.
    spacing=native_spacing/4
    half=max(spacing,round(params["mesh_half_width_m"]/spacing)*spacing)
    n=int(round(2*half/spacing))+1;P=[];heights=[];used=set()
    for j in range(n):
        for i in range(n):
            pos,h,src=point(terrain,frame,(i-n//2)*spacing,(j-n//2)*spacing)
            P.extend(pos);heights.append(h);used.add(src.id)
    level=dict(n=n,pos=P,h=heights,hole=None)
    best,reach,dist=render.mesh_silhouette([level],workers=workers)
    check,rows=render.compare(best,reach,dist,block["horizon"]["elevation_deg"],block["setting_points"]["distance_km"])
    check["method"]="Exact triangle/vertical-half-plane intersections, compared with complete exported profile. Mesh stops at local footprint; authoritative profile provides distant skyline. No accuracy claim from mesh agreement."
    blob=struct.pack(f"<{len(P)}f",*P);sid=site["id"]
    binary=folder/f"{sid}.terrain.bin";binary.write_bytes(blob)
    meta=dict(asset_version="render-terrain-1",is_rendering_asset=True,note="Bilinear terrain on a uniform local gnomonic grid, no invented detail or vertical exaggeration. Curvature once. Visibility uses the authoritative profile.",site={k:site[k] for k in ("id","name","latitude_deg","longitude_deg_east","horizons_site_altitude_km")},observer={**observer,"ground_below_eye_local_y_m":-observer["eye_above_dem_surface_m"]},
        frame=dict(axes="x = east, y = up, z = -north",direction_formula="(cos el * sin az, sin el, -cos el * cos az)"),source_dem=dict(product=source.id,url=source.url,sha256=source.digest,map_scale_m=max(source.resolution(site["latitude_deg"])),sources_used=sorted(used)),
        sampling=dict(outer_half_width_m=half,unmeshed=f"Terrain beyond the {half} m half-width local square is represented only by the exported skyline in Horizon view.",triangulation="(v00,v01,v10), (v10,v01,v11); bilinear height sampling"),
        levels=[dict(index=0,spacing_m=spacing,spacing_px=spacing/max(source.resolution(site["latitude_deg"])),half_width_m=half,nx=n,ny=n,vertex_count=n*n,triangle_count=2*(n-1)**2,byte_offset=0,byte_length=len(blob),hole_cells=None,boundary_vertices_snapped=0,kind="local gnomonic grid, bilinear DEM (no extra measured detail)",height_range_m=[min(heights),max(heights)])],counts=dict(vertices=n*n,triangles=2*(n-1)**2,bin_bytes=len(blob)),local_bounds_m={k:[min(P[i::3]),max(P[i::3])] for i,k in enumerate(("x","y","z"))},mesh_check=check,reproduce="See complete.json command",bin_file=binary.name,bin_sha256=hashlib.sha256(blob).hexdigest())
    atomic_json(folder/f"{sid}.terrain.json",meta);atomic_json(folder/"mesh_check.json",dict(summary=check,per_azimuth=rows))
    return native_spacing

def make_slope(terrain,site,observer,source,folder,spacing,params):
    frame=render.Frame(site["latitude_deg"],site["longitude_deg_east"],observer["observer_radius_m"])
    radius=params["screening_radius_m"];half=math.ceil(radius/spacing)+1;n=2*half+1
    states=[];values=[];local=[];baselines=[];used=set()
    for j in range(n):
        for i in range(n):
            x,z=(i-half)*spacing,(j-half)*spacing;p=local_unit(frame,x,z)
            outside=slope_lib.ground_distance_m(frame.u,p)>radius
            try:pos,h,src=point(terrain,frame,x,z);local.append(pos);used.add(src.id)
            except ts.CoverageError:
                local.append(None);states.append(0 if outside else 2);values.append(None);continue
            if outside:states.append(0);values.append(None);continue
            P={};invalid=False
            for di in (-1,0,1):
                for dj in (-1,0,1):
                    if not(di or dj):continue
                    pp=local_unit(frame,x+di*spacing,z+dj*spacing)
                    try:hh,ss=terrain.sample_unit(pp,local=True);used.add(ss.id)
                    except ts.CoverageError:invalid=True;break
                    P[di,dj]=tuple((th.R+hh)*v for v in pp)
            if invalid:states.append(2);values.append(None);continue
            v,_,_=slope_lib.horn_slope(P,p);states.append(1);values.append(round(v*100))
            baselines.extend(math.dist(P[-1,d],P[1,d]) for d in (-1,0,1))
    samples=[(p[0],p[2],float(k%n),float(k//n)) for k,p in enumerate(local) if p is not None]
    ca,cb=slope_lib.fit_affine(samples)
    residual=max(math.hypot(ca[0]+ca[1]*x+ca[2]*z-a,cb[0]+cb[1]*x+cb[2]*z-b) for x,z,a,b in samples)
    assert residual<.1,"Slope mapping exceeds 0.1 cell; reduce footprint or use exact mapping"
    valid=sorted(v for v in values if v is not None);inside=sum(s!=0 for s in states)
    if not valid:raise ts.CoverageError("No valid slope samples in footprint")
    rings=[]
    for r in (100,250,radius):
        pts=[]
        for az in range(0,360,5):
            p=slope_lib.destination(frame.u,site["latitude_deg"],site["longitude_deg_east"],az,r)
            h,_=terrain.sample_unit(p,local=True);pts.append(frame.local(tuple((th.R+h)*v for v in p)))
        rings.append(dict(radius_m=r,is_analysis_boundary=r==radius,points=pts))
    asset=dict(asset_version="slope-1",is_screening_asset=True,site={k:site[k] for k in ("id","name","latitude_deg","longitude_deg_east","horizons_site_altitude_km")},observer=dict(observer_radius_m=frame.r_obs),
        source_dem=dict(product=source.id,sha256=source.digest,map_scale_m=max(source.resolution(site["latitude_deg"])),anchor_pixel_1based=list(source.pixel_of(site["latitude_deg"],site["longitude_deg_east"])),counts_product=None,sources_used=sorted(used)),
        method=dict(name="Horn 3x3 on true 3D positions of bilinearly sampled local gnomonic grid",neighbourhood="3x3 samples with 1-2-1 weights",baseline_m=sum(baselines)/len(baselines),baseline_min_max_m=[min(baselines),max(baselines)],neighbourhood_extent_m=3*spacing,cell_ground_m=spacing,scale_note=f"Source pixels about {max(source.resolution(site['latitude_deg'])):.1f} m; resampled local {spacing} m grid; slope measured across about {2*spacing} m. Bilinear interpolation adds no measured detail.",percentiles="nearest rank on stored centidegrees",exceedance="stored slope strictly greater than threshold",area_weighting="equal local sampling cells; gnomonic area variation negligible over 500 m",invalid="missing any neighbor: unknown, excluded; never flat"),
        footprint=dict(radius_m=radius,cells_in_footprint=inside,cells_valid=len(valid),cells_invalid=inside-len(valid),valid_fraction=len(valid)/inside),
        grid=dict(nx=n,ny=n,state=states,slope_centideg=values,local_to_cell=dict(a=ca,b=cb,max_residual_cells=residual),check_points=[dict(cell=[k%n,k//n],local_xyz=list(local[k])) for k in (0,n-1,half*n+half,n*n-1) if local[k] is not None]),
        observer_cell=dict(cell=[half,half],slope_deg=values[half*n+half]/100 if values[half*n+half] is not None else None),stats=dict(median_deg=slope_lib.nearest_rank(valid,50)/100,p95_deg=slope_lib.nearest_rank(valid,95)/100,max_deg=valid[-1]/100,min_deg=valid[0]/100),default_threshold_deg=15,shot_quality=dict(fraction_cells_with_lola_shot=None,cells_with_no_shot_in_3x3=None,note="Shot counts not assessed by this path; unknown, not zero"),rings=rings,reproduce="See complete.json command")
    atomic_json(folder/f"{site['id']}.slope.json",asset)
    atomic_json(folder/"slope_report.json",dict(method=asset["method"],footprint=asset["footprint"],stats=asset["stats"],mapping=asset["grid"]["local_to_cell"]))

def validate_bundle(folder,expected_site=None):
    folder=Path(folder);manifest=json.loads((folder/"complete.json").read_text())
    if manifest["algorithm"]!=VERSION:raise ValueError("Unsupported preparation version")
    identity=json.loads((folder/"input.json").read_text())
    if fingerprint(identity)!=manifest["fingerprint"] or folder.name!=manifest["fingerprint"]:raise ValueError("Preparation fingerprint mismatch")
    if expected_site is not None:sites.require_identity(manifest["site"],expected_site,"prepared bundle")
    for filename,digest in manifest["files"].items():
        if Path(filename).name!=filename or ts.sha(folder/filename)!=digest:raise ValueError(f"Prepared product missing/corrupted: {filename}")
    validate_products(folder,manifest["site"])
    return manifest

def validate_products(folder,site):
    sid=site["id"];b=json.loads((folder/"terrain.json").read_text());h=b["horizon"]
    if h["azimuth_deg"]!=[round(k*.1,6) for k in range(3600)] or len(h["elevation_deg"])!=3600 or any(e is None or not math.isfinite(e) or not -90<=e<=90 for e in h["elevation_deg"]):raise ValueError("Incomplete/invalid terrain profile")
    expected=th.R+1000*site["horizons_site_altitude_km"]
    for suffix in ("terrain.json","slope.json"):
        a=json.loads((folder/f"{sid}.{suffix}").read_text());sites.require_identity({**sites.identity(site),**a["site"]},site,"generated asset")
        if abs(a["observer"]["observer_radius_m"]-expected)>1e-7:raise ValueError("Asset observer mismatch")
    mesh=json.loads((folder/f"{sid}.terrain.json").read_text());raw=(folder/f"{sid}.terrain.bin").read_bytes()
    if len(raw)!=mesh["counts"]["bin_bytes"] or hashlib.sha256(raw).hexdigest()!=mesh["bin_sha256"]:raise ValueError("Mesh size/checksum mismatch")
    if any(not math.isfinite(v[0]) for v in struct.iter_unpack("<f",raw)):raise ValueError("Nonfinite mesh vertex")
    slope=json.loads((folder/f"{sid}.slope.json").read_text());g=slope["grid"]
    if len(g["state"])!=g["nx"]*g["ny"] or len(g["slope_centideg"])!=len(g["state"]):raise ValueError("Slope dimensions mismatch")
    if any(st not in (0,1,2) or ((st==1)!=(v is not None)) or (v is not None and (not isinstance(v,int) or not 0<=v<=9000)) for st,v in zip(g["state"],g["slope_centideg"])):raise ValueError("Invalid slope/nodata states")
    if g["local_to_cell"]["max_residual_cells"]>=.1:raise ValueError("Slope grid mapping exceeds tolerance")

def build(site,scenario,registry=ts.REGISTRY,workers=4,params=None):
    site={k:v for k,v in site.items() if k not in ("prepared_terrain","preparation_status")}
    params={**PARAMS,**(params or {})};terrain=ts.Terrain(registry)
    try:
        lat,lon=ts.normalize(site["latitude_deg"],site["longitude_deg_east"]);site={**site,"latitude_deg":lat,"longitude_deg_east":lon}
        nominal=site["observer_height_above_surface_m"]
        if not math.isfinite(nominal) or nominal<=0:raise ValueError("Observer height must be finite and positive")
        surface,source=terrain.sample(lat,lon,local=True)
        altitude=round((round(surface,1)+nominal)/1000,7)
        if site.get("horizons_site_altitude_km") is not None:
            altitude=site["horizons_site_altitude_km"]
            if abs(altitude*1000-surface-nominal)>.050001:raise ValueError("Configured observer differs from terrain-derived observer by more than surface rounding; preserve caches and review explicitly")
        site={**site,"horizons_site_altitude_km":altitude,"surface_elevation_m":round(surface,1)}
        provenance=[]
        for src in terrain.sources:
            p=src.provenance();p["resolution_at_site_m"]=list(src.resolution(lat));provenance.append(p)
        implementation={name:ts.sha(ts.ROOT/"pipeline"/name) for name in ("prepare_site.py","terrain_sources.py","terrain_horizon.py","render_assets.py","slope.py","lola.py","sldem.py")}
        identity=dict(algorithm=VERSION,sampler_version=ts.VERSION,implementation_sha256=implementation,site=site,scenario=scenario,parameters=params,sources=provenance,registry=terrain.registry)
        key=fingerprint(identity);folder=ts.ROOT/"data/prepared"/key;folder.mkdir(parents=True,exist_ok=True)
        if (folder/"complete.json").exists():
            validate_bundle(folder,site);print(f"CACHE VALID {folder.relative_to(ts.ROOT)}",flush=True);return folder
        atomic_json(folder/"input.json",identity)
        observer=dict(observer_radius_m=th.R+altitude*1000,dem_surface_at_site_m=surface,eye_above_dem_surface_m=altitude*1000-surface,surface_source=source.id)
        atomic_json(folder/"observer.json",dict(site=sites.identity(site),observer=observer))
        azs=[round(i*params["azimuth_step_deg"],6) for i in range(round(360/params["azimuth_step_deg"]))]
        print(f"BUILD {site['id']} fingerprint={key} surface={surface:.6f} m source={source.id}; {len(azs)} rays",flush=True)
        rays_dir=folder/"rays";rays_dir.mkdir(exist_ok=True)
        with ProcessPoolExecutor(max_workers=workers,initializer=init_worker,initargs=(str(registry),site,params,str(rays_dir))) as pool:rays=list(pool.map(compute_ray,azs,chunksize=12))
        missing=[r for r in rays if r["status"]!="stopped"]
        if missing:
            atomic_json(folder/"unavailable.json",dict(missing_azimuths=missing));raise ts.CoverageError(f"{len(missing)} skyline rays lack complete coverage/extent; see {folder}/unavailable.json. No complete bundle or capabilities published.")
        refined=[ray(terrain,site,float(az),params,refine=True) for az in range(0,360,10)]
        diffs=[abs(r["elevation_deg"]-rays[round(r["azimuth_deg"]/.1)]["elevation_deg"]) for r in refined]
        stability={}
        for d in (50000,100000,200000,400000):
            deltas=[r["elevation_deg"]-r["extent_lower_bounds_deg"].get(str(d),r["elevation_deg"]) for r in rays]
            stability[str(d)]=dict(max_increase_to_complete_deg=max(deltas),rays_stopped_within_extent=sum(r["end_distance_m"]<=d for r in rays))
        overlaps={}
        for r in rays:
            for transition in r["transitions"]:
                a=next(s for s in terrain.sources if s.id==transition["from_source"]);b=next(s for s in terrain.sources if s.id==transition["to_source"])
                # Check just inside the departing source, where both products overlap.
                frame=render.Frame(lat,lon,observer["observer_radius_m"])
                pp=slope_lib.destination(frame.u,lat,lon,r["azimuth_deg"],max(5,transition["distance_m"]-500))
                ll=th.latlon(pp);ha,hb=a.sample(*ll),b.sample(*ll)
                if ha is not None and hb is not None:overlaps.setdefault(a.id+" -> "+b.id,[]).append(ha-hb)
        checks=dict(radial_convergence=dict(azimuths_deg=list(range(0,360,10)),refined_steps_m=[params[k]/2 for k in ("near_step_m","mid_step_m","far_step_m")],max_abs_change_deg=max(diffs),note="Every radial segment halved at 36 azimuths on the same DEM; not absolute terrain accuracy; first sample remains 5 m."),search_extent_stability=stability,source_overlap={k:dict(samples=len(v),min_m=min(v),max_m=max(v),mean_m=sum(v)/len(v),note="Bilinear heights 500 m inside source transition; difference retained without averaging or vertical adjustment") for k,v in overlaps.items()},source_transition_count=sum(len(r["transitions"]) for r in rays),limitations=["Source coordinates/frames retain their documented assumptions.","Global LDEM_64 is coarse distant terrain only; grid spacing varies with latitude. No fine obstacles are resolved.","No independent absolute terrain accuracy established. Source overlap statistics are differences, not accuracy estimates."])
        used={source.id}|{r["setting"]["source"] for r in rays}|{name for r in rays for tr in r["transitions"] for name in (tr["from_source"],tr["to_source"])}
        block=make_horizon(site,observer,rays,[p for p in provenance if p["name"] in used],checks,params)
        atomic_json(folder/"terrain.json",block);atomic_json(folder/"horizon_report.json",dict(site=sites.identity(site),rays=rays,checks=checks,identity=identity))
        spacing=make_mesh(terrain,site,observer,source,folder,block,workers,params)
        make_slope(terrain,site,observer,source,folder,spacing,params)
        # Internal validation before completion marker. No public asset writes here.
        validate_products(folder,site)
        files={p.name:ts.sha(p) for p in folder.iterdir() if p.is_file() and p.suffix in (".json",".bin") and p.name not in ("complete.json","unavailable.json")}
        manifest=dict(algorithm=VERSION,fingerprint=key,site=site,scenario=scenario,files=files,checks=checks,command="python "+" ".join(sys.argv),completed_at_utc=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()))
        atomic_json(folder/"complete.json",manifest);validate_bundle(folder,site)
        print(f"COMPLETE {folder.relative_to(ts.ROOT)}; eye={observer['eye_above_dem_surface_m']:.6f} m; refine max={max(diffs):.6f} deg",flush=True)
        return folder
    finally:terrain.close()

def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument("--config");ap.add_argument("--site");ap.add_argument("--id");ap.add_argument("--name");ap.add_argument("--lat",type=float);ap.add_argument("--lon",type=float);ap.add_argument("--frame",choices=[ts.FRAME]);ap.add_argument("--observer-height",type=float);ap.add_argument("--start");ap.add_argument("--end");ap.add_argument("--step-seconds",type=int);ap.add_argument("--registry",default=str(ts.REGISTRY));ap.add_argument("--workers",type=int,default=4);ap.add_argument("--publish",action="store_true",help="configured site: validated assets + scoped export + catalog, local only")
    a=ap.parse_args()
    if a.config:
        cfg=sites.load_config(a.config);s=sites.select_sites(cfg,a.site)[0]
        # Existing free-text source-frame description remains attached; this explicit field authorizes interpretation.
        if s.get("terrain_coordinate_frame")!=ts.FRAME:ap.error("Set terrain_coordinate_frame=MOON_ME_DE421 explicitly in site config after reviewing its source convention")
        scenario={k:cfg[k] for k in ("coverage_start_utc","coverage_end_utc","sample_step_seconds")}
    else:
        if any(x is None for x in (a.id,a.name,a.lat,a.lon,a.frame,a.observer_height,a.start,a.end,a.step_seconds)):ap.error("Supply config/site or all coordinate, frame, observer and time inputs")
        s=dict(id=sites.valid_id(a.id),name=a.name,latitude_deg=a.lat,longitude_deg_east=a.lon,terrain_coordinate_frame=a.frame,observer_height_above_surface_m=a.observer_height,point_type="study_location")
        scenario=dict(coverage_start_utc=a.start,coverage_end_utc=a.end,sample_step_seconds=a.step_seconds)
    dt=(vis.parse_utc(scenario["coverage_end_utc"])-vis.parse_utc(scenario["coverage_start_utc"])).total_seconds();step=scenario["sample_step_seconds"]
    if step<=0 or step%60 or dt<=0 or dt%step:ap.error("Date range must increase by whole positive minute-based sample steps")
    if a.publish and not a.config:ap.error("Public catalog promotion requires a documented configured site; CLI study points remain private preprocessing artifacts")
    folder=build(s,scenario,a.registry,a.workers)
    if a.publish:
        import prepared_export
        prepared_export.publish(a.config,s["id"],folder)
    return 0

if __name__=="__main__":
    try:raise SystemExit(main())
    except (ValueError,OSError,RuntimeError) as e:print(f"ERROR: {e}",file=sys.stderr);raise SystemExit(1)
