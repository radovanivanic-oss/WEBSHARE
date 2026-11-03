# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import hashlib
import json
import os
import re
import time
import uuid
import xml.etree.ElementTree as ET
from urllib.parse import urlencode, urlparse
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from resources.lib.paths import profile_dir


BASE_URL = "https://webshare.cz"
SALT_URL = BASE_URL + "/api/salt/"
LOGIN_URL = BASE_URL + "/api/login/"
FILE_LINK_URL = BASE_URL + "/api/file_link/"
USER_DATA_URL = BASE_URL + "/api/user_data/"
SEARCH_URL = BASE_URL + "/api/search/"
USER_AGENT = "Webshare Atlas Kodi Addon/0.8.31"
MD5_CRYPT_MAGIC = "$1$"
ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


class ResolverError(Exception):
    pass


def _cache_dir():
    return profile_dir()


def _text(node, name, default=""):
    child = node.find(name)
    return child.text.strip() if child is not None and child.text else default


def _int_text(node, name, default=0):
    try:
        return int(_text(node, name, str(default)) or default)
    except (TypeError, ValueError):
        return default


def _episode_parts(name):
    """Extract the series prefix and SxxEyy pair from a Webshare filename."""
    value = str(name or "")
    match = re.search(
        r"(?i)(?:^|[^a-z0-9])s(\d{1,3})\s*[._ -]*e(\d{1,3})(?!\d)",
        value,
    )
    if not match:
        match = re.search(
            r"(?i)(?:^|[^a-z0-9])season\s*(\d{1,3})\s*[._ -]*(?:episode|ep)\s*(\d{1,3})(?!\d)",
            value,
        )
    if not match:
        return None, None, ""

    prefix = value[: match.start()].strip(" ._-[]()")
    prefix = re.sub(r"[._]+", " ", prefix)
    prefix = re.sub(r"\s+", " ", prefix).strip()
    return int(match.group(1)), int(match.group(2)), prefix


def _search_file(node):
    name = _text(node, "name")
    season, episode, series_title = _episode_parts(name)
    extension = ""
    match = re.search(r"\.([a-z0-9]{2,5})$", name, re.IGNORECASE)
    if match:
        extension = match.group(1).lower()

    lower_name = name.lower()
    resolution = ""
    resolution_match = re.search(r"(?<!\d)(2160|1440|1080|720|576|480|360)p?(?!\d)", name, re.IGNORECASE)
    if resolution_match:
        resolution = "{}p".format(resolution_match.group(1))

    languages = []
    for code in ("CZ", "SK", "EN", "PL", "DE", "HU"):
        if re.search(r"(?i)(?:^|[. _+\[\]()\-]){}(?:$|[. _+\[\]()\-])".format(code), name):
            languages.append(code)

    return {
        "ident": _text(node, "ident"),
        "name": name,
        "size": _int_text(node, "size"),
        "type": _text(node, "type"),
        "extension": extension,
        "img": _text(node, "img"),
        "stripe": _text(node, "stripe"),
        "positive_votes": _int_text(node, "positive_votes"),
        "negative_votes": _int_text(node, "negative_votes"),
        "password": _text(node, "password", "0"),
        "season_number": season,
        "episode_number": episode,
        "series_title": series_title,
        "resolution": resolution,
        "languages": languages,
        "video_codec": "hevc" if re.search(r"(?i)(?:x|h)265|hevc", name) else "h264" if re.search(r"(?i)(?:x|h)264|avc", name) else "",
        "audio_codec": "eac3" if "eac3" in lower_name or "ddp" in lower_name else "ac3" if "ac3" in lower_name or "dd5" in lower_name else "",
        "source": "WEB-DL" if re.search(r"(?i)web[. -]?dl", name) else "WEBRip" if re.search(r"(?i)web[. -]?rip", name) else "BluRay" if re.search(r"(?i)blu[. -]?ray|bluray", name) else "",
        "hdr": bool(re.search(r"(?i)(?:^|[. _\-])hdr(?:[. _\-]|$)", name)),
        "dolby_vision": bool(re.search(r"(?i)(?:dv|dolby[. _-]?vision)", name)),
        "has_dubbing": bool(re.search(r"(?i)dab(?:ing|ovan)|dubbed|dubbing", name)),
        "has_subtitles": bool(re.search(r"(?i)titulky|sub(?:s|title)|forced", name)),
    }


