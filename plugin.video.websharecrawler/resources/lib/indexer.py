# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import time

from resources.lib.catalog import load_catalog_with_source
from resources.lib.metadata import is_video, parse_item
from resources.lib.store import AtlasStore


INDEX_VERSION = 5


class CatalogIndexer(object):
    def __init__(self, catalog_url, fallback_catalog_url=None, catalog_key="all", media_type=None):
        self.catalog_url = catalog_url
        self.fallback_catalog_url = fallback_catalog_url
        self.catalog_key = catalog_key
        self.media_type = media_type
        self.store = AtlasStore()

    def needs_rebuild(self):
        state = self.store.catalog_state()
        if not state.get("item_count"):
            return True
        if state.get("catalog_key") != self.catalog_key:
            return True
        if state.get("catalog_url") != self.catalog_url:
            return True
        return state.get("index_version") != INDEX_VERSION

    def rebuild(self, on_progress=None):
        items, used_url = load_catalog_with_source(
            self.catalog_url, self.fallback_catalog_url
        )
        rows = []
        total = len(items)

        for index, item in enumerate(items):
            if not is_video(item):
                continue
            parsed = parse_item(item, index)
            if self.media_type and parsed["media_type"] != self.media_type:
                continue
            if parsed["ident"]:
                rows.append(parsed)
            if on_progress and index % 1000 == 0:
                on_progress(index, total)

        if on_progress:
            on_progress(total, total)

        self.store.replace_items(
            rows,
            {
                "catalog": {
                    "catalog_url": self.catalog_url,
                    "fallback_catalog_url": self.fallback_catalog_url,
                    "catalog_key": self.catalog_key,
                    "media_type": self.media_type or "",
                    "source_url": used_url,
                    "indexed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                    "item_count": len(rows),
                    "index_version": INDEX_VERSION,
                }
            },
        )
        return len(rows)
