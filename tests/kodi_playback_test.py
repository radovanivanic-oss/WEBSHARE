from __future__ import absolute_import

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from urllib.parse import parse_qs
from urllib.error import URLError
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
ADDON_ROOT = ROOT / "plugin.video.websharecrawler"
PROFILE_ROOT = Path(tempfile.mkdtemp(prefix="webshare-kodi-test-"))
if str(ADDON_ROOT) not in sys.path:
    sys.path.insert(0, str(ADDON_ROOT))


def install_kodi_stubs():
    xbmcvfs = types.ModuleType("xbmcvfs")
    xbmcvfs.translatePath = lambda value: str(PROFILE_ROOT)
    xbmcvfs.exists = lambda value: True
    xbmcvfs.mkdirs = lambda value: True
    sys.modules["xbmcvfs"] = xbmcvfs

    xbmc = types.ModuleType("xbmc")
    xbmc.LOGERROR = 4
    xbmc.LOGINFO = 1
    xbmc.NOTIFICATION_ERROR = 2
    xbmc.log = lambda *args, **kwargs: None
    xbmc.Player = type("Player", (), {})
    xbmc.Monitor = type("Monitor", (), {})
    sys.modules["xbmc"] = xbmc

    class Addon:
        def getSetting(self, key):
            return {"username": "fixture-user", "password": "fixture-password"}.get(key, "")

        def getAddonInfo(self, key):
            return "Fixture Addon"

        def openSettings(self):
            return None

    xbmcaddon = types.ModuleType("xbmcaddon")
    xbmcaddon.Addon = Addon
    sys.modules["xbmcaddon"] = xbmcaddon

    class ListItem:
        def __init__(self, label="", label2="", path=None):
            self.label = label
            self.label2 = label2
            self.path = path
            self.properties = {}

        def setProperty(self, key, value):
            self.properties[key] = value

    class Dialog:
        def notification(self, *args, **kwargs):
            return None

    xbmcgui = types.ModuleType("xbmcgui")
    xbmcgui.ListItem = ListItem
    xbmcgui.Dialog = Dialog
    xbmcgui.NOTIFICATION_INFO = 1
    xbmcgui.NOTIFICATION_ERROR = 2
    xbmcgui.INPUT_ALPHANUM = 0
    sys.modules["xbmcgui"] = xbmcgui

    xbmcplugin = types.ModuleType("xbmcplugin")
    xbmcplugin.resolved = []
    xbmcplugin.setResolvedUrl = lambda handle, succeeded, item: xbmcplugin.resolved.append(
        (handle, succeeded, item)
    )
    xbmcplugin.endOfDirectory = lambda *args, **kwargs: None
    xbmcplugin.addDirectoryItem = lambda *args, **kwargs: None
    xbmcplugin.setContent = lambda *args, **kwargs: None
    sys.modules["xbmcplugin"] = xbmcplugin


install_kodi_stubs()

import resources.lib.webshare as webshare


def load_addon_module():
    sys.argv = ["plugin://plugin.video.websharecrawler", "1", ""]
    spec = importlib.util.spec_from_file_location("webshare_kodi_default_test", ADDON_ROOT / "default.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


addon = load_addon_module()


class FakeResponse:
    def __init__(self, body):
        self.body = body.encode("utf-8") if isinstance(body, str) else body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def read(self):
        return self.body


class QueueTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=30):
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return FakeResponse(response)


def xml(body):
    return "<response>{}</response>".format(body)


