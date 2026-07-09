# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import gzip
import json
from urllib.request import Request, urlopen


USER_AGENT = "Kodi Webshare Crawler Catalog/0.1"


def load_catalog(url):
    request = Request(
        url,
        headers={
            "Accept": "application/json, */*",
            "Accept-Encoding": "gzip",
            "User-Agent": USER_AGENT,
        },
    )

    with urlopen(request, timeout=30) as response:
        raw = response.read()
        encoding = response.headers.get("Content-Encoding", "")

    if encoding.lower() == "gzip" or url.endswith(".gz"):
        raw = gzip.decompress(raw)

    data = json.loads(raw.decode("utf-8"))

    if isinstance(data, list):
        return data

    if isinstance(data, dict):
        for key in ("items", "videos", "files", "data"):
            value = data.get(key)
            if isinstance(value, list):
                return value

    raise ValueError("Neznámy tvar katalógu")


def load_catalog_with_fallback(primary_url, fallback_url=None):
    data, source_url = load_catalog_with_source(primary_url, fallback_url)
    return data


def load_catalog_with_source(primary_url, fallback_url=None):
    try:
        return load_catalog(primary_url), primary_url
    except Exception:
        if not fallback_url or fallback_url == primary_url:
            raise
        return load_catalog(fallback_url), fallback_url
