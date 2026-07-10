# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import json
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from resources.lib.metadata import YEAR_RE, normalize_title


TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p/"
USER_AGENT = "AG Kino Kodi Addon/0.6.2"


def clean_query(title):
    value = normalize_title(title or "")
    value = YEAR_RE.sub(" ", value)
    value = re.sub(
        r"\b(2160p|1080p|720p|480p|uhd|4k|fhd|web-dl|webrip|bluray|brrip|hdrip|dvdrip|x264|x265|h264|h265|hevc|ac3|aac|dts|cz|sk|en|multi|dabing|titulky|tit)\b",
        " ",
        value,
        flags=re.I,
    )
    value = re.sub(r"\[[^\]]+\]|\([^\)]*\)", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def metadata_key(row):
    media_type = row["media_type"] or "movie"
    year = str(row["year"] or "")
    title = clean_query(row["title"] or row["name"] or row["ident"])
    return "{}:{}:{}".format(media_type, year, title.lower())


class TMDbClient(object):
    def __init__(self, api_key, language="sk-SK", fallback_language="cs-CZ"):
        self.api_key = api_key or ""
        self.language = language or "sk-SK"
        self.fallback_language = fallback_language or "cs-CZ"

    def enabled(self):
        return bool(self.api_key.strip())

    def fetch_for_row(self, row):
        if not self.enabled() or (row["media_type"] or "movie") != "movie":
            return None

        query = clean_query(row["title"] or row["name"] or row["ident"])
        if not query:
            return None

        year = row["year"] or None
        movie = self._search_movie(query, year, self.language)
        if not movie and self.fallback_language and self.fallback_language != self.language:
            movie = self._search_movie(query, year, self.fallback_language)
        if not movie:
            return None

        details = self._movie_details(movie["id"], self.language)
        fallback_details = None
        if self.fallback_language and self.fallback_language != self.language:
            fallback_details = self._movie_details(movie["id"], self.fallback_language)
        if not details:
            details = fallback_details
        if not details:
            return None
        if fallback_details:
            details = _merge_details(details, fallback_details)

        credits = details.get("credits") or {}
        crew = credits.get("crew") or []
        cast_rows = credits.get("cast") or []
        directors = [item.get("name") for item in crew if item.get("job") == "Director" and item.get("name")]
        cast = [item.get("name") for item in cast_rows[:10] if item.get("name")]

        countries = [
            item.get("name") or item.get("iso_3166_1")
            for item in details.get("production_countries", [])
            if item.get("name") or item.get("iso_3166_1")
        ]
        genres = [item.get("name") for item in details.get("genres", []) if item.get("name")]

        return {
            "tmdb_id": details.get("id"),
            "title": details.get("title") or movie.get("title"),
            "original_title": details.get("original_title") or "",
            "year": _year(details.get("release_date") or movie.get("release_date")),
            "overview": details.get("overview") or "",
            "genres": genres,
            "rating": details.get("vote_average") or 0,
            "runtime": details.get("runtime") or 0,
            "countries": countries,
            "director": ", ".join(directors),
            "cast": cast,
            "poster": _image(details.get("poster_path"), "w500"),
            "backdrop": _image(details.get("backdrop_path"), "w1280"),
        }

    def _get(self, path, params):
        query = dict(params or {})
        query["api_key"] = self.api_key
        url = TMDB_API + path + "?" + urlencode(query)
        request = Request(url, headers={"Accept": "application/json", "User-Agent": USER_AGENT})
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))

    def _search_movie(self, query, year, language):
        params = {
            "query": query,
            "language": language,
            "include_adult": "false",
        }
        if year:
            params["year"] = int(year)
        try:
            data = self._get("/search/movie", params)
        except Exception:
            return None
        results = data.get("results") or []
        return results[0] if results else None

    def _movie_details(self, movie_id, language):
        try:
            return self._get(
                "/movie/{}".format(movie_id),
                {"language": language, "append_to_response": "credits"},
            )
        except Exception:
            return None


def _image(path, size):
    if not path:
        return ""
    return TMDB_IMAGE + size + path


def _merge_details(primary, fallback):
    merged = dict(primary or {})
    fallback = fallback or {}
    for key in (
        "overview",
        "poster_path",
        "backdrop_path",
        "runtime",
        "release_date",
        "original_title",
        "title",
    ):
        if not merged.get(key) and fallback.get(key):
            merged[key] = fallback[key]
    for key in ("genres", "production_countries", "credits"):
        if not merged.get(key) and fallback.get(key):
            merged[key] = fallback[key]
    return merged


def _year(date):
    if not date or len(date) < 4:
        return None
    try:
        return int(date[:4])
    except ValueError:
        return None
