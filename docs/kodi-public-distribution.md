# Public Webshare Atlas Kodi distribution

The public Kodi repository is hosted from the `main` branch of
`radovanivanic-oss/AG_repo` through GitHub Pages:

```text
https://radovanivanic-oss.github.io/AG_repo/
```

The existing Kodi repository addon ID is preserved as
`repository.websharecrawler` for upgrade compatibility. Its display name is
Webshare Atlas Repository. The video addon remains
`plugin.video.websharecrawler`, currently version `0.8.27`.

## Install

Download the repository ZIP:

```text
https://radovanivanic-oss.github.io/AG_repo/repository.websharecrawler/repository.websharecrawler-1.0.8.zip
```

In Kodi, open Settings → Add-ons → Install from zip file. Enable Unknown
sources if Kodi requests it. Then install Webshare Atlas from Webshare Atlas
Repository → Video add-ons.

## Publication

From the production checkout, after changing the addon version deliberately:

```text
npm run kodi:publish
```

The command builds the addon and repository ZIPs from tracked source files,
generates `addons.xml` and its MD5, writes the static Pages files to the clean
AG_repo checkout, commits only the distribution files, and pushes `main`.
ZIPs use a fixed archive timestamp and sorted file order. Runtime build
manifests are written under `runtime/kodi-public-distribution/` and are not
part of the public repository.

The one-time Pages configuration is the `main` branch root (`/`). The static
consumer must use the Pages HTTPS URLs; raw GitHub object URLs are not the
distribution transport.

## Safety

The package builder includes only tracked addon files. It excludes `.git`,
runtime databases, credentials, local configuration, caches, `__pycache__`,
and development artifacts. It does not modify production SQLite or the
catalog pointer.