def _post_xml(url, payload):
    body = urlencode(payload).encode("utf-8")
    request = Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "text/xml; charset=UTF-8",
            "User-Agent": USER_AGENT,
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read()
    except HTTPError as exc:
        status = int(getattr(exc, "code", 0) or 0)
        if status == 401:
            raise ResolverError("Webshare authentication failed.") from None
        if status == 403:
            raise ResolverError("Webshare access was rejected (HTTP 403); file availability was not determined.") from None
        if status == 429:
            raise ResolverError("Webshare rate limit reached; file availability was not determined.") from None
        if status >= 500:
            raise ResolverError("Webshare provider temporarily unavailable; file availability was not determined.") from None
        raise ResolverError("Webshare provider request failed (HTTP {}).".format(status)) from None
    except Exception:
        raise ResolverError("Webshare network request failed; file availability was not determined.") from None

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ResolverError("Neplatná XML odpoveď z Webshare: {}".format(exc))

    status = _text(root, "status")
    if status and status != "OK":
        code = _text(root, "code")
        message = _text(root, "message", "Webshare API error")
        failure_text = "{} {}".format(code, message).lower()
        if any(marker in failure_text for marker in ("token", "wst", "access denied", "unauthor", "auth", "login")):
            raise ResolverError("Webshare authentication failed.")
        if any(marker in failure_text for marker in ("not found", "not_found", "unavailable", "removed", "does not exist")):
            raise ResolverError("Webshare file unavailable.")
        raise ResolverError("Webshare API request failed.")

    return root


def _to64(value, length):
    result = ""
    while length > 0:
        result += ITOA64[value & 0x3F]
        value >>= 6
        length -= 1
    return result


def _md5_crypt(password, salt):
    password_bytes = password.encode("utf-8")
    salt = salt.split("$")[0][:8]
    salt_bytes = salt.encode("utf-8")
    magic_bytes = MD5_CRYPT_MAGIC.encode("ascii")

    ctx = hashlib.md5()
    ctx.update(password_bytes)
    ctx.update(magic_bytes)
    ctx.update(salt_bytes)

    alternate = hashlib.md5()
    alternate.update(password_bytes)
    alternate.update(salt_bytes)
    alternate.update(password_bytes)
    final = alternate.digest()

    password_length = len(password_bytes)
    remaining = password_length
    while remaining > 0:
        ctx.update(final[: min(16, remaining)])
        remaining -= 16

    i = password_length
    while i > 0:
        if i & 1:
            ctx.update(b"\x00")
        else:
            ctx.update(password_bytes[:1])
        i >>= 1

    final = ctx.digest()

    for i in range(1000):
        loop = hashlib.md5()
        if i & 1:
            loop.update(password_bytes)
        else:
            loop.update(final)
        if i % 3:
            loop.update(salt_bytes)
        if i % 7:
            loop.update(password_bytes)
        if i & 1:
            loop.update(final)
        else:
            loop.update(password_bytes)
        final = loop.digest()

    passwd = ""
    passwd += _to64((final[0] << 16) | (final[6] << 8) | final[12], 4)
    passwd += _to64((final[1] << 16) | (final[7] << 8) | final[13], 4)
    passwd += _to64((final[2] << 16) | (final[8] << 8) | final[14], 4)
    passwd += _to64((final[3] << 16) | (final[9] << 8) | final[15], 4)
    passwd += _to64((final[4] << 16) | (final[10] << 8) | final[5], 4)
    passwd += _to64(final[11], 2)

    return "{}{}${}".format(MD5_CRYPT_MAGIC, salt, passwd)


