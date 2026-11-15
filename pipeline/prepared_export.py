"""Validated generic bundles -> existing app contract. Never exposes an incomplete run."""
import json
import os
import shutil
from pathlib import Path
import prepare_site
import sites
import terrain_sources as ts
import visibility as vis

def load(site):
    folder=(ts.ROOT/site["prepared_terrain"]).resolve()
    if not folder.is_relative_to((ts.ROOT/"data/prepared").resolve()):raise ValueError("Prepared terrain must be inside data/prepared")
    manifest=prepare_site.validate_bundle(folder,site)
    return folder,manifest

def terrain_block(site,samples):
    folder,manifest=load(site)
    b=json.loads((folder/"terrain.json").read_text())
    b["visibility_intervals"]=vis.classify(samples,b["horizon"])
    b["checks"]["preparation"]=dict(folder=folder.relative_to(ts.ROOT).as_posix(),fingerprint=manifest["fingerprint"],algorithm=manifest["algorithm"],validated_complete=True)
    sources=[dict(id="terrain-"+p["name"].lower().replace("_","-"),title=p["name"]+" coordinate-driven terrain source",url=p["url"],retrieved_at_utc="see source download metadata",product_version_or_filename=p["file"]+", sha256 "+p["sha256"],notes=f"{p['projection']}; {p['frame']}; {p['height_reference']}; {p['nodata_rule']}. Exact label, byte hash, registration and selection priority are recorded in the fingerprinted preparation bundle.") for p in b["products"]]
    return b,sources,""

def publish_assets(site):
    """Only run after full bundle validation. The catalog is regenerated last by the caller.

    Existing unequal public assets are refused: a reviewed regeneration must use a
    separate dataset/assets version, not silently overwrite partially completed assets.
    """
    folder,manifest=load(site);sid=site["id"]
    for suffix,subdir in (("terrain.bin","render"),("terrain.json","render"),("slope.json","screening")):
        source=folder/f"{sid}.{suffix}";dest=ts.ROOT/"app/public"/subdir/source.name
        dest.parent.mkdir(parents=True,exist_ok=True)
        if dest.exists():
            current,wanted=dest.read_bytes(),source.read_bytes()
            if suffix.endswith("json"):current,wanted=current.replace(b"\r\n",b"\n"),wanted.replace(b"\r\n",b"\n")
            if current!=wanted:
                # Replace only a known complete generated asset. Its older
                # fingerprinted bundle remains intact. Unknown assets are refused.
                known=False
                for marker in (ts.ROOT/"data/prepared").glob("*/complete.json"):
                    old=json.loads(marker.read_text());old_path=marker.parent/source.name
                    if old.get("site",{}).get("id")==sid and old_path.exists():
                        old_bytes=old_path.read_bytes()
                        if suffix.endswith("json"):old_bytes=old_bytes.replace(b"\r\n",b"\n")
                        if old_bytes==current and old["files"].get(source.name)==ts.sha(old_path):known=True;break
                if not known:raise ValueError(f"Unknown/partial asset preserved: {dest}")
            else:continue
        tmp=dest.with_name(dest.name+".pending");shutil.copyfile(source,tmp);os.replace(tmp,dest)
    return manifest

def publish(config_path,site_id,folder):
    """Attach a validated bundle, publish assets, scoped export, then catalog last."""
    import sys
    from unittest.mock import patch
    import export as exporter
    import catalog
    config_path=Path(config_path);cfg=sites.load_config(config_path)
    site=sites.select_sites(cfg,site_id)[0]
    manifest=prepare_site.validate_bundle(folder,site)
    site["prepared_terrain"]=Path(folder).relative_to(ts.ROOT).as_posix()
    publish_assets(site)
    temp=config_path.with_suffix(config_path.suffix+".pending")
    temp.write_text(json.dumps(cfg,indent=2,ensure_ascii=False)+"\n","utf-8",newline="\n")
    os.replace(temp,config_path)
    with patch.object(sys,"argv",["export.py","--config",str(config_path),"--site",site_id]):
        if exporter.main()!=0:raise ValueError("Scoped export failed; catalog not promoted")
    result=catalog.build(sites.dataset_dir(cfg),cfg)
    prepare_site.atomic_json(sites.dataset_dir(cfg)/"catalog.json",result)
    print(f"PUBLISHED LOCALLY {site_id}: complete bundle {manifest['fingerprint']}; catalog regenerated last")
