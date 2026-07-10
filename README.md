# Webshare Crawler

Node.js crawler pre `webshare.cz`, určený na Ubuntu server a spúšťanie cez `cron`.

## Požiadavky

- Node.js `20+`
- Ubuntu server
- ENV premenné:
  - `WEBSHARE_USERNAME`
  - `WEBSHARE_PASSWORD`
  - `OUTPUT_JSON_PATH` (default cieľ na serveri: `/var/www/html/videos_all.json`)

## Lokálny vývoj na Windows

```bash
npm install
node --check main.js
node main.js
```

Pri lokálnom spustení nastav ENV premenné pred štartom.

## GitHub workflow

Projekt je určený na workflow:

`Windows vývoj -> GitHub -> Ubuntu server -> git pull -> npm install -> cron`

Do repozitára nepatria:

- `.env`
- `runtime/`
- logy
- generované JSON výstupy
- `node_modules/`

## Ubuntu deploy

Prvé nasadenie:

```bash
cd ~
git clone git@github.com:RADOVAN_USERNAME/WEBSHARE_REPO.git webshare-crawler
cd ~/webshare-crawler
npm install
node --check main.js
```

Ďalší update:

```bash
cd ~/webshare-crawler
git pull
npm install
node --check main.js
```

## `.env` na Ubuntu

Vytvor súbor:

```bash
cd ~/webshare-crawler
nano .env
```

Obsah:

```env
WEBSHARE_USERNAME=...
WEBSHARE_PASSWORD=...
OUTPUT_JSON_PATH=/var/www/html/videos_all.json
```

## Ručný test na Ubuntu

```bash
cd ~/webshare-crawler
set -a
. ./.env
set +a
node main.js
```

## Cron

Spúšťanie 2× denne:

```cron
0 8,20 * * * cd /home/radeco/webshare-crawler && set -a && . ./.env && set +a && /usr/bin/node main.js >> runtime/cron.log 2>&1
```

Crawler je oddelený od trading bota:

- vlastný adresár: `/home/radeco/webshare-crawler`
- vlastné env: `/home/radeco/webshare-crawler/.env`
- vlastné runtime logy: `/home/radeco/webshare-crawler/runtime/`

## Výstupy

- JSON: `/var/www/html/videos_all.json`
- Gzip: `/var/www/html/videos_all.json.gz`
- Health: `runtime/health.json`

## Kodi addon

Addon `plugin.video.websharecrawler` je oddelená vrstva nad hotovým katalógom:

- crawler vyrába iba katalóg,
- Kodi addon načítava `videos_all.json.gz` s fallbackom na JSON,
- stream URL sa rieši až pri kliknutí cez Webshare `api/file_link`,
- metadata z TMDb sa načítavajú len na požiadanie pre aktuálny listing a ukladajú sa do lokálnej SQLite cache.

TMDb API kľúč, Webshare meno a heslo patria iba do nastavení addonu v Kodi, nikdy nie do repozitára.
