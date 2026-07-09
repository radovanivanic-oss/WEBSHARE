# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import json
import xbmc

from resources.lib.paths import profile_path
from resources.lib.store import AtlasStore


class AtlasMonitor(xbmc.Monitor):
    pass


def read_now_playing():
    path = profile_path("now_playing.json")
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return {}


def run():
    monitor = AtlasMonitor()
    player = xbmc.Player()
    store = AtlasStore()
    last_ident = None

    while not monitor.abortRequested():
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


if __name__ == "__main__":
    run()