class ResolverTests(unittest.TestCase):
    def setUp(self):
        self.profile = PROFILE_ROOT / self._testMethodName
        self.profile.mkdir(parents=True, exist_ok=True)
        self.cache_patch = mock.patch.object(webshare, "_cache_dir", return_value=str(self.profile))
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)

    def resolver(self):
        return webshare.WebshareResolver("fixture-user", "fixture-password")

    def test_valid_login_response_hashes_password(self):
        transport = QueueTransport(xml("<status>OK</status><salt>fixture-salt</salt>"), xml("<status>OK</status><token>fixture-wst</token>"))
        with mock.patch.object(webshare, "urlopen", transport):
            token = self.resolver()._login()
        self.assertEqual(token, "fixture-wst")
        self.assertEqual(len(transport.requests), 2)
        salt_payload = parse_qs(transport.requests[0].data.decode("utf-8"))
        login_payload = parse_qs(transport.requests[1].data.decode("utf-8"))
        self.assertEqual(salt_payload["username_or_email"], ["fixture-user"])
        self.assertNotEqual(login_payload["password"], ["fixture-password"])
        self.assertNotIn("fixture-password", transport.requests[1].data.decode("utf-8"))

    def test_invalid_login_is_sanitized(self):
        transport = QueueTransport(xml("<status>OK</status><salt>fixture-salt</salt>"), xml("<status>FAIL</status><code>AUTH_FAILED</code><message>wst=fixture-wst password=fixture-password</message>"))
        with mock.patch.object(webshare, "urlopen", transport):
            with self.assertRaises(webshare.ResolverError) as raised:
                self.resolver()._login()
        self.assertIn("authentication", str(raised.exception).lower())
        self.assertNotIn("fixture-wst", str(raised.exception))
        self.assertNotIn("fixture-password", str(raised.exception))

    def test_valid_cached_wst_is_used(self):
        (self.profile / "wst.json").write_text(json.dumps({"wst": "cached-wst", "expires_at": 4_000_000_000}), encoding="utf-8")
        resolver = self.resolver()
        resolver._login = mock.Mock(side_effect=AssertionError("login should not run"))
        self.assertEqual(resolver._get_wst(), "cached-wst")

    def test_expired_wst_is_replaced(self):
        (self.profile / "wst.json").write_text(json.dumps({"wst": "expired-wst", "expires_at": 1}), encoding="utf-8")
        resolver = self.resolver()
        resolver._login = mock.Mock(return_value="fresh-wst")
        self.assertEqual(resolver._get_wst(), "fresh-wst")
        self.assertEqual(json.loads((self.profile / "wst.json").read_text(encoding="utf-8"))["wst"], "fresh-wst")

    def test_successful_file_link_propagates_ident_and_requests_https(self):
        transport = QueueTransport(xml("<status>OK</status><link>https://media.example.test/video.mkv?signature=fixture</link>"))
        with mock.patch.object(webshare, "urlopen", transport):
            link = self.resolver()._file_link("fixture-ident", "fixture-wst")
        self.assertTrue(link.startswith("https://"))
        payload = parse_qs(transport.requests[0].data.decode("utf-8"))
        self.assertEqual(payload["ident"], ["fixture-ident"])
        self.assertEqual(payload["wst"], ["fixture-wst"])
        self.assertEqual(payload["force_https"], ["1"])
        self.assertEqual(payload["download_type"], ["video_stream"])

    def test_missing_link_fails(self):
        transport = QueueTransport(xml("<status>OK</status>"))
        with mock.patch.object(webshare, "urlopen", transport):
            with self.assertRaisesRegex(webshare.ResolverError, "stream link"):
                self.resolver()._file_link("fixture-ident", "fixture-wst")

    def test_malformed_xml_fails(self):
        with mock.patch.object(webshare, "urlopen", QueueTransport("<response>")):
            with self.assertRaises(webshare.ResolverError):
                self.resolver()._file_link("fixture-ident", "fixture-wst")

    def test_network_failure_is_normalized(self):
        with mock.patch.object(webshare, "urlopen", QueueTransport(URLError("fixture-network"))):
            with self.assertRaisesRegex(webshare.ResolverError, "network request failed"):
                self.resolver()._file_link("fixture-ident", "fixture-wst")

    def test_unavailable_file_is_normalized(self):
        response = xml("<status>FAIL</status><code>FILE_NOT_FOUND</code><message>fixture unavailable</message>")
        with mock.patch.object(webshare, "urlopen", QueueTransport(response)):
            with self.assertRaisesRegex(webshare.ResolverError, "file unavailable"):
                self.resolver()._file_link("fixture-ident", "fixture-wst")

    def test_https_link_is_accepted(self):
        self.assertEqual(webshare._validate_stream_url("https://media.example.test/path"), "https://media.example.test/path")

    def test_non_https_or_hostless_link_is_rejected(self):
        for link in ("http://media.example.test/path", "file:///tmp/video.mkv", "https://"):
            with self.subTest(link=link):
                with self.assertRaisesRegex(webshare.ResolverError, "unsafe stream link"):
                    webshare._validate_stream_url(link)

    def test_cached_unsafe_link_is_not_returned(self):
        (self.profile / "resolved_urls.json").write_text(json.dumps({"fixture-ident": {"url": "http://media.example.test/video", "expires_at": 4_000_000_000}}), encoding="utf-8")
        resolver = self.resolver()
        resolver._file_link = mock.Mock(return_value="https://media.example.test/fresh")
        resolver._get_wst = mock.Mock(return_value="fixture-wst")
        self.assertEqual(resolver.resolve("fixture-ident"), "https://media.example.test/fresh")

    def test_auth_failure_refreshes_invalid_wst(self):
        auth_failure = xml("<status>FAIL</status><code>AUTH_FAILED</code><message>fixture token rejected</message>")
        success = xml("<status>OK</status><link>https://media.example.test/refreshed</link>")
        resolver = self.resolver()
        resolver._get_wst = mock.Mock(side_effect=["cached-wst", "fresh-wst"])
        transport = QueueTransport(auth_failure, success)
        with mock.patch.object(webshare, "urlopen", transport):
            self.assertEqual(resolver.resolve("fixture-ident"), "https://media.example.test/refreshed")
        self.assertEqual(parse_qs(transport.requests[0].data.decode("utf-8"))["wst"], ["cached-wst"])
        self.assertEqual(parse_qs(transport.requests[1].data.decode("utf-8"))["wst"], ["fresh-wst"])

    def test_api_error_does_not_leak_wst_or_password(self):
        response = xml("<status>FAIL</status><code>AUTH_FAILED</code><message>wst=fixture-wst password=fixture-password</message>")
        with mock.patch.object(webshare, "urlopen", QueueTransport(response)):
            with self.assertRaises(webshare.ResolverError) as raised:
                self.resolver()._file_link("fixture-ident", "fixture-wst")
        self.assertNotIn("fixture-wst", str(raised.exception))
        self.assertNotIn("fixture-password", str(raised.exception))

    def test_token_masking_is_redacted(self):
        masked = webshare._mask_token("fixture-wst-value")
        self.assertEqual(masked, "fixt...alue")
        self.assertNotEqual(masked, "fixture-wst-value")


