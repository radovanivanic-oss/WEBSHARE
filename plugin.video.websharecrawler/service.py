# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import hashlib
import json
import time
import xbmc
import xbmcaddon

from resources.lib.paths import profile_path
from resources.lib.store import AtlasStore
from resources.lib.webshare import ResolverError, WebshareResolver


ADDON = xbmcaddon.Addon()
ACCOUNT_CHECK_INTERVAL = 12 * 3600


class AtlasMonitor(xbmc.Monitor):
    pass


def read_now_playing():
    path = profile_path("now_playing.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def setting(key, default=""):
    value = ADDON.getSetting(key)
    return value if value != "" else default


def set_setting(key, value):
    ADDON.setSetting(key, str(value))


def credential_hash(username, password):
    if not username or not password:
        return ""
    raw = "{}\0{}".format(username, password).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def clear_account_status():
    set_setting("account_status", "Zadaj Webshare meno a heslo")
    set_setting("vip_remaining", "-")
    set_setting("wst_status", "-")
    set_setting("vip_until", "-")
    set_setting("account_checked_at", "-")
    set_setting("account_credentials_hash", "")
    set_setting("account_last_check", "0")


def format_remaining(info):
    if not info.get("vip"):
        return "Bez aktívneho VIP"

    days = info.get("vip_days") or "0"
    hours = info.get("vip_hours") or "0"
    minutes = info.get("vip_minutes") or "0"
    try:
        days_int = int(days)
    except Exception:
        days_int = 0

    if days_int > 0:
        return "{} dní".format(days)
    return "{} h {} min".format(hours, minutes)


def update_account_status(force=False):
    username = setting("username")
    password = setting("password")
    current_hash = credential_hash(username, password)

    if not current_hash:
        if setting("account_credentials_hash"):
            clear_account_status()
        return

    previous_hash = setting("account_credentials_hash")
    try:
        last_check = int(setting("account_last_check", "0"))
    except Exception:
        last_check = 0

    now = int(time.time())
    if not force and previous_hash == current_hash and now - last_check < ACCOUNT_CHECK_INTERVAL:
        return

    set_setting("account_status", "Overujem Webshare účet...")
    set_setting("vip_remaining", "-")
    set_setting("wst_status", "-")
    set_setting("vip_until", "-")

    try:
        resolver = WebshareResolver(username=username, password=password)
        info = resolver.check_account()
    except ResolverError as exc:
        set_setting("account_status", "Chyba prihlásenia")
        set_setting("vip_remaining", "-")
        set_setting("wst_status", "-")
        set_setting("vip_until", str(exc)[:80])
        set_setting("account_checked_at", time.strftime("%Y-%m-%d %H:%M"))
        set_setting("account_credentials_hash", current_hash)
        set_setting("account_last_check", str(now))
        return
    except Exception as exc:
        set_setting("account_status", "Webshare nedostupný")
        set_setting("vip_remaining", "-")
        set_setting("wst_status", "-")
        set_setting("vip_until", str(exc)[:80])
        set_setting("account_checked_at", time.strftime("%Y-%m-%d %H:%M"))
        set_setting("account_credentials_hash", current_hash)
        set_setting("account_last_check", str(now))
        return

    set_setting("account_status", "Prihlásenie OK")
    set_setting("vip_remaining", format_remaining(info))
    set_setting("wst_status", info.get("token_masked") or "-")
    set_setting("vip_until", info.get("vip_until") or "-")
    set_setting("account_checked_at", time.strftime("%Y-%m-%d %H:%M"))
    set_setting("account_credentials_hash", current_hash)
    set_setting("account_last_check", str(now))


def run():
    monitor = AtlasMonitor()
    player = xbmc.Player()
    store = AtlasStore()
    last_ident = None
    ticks = 0
    update_account_status()

    while not monitor.abortRequested():
        if ticks % 6 == 0:
            update_account_status()

        if player.isPlayingVideo():
            data = read_now_playing()
            ident = data.get("ident")
            if ident:
                last_ident = ident
                try:
                    store.update_resume(ident, player.getTime(), player.getTotalTime())
                except Exception:
                    pass
        elif last_ident:
            last_ident = None

        if monitor.waitForAbort(5):
            break
        ticks += 1


if __name__ == "__main__":
    run()
