# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import sys
import json
import os
from urllib.parse import parse_qsl, urlencode

import xbmc
import xbmcaddon
import xbmcgui
import xbmcplugin

from resources.lib.indexer import CatalogIndexer
from resources.lib.catalog_api import CatalogApiClient, CatalogApiError
from resources.lib.public_catalog import PublicCatalogClient, PublicCatalogError
from resources.lib.store import AtlasStore
from resources.lib.tmdb import TMDbClient, metadata_key
from resources.lib.webshare import ResolverError, WebshareResolver


ADDON = xbmcaddon.Addon()
HANDLE = int(sys.argv[1])
BASE_URL = sys.argv[0]
PAGE_SIZE = 50
CATALOG_BASE_URL = "https://raw.githubusercontent.com/radovanivanic-oss/AG_repo/main/catalog"
PUBLIC_CATALOG_POINTER_URL = "https://raw.githubusercontent.com/radovanivanic-oss/AG_repo/main/catalog/v1/current.json"
DEFAULT_CATALOG_URL = CATALOG_BASE_URL + "/videos_all.json.gz"
DEFAULT_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_all.json"
DEFAULT_MOVIE_CATALOG_URL = CATALOG_BASE_URL + "/videos_movies.json.gz"
DEFAULT_MOVIE_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_movies.json"
DEFAULT_SERIES_CATALOG_URL = CATALOG_BASE_URL + "/videos_series.json.gz"
DEFAULT_SERIES_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_series.json"
DEFAULT_DOCUMENTARY_CATALOG_URL = CATALOG_BASE_URL + "/videos_documentary.json.gz"
DEFAULT_DOCUMENTARY_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_documentary.json"
DEFAULT_SPORT_CATALOG_URL = CATALOG_BASE_URL + "/videos_sport.json.gz"
DEFAULT_SPORT_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_sport.json"
DEFAULT_KIDS_CATALOG_URL = CATALOG_BASE_URL + "/videos_kids.json.gz"
DEFAULT_KIDS_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_kids.json"
DEFAULT_ANIME_CATALOG_URL = CATALOG_BASE_URL + "/videos_anime.json.gz"
DEFAULT_ANIME_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_anime.json"
DEFAULT_MUSIC_CATALOG_URL = CATALOG_BASE_URL + "/videos_music.json.gz"
DEFAULT_MUSIC_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_music.json"
DEFAULT_OTHER_CATALOG_URL = CATALOG_BASE_URL + "/videos_other.json.gz"
DEFAULT_OTHER_FALLBACK_CATALOG_URL = CATALOG_BASE_URL + "/videos_other.json"
_STATIC_CATALOG = None

