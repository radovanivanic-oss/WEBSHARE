from __future__ import absolute_import

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit
from urllib.error import HTTPError, URLError
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

        def addContextMenuItems(self, items):
            self.context = items

        def setInfo(self, kind, info):
            self.info = (kind, info)

        def setArt(self, art):
            self.art = art

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
    xbmcplugin.added = []
    xbmcplugin.ended = []
    xbmcplugin.setResolvedUrl = lambda handle, succeeded, item: xbmcplugin.resolved.append(
        (handle, succeeded, item)
    )
    xbmcplugin.endOfDirectory = lambda *args, **kwargs: xbmcplugin.ended.append((args, kwargs))
    xbmcplugin.addDirectoryItem = lambda *args, **kwargs: xbmcplugin.added.append((args, kwargs))
    xbmcplugin.setContent = lambda *args, **kwargs: None
    sys.modules["xbmcplugin"] = xbmcplugin


install_kodi_stubs()

import resources.lib.webshare as webshare
import resources.lib.catalog_api as catalog_api
import resources.lib.metadata as metadata
import resources.lib.store as catalog_store


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


class KodiSearchTests(unittest.TestCase):
    def setUp(self):
        self.store = mock.Mock()
        self.store_patch = mock.patch.object(addon, "store", return_value=self.store)
        self.notify_patch = mock.patch.object(addon, "notify")
        self.store_patch.start()
        self.notify_patch.start()
        self.addCleanup(self.store_patch.stop)
        self.addCleanup(self.notify_patch.stop)

    def dialog_input(self, value):
        return mock.patch.object(addon.xbmcgui.Dialog, "input", return_value=value, create=True)

    def capture_directory(self):
        added = []
        ended = []
        add_patch = mock.patch.object(
            addon.xbmcplugin,
            "addDirectoryItem",
            side_effect=lambda *args, **kwargs: added.append((args, kwargs)),
        )
        end_patch = mock.patch.object(
            addon.xbmcplugin,
            "endOfDirectory",
            side_effect=lambda *args, **kwargs: ended.append((args, kwargs)),
        )
        return added, ended, add_patch, end_patch

    @staticmethod
    def route_params(item_call):
        args, _kwargs = item_call
        return dict(parse_qsl(urlsplit(args[1]).query))

    def test_search_entries_are_directories(self):
        added, _ended, add_patch, end_patch = self.capture_directory()
        with add_patch, end_patch:
            addon.search_menu()
            with mock.patch.object(addon, "catalog_api", return_value=mock.Mock(categories=mock.Mock(return_value=[]))):
                addon.api_root_menu()
            addon.api_movies_menu()
            addon.api_series_menu()

        search_items = [
            (call, self.route_params(call))
            for call in added
            if self.route_params(call).get("action") in ("search", "api_search", "api_search_menu")
        ]
        self.assertGreaterEqual(len(search_items), 8)
        self.assertTrue(all(call[1].get("isFolder") is True for call, _params in search_items))

    def test_api_search_menu_exposes_only_populated_catalog_categories(self):
        client = mock.Mock()
        client.categories.return_value = [
            {"id": "movies", "title": "Filmy", "count": 300849},
            {"id": "series", "title": "Seriály", "count": 62989},
            {"id": "concerts", "title": "Koncerty", "count": 1767},
            {"id": "anime", "title": "Anime", "count": 0},
        ]
        added, ended, add_patch, end_patch = self.capture_directory()
        with add_patch, end_patch, mock.patch.object(addon, "catalog_api", return_value=client):
            addon.api_search_menu()
        labels = [call[0][2].label for call in added]
        self.assertEqual(labels, ["Všetko", "Filmy", "Seriály", "Hľadať Koncerty"])
        routes = [self.route_params(call) for call in added]
        self.assertEqual(routes[3]["category"], "concerts")
        self.assertTrue(all(call[1].get("isFolder") is True for call in added))
        self.assertEqual(ended[-1][1], {"succeeded": True})

    def test_api_media_sets_category_specific_content_type(self):
        client = mock.Mock()
        client.media.return_value = {"data": [], "pagination": {"pages": 1, "has_more": False}}
        content = []
        with mock.patch.object(addon, "catalog_api", return_value=client), mock.patch.object(
            addon.xbmcplugin, "setContent", side_effect=lambda *args: content.append(args[1])
        ):
            for category, expected in (("movies", "movies"), ("series", "tvshows"), ("concerts", "videos")):
                with self.subTest(category=category):
                    addon.api_media({"category": category})
        self.assertEqual(content, ["movies", "tvshows", "videos"])

    def test_api_media_uses_correct_kodi_mediatype_for_episode_and_video(self):
        captured = []
        with mock.patch.object(addon.xbmcplugin, "addDirectoryItem", side_effect=lambda *args, **kwargs: captured.append(args[2])):
            addon.add_api_media({"id": 1, "title": "Fixture episode", "media_type": "episode", "year": 2024})
            addon.add_api_media({"id": 2, "title": "Fixture concert", "media_type": "video", "year": 2024})
        self.assertEqual(captured[0].info[1]["mediatype"], "episode")
        self.assertEqual(captured[1].info[1]["mediatype"], "video")

    def test_api_media_prefers_central_display_title_and_preserves_original_title(self):
        captured = []
        with mock.patch.object(addon.xbmcplugin, "addDirectoryItem", side_effect=lambda *args, **kwargs: captured.append(args[2])):
            addon.add_api_media({
                "id": 1,
                "title": "결혼의 완성",
                "display_title": "Marriage's Completion",
                "original_title": "결혼의 완성",
                "media_type": "tv",
                "year": 2026,
            })
        self.assertEqual(captured[0].label, "Marriage's Completion [2026]")
        self.assertEqual(captured[0].info[1]["title"], "Marriage's Completion")
        self.assertEqual(captured[0].info[1]["originaltitle"], "결혼의 완성")

    def test_catalog_api_is_the_default_movie_catalog_path(self):
        with mock.patch.object(addon.ADDON, "getSetting", return_value=""):
            self.assertTrue(addon.use_catalog_api())

    def test_real_router_keyboard_api_rendering_and_detail_route(self):
        client = mock.Mock()
        client.search.return_value = {
            "data": [
                {
                    "id": 272158,
                    "title": "Počiatok",
                    "original_title": "Inception",
                    "media_type": "movie",
                    "year": 2010,
                    "versions": 1,
                    "genres": [],
                }
            ],
            "pagination": {"pages": 1, "has_more": False},
        }
        added, ended, add_patch, end_patch = self.capture_directory()
        original_argv = sys.argv[:]
        try:
            with add_patch, end_patch, self.dialog_input("Inception 2010"):
                with mock.patch.object(addon, "catalog_api", return_value=client):
                    sys.argv = [addon.BASE_URL, str(addon.HANDLE), "?" + urlencode({"action": "api_search", "category": "movies"})]
                    addon.router()
        finally:
            sys.argv = original_argv

        self.assertEqual(client.search.call_args.args, ("Inception 2010",))
        self.assertEqual(len(added), 1)
        self.assertEqual(self.route_params(added[0]), {"action": "api_media_detail", "media_id": "272158"})
        self.assertTrue(added[0][1].get("isFolder"))
        self.assertEqual(ended[-1][1], {"succeeded": True})

    def test_api_search_queries_and_unicode_are_forwarded(self):
        client = mock.Mock()
        client.search.return_value = {"data": [], "pagination": {"pages": 1, "has_more": False}}
        with mock.patch.object(addon, "catalog_api", return_value=client):
            for query in ("Inception", "Inception 2010", "Počiatok"):
                with self.subTest(query=query), self.dialog_input(query):
                    addon.api_search({"category": "movies"})
        self.assertEqual([call.args[0] for call in client.search.call_args_list], ["Inception", "Inception 2010", "Počiatok"])

    def test_api_search_cancel_and_empty_query_do_not_call_api(self):
        client = mock.Mock()
        with mock.patch.object(addon, "catalog_api", return_value=client):
            with self.dialog_input(""):
                addon.api_search({})
        client.search.assert_not_called()
        self.store.add_search.assert_not_called()

    def test_api_response_shape_renders_multiple_items_and_missing_pagination(self):
        client = mock.Mock()
        client.search.return_value = {
            "data": [
                {"id": 1, "title": "Inception", "media_type": "movie", "year": 2010, "versions": 1, "genres": []},
                {"id": 2, "title": "Počiatok", "media_type": "movie", "year": 2010, "versions": 1, "genres": []},
            ]
        }
        added, ended, add_patch, end_patch = self.capture_directory()
        with add_patch, end_patch, mock.patch.object(addon, "catalog_api", return_value=client):
            with self.dialog_input("Inception"):
                addon.api_search({})
        self.assertEqual(len(added), 2)
        self.assertEqual([self.route_params(call)["media_id"] for call in added], ["1", "2"])
        self.assertEqual(ended[-1][1], {"succeeded": True})

    def test_malformed_api_results_fail_as_directory_error(self):
        for response in (None, [], {"data": ["not-a-media-object"]}, {"data": "not-a-list"}):
            with self.subTest(response=response):
                client = mock.Mock()
                client.search.return_value = response
                added, ended, add_patch, end_patch = self.capture_directory()
                with add_patch, end_patch, mock.patch.object(addon, "catalog_api", return_value=client):
                    with self.dialog_input("Inception"):
                        addon.api_search({})
                self.assertEqual(added, [])
                self.assertEqual(ended[-1][1], {"succeeded": False})

    def test_search_menu_keyboard_query_propagates_to_movie_route(self):
        with self.dialog_input("Inception 2010"):
            with mock.patch.object(addon, "movie_groups") as movie_groups:
                addon.search({"media_type": "movie"})
        self.store.add_search.assert_called_once_with("Inception 2010")
        movie_groups.assert_called_once_with({"q": "Inception 2010", "media_type": "movie"})

    def test_cancel_and_empty_search_end_safely(self):
        with mock.patch.object(addon.xbmcplugin, "endOfDirectory") as end_directory:
            with self.dialog_input(""):
                addon.search({})
        end_directory.assert_called_once_with(addon.HANDLE)
        self.store.add_search.assert_not_called()

    def test_plugin_route_encodes_unicode_and_punctuation(self):
        route = addon.addon_url({"action": "search", "q": "Inception 2010 & Žena"})
        params = dict(parse_qsl(urlsplit(route).query))
        self.assertEqual(params, {"action": "search", "q": "Inception 2010 & Žena"})

    def test_api_search_propagates_query_and_constructs_results(self):
        client = mock.Mock()
        client.search.return_value = {
            "data": [{"id": 7, "title": "Inception", "media_type": "movie", "year": 2010, "versions": 1}],
            "pagination": {"pages": 1, "has_more": False},
        }
        with mock.patch.object(addon, "catalog_api", return_value=client):
            with self.dialog_input("Inception 2010"):
                with mock.patch.object(addon, "add_api_media") as add_media:
                    addon.api_search({"category": "movies"})
        client.search.assert_called_once()
        self.assertEqual(client.search.call_args.args, ("Inception 2010",))
        self.assertEqual(add_media.call_args.args[0]["id"], 7)

    def test_api_error_and_malformed_response_are_safe(self):
        client = mock.Mock()
        client.search.side_effect = catalog_api.CatalogApiError("fixture API error")
        with mock.patch.object(addon, "catalog_api", return_value=client):
            with self.dialog_input("Inception"):
                with mock.patch.object(addon.xbmcplugin, "endOfDirectory") as end_directory:
                    addon.api_search({})
        self.assertEqual(end_directory.call_args.kwargs, {"succeeded": False})

        transport = QueueTransport("not-json")
        with mock.patch.object(catalog_api, "urlopen", transport):
            with self.assertRaises(catalog_api.CatalogApiError):
                catalog_api.CatalogApiClient("https://catalog.example/api").search("Inception 2010 & Žena")
        query = parse_qs(urlsplit(transport.requests[0].full_url).query)
        self.assertEqual(query["q"], ["Inception 2010 & Žena"])

        for status in (400, 500):
            transport = QueueTransport(HTTPError("https://catalog.example/api/search", status, "fixture", None, None))
            with mock.patch.object(catalog_api, "urlopen", transport):
                with self.assertRaises(catalog_api.CatalogApiError):
                    catalog_api.CatalogApiClient("https://catalog.example/api").search("Inception")

        transport = QueueTransport(URLError("fixture-network"))
        with mock.patch.object(catalog_api, "urlopen", transport):
            with self.assertRaises(catalog_api.CatalogApiError):
                catalog_api.CatalogApiClient("https://catalog.example/api").search("Inception")

    def test_api_file_ident_uses_existing_playback_route(self):
        captured = []
        with mock.patch.object(addon.xbmcplugin, "addDirectoryItem", side_effect=lambda *args, **kwargs: captured.append((args, kwargs))):
            addon.add_api_file(
                {"ident": "fixture-ident", "name": "Inception 2010.mkv", "size": 1000, "extension": "mkv", "resolution": "1080p"},
                {"title": "Inception", "media_type": "movie", "year": 2010},
                {"genres": []},
            )
        self.assertEqual(len(captured), 1)
        args, kwargs = captured[0]
        params = dict(parse_qsl(urlsplit(args[1]).query))
        self.assertEqual(params, {"action": "play", "ident": "fixture-ident", "title": "Inception"})
        self.assertFalse(kwargs.get("isFolder"))
        self.assertEqual(args[2].properties["IsPlayable"], "true")

    def test_movie_metadata_has_safe_description_and_art_fallback(self):
        row = {
            "media_type": "movie", "title": "Fixture Movie", "name": "Fixture Movie.mkv",
            "year": 2024, "genre": "unknown", "quality": "1080p", "language": "unknown",
            "audio_type": "unknown", "subtitle_type": "unknown", "size": 100,
        }
        info = addon.build_video_info(row, {}, "Fixture Movie")
        self.assertEqual(info["plot"], "Popis nie je k dispozícii.")
        captured = []
        with mock.patch.object(addon.xbmcplugin, "addDirectoryItem", side_effect=lambda *args, **kwargs: captured.append((args, kwargs))):
            addon.add_api_media({"id": 1, "title": "Fixture Movie", "media_type": "movie", "year": 2024, "versions": 1, "genres": []})
        self.assertTrue(captured[0][0][2].art["poster"].endswith("icon.png"))

    def test_api_movie_detail_rejects_malformed_files_response(self):
        client = mock.Mock()
        client.detail.return_value = {"id": 1, "title": "Fixture Movie", "media_type": "movie"}
        client.files.return_value = {"data": ["not-a-file"]}
        with mock.patch.object(addon, "catalog_api", return_value=client):
            with mock.patch.object(addon.xbmcplugin, "endOfDirectory") as end_directory:
                addon.api_media_detail({"media_id": "1"})
        self.assertEqual(end_directory.call_args.kwargs, {"succeeded": False})

    def test_local_index_search_is_partial_case_and_punctuation_tolerant(self):
        with mock.patch.object(catalog_store, "DB_PATH", str(PROFILE_ROOT / "local-search" / "catalog.db")):
            local_store = catalog_store.AtlasStore()
            local_store.replace_items(
                [
                    metadata.parse_item(
                        {"ident": "fixture-inception", "name": "Inception 2010 1080p AV1 10Bit DKong.mkv", "type": "mkv", "category": "video"},
                        0,
                    ),
                    metadata.parse_item(
                        {"ident": "fixture-zena", "name": "Žena 2025 1080p.mkv", "type": "mkv", "category": "video"},
                        1,
                    ),
                ],
                {"catalog": {"catalog_key": "movie", "index_version": 5}},
            )
            for query in ("Inception", "inception 2010", "Inception: 2010", "DKong", "Zena", "2025"):
                rows, has_more = local_store.query_items({"q": query}, limit=10)
                self.assertFalse(has_more, query)
                self.assertIn("fixture-inception" if query != "Zena" and query != "2025" else "fixture-zena", [row["ident"] for row in rows], query)


if __name__ == "__main__":
    unittest.main()
