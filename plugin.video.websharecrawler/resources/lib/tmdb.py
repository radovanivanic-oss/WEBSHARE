# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import json
import re
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from resources.lib.metadata import YEAR_RE, normalize_title


TMDB_API = "https://api.themoviedb.org/3"
TMDB_IMAGE = "https://image.tmdb.org/t/p/"
USER_AGENT = "Webshare Atlas Kodi Addon/0.8.37"


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
    def __init__(
        self,
        api_key,
        language="sk-SK",
        fallback_language="cs-CZ",
        second_fallback_language="en-US",
    ):
        self.api_key = api_key or ""
        self.language = language or "sk-SK"
        self.fallback_language = fallback_language or "cs-CZ"
        self.second_fallback_language = second_fallback_language or "en-US"

    def enabled(self):
        return bool(self.api_key.strip())

    def fetch_for_row(self, row):
        if not self.enabled() or (row["media_type"] or "movie") != "movie":
            return None

        query = clean_query(row["title"] or row["name"] or row["ident"])
        if not query:
            return None

        year = row["year"] or None
        languages = self.languages()
        movie = None
        for language in languages:
            movie = self._search_movie(query, year, language)
            if movie:
                break
        if not movie:
            return None

        detail_rows = []
        for language in languages:
            details = self._movie_details(movie["id"], language)
            if details:
                details["_language"] = language
                detail_rows.append(details)

        if not detail_rows:
            return None

        details = detail_rows[0]
        for fallback_details in detail_rows[1:]:
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
            "language": details.get("_overview_language") or details.get("_language") or languages[0],
        }

    def fetch_movie_by_id(self, movie_id):
        if not self.enabled() or not movie_id:
            return None

        detail_rows = []
        for language in self.languages():
            details = self._movie_details(movie_id, language)
            if details:
                details["_language"] = language
                detail_rows.append(details)

        if not detail_rows:
            return None

        details = detail_rows[0]
        for fallback_details in detail_rows[1:]:
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
            "title": details.get("title") or "",
            "original_title": details.get("original_title") or "",
            "year": _year(details.get("release_date")),
            "overview": details.get("overview") or "",
            "genres": genres,
            "rating": details.get("vote_average") or 0,
            "runtime": details.get("runtime") or 0,
            "countries": countries,
            "director": ", ".join(directors),
            "cast": cast,
            "poster": _image(details.get("poster_path"), "w500"),
            "backdrop": _image(details.get("backdrop_path"), "w1280"),
            "language": details.get("_overview_language") or details.get("_language") or self.languages()[0],
        }

    def fetch_tv_by_id(self, tv_id):
        if not self.enabled() or not tv_id:
            return None

        detail_rows = []
        for language in self.languages():
            details = self._tv_details(tv_id, language)
            if details:
                details["_language"] = language
                detail_rows.append(details)

        if not detail_rows:
            return None

        details = detail_rows[0]
        for fallback_details in detail_rows[1:]:
            details = _merge_details(details, fallback_details)

        countries = [
            item.get("name") or item.get("iso_3166_1")
            for item in details.get("production_countries", [])
            if item.get("name") or item.get("iso_3166_1")
        ] or [country for country in details.get("origin_country", []) if country]
        genres = [item.get("name") for item in details.get("genres", []) if item.get("name")]
        creators = [item.get("name") for item in details.get("created_by", []) if item.get("name")]
        runtime_values = [value for value in details.get("episode_run_time", []) if value]
        season_numbers = [
            int(season.get("season_number"))
            for season in details.get("seasons", [])
            if isinstance(season, dict) and str(season.get("season_number", "")).isdigit()
        ]

        return {
            "tmdb_id": details.get("id"),
            "title": details.get("name") or "",
            "original_title": details.get("original_name") or "",
            "year": _year(details.get("first_air_date")),
            "overview": details.get("overview") or "",
            "genres": genres,
            "rating": details.get("vote_average") or 0,
            "runtime": runtime_values[0] if runtime_values else 0,
            "countries": countries,
            "director": ", ".join(creators),
            "cast": [],
            "poster": _image(details.get("poster_path"), "w500"),
            "backdrop": _image(details.get("backdrop_path"), "w1280"),
            "language": details.get("_overview_language") or details.get("_language") or self.languages()[0],
            "season_numbers": sorted(set(season_numbers)),
            "external_url": "https://www.themoviedb.org/tv/{}".format(details.get("id")),
        }

    def fetch_tv_season(self, tv_id, season_number):
        """Fetch one season live, merging localized fields without persisting them.

        TMDb often has an empty Slovak/Czech overview while the English
        episode overview is present.  We therefore request every configured
        language and merge only missing fields in memory.  Nothing is written
        to the Kodi or crawler database.
        """
        if not self.enabled() or not tv_id:
            return None
        try:
            season_number = int(season_number)
        except (TypeError, ValueError):
            return None

        season_rows = []
        episode_rows = {}
        for language in self.languages():
            details = self._tv_season_details(tv_id, season_number, language)
            if not details:
                continue
            details["_language"] = language
            season_rows.append(details)
            for episode in details.get("episodes") or []:
                if not isinstance(episode, dict) or not episode.get("episode_number"):
                    continue
                number = int(episode.get("episode_number"))
                episode_rows[number] = _merge_episode_details(episode_rows.get(number), episode)

        if not season_rows:
            return None
        details = season_rows[0]
        for fallback_details in season_rows[1:]:
            if not details.get("overview") and fallback_details.get("overview"):
                details["overview"] = fallback_details.get("overview")
            for key in ("poster_path", "air_date", "name"):
                if not details.get(key) and fallback_details.get(key):
                    details[key] = fallback_details[key]

        return {
            "tmdb_id": details.get("id"),
            "tv_id": str(tv_id),
            "season_number": season_number,
            "name": details.get("name") or "Séria {:02d}".format(season_number),
            "overview": details.get("overview") or "",
            "air_date": details.get("air_date") or "",
            "poster": _image(details.get("poster_path"), "w500"),
            "external_url": "https://www.themoviedb.org/tv/{}/season/{}".format(tv_id, season_number),
            "episodes": [
                {
                    "tmdb_id": episode.get("id"),
                    "episode_number": number,
                    "name": episode.get("name") or "",
                    "overview": episode.get("overview") or "",
                    "air_date": episode.get("air_date") or "",
                    "runtime": episode.get("runtime") or 0,
                    "still": _image(episode.get("still_path"), "w500"),
                    "external_url": "https://www.themoviedb.org/tv/{}/season/{}/episode/{}".format(tv_id, season_number, number),
                }
                for number, episode in sorted(episode_rows.items())
            ],
        }

    def fetch_tv_episode(self, tv_id, season_number, episode_number):
        season = self.fetch_tv_season(tv_id, season_number)
        if not season:
            return None
        wanted = int(episode_number)
        return next((episode for episode in season.get("episodes", []) if int(episode.get("episode_number") or -1) == wanted), None)

    def fetch_tv_by_title(self, title, year=None):
        if not self.enabled():
            return None

        query = clean_query(title)
        if not query:
            return None
        query_normalized = clean_query(title).casefold()
        exact_results = []
        all_results = []
        for language in self.languages():
            params = {
                "query": query,
                "language": language,
                "include_adult": "false",
            }
            if year:
                params["first_air_date_year"] = int(year)
            try:
                data = self._get("/search/tv", params)
            except Exception:
                continue
            results = data.get("results") or []
            all_results.extend(results)
            for result in results:
                names = [result.get("name"), result.get("original_name")]
                if query_normalized and any(clean_query(name).casefold() == query_normalized for name in names if name):
                    result_year = _year(result.get("first_air_date"))
                    if year and result_year and abs(int(year) - result_year) > 1:
                        continue
                    exact_results.append(result)
        candidates = exact_results or all_results
        if candidates:
            candidates = sorted(
                candidates,
                key=lambda result: (
                    1 if year and _year(result.get("first_air_date")) == int(year) else 0,
                    1 if _year(result.get("first_air_date")) else 0,
                    float(result.get("popularity") or 0),
                ),
                reverse=True,
            )
            if candidates[0].get("id"):
                return self.fetch_tv_by_id(candidates[0]["id"])
        return None

    def languages(self):
        result = []
        for language in (
            self.language,
            self.fallback_language,
            self.second_fallback_language,
        ):
            if language and language not in result:
                result.append(language)
        return result or ["sk-SK", "cs-CZ", "en-US"]

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

    def _tv_details(self, tv_id, language):
        try:
            return self._get(
                "/tv/{}".format(tv_id),
                {"language": language},
            )
        except Exception:
            return None

    def _tv_season_details(self, tv_id, season_number, language):
        try:
            return self._get(
                "/tv/{}/season/{}".format(tv_id, season_number),
                {"language": language},
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
    if not merged.get("overview") and fallback.get("overview"):
        merged["overview"] = fallback["overview"]
        merged["_overview_language"] = fallback.get("_language")

    for key in (
        "poster_path",
        "backdrop_path",
        "runtime",
        "episode_run_time",
        "release_date",
        "first_air_date",
        "original_title",
        "original_name",
        "title",
        "name",
    ):
        if not merged.get(key) and fallback.get(key):
            merged[key] = fallback[key]
    for key in ("genres", "production_countries", "origin_country", "created_by", "credits"):
        if not merged.get(key) and fallback.get(key):
            merged[key] = fallback[key]
    return merged


def _merge_episode_details(primary, fallback):
    merged = dict(primary or {})
    fallback = fallback or {}
    for key in ("overview", "still_path", "air_date", "runtime", "name"):
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