class KodiPlaybackTests(unittest.TestCase):
    def setUp(self):
        addon.xbmcplugin.resolved[:] = []
        self.store = mock.Mock()
        self.store.get_item.return_value = {"title": "Fixture title"}
        self.settings = {"username": "fixture-user", "password": "fixture-password"}
        self.setting_patch = mock.patch.object(addon, "setting", side_effect=lambda key, default="": self.settings.get(key, default))
        self.store_patch = mock.patch.object(addon, "store", return_value=self.store)
        self.notify_patch = mock.patch.object(addon, "notify")
        self.setting_patch.start()
        self.store_patch.start()
        self.notify_patch.start()
        self.addCleanup(self.setting_patch.stop)
        self.addCleanup(self.store_patch.stop)
        self.addCleanup(self.notify_patch.stop)

    def test_successful_resolution_calls_kodi_set_resolved_url(self):
        resolver = mock.Mock()
        resolver.resolve.return_value = "https://media.example.test/fixture.mkv"
        with mock.patch.object(addon, "WebshareResolver", return_value=resolver):
            addon.play_video({"ident": "fixture-ident", "title": "Fixture title"})
        self.assertEqual(resolver.resolve.call_args.args, ("fixture-ident",))
        self.assertEqual(len(addon.xbmcplugin.resolved), 1)
        handle, succeeded, item = addon.xbmcplugin.resolved[0]
        self.assertEqual(handle, 1)
        self.assertTrue(succeeded)
        self.assertEqual(item.path, "https://media.example.test/fixture.mkv")
        self.assertEqual(item.properties["IsPlayable"], "true")
        self.store.record_play_start.assert_called_once_with("fixture-ident")

    def test_failed_resolution_sets_resolved_url_false(self):
        resolver = mock.Mock()
        resolver.resolve.side_effect = addon.ResolverError("Webshare file unavailable.")
        with mock.patch.object(addon, "WebshareResolver", return_value=resolver):
            addon.play_video({"ident": "fixture-ident", "title": "Fixture title"})
        self.assertEqual(len(addon.xbmcplugin.resolved), 1)
        self.assertFalse(addon.xbmcplugin.resolved[0][1])
        self.store.record_play_start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