CATALOG_SCOPES = {
    "all": {
        "label": "Všetko",
        "primary_default": DEFAULT_CATALOG_URL,
        "fallback_default": DEFAULT_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "movie": {
        "label": "Filmy",
        "primary_default": DEFAULT_MOVIE_CATALOG_URL,
        "fallback_default": DEFAULT_MOVIE_FALLBACK_CATALOG_URL,
        "media_type": "movie",
    },
    "series": {
        "label": "Seriály",
        "primary_default": DEFAULT_SERIES_CATALOG_URL,
        "fallback_default": DEFAULT_SERIES_FALLBACK_CATALOG_URL,
        "media_type": "episode",
    },
    "documentary": {
        "label": "Dokumenty",
        "primary_default": DEFAULT_DOCUMENTARY_CATALOG_URL,
        "fallback_default": DEFAULT_DOCUMENTARY_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "sport": {
        "label": "Šport",
        "primary_default": DEFAULT_SPORT_CATALOG_URL,
        "fallback_default": DEFAULT_SPORT_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "kids": {
        "label": "Detské",
        "primary_default": DEFAULT_KIDS_CATALOG_URL,
        "fallback_default": DEFAULT_KIDS_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "anime": {
        "label": "Anime",
        "primary_default": DEFAULT_ANIME_CATALOG_URL,
        "fallback_default": DEFAULT_ANIME_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "music": {
        "label": "Hudba",
        "primary_default": DEFAULT_MUSIC_CATALOG_URL,
        "fallback_default": DEFAULT_MUSIC_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
    "other": {
        "label": "Ostatné",
        "primary_default": DEFAULT_OTHER_CATALOG_URL,
        "fallback_default": DEFAULT_OTHER_FALLBACK_CATALOG_URL,
        "media_type": None,
    },
}

VIDEO_TYPE_SCOPES = ("documentary", "sport", "kids", "anime", "music", "other")
VISIBLE_VIDEO_TYPE_SCOPES = ("documentary", "sport", "kids", "anime", "music")


def setting(key, default=""):
    value = ADDON.getSetting(key)
    return value if value != "" else default


def int_setting(key, default):
    try:
        return int(setting(key, str(default)))
    except ValueError:
        return default


def bool_setting(key, default=False):
    value = setting(key, "true" if default else "false").lower()
    return value in ("true", "1", "yes", "on")


def addon_url(query):
    return BASE_URL + "?" + urlencode(query)


def notify(message, icon=xbmcgui.NOTIFICATION_INFO):
    xbmcgui.Dialog().notification(ADDON.getAddonInfo("name"), message, icon)


def store():
    return AtlasStore()


def catalog_scope_for_params(params=None):
    params = params or {}
    explicit = params.get("catalog_scope")
    if explicit in CATALOG_SCOPES:
        return explicit
    media_type = params.get("media_type")
    if media_type == "movie":
        return "movie"
    if media_type == "episode" or params.get("series_title"):
        return "series"
    return "all"


def catalog_scope_config(scope):
    return CATALOG_SCOPES.get(scope) or CATALOG_SCOPES["all"]


def indexer(scope="all"):
    config = catalog_scope_config(scope)
    return CatalogIndexer(
        catalog_url=config["primary_default"],
        fallback_catalog_url=config["fallback_default"],
        catalog_key=scope,
        media_type=config["media_type"],
    )


def page_size():
    return max(10, int_setting("page_size", PAGE_SIZE))


def metadata_ttl_seconds():
    return max(1, int_setting("metadata_cache_ttl_days", 30)) * 86400


def enum_setting(key, values, default):
    value = setting(key, default)
    if value in values:
        return value
    try:
        return values[int(value)]
    except Exception:
        return default


def metadata_language():
    return enum_setting("metadata_language", ["sk-SK", "cs-CZ", "en-US"], "sk-SK")


def metadata_fallback_language():
    return enum_setting("metadata_fallback_language", ["cs-CZ", "en-US", "sk-SK"], "cs-CZ")


def metadata_second_fallback_language():
    return enum_setting("metadata_second_fallback_language", ["en-US", "cs-CZ", "sk-SK"], "en-US")


def fallback_art():
    return os.path.join(ADDON.getAddonInfo("path"), "icon.png")


def use_catalog_api():
    return bool_setting("use_catalog_api", False)


def use_static_catalog():
    return bool_setting("use_static_catalog", True)


def catalog_mode():
    """Return the explicit catalog mode with static mode taking precedence."""
    if use_static_catalog():
        return "static"
    if use_catalog_api():
        return "api"
    return "legacy"


def static_catalog():
    global _STATIC_CATALOG
    pointer_url = setting("public_catalog_url", PUBLIC_CATALOG_POINTER_URL)
    if _STATIC_CATALOG is None or _STATIC_CATALOG.pointer_url != pointer_url.rstrip("/"):
        _STATIC_CATALOG = PublicCatalogClient(pointer_url)
    return _STATIC_CATALOG


def catalog_api():
    mode = catalog_mode()
    if mode == "static":
        return static_catalog()
    api_url = setting("catalog_api_url", "").strip()
    if not api_url:
        raise CatalogApiError("URL katalógového API je dostupná iba v expertnom režime")
    return CatalogApiClient(api_url)


def ensure_index(scope="all"):
    if not bool_setting("auto_index", True):
        return

    config = catalog_scope_config(scope)
    catalog_indexer = indexer(scope)
    if catalog_indexer.needs_rebuild():
        progress = xbmcgui.DialogProgress()
        progress.create(
            ADDON.getAddonInfo("name"),
            "Indexujem katalóg: {}...".format(config["label"]),
        )

        def on_progress(done, total):
            if total:
                percent = min(100, int(done * 100 / total))
                progress.update(percent, "Indexujem položky: {} / {}".format(done, total))

        try:
            catalog_indexer.rebuild(on_progress=on_progress)
        finally:
            progress.close()


def add_directory(label, action, query=None):
    query = query or {}
    query["action"] = action
    item = xbmcgui.ListItem(label=label)
    add_home_context(item, label, query)
    xbmcplugin.addDirectoryItem(HANDLE, addon_url(query), item, isFolder=True)


def add_command(label, action, query=None):
    query = query or {}
    query["action"] = action
    item = xbmcgui.ListItem(label=label)
    add_home_context(item, label, query)
    xbmcplugin.addDirectoryItem(HANDLE, addon_url(query), item, isFolder=False)


def add_home_context(item, label, query):
    action = query.get("action")
    if action in ("pin_add", "pin_remove", "hide_home", "favorite_add", "favorite_remove"):
        return
    item_key = "{}:{}".format(action, json.dumps(query, sort_keys=True))
    item.addContextMenuItems(
        [
            (
                "Pripnúť na hlavnú stránku",
                "RunPlugin({})".format(
                    addon_url(
                        {
                            "action": "pin_add",
                            "kind": "menu",
                            "item_key": item_key,
                            "label": label,
                            "payload": json.dumps(query),
                        }
                    )
                ),
            ),
            (
                "Skryť z hlavnej stránky",
                "RunPlugin({})".format(addon_url({"action": "hide_home", "item_key": item_key})),
            ),
        ]
    )


def root_menu():
    if catalog_mode() != "legacy":
        api_root_menu()
        return
    hidden = store().hidden_home_keys()
    add_home_item("quick-search-movies", hidden, "[B]Rýchle hľadanie filmov[/B]", "search", {"media_type": "movie"})
    add_home_item("quick-search-series", hidden, "[B]Rýchle hľadanie seriálov[/B]", "search", {"media_type": "episode"})
    add_saved_filters_to_home(hidden)
    add_pins_to_home()

    add_home_item("movies", hidden, "Filmy", "movies")
    add_home_item("series", hidden, "Seriály", "series")
    add_home_item("documentary", hidden, "Dokumenty", "video_type", {"catalog_scope": "documentary"})
    add_home_item("sport", hidden, "Šport", "video_type", {"catalog_scope": "sport"})
    add_home_item("kids", hidden, "Detské", "video_type", {"catalog_scope": "kids"})
    add_home_item("anime", hidden, "Anime", "video_type", {"catalog_scope": "anime"})
    add_home_item("music", hidden, "Hudba", "video_type", {"catalog_scope": "music"})
    add_home_item("news", hidden, "Novinky", "news")
    add_home_item("latest", hidden, "Najnovšie", "latest")
    add_home_item("genres", hidden, "Žánre", "genres")
    add_home_item("years", hidden, "Roky", "years")
    add_home_item("quality", hidden, "Kvalita", "quality")
    add_home_item("audio-subtitles", hidden, "Dabing / titulky", "audio_subtitles")
    add_home_item("search-menu", hidden, "Vyhľadávanie", "search_menu")
    add_home_item("favorites", hidden, "Obľúbené", "favorites")
    add_home_item("history", hidden, "História", "history")
    add_home_item("advanced-filter", hidden, "Filter", "advanced_filter")
    add_home_item("tools", hidden, "Nástroje", "tools")
    add_command("Nastavenia", "settings")
    xbmcplugin.endOfDirectory(HANDLE)


def api_root_menu():
    add_directory("[B]Rýchle hľadanie filmov[/B]", "api_search", {"category": "movies"})
    add_directory("[B]Rýchle hľadanie seriálov[/B]", "api_search", {"category": "series"})
    add_directory("Vyhľadávanie", "api_search_menu")
    add_directory("Filmy", "api_movies")
    add_directory("Seriály", "api_series")
    static_counts = None
    if catalog_mode() == "static":
        try:
            static_counts = {row.get("id"): int(row.get("count") or 0) for row in static_catalog().categories() if isinstance(row, dict)}
        except CatalogApiError:
            static_counts = {}
    for label, category in (
        ("Dokumentárne", "documentaries"),
        ("Koncerty", "concerts"),
        ("Anime", "anime"),
        ("Šport", "sports"),
        ("Detské", "kids"),
        ("Hudobné videá", "music-videos"),
        ("Ostatné", "other"),
        ("Nezaradené", "unknown"),
    ):
        if static_counts is not None and static_counts.get(category, 0) <= 0:
            continue
        add_directory(label, "api_media", {"category": category, "sort": "recent"})
    add_directory("Obľúbené", "favorites")
    add_directory("História", "history")
    add_command("Nastavenia", "settings")
    xbmcplugin.endOfDirectory(HANDLE)


def api_search_menu():
    """Render category-scoped catalog search without inventing empty sections."""
    add_directory("Všetko", "api_search")
    added_categories = set()
    for label, category in (("Filmy", "movies"), ("Seriály", "series")):
        add_directory(label, "api_search", {"category": category})
        added_categories.add(category)

    try:
        categories = catalog_api().categories()
    except CatalogApiError:
        categories = []
    if not isinstance(categories, list):
        categories = []
    for row in categories:
        if not isinstance(row, dict):
            continue
        category = row.get("id")
        try:
            count = int(row.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if not category or category in added_categories or count <= 0:
            continue
        label = row.get("title") or category
        add_directory("Hľadať {}".format(label), "api_search", {"category": category})
        added_categories.add(category)
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def api_movies_menu():
    add_directory("Novinky", "api_media", {"category": "movies", "sort": "release_date_desc"})
    add_directory("Najnovšie pridané", "api_media", {"category": "movies", "sort": "recent", "order": "desc"})
    add_directory("Všetky filmy", "api_media", {"category": "movies", "sort": "title", "order": "asc"})
    add_directory("Najlepšie hodnotené", "api_media", {"category": "movies", "sort": "rating", "order": "desc"})
    add_directory("Roky", "api_years", {"category": "movies"})
    add_directory("Žánre", "api_genres", {"category": "movies"})
    add_directory("Kvalita", "api_quality", {"category": "movies"})
    add_directory("Dabing / titulky", "api_languages", {"category": "movies"})
    add_directory("Hľadať film", "api_search", {"category": "movies"})
    xbmcplugin.endOfDirectory(HANDLE)


def api_series_menu():
    add_directory("Novinky", "api_media", {"category": "series", "sort": "series_release_date_desc", "order": "desc"})
    add_directory("Najnovšie pridané", "api_media", {"category": "series", "sort": "recent", "order": "desc"})
    add_directory("Všetky seriály", "api_media", {"category": "series", "sort": "title", "order": "asc"})
    add_directory("Najlepšie hodnotené", "api_media", {"category": "series", "sort": "rating", "order": "desc"})
    add_directory("Roky", "api_years", {"category": "series"})
    add_directory("Žánre", "api_genres", {"category": "series"})
    add_directory("Kvalita", "api_quality", {"category": "series"})
    add_directory("Dabing / titulky", "api_languages", {"category": "series"})
    add_directory("Hľadať seriál", "api_search", {"category": "series"})
    xbmcplugin.endOfDirectory(HANDLE)


def api_filter_menu(params, filter_name, param_key):
    category = params.get("category")
    try:
        rows = catalog_api().filters(filter_name, category)
    except CatalogApiError as exc:
        notify(str(exc), xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return

    for row in rows:
        value = row.get("value")
        if value in (None, ""):
            continue
        label = str(value)
        if row.get("count") is not None:
            label = "{} ({})".format(label, row.get("count"))
        add_directory(label, "api_media", {"category": category, param_key: value, "sort": "recent", "order": "desc"})
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def api_years_menu(params):
    api_filter_menu(params, "years", "year")


def api_genres_menu(params):
    api_filter_menu(params, "genres", "genre")


def api_quality_menu(params):
    api_filter_menu(params, "qualities", "quality")


def api_languages_menu(params):
    api_filter_menu(params, "languages", "language")


def add_home_item(item_key, hidden, label, action, query=None):
    if item_key in hidden:
        return
    add_directory(label, action, query or {})


def add_saved_filters_to_home(hidden):
    if "saved-filters" in hidden:
        return
    filters = store().saved_filters(limit=8)
    for row in filters:
        try:
            payload = json.loads(row["payload"])
        except Exception:
            continue
        label = "[COLOR yellow]{}[/COLOR]".format(row["name"])
        add_directory(label, listing_action(payload), payload)


def add_pins_to_home():
    for row in store().pinned_items(limit=15):
        try:
            payload = json.loads(row["payload"])
        except Exception:
            continue
        if row["kind"] == "video":
            video = store().get_item(row["item_key"])
            if video:
                add_playable(video)
            continue
        label = "[B]*[/B] {}".format(row["label"])
        payload["pinned_key"] = row["item_key"]
        add_directory(label, payload.get("action", "list"), payload)


def search_menu():
    add_directory("Rýchle hľadanie", "search")
    add_directory("Hľadať film", "search", {"media_type": "movie"})
    add_directory("Hľadať seriál", "search", {"media_type": "episode"})
    add_directory("Posledné hľadania", "recent_searches")
    add_command("Hľadať podľa identu", "search_ident")
    add_directory("Filter", "advanced_filter")
    add_directory("Uložené filtre", "saved_filters")
    xbmcplugin.endOfDirectory(HANDLE)


def quick_menu():
    add_directory("Najnovšie v katalógu", "list", {"preset": "recent"})
    add_directory("Veľké súbory", "list", {"preset": "large"})
    add_directory("Menšie súbory", "list", {"preset": "small"})
    add_directory("4K / UHD", "list", {"quality": "2160p"})
    add_directory("1080p", "list", {"quality": "1080p"})
    add_directory("CZ / SK", "list", {"language": "CZ/SK"})
    add_directory("Náhodný výber", "list", {"preset": "random"})
    add_directory("Nedokončené", "continue")
    xbmcplugin.endOfDirectory(HANDLE)


def movies_menu():
    add_directory("Všetky filmy", "movie_groups", {"preset": "recent"})
    add_directory("Novinky", "movie_groups", {"preset": "recent"})
    add_directory("Roky", "years", {"media_type": "movie"})
    add_directory("Žánre", "genres", {"media_type": "movie"})
    add_directory("Kvalita", "quality", {"media_type": "movie"})
    add_directory("Dabing / titulky", "audio_subtitles", {"media_type": "movie"})
    add_directory("4K / UHD filmy", "movie_groups", {"quality": "2160p"})
    add_directory("1080p filmy", "movie_groups", {"quality": "1080p"})
    add_directory("CZ / SK filmy", "movie_groups", {"language": "CZ/SK"})
    add_directory("Náhodný film", "movie_groups", {"preset": "random"})
    xbmcplugin.endOfDirectory(HANDLE)


def series_menu():
    add_directory("Všetky seriály", "series_titles", {"preset": "recent"})
    add_directory("Seriály A-Z", "series_titles", {"preset": "title"})
    add_directory("Rozpozerané seriály", "continue", {"media_type": "episode"})
    add_directory("Nové epizódy", "list", {"media_type": "episode", "preset": "recent"})
    add_directory("Roky", "years", {"media_type": "episode"})
    add_directory("Žánre", "genres", {"media_type": "episode"})
    add_directory("Kvalita", "quality", {"media_type": "episode"})
    add_directory("Dabing / titulky", "audio_subtitles", {"media_type": "episode"})
    add_directory("1080p epizódy", "list", {"media_type": "episode", "quality": "1080p"})
    add_directory("CZ / SK epizódy", "list", {"media_type": "episode", "language": "CZ/SK"})
    xbmcplugin.endOfDirectory(HANDLE)


def video_type_menu(params):
    scope = params.get("catalog_scope", "all")
    if scope not in CATALOG_SCOPES:
        scope = "all"
    query = {"catalog_scope": scope, "preset": "recent"}
    add_directory("Najnovšie", "list", query)
    add_directory("Všetko", "list", {"catalog_scope": scope, "preset": "recent"})
    add_command("Hľadať", "search", {"catalog_scope": scope})
    add_directory("Kvalita", "quality", {"catalog_scope": scope})
    add_directory("Roky", "years", {"catalog_scope": scope})
    add_directory("Dabing / titulky", "audio_subtitles", {"catalog_scope": scope})
    add_directory("4K / UHD", "list", {"catalog_scope": scope, "quality": "2160p", "preset": "recent"})
    add_directory("1080p", "list", {"catalog_scope": scope, "quality": "1080p", "preset": "recent"})
    add_directory("CZ / SK", "list", {"catalog_scope": scope, "language": "CZ/SK", "preset": "recent"})
    xbmcplugin.endOfDirectory(HANDLE)


def news_menu():
    add_directory("Nové filmy", "movie_groups", {"preset": "recent"})
    add_directory("Nové epizódy", "list", {"media_type": "episode", "preset": "recent"})
    for scope in VISIBLE_VIDEO_TYPE_SCOPES:
        add_directory(
            "Nové {}".format(catalog_scope_config(scope)["label"].lower()),
            "list",
            {"catalog_scope": scope, "preset": "recent"},
        )
    add_directory("Nové 4K / UHD", "list", {"quality": "2160p", "preset": "recent"})
    add_directory("Nové CZ/SK", "list", {"language": "CZ/SK", "preset": "recent"})
    xbmcplugin.endOfDirectory(HANDLE)


def latest_menu():
    add_directory("Všetko", "list", {"preset": "recent"})
    add_directory("Filmy", "movie_groups", {"preset": "recent"})
    add_directory("Seriály", "list", {"media_type": "episode", "preset": "recent"})
    for scope in VISIBLE_VIDEO_TYPE_SCOPES:
        add_directory(catalog_scope_config(scope)["label"], "list", {"catalog_scope": scope, "preset": "recent"})
    add_directory("1080p", "list", {"quality": "1080p", "preset": "recent"})
    add_directory("4K / UHD", "list", {"quality": "2160p", "preset": "recent"})
    xbmcplugin.endOfDirectory(HANDLE)


def genres_menu():
    params = dict(parse_qsl(sys.argv[2][1:]))
    base = {}
    if params.get("media_type"):
        base["media_type"] = params["media_type"]
    for label, genre in (
        ("Akčné", "action"),
        ("Dobrodružné", "adventure"),
        ("Animované", "animation"),
        ("Komédie", "comedy"),
        ("Krimi", "crime"),
        ("Dokumenty", "documentary"),
        ("Drámy", "drama"),
        ("Rodinné", "family"),
        ("Fantasy", "fantasy"),
        ("Horory", "horror"),
        ("Romantické", "romance"),
        ("Sci-Fi", "sci-fi"),
        ("Thrillery", "thriller"),
        ("Neznáme / neurčené", "unknown"),
    ):
        query = dict(base)
        query["genre"] = genre
        add_directory(label, listing_action(query), query)
    xbmcplugin.endOfDirectory(HANDLE)


def quality_menu(params=None):
    params = params or {}
    for quality in ("2160p", "1080p", "720p", "SD", "unknown"):
        query = dict(params)
        query["quality"] = quality
        add_directory(quality_label(quality), listing_action(query), query)
    xbmcplugin.endOfDirectory(HANDLE)


def years_menu(params=None):
    params = params or {}
    for label, start, end in (
        ("2020+", 2020, 2099),
        ("2010-2019", 2010, 2019),
        ("2000-2009", 2000, 2009),
        ("1990-1999", 1990, 1999),
        ("Staršie", 1900, 1989),
        ("Neznámy rok", 0, 0),
    ):
        query = dict(params)
        query.update({"year_from": start, "year_to": end})
        add_directory(label, listing_action(query), query)
    xbmcplugin.endOfDirectory(HANDLE)


def languages_menu():
    for language in ("CZ", "SK", "CZ/SK", "EN", "MULTI", "unknown"):
        add_directory(language_label(language), "list", {"language": language})
    xbmcplugin.endOfDirectory(HANDLE)


def audio_subtitles_menu(params=None):
    params = params or {}
    base = {}
    if params.get("media_type"):
        base["media_type"] = params["media_type"]
    for label, payload in (
        ("CZ dabing", {"audio_type": "cz_dub"}),
        ("SK dabing", {"audio_type": "sk_dub"}),
        ("Dabing", {"audio_type": "dubbed"}),
        ("CZ/SK", {"audio_type": "cz_sk"}),
        ("CZ", {"audio_type": "cz"}),
        ("SK", {"audio_type": "sk"}),
        ("Titulky", {"subtitle_type": "subs"}),
        ("CZ titulky", {"subtitle_type": "cz_subs"}),
        ("SK titulky", {"subtitle_type": "sk_subs"}),
        ("Neznáme", {"audio_type": "unknown", "subtitle_type": "unknown"}),
    ):
        query = dict(base)
        query.update(payload)
        add_directory(label, listing_action(query), query)
    xbmcplugin.endOfDirectory(HANDLE)


def tools_menu():
    add_directory("Katalóg", "catalog")
    add_command("Preindexovať aktívny katalóg", "reindex")
    add_command("Preindexovať filmy", "reindex", {"catalog_scope": "movie"})
    add_command("Preindexovať seriály", "reindex", {"catalog_scope": "series"})
    for scope in VISIBLE_VIDEO_TYPE_SCOPES:
        add_command("Preindexovať {}".format(catalog_scope_config(scope)["label"].lower()), "reindex", {"catalog_scope": scope})
    add_command("Preindexovať všetko", "reindex", {"catalog_scope": "all"})
    add_command("Vymazať lokálny index", "clear_index")
    add_command("Vymazať cache metadát", "clear_metadata_cache")
    add_command("Vymazať resolver cache", "clear_resolver_cache")
    add_command("Vymazať históriu", "clear_history")
    add_command("Obnoviť skryté položky", "reset_hidden_home")
    add_command("Nastavenia", "settings")
    xbmcplugin.endOfDirectory(HANDLE)


def catalog_menu():
    state = store().catalog_state()
    scope = state.get("catalog_key") or "none"
    scope_label = catalog_scope_config(scope)["label"] if scope in CATALOG_SCOPES else "Žiadny"
    total = state.get("item_count") or 0
    movies = state.get("movie_count") or 0
    episodes = state.get("episode_count") or 0
    unknown = state.get("unknown_count") or 0
    updated = state.get("indexed_at") or "neznáme"
    source = state.get("source_url") or "interný legacy katalóg"

    add_command("Aktívny katalóg: {}".format(scope_label), "catalog_status")
    add_command("Stav: {} položiek".format(total), "catalog_status")
    add_command("Filmy: {}".format(movies), "catalog_status")
    add_command("Epizódy: {}".format(episodes), "catalog_status")
    add_command("Nezaradené: {}".format(unknown), "catalog_status")
    add_command("Indexované: {}".format(updated), "catalog_status")
    add_command("Zdroj: {}".format(source), "catalog_status")
    add_command("Preindexovať aktívny katalóg", "reindex", {"catalog_scope": scope if scope in CATALOG_SCOPES else "all"})
    add_command("Vymazať index", "clear_index")
    add_command("Vymazať cache metadát", "clear_metadata_cache")
    add_command("Vymazať resolver cache", "clear_resolver_cache")
    add_command("Obnoviť skryté položky", "reset_hidden_home")
    xbmcplugin.endOfDirectory(HANDLE)


def search(params=None):
    params = params or {}
    query = xbmcgui.Dialog().input("Hľadať v lokálnom katalógu", type=xbmcgui.INPUT_ALPHANUM)
    if not query:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    store().add_search(query)
    list_params = {"q": query}
    if params.get("media_type"):
        list_params["media_type"] = params["media_type"]
    if params.get("catalog_scope"):
        list_params["catalog_scope"] = params["catalog_scope"]
    if list_params.get("media_type") == "movie":
        movie_groups(list_params)
    else:
        list_items(list_params)


def api_search(params=None):
    params = dict(params or {})
    query = xbmcgui.Dialog().input("Hľadať v katalógu", type=xbmcgui.INPUT_ALPHANUM)
    if not query:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    store().add_search(query)
    params["q"] = query
    api_media(params)


def search_ident():
    ident = xbmcgui.Dialog().input("Webshare ident", type=xbmcgui.INPUT_ALPHANUM)
    if not ident:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    row = store().get_item(ident)
    if row:
        add_playable(row)
        xbmcplugin.setContent(HANDLE, "videos")
        xbmcplugin.endOfDirectory(HANDLE, succeeded=True)
        return
    notify("Ident nie je v lokálnom katalógu", xbmcgui.NOTIFICATION_WARNING)
    xbmcplugin.endOfDirectory(HANDLE, succeeded=False)


def advanced_filter():
    dialog = xbmcgui.Dialog()
    params = {}

    type_options = [
        ("Všetko", None),
        ("Filmy", "movie"),
        ("Seriály", "episode"),
        ("Dokumenty", "documentary"),
        ("Šport", "sport"),
        ("Detské", "kids"),
        ("Anime", "anime"),
        ("Hudba", "music"),
        ("Ostatné", "other"),
    ]
    selected = dialog.select("Typ obsahu", [item[0] for item in type_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    selected_type = type_options[selected][1]
    if selected_type in ("movie", "episode"):
        params["media_type"] = selected_type
    elif selected_type:
        params["catalog_scope"] = selected_type

    quality_options = [
        ("Všetky kvality", None),
        ("4K / UHD / 2160p", "2160p"),
        ("1080p", "1080p"),
        ("720p", "720p"),
        ("SD", "SD"),
        ("Neznáma kvalita", "unknown"),
    ]
    selected = dialog.select("Kvalita", [item[0] for item in quality_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    if quality_options[selected][1]:
        params["quality"] = quality_options[selected][1]

    language_options = [
        ("Všetky jazyky", None),
        ("CZ", "CZ"),
        ("SK", "SK"),
        ("CZ / SK", "CZ/SK"),
        ("EN", "EN"),
        ("Multi", "MULTI"),
        ("Neznámy jazyk", "unknown"),
    ]
    selected = dialog.select("Jazyk", [item[0] for item in language_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    if language_options[selected][1]:
        params["language"] = language_options[selected][1]

    audio_options = [
        ("Všetko", None, None),
        ("CZ dabing", "audio_type", "cz_dub"),
        ("SK dabing", "audio_type", "sk_dub"),
        ("Dabing", "audio_type", "dubbed"),
        ("CZ/SK", "audio_type", "cz_sk"),
        ("Titulky", "subtitle_type", "subs"),
        ("CZ titulky", "subtitle_type", "cz_subs"),
        ("SK titulky", "subtitle_type", "sk_subs"),
        ("Neznáme", "audio_type", "unknown"),
    ]
    selected = dialog.select("Dabing / titulky", [item[0] for item in audio_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    field = audio_options[selected][1]
    value = audio_options[selected][2]
    if field and value:
        params[field] = value

    genre_options = [
        ("Všetko", None),
        ("Neznáme / neurčené", "unknown"),
    ]
    selected = dialog.select("Žáner", [item[0] for item in genre_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    if genre_options[selected][1]:
        params["genre"] = genre_options[selected][1]

    year = dialog.input("Rok alebo rozsah rokov, napr. 2020 alebo 2010:2020", type=xbmcgui.INPUT_ALPHANUM)
    if year:
        apply_year_filter(params, year)

    size = dialog.input("Veľkosť v GB, napr. >3, <6 alebo 3:8", type=xbmcgui.INPUT_ALPHANUM)
    if size:
        apply_size_filter(params, size)

    sort_options = [
        ("Najnovšie v katalógu", "recent"),
        ("Názov A-Z", "title"),
        ("Najväčšie súbory", "large"),
        ("Najmenšie súbory", "small"),
        ("Náhodne", "random"),
    ]
    selected = dialog.select("Zoradiť podľa", [item[0] for item in sort_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    params["preset"] = sort_options[selected][1]

    if dialog.yesno(ADDON.getAddonInfo("name"), "Uložiť tento filter na hlavnú stránku?"):
        name = dialog.input("Názov filtra", type=xbmcgui.INPUT_ALPHANUM)
        if name:
            store().save_filter(name, params)

    if params.get("media_type") == "movie":
        movie_groups(params)
    else:
        list_items(params)


def apply_year_filter(params, value):
    value = value.strip()
    try:
        if ":" in value:
            start, end = value.split(":", 1)
            params["year_from"] = int(start.strip())
            params["year_to"] = int(end.strip())
        else:
            year = int(value)
            params["year_from"] = year
            params["year_to"] = year
    except ValueError:
        pass


def apply_size_filter(params, value):
    value = value.strip().replace(",", ".")
    gib = 1024 * 1024 * 1024
    try:
        if value.startswith(">"):
            params["size_min"] = int(float(value[1:].strip()) * gib)
        elif value.startswith("<"):
            params["size_max"] = int(float(value[1:].strip()) * gib)
        elif ":" in value:
            start, end = value.split(":", 1)
            params["size_min"] = int(float(start.strip()) * gib)
            params["size_max"] = int(float(end.strip()) * gib)
    except ValueError:
        pass


def recent_searches():
    rows = store().recent_searches(limit=25)
    for row in rows:
        add_directory(row["query"], "list", {"q": row["query"]})
    xbmcplugin.endOfDirectory(HANDLE)


def saved_filters_menu():
    rows = store().saved_filters(limit=100)
    add_directory("Vytvoriť nový filter", "advanced_filter")
    for row in rows:
        try:
            payload = json.loads(row["payload"])
        except Exception:
            continue
        item = xbmcgui.ListItem(label=row["name"])
        item.addContextMenuItems(
            [
                (
                    "Vymazať filter",
                    "RunPlugin({})".format(addon_url({"action": "filter_delete", "name": row["name"]})),
                )
            ]
        )
        payload["action"] = "list"
        payload["action"] = listing_action(payload)
        xbmcplugin.addDirectoryItem(HANDLE, addon_url(payload), item, isFolder=True)
    xbmcplugin.endOfDirectory(HANDLE)


def filter_delete(params):
    store().delete_filter(params.get("name", ""))
    notify("Filter vymazaný")


def listing_action(query):
    return "movie_groups" if query.get("media_type") == "movie" else "list"


def api_media(params):
    page = int(params.get("page", "0"))
    category = params.get("category")
    request_params = {
        "category": category,
        "page": page + 1,
        "limit": api_page_size(category),
        "light": "1" if category not in (None, "", "movies") else "",
        "sort": params.get("sort", "recent"),
        "order": params.get("order", "desc"),
        "year": params.get("year"),
        "genre": params.get("genre"),
        "language": params.get("language"),
        "quality": params.get("quality"),
    }
    try:
        if params.get("q"):
            response = catalog_api().search(params["q"], **request_params)
        else:
            response = catalog_api().media(**request_params)
    except CatalogApiError as exc:
        notify(str(exc), xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return

    if not isinstance(response, dict):
        notify("Katalógové API vrátilo neplatnú odpoveď", xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return

    data = response.get("data", [])
    if data is None:
        data = []
    if not isinstance(data, list):
        notify("Katalógové API vrátilo neplatné výsledky", xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return
    if any(not isinstance(media, dict) for media in data):
        notify("Katalógové API vrátilo neplatné položky", xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return

    for media in hydrate_api_listing_metadata(data):
        add_api_media(media)
    pagination = response.get("pagination") or {}
    if not isinstance(pagination, dict):
        pagination = {}
    has_more = bool(pagination.get("has_more")) if "has_more" in pagination else page + 1 < int(pagination.get("pages") or 0)
    add_next_page(has_more, "api_media", params, page)
    category = params.get("category")
    content = "tvshows" if category == "series" else "movies" if category == "movies" else "videos"
    xbmcplugin.setContent(HANDLE, content)
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def api_page_size(category):
    if category in (None, "", "movies"):
        return page_size()
    return min(page_size(), 20)


def hydrate_api_listing_metadata(items):
    hydrated = []
    for media in items or []:
        if media.get("media_type") != "tv":
            hydrated.append(media)
            continue
        if safe_text(media.get("overview")):
            hydrated.append(media)
            continue

        enriched = dict(media)
        live_metadata = {}
        try:
            live_metadata = catalog_api().metadata(media.get("id")) or {}
        except CatalogApiError:
            live_metadata = {}
        meta = api_detail_meta(media, live_metadata)
        if safe_text(meta.get("overview")):
            enriched["overview"] = meta.get("overview")
        if meta.get("genres"):
            enriched["genres"] = meta.get("genres")
        if meta.get("rating"):
            enriched["rating"] = meta.get("rating")
        if meta.get("poster"):
            enriched["poster_url"] = meta.get("poster")
        if meta.get("backdrop"):
            enriched["backdrop_url"] = meta.get("backdrop")
        hydrated.append(enriched)
    return hydrated


def add_api_media(media):
    title = media.get("display_title") or media.get("title") or "Bez názvu"
    year = media.get("year")
    versions = int(media.get("available_files_count") or media.get("variant_count") or media.get("versions") or 0)
    label_parts = [str(year)] if year else []
    if media.get("media_type") == "episode":
        label_parts.append(
            "S{:02d}E{:02d}".format(
                int(media.get("season_number") or 0),
                int(media.get("episode_number") or 0),
            )
        )
    if media.get("media_type") == "movie":
        label_parts.append("{} verzií".format(versions))
    item = xbmcgui.ListItem(label="{} [{}]".format(title, " | ".join(label_parts)) if label_parts else title)
    info = {
        "title": title,
        "originaltitle": media.get("original_title") or media.get("title") or "",
        "plot": media.get("overview") or "",
        "plotoutline": media.get("overview") or "",
        "year": int(year or 0),
        "genre": ", ".join(
            [genre.get("name", "") if isinstance(genre, dict) else str(genre) for genre in media.get("genres") or []]
        ),
        "rating": float(media.get("rating") or 0),
        "mediatype": (
            "tvshow" if media.get("media_type") == "tv" else
            "episode" if media.get("media_type") == "episode" else
            "movie" if media.get("media_type") == "movie" else
            "video"
        ),
    }
    if media.get("release_date"):
        info["premiered"] = media["release_date"]
    if media.get("release_date_precision"):
        item.setProperty("ReleaseDatePrecision", str(media["release_date_precision"]))
    item.setInfo(
        "video",
        info,
    )
    item.setArt(
        {
            "poster": media.get("poster_url") or fallback_art(),
            "thumb": media.get("poster_url") or fallback_art(),
            "fanart": media.get("backdrop_url") or fallback_art(),
        }
    )
    xbmcplugin.addDirectoryItem(
        HANDLE,
        addon_url({"action": "api_media_detail", "media_id": media.get("id")}),
        item,
        isFolder=True,
    )


def api_media_detail(params):
    media_id = params.get("media_id")
    page = int(params.get("page", "0"))
    try:
        detail = catalog_api().detail(media_id) or {}
        if not isinstance(detail, dict):
            raise CatalogApiError("Katalógové API vrátilo neplatný detail filmu")
        if detail.get("media_type") == "tv":
            live_metadata = {}
            try:
                live_metadata = catalog_api().metadata(media_id) or {}
            except CatalogApiError:
                live_metadata = {}
            meta = api_detail_meta(detail, live_metadata)
            api_media_seasons(media_id, detail, meta)
            return
        file_response = catalog_api().files(media_id, page=page + 1, limit=page_size())
        if not isinstance(file_response, dict):
            raise CatalogApiError("Katalógové API vrátilo neplatné súbory")
        files = file_response.get("data", [])
        if files is None:
            files = []
        if not isinstance(files, list) or any(not isinstance(file_row, dict) for file_row in files):
            raise CatalogApiError("Katalógové API vrátilo neplatné súbory")
    except CatalogApiError as exc:
        notify(str(exc), xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return
    live_metadata = {}
    try:
        live_metadata = catalog_api().metadata(media_id) or {}
    except CatalogApiError:
        live_metadata = {}
    if not isinstance(live_metadata, dict):
        live_metadata = {}
    meta = api_detail_meta(detail, live_metadata)
    for file_row in files:
        add_api_file(file_row, detail, meta)
    pagination = file_response.get("pagination") or {}
    add_next_page(page + 1 < int(pagination.get("pages") or 0), "api_media_detail", params, page)
    xbmcplugin.setContent(HANDLE, "episodes" if detail.get("media_type") == "episode" else "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def api_detail_meta(detail, live_metadata):
    detail = detail if isinstance(detail, dict) else {}
    live_metadata = live_metadata if isinstance(live_metadata, dict) else {}
    meta = {
        "title": detail.get("display_title") or detail.get("title") or "",
        "original_title": detail.get("original_title") or "",
        "overview": live_metadata.get("overview") or detail.get("overview") or "",
        "genres": live_metadata.get("genres") or [genre.get("name", "") if isinstance(genre, dict) else str(genre) for genre in detail.get("genres") or []],
        "rating": live_metadata.get("rating") or detail.get("rating") or 0,
        "runtime": live_metadata.get("runtimeMinutes") or detail.get("runtime_minutes") or 0,
        "countries": detail.get("countries") or [],
        "director": detail.get("director") or "",
        "cast": detail.get("cast") or [],
        "poster": live_metadata.get("posterUrl") or detail.get("poster_url") or "",
        "backdrop": live_metadata.get("backdropUrl") or detail.get("backdrop_url") or "",
    }
    return enrich_api_meta_from_tmdb_id(detail, meta)


def api_media_seasons(media_id, detail, meta=None):
    meta = meta or api_detail_meta(detail, {})
    try:
        response = catalog_api().seasons(media_id) or {}
        seasons = response.get("data") or []
    except CatalogApiError as exc:
        notify(str(exc), xbmcgui.NOTIFICATION_ERROR)
        seasons = []

    if not seasons:
        api_media_season({"media_id": media_id})
        return

    for season in seasons:
        season_number = int(season.get("season_number") or 0)
        episode_count = int(season.get("episode_count") or 0)
        label = "Séria {:02d}".format(season_number) if season_number else "Séria ?"
        if episode_count:
            label = "{} ({} epizód)".format(label, episode_count)
        item = xbmcgui.ListItem(label=label)
        plot = meta.get("overview") or "Popis seriálu nie je dostupný."
        genres = safe_text_list(meta.get("genres"))
        countries = safe_text_list(meta.get("countries"))
        item.setInfo(
            "video",
            {
                "title": label,
                "tvshowtitle": detail.get("display_title") or detail.get("title") or "",
                "plot": plot,
                "plotoutline": plot,
                "year": safe_int(meta.get("year") or detail.get("year")),
                "genre": ", ".join(genres),
                "rating": safe_float(meta.get("rating")),
                "country": ", ".join(countries),
                "season": season_number,
                "mediatype": "season",
            },
        )
        item.setArt(
            {
                "poster": meta.get("poster") or detail.get("poster_url") or fallback_art(),
                "thumb": meta.get("poster") or detail.get("poster_url") or fallback_art(),
                "fanart": meta.get("backdrop") or detail.get("backdrop_url") or fallback_art(),
            }
        )
        item.setProperty("plot", plot)
        item.setProperty("description", plot)
        xbmcplugin.addDirectoryItem(
            HANDLE,
            addon_url({"action": "api_media_season", "media_id": media_id, "season": season_number}),
            item,
            isFolder=True,
        )
    xbmcplugin.setContent(HANDLE, "seasons")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def api_media_season(params):
    media_id = params.get("media_id")
    season = params.get("season")
    page = int(params.get("page", "0"))
    try:
        response = catalog_api().episodes(media_id, page=page + 1, limit=page_size(), season=season)
    except CatalogApiError as exc:
        notify(str(exc), xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.endOfDirectory(HANDLE, succeeded=False)
        return
    for episode in response.get("data", []):
        add_api_media(episode)
    pagination = response.get("pagination") or {}
    add_next_page(page + 1 < int(pagination.get("pages") or 0), "api_media_season", params, page)
    xbmcplugin.setContent(HANDLE, "episodes")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def enrich_api_meta_from_tmdb_id(detail, meta):
    if safe_text(meta.get("overview")):
        return meta
    if detail.get("external_source") != "tmdb" or detail.get("media_type") not in ("movie", "tv"):
        return meta
    external_id = safe_text(detail.get("external_id"))
    if not external_id.isdigit():
        return meta

    client = TMDbClient(
        api_key=setting("tmdb_api_key"),
        language=metadata_language(),
        fallback_language=metadata_fallback_language(),
        second_fallback_language=metadata_second_fallback_language(),
    )
    if not client.enabled():
        return meta

    if detail.get("media_type") == "tv":
        data = client.fetch_tv_by_id(external_id)
    else:
        data = client.fetch_movie_by_id(external_id)
    if not data:
        return meta

    merged = dict(meta)
    for target, source in (
        ("title", "title"),
        ("original_title", "original_title"),
        ("overview", "overview"),
        ("genres", "genres"),
        ("rating", "rating"),
        ("runtime", "runtime"),
        ("countries", "countries"),
        ("director", "director"),
        ("cast", "cast"),
        ("poster", "poster"),
        ("backdrop", "backdrop"),
    ):
        if not merged.get(target) and data.get(source):
            merged[target] = data[source]
    return merged


def api_file_label(file_row):
    languages = [str(value).upper() for value in file_row.get("languages") or []]
    parts = [file_row.get("resolution") or "Neznáma kvalita"]
    if file_row.get("dolby_vision"):
        parts.append("Dolby Vision")
    if file_row.get("hdr"):
        parts.append("HDR")
    if file_row.get("source"):
        parts.append(str(file_row["source"]))
    if file_row.get("video_codec"):
        parts.append(str(file_row["video_codec"]).upper())
    if file_row.get("audio_codec"):
        parts.append(str(file_row["audio_codec"]).upper())
    if languages:
        parts.append(" + ".join(languages))
    if file_row.get("has_dubbing"):
        dubbing_language = "CZ/SK" if "CZ" in languages and "SK" in languages else "CZ" if "CZ" in languages else "SK" if "SK" in languages else ""
        parts.append("{} dabing".format(dubbing_language).strip())
    if file_row.get("has_subtitles"):
        subtitle_language = "CZ/SK" if "CZ" in languages and "SK" in languages else "CZ" if "CZ" in languages else "SK" if "SK" in languages else ""
        parts.append("{} titulky".format(subtitle_language).strip())
    return " • ".join(parts)


def add_api_file(file_row, detail, meta):
    languages = file_row.get("languages") or []
    quality = file_row.get("resolution") or "unknown"
    row = {
        "ident": file_row.get("ident") or "",
        "title": detail.get("title") or file_row.get("name") or "",
        "catalog_title": detail.get("title") or "",
        "name": file_row.get("name") or "",
        "size": int(file_row.get("size") or 0),
        "extension": file_row.get("extension") or "",
        "mime": "",
        "media_type": detail.get("media_type") or "movie",
        "year": detail.get("year"),
        "quality": quality,
        "language": "/".join(languages) if languages else "unknown",
        "audio_type": "dubbed" if file_row.get("has_dubbing") else "unknown",
        "subtitle_type": "subs" if file_row.get("has_subtitles") else "unknown",
        "genre": ", ".join(safe_text_list(meta.get("genres"))),
        "series_title": detail.get("title") if detail.get("media_type") == "episode" else None,
        "season": detail.get("season_number"),
        "episode": detail.get("episode_number"),
        "source": file_row.get("source") or "webshare",
        "url": "webshare://{}".format(file_row.get("ident") or ""),
    }
    title = row["title"]
    size_label = "{:.2f} GB".format(row["size"] / float(1024 ** 3))
    item = xbmcgui.ListItem(label=api_file_label(file_row), label2=size_label)
    item.setProperty("IsPlayable", "true")
    set_video_metadata(item, row, meta, title)
    item.setProperty("VideoCodec", str(file_row.get("video_codec") or "").lower())
    item.setProperty("VideoResolution", resolution_from_quality(quality))
    item.setProperty("AudioLanguage", "/".join(languages))
    item.setProperty("WebshareOriginalName", row["name"])
    item.setProperty("FileSize", size_label)
    item.addContextMenuItems(
        [
            (
                "Pôvodný názov súboru",
                "RunPlugin({})".format(addon_url({"action": "show_file_name", "name": row["name"]})),
            )
        ]
    )
    xbmcplugin.addDirectoryItem(
        HANDLE,
        addon_url({"action": "play", "ident": row["ident"], "title": title}),
        item,
        isFolder=False,
    )


def show_file_name(params):
    xbmcgui.Dialog().textviewer("Pôvodný názov súboru", params.get("name") or "Názov nie je k dispozícii.")


def movie_groups(params):
    ensure_index("movie")
    page = int(params.get("page", "0"))
    limit = page_size()
    offset = page * limit
    rows, has_more = store().movie_groups(params, limit=limit, offset=offset)
    metadata = load_group_metadata(rows)

    if page == 0:
        add_directory("Pokročilý filter", "advanced_filter")

    for row in rows:
        add_movie_group(row, metadata.get(movie_group_cache_key(row)))

    add_next_page(has_more, "movie_groups", params, page)
    xbmcplugin.setContent(HANDLE, "movies")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def movie_detail(params):
    ensure_index("movie")
    title = params.get("catalog_title", "")
    year = int(params.get("year") or 0)
    rows = store().movie_group_items(title, year, limit=200)
    group_row = {"group_title": title, "year": year}
    group_meta = load_group_metadata([group_row]).get(movie_group_cache_key(group_row)) or {}
    metadata = load_page_metadata(rows) if not group_meta else {}

    if rows:
        best = rows[0]
        item = xbmcgui.ListItem(label="[B]Prehrať najlepší stream[/B]")
        item.setProperty("IsPlayable", "true")
        best_meta = group_meta or metadata.get(best["ident"]) or {}
        set_video_metadata(item, best, best_meta, best_meta.get("title") or title)
        xbmcplugin.addDirectoryItem(
            HANDLE,
            addon_url({"action": "play", "ident": best["ident"]}),
            item,
            isFolder=False,
        )

    for row in rows:
        add_playable(row, group_meta or metadata.get(row["ident"]))

    xbmcplugin.setContent(HANDLE, "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def movie_group_cache_key(row):
    return "movie:{}:{}".format(int(row["year"] or 0), row["group_title"].lower())


def movie_item_cache_key(row):
    title = row["catalog_title"] or row["title"] or row["name"] or row["ident"]
    return "movie:{}:{}".format(int(row["year"] or 0), title.lower())


def group_as_metadata_row(row):
    return {
        "ident": movie_group_cache_key(row),
        "media_type": "movie",
        "title": row["group_title"],
        "name": row["group_title"],
        "year": row["year"],
    }


def load_group_metadata(rows):
    if not bool_setting("show_descriptions", True) and not bool_setting("show_posters", True):
        return {}

    keys = [movie_group_cache_key(row) for row in rows]
    cached = store().movie_metadata_get_many(keys, metadata_ttl_seconds())
    result = dict(cached)
    missing = [row for row in rows if movie_group_cache_key(row) not in cached]

    client = TMDbClient(
        api_key="",
        language=metadata_language(),
        fallback_language=metadata_fallback_language(),
        second_fallback_language=metadata_second_fallback_language(),
    )
    if not client.enabled():
        return result

    for row in missing:
        key = movie_group_cache_key(row)
        data = client.fetch_for_row(group_as_metadata_row(row))
        if data:
            data["movie_key"] = key
            store().movie_metadata_set(key, data)
            result[key] = data
    return result


def add_movie_group(row, meta=None):
    meta = meta or {}
    title = meta.get("title") or row["group_title"]
    label = movie_group_label(row, title)
    item = xbmcgui.ListItem(label=label)
    info_row = {
        "title": row["group_title"],
        "name": row["group_title"],
        "year": row["year"],
        "genre": "unknown",
        "media_type": "movie",
        "quality": "",
        "language": "",
        "audio_type": "",
        "subtitle_type": "",
        "size": row["max_size"] or 0,
    }
    set_video_metadata(item, info_row, meta, title)
    item.setProperty("stream_count", str(row["stream_count"]))
    item.addContextMenuItems(
        [
            (
                "Pripnúť na hlavnú stránku",
                "RunPlugin({})".format(
                    addon_url(
                        {
                            "action": "pin_add",
                            "kind": "menu",
                            "item_key": movie_group_cache_key(row),
                            "label": title,
                            "payload": json.dumps(
                                {
                                    "action": "movie_detail",
                                    "catalog_title": row["group_title"],
                                    "year": int(row["year"] or 0),
                                }
                            ),
                        }
                    )
                ),
            )
        ]
    )
    xbmcplugin.addDirectoryItem(
        HANDLE,
        addon_url(
            {
                "action": "movie_detail",
                "catalog_title": row["group_title"],
                "year": int(row["year"] or 0),
            }
        ),
        item,
        isFolder=True,
    )


def movie_group_label(row, title):
    meta = []
    if row["year"]:
        meta.append(str(row["year"]))
    qualities = compact_csv(row["qualities"], skip=("unknown", ""))
    languages = compact_csv(row["languages"], skip=("unknown", ""))
    if qualities:
        meta.append(qualities)
    if languages:
        meta.append(languages)
    meta.append("{} streamov".format(row["stream_count"]))
    return "{} [{}]".format(title, " | ".join(meta))


def compact_csv(value, skip=()):
    if not value:
        return ""
    out = []
    for part in str(value).split(","):
        part = part.strip()
        if part and part not in skip and part not in out:
            out.append(part)
    return "/".join(out[:4])


def series_titles(params):
    ensure_index("series")
    page = int(params.get("page", "0"))
    limit = page_size()
    offset = page * limit
    rows, has_more = store().series_titles(
        limit=limit,
        offset=offset,
        preset=params.get("preset", "recent"),
    )
    for row in rows:
        add_directory(
            "{} ({})".format(row["series_title"], row["count"]),
            "series_detail",
            {"series_title": row["series_title"]},
        )
    add_next_page(has_more, "series_titles", params, page)
    xbmcplugin.endOfDirectory(HANDLE)


def series_detail(params):
    ensure_index("series")
    title = params.get("series_title", "")
    seasons = store().series_seasons(title)
    if not seasons:
        list_items({"series_title": title})
        return
    for season in seasons:
        label = "Séria {}".format(season["season"] or "?")
        add_directory(
            label,
            "list",
            {"series_title": title, "season": season["season"] or 0, "preset": "episode"},
        )
    xbmcplugin.endOfDirectory(HANDLE)


def list_items(params):
    ensure_index(catalog_scope_for_params(params))
    page = int(params.get("page", "0"))
    limit = page_size()
    offset = page * limit
    rows, has_more = store().query_items(params, limit=limit, offset=offset)
    metadata = load_page_metadata(rows)

    if page == 0:
        add_directory("Pokročilý filter", "advanced_filter")

    for row in rows:
        add_playable(row, metadata.get(row["ident"]))

    add_next_page(has_more, "list", params, page)
    xbmcplugin.setContent(HANDLE, "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def add_next_page(has_more, action, params, page):
    if not has_more:
        return
    next_params = dict(params)
    next_params["page"] = page + 1
    add_directory("Ďalšia strana", action, next_params)


def load_page_metadata(rows):
    if not bool_setting("show_descriptions", True) and not bool_setting("show_posters", True):
        return {}

    movie_keys = {}
    file_keys = {}
    for row in rows:
        if row["media_type"] == "movie":
            movie_keys[row["ident"]] = movie_item_cache_key(row)
        else:
            file_keys[row["ident"]] = metadata_key(row)

    result = {}
    movie_cached = store().movie_metadata_get_many(list(movie_keys.values()), metadata_ttl_seconds())
    file_cached = store().metadata_get_many(list(file_keys.values()), metadata_ttl_seconds())
    missing_movies = []
    missing_files = []
    for row in rows:
        if row["media_type"] == "movie":
            key = movie_keys[row["ident"]]
            if key in movie_cached:
                result[row["ident"]] = movie_cached[key]
            else:
                missing_movies.append((row, key))
        else:
            key = file_keys[row["ident"]]
            if key in file_cached:
                result[row["ident"]] = file_cached[key]
            else:
                missing_files.append((row, key))

    client = TMDbClient(
        api_key="",
        language=metadata_language(),
        fallback_language=metadata_fallback_language(),
        second_fallback_language=metadata_second_fallback_language(),
    )
    if not client.enabled():
        return result

    for row, key in missing_movies:
        data = client.fetch_for_row(row)
        if data:
            data["movie_key"] = key
            store().movie_metadata_set(key, data)
            result[row["ident"]] = data

    for row, key in missing_files:
        data = client.fetch_for_row(row)
        if data:
            store().metadata_set(key, data)
            result[row["ident"]] = data
    return result


def add_playable(row, meta=None):
    meta = meta or {}
    title = row["title"] or row["name"] or row["ident"]
    display_title = meta.get("title") or title
    label = decorate_label(row)
    item = xbmcgui.ListItem(label=label)
    item.setProperty("IsPlayable", "true")
    set_video_metadata(item, row, meta, display_title)
    item.setProperty("VideoCodec", codec_from_name(row["name"]))
    item.setProperty("VideoResolution", resolution_from_quality(row["quality"]))
    item.setProperty("AudioLanguage", row["language"] or "")
    item.setProperty("AudioChannels", audio_channels_from_name(row["name"]))
    item.setProperty("AspectRatio", aspect_ratio_from_name(row["name"]))

    ident = row["ident"]
    context = [
        (
            "Pridať do obľúbených",
            "RunPlugin({})".format(addon_url({"action": "favorite_add", "ident": ident})),
        ),
        (
            "Odobrať z obľúbených",
            "RunPlugin({})".format(addon_url({"action": "favorite_remove", "ident": ident})),
        ),
        (
            "Označiť ako pozreté",
            "RunPlugin({})".format(addon_url({"action": "mark_watched", "ident": ident})),
        ),
        (
            "Pripnúť na hlavnú stránku",
            "RunPlugin({})".format(
                addon_url(
                    {
                        "action": "pin_add",
                        "kind": "video",
                        "item_key": ident,
                        "label": title,
                        "payload": json.dumps({"action": "play", "ident": ident}),
                    }
                )
            ),
        ),
        (
            "Odopnúť z hlavnej stránky",
            "RunPlugin({})".format(
                addon_url({"action": "pin_remove", "kind": "video", "item_key": ident})
            ),
        ),
    ]
    item.addContextMenuItems(context)

    xbmcplugin.addDirectoryItem(
        HANDLE,
        addon_url({"action": "play", "ident": ident}),
        item,
        isFolder=False,
    )


def set_video_metadata(item, row, meta, title):
    info = build_video_info(row, meta, title)
    item.setInfo("video", info)
    item.setArt(build_art(meta))
    item.setProperty("plot", info.get("plot") or "")
    item.setProperty("description", info.get("plot") or "")
    item.setProperty("genre", info.get("genre") or "")
    item.setProperty("year", str(info.get("year") or ""))
    item.setProperty("VideoCodec", codec_from_name(row["name"]))
    item.setProperty("VideoResolution", resolution_from_quality(row["quality"]))
    item.setProperty("AudioLanguage", row["language"] or "")
    item.setProperty("AudioChannels", audio_channels_from_name(row["name"]))
    item.setProperty("AspectRatio", aspect_ratio_from_name(row["name"]))


def safe_text(value):
    if value is None:
        return ""
    if isinstance(value, dict):
        for key in ("name", "title", "original_name", "original_title"):
            if value.get(key):
                return str(value.get(key))
        return ""
    if isinstance(value, (list, tuple)):
        return " / ".join([part for part in safe_text_list(value) if part])
    return str(value)


def safe_text_list(value):
    if not value:
        return []
    if isinstance(value, str):
        parts = [part.strip() for part in value.split(",")]
        return [part for part in parts if part]
    if not isinstance(value, (list, tuple)):
        text = safe_text(value)
        return [text] if text else []
    result = []
    for item in value:
        text = safe_text(item).strip()
        if text and text not in result:
            result.append(text)
    return result


def safe_int(value, default=0):
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def safe_float(value, default=0.0):
    try:
        return float(value or default)
    except (TypeError, ValueError):
        return default


def decorate_label(row):
    parts = [row["title"] or row["name"] or row["ident"]]
    meta = []
    if row["year"]:
        meta.append(str(row["year"]))
    if row["quality"] and row["quality"] != "unknown":
        meta.append(row["quality"])
    if row["language"] and row["language"] != "unknown":
        meta.append(row["language"])
    if meta:
        parts.append("[{}]".format(" | ".join(meta)))
    return " ".join(parts)


def build_video_info(row, meta, title):
    is_movie = row["media_type"] == "movie"
    if is_movie:
        plot = meta.get("overview") or "Popis nie je k dispozícii."
    else:
        plot = meta.get("overview") or technical_plot(row)
    plot = safe_text(plot)
    genres = safe_text_list(meta.get("genres"))
    countries = safe_text_list(meta.get("countries"))
    cast = safe_text_list(meta.get("cast"))
    runtime = safe_int(meta.get("runtime"))
    fallback_genre = safe_text(row["genre"]) if row["genre"] != "unknown" else ""
    info = {
        "title": safe_text(title),
        "originaltitle": safe_text(meta.get("original_title") or row["name"] or title),
        "year": safe_int(meta.get("year") or row["year"]),
        "plot": plot if bool_setting("show_descriptions", True) else "",
        "plotoutline": plot if bool_setting("show_descriptions", True) else "",
        "genre": " / ".join(genres) if genres else fallback_genre,
        "rating": safe_float(meta.get("rating")),
        "duration": runtime * 60 if runtime else 0,
        "country": " / ".join(countries),
        "director": safe_text(meta.get("director")),
        "cast": cast,
        "mediatype": "episode" if row["media_type"] == "episode" else "movie",
    }
    return info


def build_art(meta):
    art = {}
    fallback = fallback_art()
    if bool_setting("show_posters", True):
        art["poster"] = meta.get("poster") or fallback
        art["thumb"] = meta.get("poster") or fallback
        art["icon"] = meta.get("poster") or fallback
    art["fanart"] = meta.get("backdrop") or fallback
    return art


def technical_plot(row):
    if not bool_setting("show_technical_info", True):
        return ""

    values = []
    if row["quality"] and row["quality"] != "unknown":
        values.append("Kvalita: {}".format(row["quality"]))
    if row["language"] and row["language"] != "unknown":
        values.append("Jazyk: {}".format(row["language"]))
    if row["audio_type"] and row["audio_type"] != "unknown":
        values.append("Audio: {}".format(row["audio_type"]))
    if row["subtitle_type"] and row["subtitle_type"] != "unknown":
        values.append("Titulky: {}".format(row["subtitle_type"]))
    if row["size"]:
        values.append("Veľkosť: {:.2f} GB".format(float(row["size"]) / (1024 ** 3)))
    return "\n".join(values)


def codec_from_name(name):
    text = (name or "").lower()
    if "x265" in text or "h265" in text or "hevc" in text:
        return "hevc"
    if "x264" in text or "h264" in text or "avc" in text:
        return "h264"
    if "xvid" in text:
        return "xvid"
    return ""


def resolution_from_quality(quality):
    return {
        "2160p": "2160",
        "1080p": "1080",
        "720p": "720",
        "SD": "576",
    }.get(quality or "", "")


def audio_channels_from_name(name):
    text = (name or "").lower()
    if "7.1" in text:
        return "8"
    if "5.1" in text:
        return "6"
    if "2.0" in text:
        return "2"
    return ""


def aspect_ratio_from_name(name):
    text = (name or "").lower()
    if "1920x800" in text or "1920x804" in text or "1920x816" in text:
        return "2.39"
    if "1920x1080" in text or "1280x720" in text:
        return "1.78"
    return ""


def quality_label(quality):
    return {
        "2160p": "4K / UHD / 2160p",
        "1080p": "1080p",
        "720p": "720p",
        "SD": "SD",
        "unknown": "Neznáma kvalita",
    }.get(quality, quality)


def language_label(language):
    return {
        "CZ": "CZ",
        "SK": "SK",
        "CZ/SK": "CZ / SK",
        "EN": "EN",
        "MULTI": "Multi",
        "unknown": "Neznámy jazyk",
    }.get(language, language)


def play_video(params):
    ident = params.get("ident", "")
    row = store().get_item(ident)
    title = row["title"] if row else params.get("title", ident)

    resolver = WebshareResolver(
        username=setting("username"),
        password=setting("password"),
        cache_ttl_seconds=int_setting("cache_ttl_hours", 6) * 3600,
    )

    try:
        stream_url = resolver.resolve(ident)
    except ResolverError as exc:
        notify("Resolver zlyhal: {}".format(exc), xbmcgui.NOTIFICATION_ERROR)
        xbmcplugin.setResolvedUrl(HANDLE, False, xbmcgui.ListItem())
        return

    store().record_play_start(ident)
    play_item = xbmcgui.ListItem(path=stream_url, label=title)
    play_item.setProperty("IsPlayable", "true")
    xbmcplugin.setResolvedUrl(HANDLE, True, play_item)


def continue_menu(params):
    rows, has_more = store().resume_items(params.get("media_type"), limit=page_size())
    for row in rows:
        add_playable(row)
    xbmcplugin.setContent(HANDLE, "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def favorites_menu():
    add_directory("Všetko", "favorites_list")
    add_directory("Filmy", "favorites_list", {"media_type": "movie"})
    add_directory("Seriály", "favorites_list", {"media_type": "episode"})
    add_directory("Posledné pridané", "favorites_list")
    xbmcplugin.endOfDirectory(HANDLE)


def favorites_list(params):
    rows, has_more = store().favorite_items(media_type=params.get("media_type"), limit=page_size())
    for row in rows:
        add_playable(row)
    xbmcplugin.setContent(HANDLE, "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def history_menu():
    add_directory("Naposledy prehrané", "history_list")
    add_directory("Dopozerané", "history_list", {"watched": "1"})
    add_directory("Nedopozerané", "continue")
    add_command("Vymazať históriu", "clear_history")
    xbmcplugin.endOfDirectory(HANDLE)


def history_list(params):
    watched = params.get("watched")
    rows, has_more = store().history_items(watched=watched, limit=page_size())
    for row in rows:
        add_playable(row)
    xbmcplugin.setContent(HANDLE, "videos")
    xbmcplugin.endOfDirectory(HANDLE, succeeded=True)


def favorite_add(params):
    store().add_favorite(params.get("ident", ""))
    notify("Pridané do obľúbených")


def favorite_remove(params):
    store().remove_favorite(params.get("ident", ""))
    notify("Odstránené z obľúbených")


def mark_watched(params):
    store().mark_watched(params.get("ident", ""))
    notify("Označené ako pozreté")


def reindex(params=None):
    params = params or {}
    state = store().catalog_state()
    scope = params.get("catalog_scope") or state.get("catalog_key") or "all"
    if scope not in CATALOG_SCOPES:
        scope = "all"
    indexer(scope).rebuild()
    notify("Katalóg {} je preindexovaný".format(catalog_scope_config(scope)["label"]))
    catalog_menu()


def clear_resolver_cache():
    WebshareResolver.clear_cache()
    notify("Resolver cache vymazaná")


def clear_metadata_cache():
    store().clear_metadata_cache()
    notify("Metadata cache vymazaná")


def clear_index():
    store().clear_index()
    notify("Index vymazaný")


def clear_history():
    store().clear_history()
    notify("História vymazaná")


def pin_add(params):
    try:
        payload = json.loads(params.get("payload", "{}"))
    except Exception:
        payload = {}
    store().add_pin(
        params.get("kind", "menu"),
        params.get("item_key", ""),
        params.get("label", ""),
        payload,
    )
    notify("Pripnuté na hlavnú stránku")


def pin_remove(params):
    store().remove_pin(params.get("kind", "menu"), params.get("item_key", ""))
    notify("Odopnuté z hlavnej stránky")


def hide_home(params):
    store().hide_home_item(params.get("item_key", ""))
    notify("Položka skrytá")


def reset_hidden_home():
    store().reset_hidden_home()
    notify("Skryté položky obnovené")


def open_settings():
    ADDON.openSettings()


def router():
    params = dict(parse_qsl(sys.argv[2][1:]))
    action = params.get("action", "root")

    routes = {
        "root": root_menu,
        "search_menu": search_menu,
        "api_search_menu": api_search_menu,
        "quick": quick_menu,
        "movies": movies_menu,
        "series": series_menu,
        "video_type": lambda: video_type_menu(params),
        "news": news_menu,
        "latest": latest_menu,
        "genres": genres_menu,
        "quality": lambda: quality_menu(params),
        "years": lambda: years_menu(params),
        "languages": languages_menu,
        "audio_subtitles": lambda: audio_subtitles_menu(params),
        "tools": tools_menu,
        "catalog": catalog_menu,
        "search": lambda: search(params),
        "api_search": lambda: api_search(params),
        "api_movies": api_movies_menu,
        "api_series": api_series_menu,
        "api_years": lambda: api_years_menu(params),
        "api_genres": lambda: api_genres_menu(params),
        "api_quality": lambda: api_quality_menu(params),
        "api_languages": lambda: api_languages_menu(params),
        "api_media": lambda: api_media(params),
        "api_media_detail": lambda: api_media_detail(params),
        "api_media_season": lambda: api_media_season(params),
        "show_file_name": lambda: show_file_name(params),
        "search_ident": search_ident,
        "recent_searches": recent_searches,
        "advanced_filter": advanced_filter,
        "saved_filters": saved_filters_menu,
        "filter_delete": lambda: filter_delete(params),
        "movie_groups": lambda: movie_groups(params),
        "movie_detail": lambda: movie_detail(params),
        "series_titles": lambda: series_titles(params),
        "series_detail": lambda: series_detail(params),
        "list": lambda: list_items(params),
        "play": lambda: play_video(params),
        "continue": lambda: continue_menu(params),
        "favorites": favorites_menu,
        "favorites_list": lambda: favorites_list(params),
        "history": history_menu,
        "history_list": lambda: history_list(params),
        "favorite_add": lambda: favorite_add(params),
        "favorite_remove": lambda: favorite_remove(params),
        "mark_watched": lambda: mark_watched(params),
        "reindex": lambda: reindex(params),
        "clear_index": clear_index,
        "clear_history": clear_history,
        "pin_add": lambda: pin_add(params),
        "pin_remove": lambda: pin_remove(params),
        "hide_home": lambda: hide_home(params),
        "reset_hidden_home": reset_hidden_home,
        "clear_resolver_cache": clear_resolver_cache,
        "clear_metadata_cache": clear_metadata_cache,
        "settings": open_settings,
        "catalog_status": catalog_menu,
    }

    routes.get(action, root_menu)()


if __name__ == "__main__":
    router()
