# Webshare Crawler

Node.js crawler pre `webshare.cz`, určený na Ubuntu server a spúšťanie cez `cron`.

## Požiadavky

- Node.js `22+` (Ubuntu server používa Node.js 24 LTS)
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
0 8,20 * * * /usr/bin/bash /home/radeco/webshare-crawler/scripts/run-crawler-and-update.sh >> /home/radeco/webshare-crawler/runtime/cron.log 2>&1
```

Wrapper používa `flock`, vykoná preflight kontrolu Node.js a `.env` a nespustí druhý
súbežný crawl/update. Volanie cez `/usr/bin/bash` nezávisí od execute bitu skriptu.

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
- v API režime sa živý popis a artwork načítajú cez serverovú TMDb proxy podľa už priradeného externého ID,
- sekcia Filmy → Novinky používa iba overený dátum premiéry z offline TMDb matchingu.

TMDb API kľúč patrí iba do serverového `.env`. Webshare meno, heslo a WST zostávajú iba v profile Kodi a nikdy sa neposielajú katalógovému serveru.

## Katalógový mediálny server

Projekt obsahuje aj novú serverovú pipeline nad SQLite:

```text
runtime/catalog-items.jsonl
→ streaming import
→ parser a grouping
→ data/catalog.sqlite
→ voliteľný TMDb enrichment
→ read-only REST API
→ Kodi API režim
```

Základné príkazy:

```bash
npm run db:migrate
npm run catalog:import -- --input runtime/catalog-items.jsonl
npm run metadata:enrich -- --limit 1000
npm run catalog:reclassify
npm run api:start
```

Celý bezpečný crawler + SQLite update tok na Ubuntu:

```bash
bash scripts/run-crawler-and-update.sh
```

## Production safety guardrail

Aktuálna prefixová stratégia ešte nedokáže formálne potvrdiť úplnosť. Crawler preto
vytvára manifest `run_status: incomplete`, `is_full: false` a
`reconciliation_safe: false`. Automatický update je iba inkrementálny a nikdy
nezneaktívni staršie súbory.

Full reconciliation je fail-closed a vyžaduje samostatne overený manifest,
`--allow-deactivation` aj `CATALOG_ALLOW_FULL_RECONCILIATION=true`. Tento prepínač
má v produkčnom `.env` zostať `false`, kým Fáza B nepotvrdí úplnosť crawlu.

API štandardne počúva iba na `127.0.0.1:8787` a je určené pre nginx reverse proxy cez `/api/`.
Podrobná architektúra a bezpečné nasadenie sú v `docs/CATALOG-SERVER.md`.
