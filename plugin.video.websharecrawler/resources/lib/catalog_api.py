# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen


USER_AGENT = "Webshare Atlas Catalog API/0.8.34"


class CatalogApiError(Exception):
    pass


class CatalogApiClient(object):
    def __init__(self, base_url, timeout=15):
        self.base_url = (base_url or "").rstrip("/")
        self.timeout = timeout

    def _get(self, path, params=None):
        if not self.base_url:
            raise CatalogApiError("Chýba URL katalógového API")
        query = urlencode(
            dict((key, value) for key, value in (params or {}).items() if value not in (None, ""))
        )
        url = self.base_url + path + ("?" + query if query else "")
        request = Request(
            url,
            headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                payload = response.read().decode("utf-8")
            return json.loads(payload)
        except Exception as exc:
            raise CatalogApiError("Katalógové API zlyhalo: {}".format(exc))

    def health(self):
        return self._get("/health")

    def categories(self):
        return self._get("/categories").get("categories", [])

    def media(self, **params):
        return self._get("/media", params)

    def search(self, query, **params):
        params["q"] = query
        return self._get("/search", params)

    def detail(self, media_id):
        return self._get("/media/{}".format(int(media_id))).get("data")

    def files(self, media_id, page=1, limit=100):
        return self._get(
            "/media/{}/files".format(int(media_id)),
            {"page": page, "limit": limit},
        )

    def metadata(self, media_id):
        return self._get("/media/{}/metadata".format(int(media_id)))

    def seasons(self, media_id):
        return self._get("/media/{}/seasons".format(int(media_id)))

    def episodes(self, media_id, page=1, limit=50, season=None):
        return self._get(
            "/media/{}/episodes".format(int(media_id)),
            {"page": page, "limit": limit, "season": season},
        )

    def filters(self, name, category=None):
        return self._get("/filters/{}".format(name), {"category": category}).get("data", [])
