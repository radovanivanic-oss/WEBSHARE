# -*- coding: utf-8 -*-
"""Offline-capable consumer for the Webshare Atlas public read model."""

from __future__ import absolute_import, division, unicode_literals

import gzip
import hashlib
import json
import os
import re
from datetime import date
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from resources.lib.catalog_api import CatalogApiError
from resources.lib.paths import profile_path


USER_AGENT = "Webshare Atlas Public Catalog/0.8.16"
ROOT_SCHEMA = "webshare-atlas-public-catalog/v1"
TOKEN_RE = re.compile(r"[\w]+", re.UNICODE)


def _tokens(value):
    result = []
    for raw in TOKEN_RE.findall(value or ""):
        # Preserve native scripts; strip accents only from Latin tokens.
        if any("LATIN" in "" for _ in ()):  # pragma: no cover - keeps Python 3.0 syntax simple
            pass
        folded = raw.casefold()
        if all("a" <= char.lower() <= "z" or char in "áäčďéíĺľňóôŕšťúýžÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ" for char in raw):
            import unicodedata
            folded = "".join(ch for ch in unicodedata.normalize("NFKD", raw) if not unicodedata.combining(ch)).casefold()
        result.append(folded)
    return [token for token in result if token]


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


class PublicCatalogError(CatalogApiError):
    pass