def _webshare_password_hash(password, salt):
    return hashlib.sha1(_md5_crypt(password, salt).encode("utf-8")).hexdigest()


def _validate_stream_url(url):
    if not isinstance(url, str):
        raise ResolverError("Webshare returned an unsafe stream link.")
    parsed = urlparse(url or "")
    if parsed.scheme.lower() != "https" or not parsed.netloc:
        raise ResolverError("Webshare returned an unsafe stream link.")
    return url


class WebshareResolver(object):
    def __init__(self, username, password, cache_ttl_seconds=21600):
        self.username = username
        self.password = password
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_path = os.path.join(_cache_dir(), "resolved_urls.json")
        self.wst_path = os.path.join(_cache_dir(), "wst.json")
        self.device_uuid_path = os.path.join(_cache_dir(), "device_uuid.json")

    @staticmethod
    def clear_cache():
        for filename in ("resolved_urls.json", "wst.json"):
            path = os.path.join(_cache_dir(), filename)
            try:
                os.remove(path)
            except OSError:
                pass

    def resolve(self, ident):
        if not ident:
            raise ResolverError("Chýba ident")

        cached = self._get_cached_url(ident)
        if cached:
            return cached

        wst = self._get_wst()
        try:
            link = self._file_link(ident, wst)
        except ResolverError as exc:
            if not self._looks_like_auth_error(exc):
                raise
            self._clear_wst()
            link = self._file_link(ident, self._get_wst())
        self._set_cached_url(ident, link)
        return link

    def search(self, query, limit=100, offset=0, sort="recent"):
        """Search public Webshare files without mixing them into the catalog DB."""
        query = str(query or "").strip()
        if not query:
            return {"total": 0, "files": []}

        payload = {
            "what": query,
            "sort": sort or "recent",
            "limit": max(1, min(100, int(limit))),
            "offset": max(0, int(offset)),
            "category": "video",
        }
        if self.username and self.password:
            try:
                payload["wst"] = self._get_wst()
            except ResolverError:
                # Search is also public; a broken login must not hide the
                # anonymous results or make browsing unusable.
                pass

        try:
            response = _post_xml(SEARCH_URL, payload)
        except ResolverError as exc:
            if "wst" not in payload or not self._looks_like_auth_error(exc):
                raise
            self._clear_wst()
            try:
                payload["wst"] = self._get_wst()
                response = _post_xml(SEARCH_URL, payload)
            except ResolverError:
                payload.pop("wst", None)
                response = _post_xml(SEARCH_URL, payload)
        return {
            "total": _int_text(response, "total"),
            "files": [_search_file(node) for node in response.findall("file")],
        }

    def search_all(self, query, max_files=1000, page_size=100):
        """Read all bounded search pages so a 100-result page cannot hide seasons."""
        max_files = max(1, int(max_files))
        page_size = max(1, min(100, int(page_size)))
        rows = []
        offset = 0
        total = None
        seen = set()
        while len(rows) < max_files:
            page = self.search(query, limit=min(page_size, max_files - len(rows)), offset=offset)
            if total is None:
                total = page.get("total") or 0
            page_rows = page.get("files") or []
            if not page_rows:
                break
            before = len(rows)
            for row in page_rows:
                ident = row.get("ident")
                if ident and ident not in seen:
                    seen.add(ident)
                    rows.append(row)
            offset += len(page_rows)
            if len(rows) == before:
                break
            if len(page_rows) < page_size or offset >= int(total or 0):
                break
        return {"total": int(total or len(rows)), "files": rows[:max_files]}

    def search_series(self, title, max_files=1000):
        """Return only episode-shaped files; title matching is done by the addon."""
        result = self.search_all(title, max_files=max_files)
        return {
            "total": result["total"],
            "files": [
                row for row in result["files"]
                if row.get("season_number") is not None and row.get("episode_number") is not None
            ],
        }

    def check_account(self):
        token = self._get_wst(force=True)
        response = _post_xml(USER_DATA_URL, {"wst": token})
        vip = _text(response, "vip", "0") == "1"
        vip_days = _text(response, "vip_days", "0")
        vip_hours = _text(response, "vip_hours", "0")
        vip_minutes = _text(response, "vip_minutes", "0")
        vip_until = _text(response, "vip_until", "")
        return {
            "logged_in": True,
            "token": token,
            "token_masked": _mask_token(token),
            "vip": vip,
            "vip_days": vip_days,
            "vip_hours": vip_hours,
            "vip_minutes": vip_minutes,
            "vip_until": vip_until,
        }

    def _load_json(self, path, default):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return default

    def _save_json(self, path, data):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)

    def _looks_like_auth_error(self, error):
        message = str(error).lower()
        return "token" in message or "access denied" in message or "wst" in message or "authentication" in message

    def _get_cached_url(self, ident):
        cache = self._load_json(self.cache_path, {})
        entry = cache.get(ident)
        if not entry:
            return None

        expires_at = int(entry.get("expires_at") or 0)
        url = entry.get("url")
        if url and expires_at > int(time.time()):
            try:
                return _validate_stream_url(url)
            except ResolverError:
                pass

        cache.pop(ident, None)
        self._save_json(self.cache_path, cache)
        return None

    def _set_cached_url(self, ident, url):
        _validate_stream_url(url)
        cache = self._load_json(self.cache_path, {})
        cache[ident] = {
            "url": url,
            "expires_at": int(time.time()) + self.cache_ttl_seconds,
        }
        self._save_json(self.cache_path, cache)

    def _get_wst(self, force=False):
        cached = self._load_json(self.wst_path, {})
        token = cached.get("wst")
        expires_at = int(cached.get("expires_at") or 0)
        if not force and token and expires_at > int(time.time()):
            return token

        token = self._login()
        self._save_json(
            self.wst_path,
            {
                "wst": token,
                "expires_at": int(time.time()) + 12 * 3600,
            },
        )
        return token

    def _clear_wst(self):
        try:
            os.remove(self.wst_path)
        except OSError:
            pass

    def _device_uuid(self):
        cached = self._load_json(self.device_uuid_path, {})
        value = cached.get("device_uuid")
        if value:
            return value

        value = str(uuid.uuid4())
        self._save_json(self.device_uuid_path, {"device_uuid": value})
        return value

    def _login(self):
        if not self.username or not self.password:
            raise ResolverError("Nastav Webshare meno a heslo v nastaveniach addonu")

        salt_xml = _post_xml(SALT_URL, {"username_or_email": self.username})
        salt = _text(salt_xml, "salt")
        if not salt:
            raise ResolverError("Webshare nevrátil salt")

        login_xml = _post_xml(
            LOGIN_URL,
            {
                "username_or_email": self.username,
                "password": _webshare_password_hash(self.password, salt),
                "keep_logged_in": "1",
            },
        )
        token = _text(login_xml, "token") or _text(login_xml, "wst")
        if not token:
            raise ResolverError("Webshare nevrátil WST token")
        return token

    def _file_link(self, ident, wst):
        response = _post_xml(
            FILE_LINK_URL,
            {
                "ident": ident,
                "wst": wst,
                "download_type": "video_stream",
                "force_https": "1",
                "device_uuid": self._device_uuid(),
            },
        )
        link = _text(response, "link")
        if not link:
            raise ResolverError("Webshare nevrátil stream link")
        return _validate_stream_url(link)


def _mask_token(token):
    if not token:
        return "-"
    if len(token) <= 8:
        return "*" * len(token)
    return "{}...{}".format(token[:4], token[-4:])
