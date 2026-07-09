# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import os
import re


VIDEO_EXTENSIONS = set(("mp4", "mkv", "avi", "mov", "wmv", "m4v", "webm"))
EPISODE_PATTERNS = (
    re.compile(r"\bS(?P<season>\d{1,2})E(?P<episode>\d{1,3})\b", re.I),
    re.compile(r"\b(?P<season>\d{1,2})x(?P<episode>\d{1,3})\b", re.I),
)
YEAR_RE = re.compile(r"(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)")


def item_ident(item):
    url = item.get("url") or ""
    if url.startswith("webshare://"):
        return url.replace("webshare://", "", 1)
    return item.get("ident") or item.get("id") or ""


def item_title(item):
    return item.get("title") or item.get("name") or item_ident(item) or "Untitled"


def item_extension(item):
    extension = item.get("extension") or item.get("type") or ""
    if not extension:
        extension = os.path.splitext(item.get("name") or "")[1].replace(".", "")
    return extension.lower()


def is_video(item):
    extension = item_extension(item)
    mime = (item.get("mime") or "").lower()
    category = (item.get("category") or "").lower()
    return category == "video" or mime.startswith("video/") or extension in VIDEO_EXTENSIONS


def normalize_title(value):
    base = os.path.splitext(value or "")[0]
    base = re.sub(r"[\._]+", " ", base)
    base = re.sub(r"\s+", " ", base)
    return base.strip()


def parse_year(name):
    match = YEAR_RE.search(name or "")
    return int(match.group(1)) if match else None


def parse_quality(name):
    text = (name or "").lower()
    if "2160p" in text or "uhd" in text or "4k" in text:
        return "2160p"
    if "1080p" in text or "fhd" in text or "fullhd" in text:
        return "1080p"
    if "720p" in text or "hd" in text:
        return "720p"
    if "480p" in text or "dvdrip" in text or "xvid" in text:
        return "SD"
    return "unknown"


def parse_language(name):
    text = " {} ".format((name or "").lower())
    has_cz = bool(re.search(r"[\s\.\[\]\(\)_-](cz|czech|dabingcz)[\s\.\[\]\(\)_-]", text))
    has_sk = bool(re.search(r"[\s\.\[\]\(\)_-](sk|slovak|dabingsk)[\s\.\[\]\(\)_-]", text))
    has_en = bool(re.search(r"[\s\.\[\]\(\)_-](en|eng|english)[\s\.\[\]\(\)_-]", text))
    if "multi" in text or "dual" in text:
        return "MULTI"
    if has_cz and has_sk:
        return "CZ/SK"
    if has_cz:
        return "CZ"
    if has_sk:
        return "SK"
    if has_en:
        return "EN"
    return "unknown"


def parse_audio_type(name):
    text = " {} ".format((name or "").lower())
    has_dub = any(token in text for token in (" dab", " dabing", " dubbed", " czdub", " skdub"))
    has_cz = bool(re.search(r"[\s\.\[\]\(\)_-](cz|czech)[\s\.\[\]\(\)_-]", text))
    has_sk = bool(re.search(r"[\s\.\[\]\(\)_-](sk|slovak)[\s\.\[\]\(\)_-]", text))
    if has_dub and has_cz:
        return "cz_dub"
    if has_dub and has_sk:
        return "sk_dub"
    if has_dub:
        return "dubbed"
    if has_cz and has_sk:
        return "cz_sk"
    if has_cz:
        return "cz"
    if has_sk:
        return "sk"
    return "unknown"


def parse_subtitle_type(name):
    text = (name or "").lower()
    if any(token in text for token in ("subs", "subtitles", "titulky", "tit.", "tit ", "cztit", "sktit")):
        if "cz" in text:
            return "cz_subs"
        if "sk" in text:
            return "sk_subs"
        return "subs"
    return "unknown"


def parse_genre(item, name):
    genre = item.get("genre") or item.get("genres")
    if isinstance(genre, list):
        return ", ".join([str(value) for value in genre if value])
    if genre:
        return str(genre)
    return "unknown"


def parse_episode(name):
    clean = normalize_title(name)
    for pattern in EPISODE_PATTERNS:
        match = pattern.search(clean)
        if not match:
            continue
        prefix = clean[: match.start()].strip(" -._")
        series_title = re.sub(r"\s+", " ", prefix).strip() or clean
        return {
            "media_type": "episode",
            "series_title": strip_noise(series_title),
            "season": int(match.group("season")),
            "episode": int(match.group("episode")),
        }
    return {
        "media_type": "movie",
        "series_title": None,
        "season": None,
        "episode": None,
    }


def strip_noise(title):
    title = YEAR_RE.sub(" ", title or "")
    title = re.sub(r"\b(2160p|1080p|720p|uhd|4k|fhd|cz|sk|en|multi)\b", " ", title, flags=re.I)
    title = re.sub(r"\s+", " ", title)
    return title.strip()


def parse_item(item, added_order):
    ident = item_ident(item)
    name = item.get("name") or item.get("title") or ident
    title = item_title(item)
    normalized = normalize_title(title)
    episode = parse_episode(name)
    size = 0
    try:
        size = int(item.get("size") or 0)
    except (TypeError, ValueError):
        size = 0

    return {
        "ident": ident,
        "title": normalized or title,
        "name": name,
        "size": size,
        "extension": item_extension(item),
        "mime": item.get("mime") or "",
        "media_type": episode["media_type"],
        "year": parse_year(name),
        "quality": parse_quality(name),
        "language": parse_language(name),
        "audio_type": parse_audio_type(name),
        "subtitle_type": parse_subtitle_type(name),
        "genre": parse_genre(item, name),
        "series_title": episode["series_title"],
        "season": episode["season"],
        "episode": episode["episode"],
        "source": item.get("source") or "",
        "url": item.get("url") or "webshare://{}".format(ident),
        "added_order": added_order,
        "search_text": "{} {} {} {} {} {}".format(
            title,
            name,
            ident,
            parse_language(name),
            parse_audio_type(name),
            parse_subtitle_type(name),
        ).lower(),
    }
