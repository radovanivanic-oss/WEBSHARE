import hashlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ADDON_ROOT = ROOT / "plugin.video.websharecrawler"
if str(ADDON_ROOT) not in sys.path:
    sys.path.insert(0, str(ADDON_ROOT))

xbmcvfs = types.ModuleType("xbmcvfs")
xbmcvfs.translatePath = lambda value: tempfile.gettempdir()
xbmcvfs.exists = lambda value: True
xbmcvfs.mkdirs = lambda value: True
sys.modules["xbmcvfs"] = xbmcvfs

from resources.lib.public_catalog import PublicCatalogClient, PublicCatalogError


class PublicCatalogTests(unittest.TestCase):
    def client(self):
        client = PublicCatalogClient("https://catalog.example/current.json", cache_root=tempfile.mkdtemp(prefix="atlas-public-"))
        client._manifest = {
            "schema": "webshare-atlas-public-catalog/v1",
            "schema_version": 1,
            "generation_id": "fixture",
            "shard_range": 25000,
            "categories": [{"category": "movies", "record_count": 1, "shards": [{"sha256": "m", "range": 0}]}, {"category": "series", "record_count": 1, "shards": [{"sha256": "s", "range": 0}]}],
            "files": {"shards": [{"sha256": "f", "range": 10}]},
            "episodes": {"shards": [{"sha256": "e", "range": 40}]},
        }
        client._manifest_url = "https://catalog.example/generations/fixture/manifest.json"
        client._objects = {
            "m": [{"id": 272158, "category": "movies", "title": "Počiatok", "display_title": "Počiatok", "original_title": "Inception", "year": 2010, "release_date": "2010-07-15", "aliases": ["Inception"]}],
            "s": [{"id": 1000727, "category": "series", "title": "결혼의 완성", "display_title": "The Completion of Marriage", "original_title": "결혼의 완성", "year": 2026, "release_date": "2026-07-04", "aliases": ["The Completion of Marriage"]}],
            "f": [{"id": 272158, "files": [{"id": 1, "ident": "fixture-ident", "name": "Inception.mkv", "needs_file_link": True}]}],
            "e": [{"id": 1000727, "episodes": [{"id": 2, "title": "S01E01", "season_number": 1, "episode_number": 1, "tvshow_id": 1000727}]}],
        }
        return client

    def test_native_and_english_search_share_canonical_entity(self):
        client = self.client()
        native = client.search("결혼의 완성", category="series")
        english = client.search("The Completion of Marriage", category="series")
        self.assertEqual([row["id"] for row in native["data"]], [1000727])
        self.assertEqual([row["id"] for row in english["data"]], [1000727])

    def test_detail_hierarchy_and_variant_ident_are_static(self):
        client = self.client()
        self.assertEqual(client.detail(272158)["id"], 272158)
        self.assertEqual(client.files(272158)["data"][0]["ident"], "fixture-ident")
        self.assertEqual(client.seasons(1000727)["data"], [{"season_number": 1, "episode_count": 1}])
        self.assertEqual(client.episodes(1000727)["data"][0]["id"], 2)

    def test_corrupt_cached_object_fails_closed(self):
        client = self.client()
        client._objects = {}
        client._get = lambda url: b"not-gzip"
        with self.assertRaises(PublicCatalogError):
            client._object({"sha256": hashlib.sha256(b"expected").hexdigest()})

    def test_invalid_new_generation_keeps_last_active_generation(self):
        client = self.client()
        old_pointer = {"generation_id": "old", "manifest_path": "generations/old/manifest.json"}
        old_manifest = dict(client._manifest, generation_id="old")
        client._save_json(client._path("generations/old/manifest.json"), old_manifest)
        client._save_json(client._path("active.json"), {"pointer": old_pointer, "manifest_url": "https://catalog.example/generations/old/manifest.json"})
        new_manifest = {"schema": "webshare-atlas-public-catalog/v1", "schema_version": 1, "generation_id": "new", "unclassified_exported": 0, "categories": [], "files": {"shards": []}, "episodes": {"shards": []}}
        new_raw = (json.dumps(new_manifest, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        new_pointer = {"schema": "webshare-atlas-public-catalog-current/v1", "schema_version": 1, "generation_id": "new", "manifest_path": "generations/new/manifest.json", "manifest_sha256": hashlib.sha256(new_raw).hexdigest()}
        responses = [json.dumps(new_pointer).encode("utf-8"), new_raw]
        client._get = lambda url: responses.pop(0) if responses else b"not-gzip"
        client.refresh()
        with self.assertRaises(PublicCatalogError):
            client._object({"sha256": hashlib.sha256(b"expected").hexdigest()})
        active = json.loads(open(os.path.join(client.cache_root, "active.json"), "r", encoding="utf-8").read())
        self.assertEqual(active["pointer"]["generation_id"], "old")


if __name__ == "__main__":
    unittest.main()
