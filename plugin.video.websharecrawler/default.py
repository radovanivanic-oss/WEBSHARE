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
from resources.lib.store import AtlasStore
from resources.lib.tmdb import TMDbClient, metadata_key
from resources.lib.webshare import ResolverError, WebshareResolver


ADDON = xbmcaddon.Addon()
HANDLE = int(sys.argv[1])
BASE_URL = sys.argv[0]
PAGE_SIZE = 50


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


def indexer():
    return CatalogIndexer(
        catalog_url=setting("catalog_url", "http://192.168.2.226/videos_all.json.gz"),
        fallback_catalog_url=setting(
            "fallback_catalog_url", "http://192.168.2.226/videos_all.json"
        ),
    )


def page_size():
    return max(10, int_setting("page_size", PAGE_SIZE))


def metadata_ttl_seconds():
    return max(1, int_setting("metadata_cache_ttl_days", 30)) * 86400


def fallback_art():
    return os.path.join(ADDON.getAddonInfo("path"), "icon.png")


def ensure_index():
    if not bool_setting("auto_index", True):
        return

    catalog_indexer = indexer()
    if catalog_indexer.needs_rebuild():
        progress = xbmcgui.DialogProgress()
        progress.create(ADDON.getAddonInfo("name"), "Indexujem lokálny katalóg...")

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
    ensure_index()
    hidden = store().hidden_home_keys()
    add_home_item("quick-search-movies", hidden, "[B]Rýchle hľadanie filmov[/B]", "search", {"media_type": "movie"})
    add_home_item("quick-search-series", hidden, "[B]Rýchle hľadanie seriálov[/B]", "search", {"media_type": "episode"})
    add_saved_filters_to_home(hidden)
    add_pins_to_home()

    add_home_item("movies", hidden, "Filmy", "movies")
    add_home_item("series", hidden, "Seriály", "series")
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
    add_command("Rýchle hľadanie", "search")
    add_command("Hľadať film", "search", {"media_type": "movie"})
    add_command("Hľadať seriál", "search", {"media_type": "episode"})
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


def news_menu():
    add_directory("Nové filmy", "movie_groups", {"preset": "recent"})
    add_directory("Nové epizódy", "list", {"media_type": "episode", "preset": "recent"})
    add_directory("Nové 4K / UHD", "list", {"quality": "2160p", "preset": "recent"})
    add_directory("Nové CZ/SK", "list", {"language": "CZ/SK", "preset": "recent"})
    xbmcplugin.endOfDirectory(HANDLE)


def latest_menu():
    add_directory("Všetko", "list", {"preset": "recent"})
    add_directory("Filmy", "movie_groups", {"preset": "recent"})
    add_directory("Seriály", "list", {"media_type": "episode", "preset": "recent"})
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
    add_command("Preindexovať katalóg", "reindex")
    add_command("Vymazať lokálny index", "clear_index")
    add_command("Vymazať metadata cache", "clear_metadata_cache")
    add_command("Vymazať resolver cache", "clear_resolver_cache")
    add_command("Vymazať históriu", "clear_history")
    add_command("Obnoviť skryté položky", "reset_hidden_home")
    add_command("Nastavenia", "settings")
    xbmcplugin.endOfDirectory(HANDLE)


def catalog_menu():
    state = store().catalog_state()
    total = state.get("item_count") or 0
    movies = state.get("movie_count") or 0
    episodes = state.get("episode_count") or 0
    unknown = state.get("unknown_count") or 0
    updated = state.get("indexed_at") or "neznáme"
    source = state.get("source_url") or setting("catalog_url")

    add_command("Stav: {} položiek".format(total), "catalog_status")
    add_command("Filmy: {}".format(movies), "catalog_status")
    add_command("Epizódy: {}".format(episodes), "catalog_status")
    add_command("Nezaradené: {}".format(unknown), "catalog_status")
    add_command("Indexované: {}".format(updated), "catalog_status")
    add_command("Zdroj: {}".format(source), "catalog_status")
    add_command("Preindexovať katalóg", "reindex")
    add_command("Vymazať index", "clear_index")
    add_command("Vymazať metadata cache", "clear_metadata_cache")
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
    if list_params.get("media_type") == "movie":
        movie_groups(list_params)
    else:
        list_items(list_params)


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
    ]
    selected = dialog.select("Typ obsahu", [item[0] for item in type_options])
    if selected == -1:
        xbmcplugin.endOfDirectory(HANDLE)
        return
    if type_options[selected][1]:
        params["media_type"] = type_options[selected][1]

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


def movie_groups(params):
    ensure_index()
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
    cached = store().metadata_get_many(keys, metadata_ttl_seconds())
    result = dict(cached)
    missing = [row for row in rows if movie_group_cache_key(row) not in cached]

    client = TMDbClient(
        api_key=setting("tmdb_api_key"),
        language=setting("metadata_language", "sk-SK"),
        fallback_language=setting("metadata_fallback_language", "cs-CZ"),
    )
    if not client.enabled():
        return result

    for row in missing:
        key = movie_group_cache_key(row)
        data = client.fetch_for_row(group_as_metadata_row(row))
        if data:
            store().metadata_set(key, data)
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
    ensure_index()
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

    cache_keys = {}
    for row in rows:
        cache_keys[row["ident"]] = metadata_key(row)

    cached = store().metadata_get_many(list(cache_keys.values()), metadata_ttl_seconds())
    result = {}
    missing = []
    for row in rows:
        key = cache_keys[row["ident"]]
        if key in cached:
            result[row["ident"]] = cached[key]
        else:
            missing.append((row, key))

    client = TMDbClient(
        api_key=setting("tmdb_api_key"),
        language=setting("metadata_language", "sk-SK"),
        fallback_language=setting("metadata_fallback_language", "cs-CZ"),
    )
    if not client.enabled():
        return result

    for row, key in missing:
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
    plot = meta.get("overview") or technical_plot(row)
    genres = meta.get("genres") or []
    countries = meta.get("countries") or []
    runtime = int(meta.get("runtime") or 0)
    info = {
        "title": title,
        "originaltitle": meta.get("original_title") or row["name"] or title,
        "year": int(meta.get("year") or row["year"] or 0),
        "plot": plot if bool_setting("show_descriptions", True) else "",
        "plotoutline": plot if bool_setting("show_descriptions", True) else "",
        "genre": " / ".join(genres) if genres else (row["genre"] if row["genre"] != "unknown" else ""),
        "rating": float(meta.get("rating") or 0),
        "duration": runtime * 60 if runtime else 0,
        "country": " / ".join(countries),
        "director": meta.get("director") or "",
        "cast": meta.get("cast") or [],
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
    if meta.get("backdrop"):
        art["fanart"] = meta["backdrop"]
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
    title = row["title"] if row else ident

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


def reindex():
    indexer().rebuild()
    notify("Katalóg je preindexovaný")
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
        "quick": quick_menu,
        "movies": movies_menu,
        "series": series_menu,
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
        "reindex": reindex,
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