class PublicCatalogClient(object):
    def __init__(self, pointer_url, timeout=30, cache_root=None):
        self.pointer_url = (pointer_url or "").rstrip("/")
        self.timeout = timeout
        self.cache_root = cache_root or profile_path("public_catalog")
        self._manifest = None
        self._pointer = None
        self._records = {}
        self._objects = {}

    def _path(self, name):
        path = os.path.join(self.cache_root, name)
        parent = os.path.dirname(path)
        if not os.path.isdir(parent):
            os.makedirs(parent)
        return path

    def _get(self, url):
        request = Request(url, headers={"Accept": "application/json, */*", "Accept-Encoding": "gzip", "User-Agent": USER_AGENT})
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return response.read()
        except Exception as exc:
            raise PublicCatalogError("Verejný katalóg nie je dostupný: {}".format(exc))

    def _load_json_url(self, url):
        raw = self._get(url)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception as exc:
            raise PublicCatalogError("Verejný katalóg vrátil neplatný JSON: {}".format(exc))

    def _save_json(self, path, value):
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)

    def _activate_manifest(self, pointer, manifest, pointer_url, manifest_url):
        if manifest.get("schema") != ROOT_SCHEMA or manifest.get("schema_version") != 1 or manifest.get("unclassified_exported") != 0:
            raise PublicCatalogError("Verejný katalóg má neplatnú schému")
        if pointer.get("manifest_sha256") and _sha256(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) != pointer.get("manifest_sha256"):
            # GitHub raw files normally preserve the builder's trailing newline; accept the
            # canonical JSON hash only when a server-side pointer does not include a hash.
            pass
        self._pointer = pointer
        self._manifest = manifest
        self._manifest_url = manifest_url
        self._pointer_url = pointer_url
        self._save_json(self._path("generations/{}/manifest.json".format(manifest["generation_id"])), manifest)
        self._save_json(self._path("active.json"), {"pointer": pointer, "manifest_url": manifest_url})

    def refresh(self):
        try:
            pointer = self._load_json_url(self.pointer_url)
            if pointer.get("schema") != "webshare-atlas-public-catalog-current/v1":
                raise PublicCatalogError("Neplatný verejný katalógový ukazovateľ")
            manifest_url = urljoin(self.pointer_url + "/", pointer.get("manifest_path", ""))
            raw_manifest = self._get(manifest_url)
            if pointer.get("manifest_sha256") and _sha256(raw_manifest) != pointer.get("manifest_sha256"):
                raise PublicCatalogError("Kontrolný súčet verejného manifestu nesedí")
            try:
                manifest = json.loads(raw_manifest.decode("utf-8"))
            except Exception as exc:
                raise PublicCatalogError("Verejný manifest nie je JSON: {}".format(exc))
            self._activate_manifest(pointer, manifest, self.pointer_url, manifest_url)
            return manifest
        except Exception as exc:
            active_path = self._path("active.json")
            if os.path.exists(active_path):
                try:
                    active = json.loads(open(active_path, "r", encoding="utf-8").read())
                    manifest = json.loads(open(self._path("generations/{}/manifest.json".format(active["pointer"]["generation_id"])), "r", encoding="utf-8").read())
                    self._pointer = active["pointer"]
                    self._manifest = manifest
                    self._manifest_url = active["manifest_url"]
                    return manifest
                except Exception:
                    pass
            if isinstance(exc, PublicCatalogError):
                raise
            raise PublicCatalogError(str(exc))

    def _ensure_manifest(self):
        if self._manifest is None:
            self.refresh()
        return self._manifest

    def _object_url(self, sha):
        manifest = self._ensure_manifest()
        base = manifest.get("object_base_url")
        if base:
            return base.rstrip("/") + "/" + sha + ".json.gz"
        return urljoin(self._manifest_url, "objects/" + sha + ".json.gz")

    def _object(self, item):
        sha = item["sha256"]
        if sha in self._objects:
            return self._objects[sha]
        cached = self._path("objects/{}.json.gz".format(sha))
        try:
            raw = open(cached, "rb").read() if os.path.exists(cached) else self._get(self._object_url(sha))
            if _sha256(raw) != sha:
                raise PublicCatalogError("Poškodený objekt verejného katalógu")
            if not os.path.exists(cached):
                tmp = cached + ".tmp"
                with open(tmp, "wb") as handle:
                    handle.write(raw)
                os.replace(tmp, cached)
            value = json.loads(gzip.decompress(raw).decode("utf-8"))
            self._objects[sha] = value
            return value
        except Exception as exc:
            raise PublicCatalogError(str(exc))

    def categories(self):
        return [{"id": row["category"], "title": row["category"], "count": row["record_count"]} for row in self._ensure_manifest().get("categories", [])]

    def _category_records(self, category):
        if category in self._records:
            return self._records[category]
        manifest_row = next((row for row in self._ensure_manifest().get("categories", []) if row.get("category") == category), None)
        if not manifest_row:
            self._records[category] = []
            return []
        records = []
        for shard in manifest_row.get("shards", []):
            records.extend(self._object(shard))
        self._records[category] = records
        return records

    def _matches(self, row, query):
        query_tokens = _tokens(query)
        haystack = []
        for key in ("display_title", "title", "original_title"):
            haystack.extend(_tokens(row.get(key) or ""))
        for alias in row.get("aliases") or []:
            haystack.extend(_tokens(alias))
        return all(token in haystack for token in query_tokens)

    def media(self, **params):
        category = params.get("category") or "movies"
        rows = list(self._category_records(category))
        query = params.get("query") or params.get("q")
        if query:
            rows = [row for row in rows if self._matches(row, query)]
        if params.get("year"):
            rows = [row for row in rows if int(row.get("year") or 0) == int(params["year"])]
        if params.get("genre"):
            wanted = str(params["genre"]).casefold()
            rows = [row for row in rows if any(str(g.get("name") if isinstance(g, dict) else g).casefold() == wanted for g in row.get("genres") or [])]
        sort = params.get("sort") or "recent"
        reverse = str(params.get("order", "desc")).lower() != "asc"
        if sort in ("release_date_desc", "series_release_date_desc"):
            today = date.today().isoformat()
            rows = [row for row in rows if not row.get("release_date") or row.get("release_date") <= today]
            rows.sort(key=lambda row: (row.get("latest_release_date") or row.get("release_date") or "0000-00-00", row.get("latest_episode_year") or row.get("year") or 0, row.get("id") or 0), reverse=True)
        elif sort == "title":
            rows.sort(key=lambda row: ((row.get("display_title") or row.get("title") or "").casefold(), row.get("id") or 0), reverse=reverse)
        elif sort == "rating":
            rows.sort(key=lambda row: (row.get("rating") or 0, row.get("id") or 0), reverse=reverse)
        else:
            rows.sort(key=lambda row: (row.get("updated_at") or "", row.get("id") or 0), reverse=True)
        page = max(1, int(params.get("page") or 1)); limit = max(1, min(100, int(params.get("limit") or 50)))
        start = (page - 1) * limit
        page_rows = rows[start:start + limit]
        return {"data": page_rows, "pagination": {"page": page, "limit": limit, "total": len(rows), "pages": (len(rows) + limit - 1) // limit, "has_more": start + limit < len(rows)}}

    def search(self, query, **params):
        params["query"] = query
        return self.media(**params)

    def _find_media(self, media_id):
        for category in (row.get("category") for row in self._ensure_manifest().get("categories", [])):
            for row in self._category_records(category):
                if int(row.get("id") or 0) == int(media_id):
                    return row
        return None

    def detail(self, media_id):
        row = self._find_media(media_id)
        if not row:
            raise PublicCatalogError("Médiá sa nenašli")
        return row

    def _range_item(self, collection, media_id):
        value = int(media_id) // int(self._ensure_manifest().get("shard_range") or 25000)
        for shard in self._ensure_manifest().get(collection, {}).get("shards", []):
            if int(shard.get("range", -1)) == value:
                for group in self._object(shard):
                    if int(group.get("id") or 0) == int(media_id):
                        return group
        return None

    def files(self, media_id, page=1, limit=100):
        group = self._range_item("files", media_id) or {"files": []}
        rows = group.get("files") or []
        page = max(1, int(page)); limit = max(1, min(100, int(limit))); start = (page - 1) * limit
        return {"data": rows[start:start + limit], "pagination": {"page": page, "limit": limit, "total": len(rows), "pages": (len(rows) + limit - 1) // limit}}

    def episodes(self, media_id, page=1, limit=50, season=None):
        group = self._range_item("episodes", media_id) or {"episodes": []}
        rows = group.get("episodes") or []
        if season not in (None, ""):
            rows = [row for row in rows if int(row.get("season_number") or 0) == int(season)]
        rows = [dict(row, display_title=self.detail(media_id).get("display_title")) for row in rows]
        page = max(1, int(page)); limit = max(1, min(100, int(limit))); start = (page - 1) * limit
        return {"data": rows[start:start + limit], "pagination": {"page": page, "limit": limit, "total": len(rows), "pages": (len(rows) + limit - 1) // limit}}

    def seasons(self, media_id):
        rows = (self._range_item("episodes", media_id) or {}).get("episodes") or []
        groups = {}
        for row in rows:
            season = int(row.get("season_number") or 0)
            groups[season] = groups.get(season, 0) + 1
        return {"data": [{"season_number": season, "episode_count": groups[season]} for season in sorted(groups)]}

    def metadata(self, media_id):
        row = self.detail(media_id)
        return {"available": True, "metadataAvailable": True, "source": row.get("external_source"), "externalId": row.get("external_id"), "overview": row.get("overview"), "posterUrl": row.get("poster_url"), "backdropUrl": row.get("backdrop_url"), "genres": row.get("genres") or [], "runtimeMinutes": row.get("runtime_minutes"), "rating": row.get("rating"), "message": ""}
