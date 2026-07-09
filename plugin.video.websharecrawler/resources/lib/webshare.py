# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import hashlib
import json
import os
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from resources.lib.paths import profile_dir


BASE_URL = "https://webshare.cz"
SALT_URL = BASE_URL + "/api/salt/"
LOGIN_URL = BASE_URL + "/api/login/"
FILE_LINK_URL = BASE_URL + "/api/file_link/"
USER_DATA_URL = BASE_URL + "/api/user_data/"
USER_AGENT = "Kodi Webshare Crawler Catalog/0.1"
MD5_CRYPT_MAGIC = "$1$"
ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


class ResolverError(Exception):
    pass


def _cache_dir():
    return profile_dir()


def _text(node, name, default=""):
    child = node.find(name)
    return child.text.strip() if child is not None and child.text else default


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

    with urlopen(request, timeout=30) as response:
        raw = response.read()

    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        raise ResolverError("Neplatná XML odpoveď z Webshare: {}".format(exc))

    status = _text(root, "status")
    if status and status != "OK":
        code = _text(root, "code")
        message = _text(root, "message", "Webshare API error")
        raise ResolverError("{} {}".format(code, message).strip())

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


class WebshareResolver(object):
    def __init__(self, username, password, cache_ttl_seconds=21600):
        self.username = username
        self.password = password
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_path = os.path.join(_cache_dir(), "resolved_urls.json")
        self.wst_path = os.path.join(_cache_dir(), "wst.json")

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
        return "token" in message or "access denied" in message or "wst" in message

    def _get_cached_url(self, ident):
        cache = self._load_json(self.cache_path, {})
        entry = cache.get(ident)
        if not entry:
            return None

        expires_at = int(entry.get("expires_at") or 0)
        url = entry.get("url")
        if url and expires_at > int(time.time()):
            return url

        cache.pop(ident, None)
        self._save_json(self.cache_path, cache)
        return None

    def _set_cached_url(self, ident, url):
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
            },
        )
        link = _text(response, "link")
        if not link:
            raise ResolverError("Webshare nevrátil stream link")
        return link


def _mask_token(token):
    if not token:
        return "-"
    if len(token) <= 8:
        return "*" * len(token)
    return "{}...{}".format(token[:4], token[-4:])
