from __future__ import absolute_import

import argparse
import os
import re
import sys
import types
import uuid
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
ADDON_ROOT = ROOT / "plugin.video.websharecrawler"
if str(ADDON_ROOT) not in sys.path:
    sys.path.insert(0, str(ADDON_ROOT))

# The resolver imports xbmcvfs for Kodi's profile path. The probe overrides all
# persistence methods, so this stub never creates a profile or cache file.
if "xbmcvfs" not in sys.modules:
    xbmcvfs = types.ModuleType("xbmcvfs")
    xbmcvfs.translatePath = lambda value: os.path.join(os.path.abspath(os.path.dirname(__file__)), ".probe-unused")
    xbmcvfs.exists = lambda value: True
    xbmcvfs.mkdirs = lambda value: True
    sys.modules["xbmcvfs"] = xbmcvfs

from resources.lib import webshare


class ProbeResolver(webshare.WebshareResolver):
    def __init__(self, username, password):
        super().__init__(username, password, cache_ttl_seconds=0)
        self.authentication_ok = False
        self.probe_device_uuid = str(uuid.uuid4())

    def _get_cached_url(self, ident):
        return None

    def _set_cached_url(self, ident, url):
        return None

    def _clear_wst(self):
        return None

    def _get_wst(self, force=False):
        return self._login()

    def _login(self):
        token = super()._login()
        self.authentication_ok = True
        return token

    def _device_uuid(self):
        return self.probe_device_uuid


def safe_reason(error):
    message = str(error).lower()
    if "authentication" in message or "token" in message or "wst" in message:
        return "authentication_failed"
    if "unavailable" in message or "not found" in message:
        return "file_unavailable"
    if "network" in message:
        return "network_failure"
    if "unsafe" in message:
        return "unsafe_url"
    return "resolver_failed"


def safe_ident(value):
    return re.sub(r"[^A-Za-z0-9._-]", "_", value)[:128]


def probe(ident, env=None):
    if env is None:
        env = os.environ
    username = env.get("WEBSHARE_USERNAME", "")
    password = env.get("WEBSHARE_PASSWORD", "")
    if not username or not password:
        return {"status": "LIVE_PROBE_BLOCKED_MISSING_CREDENTIALS"}

    resolver = ProbeResolver(username, password)
    try:
        stream_url = resolver.resolve(ident)
        parsed = urlparse(stream_url)
        if parsed.scheme.lower() != "https" or not parsed.hostname:
            return {"status": "PLAYBACK_VERTICAL_SLICE_FAILED", "reason": "unsafe_url"}
        return {
            "status": "FILE_LINK_VERIFIED",
            "authentication": "OK" if resolver.authentication_ok else "UNKNOWN",
            "file_ident": safe_ident(ident),
            "file_link_status": "OK",
            "scheme": parsed.scheme.lower(),
            "host": parsed.hostname,
            "url_received": "yes",
        }
    except webshare.ResolverError as error:
        return {
            "status": "PLAYBACK_VERTICAL_SLICE_FAILED",
            "authentication": "OK" if resolver.authentication_ok else "UNKNOWN",
            "file_ident": safe_ident(ident),
            "reason": safe_reason(error),
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description="Bounded Webshare ident-to-file_link probe")
    parser.add_argument("--ident", required=True, help="Known Webshare file ident")
    args = parser.parse_args(argv)
    result = probe(args.ident)
    for key, value in result.items():
        print("{}: {}".format(key, value))
    return 0 if result["status"] == "FILE_LINK_VERIFIED" else 2


if __name__ == "__main__":
    raise SystemExit(main())
