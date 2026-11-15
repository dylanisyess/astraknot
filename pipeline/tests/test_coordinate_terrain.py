"""Synthetic adapter/geometry tests and prepared-bundle refusal. No NASA network."""
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parent.parent))
import terrain_sources as ts
import prepare_site as prep
import terrain_horizon as th
import render_assets as ra
import slope

def tile(west=0,values=None):
    # Synthetic 2x2 one-degree tile, pixel centres .5/1.5 degrees.
    s=object.__new__(ts.Source);s.id=f"tile-{west}";s.kind="sldem_cylindrical";s.periodic=False
    s.width=s.height=2;s.res=1;s.lpo=1.5;s.spo=179.5-west;s.center_lon=180;s.bounds=[0,2,west,west+2]
    s.scale=1;s.nodata=None;s.data=[1.,2.,3.,4.] if values is None else values
    s.spec=dict(local=True,priority=1)
    return s

class SourceGeometry(unittest.TestCase):
    def test_normalize_wrap_and_reject_invalid(self):
        self.assertEqual(ts.normalize(20,-329.2),(20,30.80000000000001))
        self.assertEqual(ts.normalize(-80,721),(-80,1))
        for lat,lon in [(91,0),(0,float('nan')),(float('inf'),0)]:
            with self.assertRaises(ValueError):ts.normalize(lat,lon)

    def test_cylindrical_registration_units_and_orientation(self):
        s=tile();self.assertEqual(s.pixel_of(1.5,.5),(1,1));self.assertEqual(s.sample(1,1),2.5)
        self.assertAlmostEqual(th.latlon(s.unit_at(1,1))[0],1.5)
        self.assertAlmostEqual(th.latlon(s.unit_at(1,1))[1],.5)
        s.scale=1000;self.assertEqual(s.sample(1,1),2500)
        self.assertIsNone(s.sample(1,5))

    def test_nodata_nan_and_edges_never_flat(self):
        for v in (None,float('nan'),-9999):
            s=tile(values=[1,2,3,float('nan') if v is None else v]);s.nodata=-9999
            self.assertIsNone(s.sample(1,1))

    def test_registered_tile_edge_stitches_bilinear_neighbors(self):
        a,b=tile(),tile(2,values=[5.,6.,7.,8.]);t=object.__new__(ts.Terrain);t.sources=[a,b];t.missing=[]
        # Boundary lon=2 lies between pixel centres 1.5 and 2.5, not a flat edge.
        h,s=t.sample(1,2,local=False);self.assertEqual(h,4.5)
        t.sources=[a]
        with self.assertRaises(ts.CoverageError):t.sample(1,2)

    def test_global_wrap_interpolates_first_last_columns(self):
        s=tile();s.width=4;s.height=2;s.res=1/90;s.lpo=.5;s.spo=1.5;s.center_lon=180;s.bounds=[-90,90,0,360];s.periodic=True;s.data=[1.,2.,3.,4.,1.,2.,3.,4.]
        self.assertAlmostEqual(s.sample(0,0),2.5)
        self.assertEqual(s.sample(0,0),s.sample(0,360))

    def test_local_grid_cardinals_and_sphere_slope(self):
        for lat,lon in [(20,31),(-80,1),(-89,223)]:
            f=ra.Frame(lat,lon,th.R+1000)
            east=f.local(tuple(th.R*x for x in prep.local_unit(f,100,0)))
            north=f.local(tuple(th.R*x for x in prep.local_unit(f,0,-100)))
            self.assertGreater(east[0],99);self.assertLess(north[2],-99)
            P={(i,j):tuple(th.R*v for v in prep.local_unit(f,i*60,j*60)) for i in (-1,0,1) for j in (-1,0,1) if i or j}
            self.assertLess(slope.horn_slope(P,f.u)[0],1e-6)

    def test_missing_coarse_only_never_becomes_local_capability(self):
        s=tile();s.spec['local']=False;t=object.__new__(ts.Terrain);t.sources=[s];t.missing=[]
        self.assertEqual(t.sample(1,1)[0],2.5)
        with self.assertRaisesRegex(ts.CoverageError,'local.*100 m'):t.sample(1,1,local=True)

    def test_fingerprint_changes_for_coordinate_observer_source_and_algorithm(self):
        a=dict(lat=20,lon=31,observer=1,sources=['abc'],algorithm='v1')
        for k,v in [('lat',21),('lon',32),('observer',2),('sources',['def']),('algorithm','v2')]:
            self.assertNotEqual(prep.fingerprint(a),prep.fingerprint({**a,k:v}))

    def test_incomplete_run_has_no_complete_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            prep.atomic_json(Path(d)/'observer.json',{'partial':True})
            with self.assertRaises(FileNotFoundError):prep.validate_bundle(d)

    def test_generic_horizon_matches_analytic_sphere_and_explicit_extent_failure(self):
        class Flat:
            def sample(self,lat,lon):return 1000.,type('Source',(),{'id':'synthetic-flat'})()
        site=dict(latitude_deg=20,longitude_deg_east=31,horizons_site_altitude_km=1.001)
        result=prep.ray(Flat(),site,359.9)
        expected=-math.degrees(math.acos((th.R+1000)/(th.R+1001)))
        self.assertEqual(result['status'],'stopped')
        self.assertAlmostEqual(result['elevation_deg'],expected,places=3)
        result=prep.ray(Flat(),site,0,{**prep.PARAMS,'max_search_m':31000})
        self.assertEqual(result['status'],'insufficient_extent');self.assertIsNone(result['elevation_deg'])

if __name__=='__main__':unittest.main()
