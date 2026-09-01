import gzip
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
            "schema_version": 2,
            "generation_id": "fixture",
            "shard_range": 25000,
            "categories": [{"category": "movies", "record_count": 1, "shards": [{"sha256": "m", "range": 10}]}, {"category": "series", "record_count": 1, "shards": [{"sha256": "s", "range": 40}]}],
            "files": {"shards": [{"sha256": "f", "range": 10}]},
            "episodes": {"shards": [{"sha256": "e", "range": 40}]},
            "details": {"shards": [{"sha256": "d", "range": 10}]},
        }
        client._manifest_url = "https://catalog.example/generations/fixture/manifest.json"
        client._objects = {
            "m": [{"id": 272158, "category": "movies", "title": "Počiatok", "display_title": "Počiatok", "original_title": "Inception", "year": 2010, "release_date": "2010-07-15", "aliases": ["Inception"], "variant_count": 1}],
            "s": [{"id": 1000727, "category": "series", "title": "결혼의 완성", "display_title": "The Completion of Marriage", "original_title": "결혼의 완성", "year": 2026, "release_date": "2026-07-04", "aliases": ["The Completion of Marriage"]}],
            "d": [{"id": 272158, "category": "movies", "title": "Počiatok", "display_title": "Počiatok", "original_title": "Inception", "year": 2010, "release_date": "2010-07-15", "overview": "A detail overview", "genres": [{"name": "Science Fiction"}], "variant_count": 1}],
            "f": [{"id": 272158, "files": [{"id": 1, "ident": "fixture-ident", "name": "Inception.mkv", "needs_file_link": True}]}],
            "e": [{"id": 1000727, "episodes": [{"id": 2, "title": "S01E01", "season_number": 1, "episode_number": 1, "tvshow_id": 1000727}]}],
        }
        return client

    def test_missing_object_base_uses_generation_bound_release(self):
        client = self.client()
        sha = "a" * 64
        self.assertEqual(
            client._object_url(sha),
            "https://github.com/radovanivanic-oss/AG_repo/releases/download/atlas-catalog-fixture/{}.json.gz".format(sha),
        )
        self.assertNotIn("raw.githubusercontent.com", client._object_url(sha))

    def test_explicit_object_base_has_precedence(self):
        client = self.client()
        client._manifest["object_base_url"] = "https://objects.example/catalog/b54"
        sha = "b" * 64
        self.assertEqual(client._object_url(sha), "https://objects.example/catalog/b54/{}.json.gz".format(sha))

    def test_b49_explicit_release_base_remains_compatible(self):
        client = self.client()
        client._manifest.update({
            "generation_id": "b49-20260901T072316Z",
            "object_base_url": "https://github.com/radovanivanic-oss/AG_repo/releases/download/atlas-catalog-b49-20260901T072316Z",
        })
        sha = "c" * 64
        self.assertEqual(
            client._object_url(sha),
            "https://github.com/radovanivanic-oss/AG_repo/releases/download/atlas-catalog-b49-20260901T072316Z/{}.json.gz".format(sha),
        )

    def test_b53_generation_derives_its_own_release_identity(self):
        client = self.client()
        client._manifest["generation_id"] = "b53-20260901T130321Z"
        sha = "d" * 64
        self.assertIn(
            "/atlas-catalog-b53-20260901T130321Z/{}.json.gz".format(sha),
            client._object_url(sha),
        )

    def test_known_ag_raw_object_base_is_rejected(self):
        client = self.client()
        client._manifest["object_base_url"] = "https://raw.githubusercontent.com/radovanivanic-oss/AG_repo/main/catalog/v1/generations/fixture/objects"
        with self.assertRaises(PublicCatalogError):
            client._object_url("e" * 64)

    def test_missing_generation_identity_fails_closed(self):
        client = self.client()
        del client._manifest["generation_id"]
        with self.assertRaises(PublicCatalogError):
            client._object_url("f" * 64)

    def test_release_tag_is_escaped_without_latest_dependency(self):
        client = self.client()
        client._manifest["release_tag"] = "atlas catalog+v1"
        sha = "1" * 64
        self.assertEqual(
            client._object_url(sha),
            "https://github.com/radovanivanic-oss/AG_repo/releases/download/atlas%20catalog%2Bv1/{}.json.gz".format(sha),
        )
        self.assertNotIn("latest", client._object_url(sha).lower())

    def test_invalid_object_digest_fails_closed(self):
        client = self.client()
        with self.assertRaises(PublicCatalogError):
            client._object_url("../objects/escape")

    def test_native_and_english_search_share_canonical_entity(self):
        client = self.client()
        native = client.search("결혼의 완성", category="series")
        english = client.search("The Completion of Marriage", category="series")
        self.assertEqual([row["id"] for row in native["data"]], [1000727])
        self.assertEqual([row["id"] for row in english["data"]], [1000727])

    def test_v2_listing_is_lean_and_detail_loads_rich_metadata_on_demand(self):
        client = self.client()
        self.assertNotIn("overview", client._objects["m"][0])
        detail = client.detail(272158)
        self.assertEqual(detail["overview"], "A detail overview")
        self.assertEqual(detail["genres"][0]["name"], "Science Fiction")

    def test_detail_hierarchy_and_variant_ident_are_static(self):
        client = self.client()
        self.assertEqual(client.detail(272158)["id"], 272158)
        self.assertEqual(client.files(272158)["data"][0]["ident"], "fixture-ident")
        self.assertEqual(client.seasons(1000727)["data"], [{"season_number": 1, "episode_count": 1}])
        self.assertEqual(client.episodes(1000727)["data"][0]["id"], 2)

    def test_variant_lookup_handles_adjacent_id_ranges(self):
        client = self.client()
        client._manifest["files"]["shards"] = [{"sha256": "f0", "range": 0}, {"sha256": "f1", "range": 1}]
        client._objects["f0"] = [{"id": 24999, "files": [{"id": 9, "ident": "before-boundary"}]}]
        client._objects["f1"] = [{"id": 25000, "files": [{"id": 10, "ident": "after-boundary"}]}]
        self.assertEqual(client.files(24999)["data"][0]["ident"], "before-boundary")
        self.assertEqual(client.files(25000)["data"][0]["ident"], "after-boundary")

    def test_static_pagination_is_complete_and_non_overlapping(self):
        client = self.client()
        rows = [{"id": i, "category": "movies", "title": "Title {:02d}".format(i), "display_title": "Title {:02d}".format(i), "year": 2020, "available_files_count": 1} for i in range(1, 8)]
        client._objects["m"] = rows
        client._manifest["categories"][0]["record_count"] = len(rows)
        pages = []
        for page in range(1, 4):
            response = client.media(category="movies", page=page, limit=3, sort="title", order="asc")
            pages.append([row["id"] for row in response["data"]])
        flattened = [item for page in pages for item in page]
        self.assertEqual(flattened, list(range(1, 8)))
        self.assertEqual(len(flattened), len(set(flattened)))
        self.assertEqual(client.media(category="movies", page=3, limit=3, sort="title", order="asc")["pagination"]["has_more"], False)

    def test_precomputed_release_listing_loads_only_the_requested_chunk(self):
        client = self.client()
        rows = [{"id": i, "category": "movies", "title": "Title {:02d}".format(i), "display_title": "Title {:02d}".format(i), "year": 2026, "release_date": "2026-07-{:02d}".format(i), "available_files_count": 1} for i in range(1, 8)]
        client._manifest["listings"] = [{
            "category": "movies", "sort": "release_date_desc", "order": "desc", "chunk_size": 3,
            "record_count": len(rows), "shards": [{"sha256": "l0", "range": 0}, {"sha256": "l1", "range": 1}, {"sha256": "l2", "range": 2}],
        }]
        client._objects["l0"] = rows[0:3]
        client._objects["l1"] = rows[3:6]
        client._objects["l2"] = rows[6:7]
        result = client.media(category="movies", sort="release_date_desc", page=2, limit=3)
        self.assertEqual([row["id"] for row in result["data"]], [4, 5, 6])
        self.assertEqual(result["pagination"], {"page": 2, "limit": 3, "total": 7, "pages": 3, "has_more": True})

    def test_generation_activation_discards_old_in_memory_listing_records(self):
        client = self.client()
        client._manifest["generation_id"] = "old"
        client._records["movies"] = [{"id": 1}]
        client._search_indexes["movies"] = {"old": {1}}
        client._objects["old-object"] = []
        new_manifest = dict(client._manifest, generation_id="new", unclassified_exported=0)
        client._activate_manifest({"generation_id": "new"}, new_manifest, client.pointer_url, client._manifest_url)
        self.assertEqual(client._records, {})
        self.assertEqual(client._search_indexes, {})
        self.assertEqual(client._objects, {})

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
        with open(os.path.join(client.cache_root, "active.json"), "r", encoding="utf-8") as handle:
            active = json.loads(handle.read())
        self.assertEqual(active["pointer"]["generation_id"], "old")

    def test_later_object_failure_rolls_back_after_new_generation_activation(self):
        client = self.client()
        old_pointer = {"generation_id": "old", "manifest_path": "generations/old/manifest.json"}
        old_manifest = dict(client._manifest, generation_id="old")
        client._save_json(client._path("generations/old/manifest.json"), old_manifest)
        client._save_json(client._path("active.json"), {"pointer": old_pointer, "manifest_url": "https://catalog.example/generations/old/manifest.json"})
        client._pointer = {"generation_id": "new"}
        client._manifest = dict(old_manifest, generation_id="new")
        client._manifest_url = "https://catalog.example/generations/new/manifest.json"
        client._pending_activation = True
        good = gzip.compress(b"[]")
        good_sha = hashlib.sha256(good).hexdigest()
        client._get = lambda url: good
        client._object({"sha256": good_sha})
        client._get = lambda url: b"broken"
        with self.assertRaises(PublicCatalogError):
            client._object({"sha256": hashlib.sha256(b"expected").hexdigest()})
        with open(os.path.join(client.cache_root, "active.json"), "r", encoding="utf-8") as handle:
            active = json.loads(handle.read())
        self.assertEqual(active["pointer"]["generation_id"], "old")


if __name__ == "__main__":
    unittest.main()
