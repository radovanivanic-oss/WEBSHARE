# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import os

import xbmcvfs


ADDON_ID = "plugin.video.websharecrawler"


def profile_dir():
    path = xbmcvfs.translatePath("special://profile/addon_data/{}".format(ADDON_ID))
    if not xbmcvfs.exists(path):
        xbmcvfs.mkdirs(path)
    return path


def profile_path(filename):
    return os.path.join(profile_dir(), filename)
