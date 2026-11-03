import hashlib
import re
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parents[1]
ADDON_ID = "plugin.video.websharecrawler"
ADDON_ROOT = ROOT / ADDON_ID
KODI_REPO = ROOT / "kodi-repo"
ZIP_PATH = KODI_REPO / ADDON_ID / (ADDON_ID + "-0.8.33.zip")
TEXT_EXTENSIONS = {".js", ".json", ".md", ".py", ".txt", ".xml"}


def authoritative_bytes(path):
    data = path.read_bytes()
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return data
    return data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")


class KodiRepositoryTests(unittest.TestCase):
    def test_repository_metadata_advertises_current_webshare_atlas(self):
        addons = ElementTree.parse(KODI_REPO / "addons.xml").getroot()
        addon = next(item for item in addons.findall("addon") if item.get("id") == ADDON_ID)
        self.assertEqual(addon.get("name"), "Webshare Atlas")
        self.assertEqual(addon.get("version"), "0.8.33")
        self.assertEqual(addon.get("provider-name"), "Radeco")

        addons_bytes = (KODI_REPO / "addons.xml").read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
        expected_md5 = hashlib.md5(addons_bytes).hexdigest()
        self.assertEqual((KODI_REPO / "addons.xml.md5").read_text(encoding="ascii").strip(), expected_md5)

    def test_repository_zip_matches_authoritative_addon_source(self):
        self.assertTrue(ZIP_PATH.is_file())
        self.assertEqual(len(hashlib.sha256(ZIP_PATH.read_bytes()).hexdigest()), 64)

        source_files = {
            path.relative_to(ROOT).as_posix(): authoritative_bytes(path)
            for path in ADDON_ROOT.rglob("*")
            if path.is_file() and "__pycache__" not in path.parts and path.suffix not in {".pyc", ".pyo"}
        }
        with zipfile.ZipFile(ZIP_PATH) as archive:
            names = {name for name in archive.namelist() if not name.endswith("/")}
            packaged_files = {name: archive.read(name) for name in names}

        self.assertEqual(set(packaged_files), set(source_files))
        self.assertEqual(packaged_files, source_files)
        self.assertEqual({name.split("/", 1)[0] for name in names}, {ADDON_ID})

        addon = ElementTree.fromstring(packaged_files[f"{ADDON_ID}/addon.xml"])
        self.assertEqual(addon.get("id"), ADDON_ID)
        self.assertEqual(addon.get("name"), "Webshare Atlas")
        self.assertEqual(addon.get("version"), "0.8.33")

    def test_final_zip_contains_search_fix_and_no_junk_or_secret_values(self):
        with zipfile.ZipFile(ZIP_PATH) as archive:
            names = archive.namelist()
            text = "\n".join(
                archive.read(name).decode("utf-8", errors="ignore")
                for name in names
                if not name.endswith("/")
            )

        forbidden = [
            name
            for name in names
            if ".git/" in name
            or "/tests/" in name
            or "/runtime/" in name
            or "__pycache__" in name
            or name.endswith((".pyc", ".pyo"))
        ]
        self.assertEqual(forbidden, [])
        self.assertIn('add_directory("Vyhľadávanie", "api_search_menu")', text)
        self.assertIn('if not isinstance(response, dict):', text)
        self.assertIsNone(re.search(r"(?i)(password|passwd)\s*[:=]\s*['\"][^'\"]+", text))
        self.assertIsNone(re.search(r"(?i)\b(wst|token|authorization|bearer|cookie|api[_-]?key|secret)\s*[:=]\s*['\"][^'\"]+", text))
        self.assertNotIn("signature=", text.lower())


if __name__ == "__main__":
    unittest.main()
