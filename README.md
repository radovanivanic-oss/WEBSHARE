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
node main.js --status
```

Crawler sa nespustí bez explicitného režimu. Návrh a recovery postup sú v
`docs/crawler-correctness-recovery-v2.md`.

### Legacy utility credentials

The legacy `endpoint.js` proxy utility requires `PROXY_API_KEY`, and
`today.js` requires `WEBSHARE_WST`. Set these only in the local process
environment when deliberately running the corresponding utility. Both scripts
fail closed when the variable is missing, redact sensitive response fields,
and never accept a source-code fallback. Revoke and regenerate any credential
that was previously committed before using either utility again.

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
node main.js --status
```

Wrapper spúšťa inkrementálny `--crawl`; full reconciliation ani deaktivácia starých
súborov nie sú povolené bez bezpečného manifestu. Keďže Webshare pri širokých
full-text dotazoch hlási falošne nízky `total=1000`, wrapper používa bounded
best-effort stránkovanie do offsetu 10 000 (`CRAWLER_MAX_PAGES_PER_PREFIX=110`).
Výsledky sa deduplikujú a importujú inkrementálne, ale manifest zostáva
`incomplete`: verejné Webshare API neposkytuje dôkaz, že takýto zber pokryl celý
katalóg.

## Cron

Spúšťanie 2× denne:

```cron
0 8,20 * * * /usr/bin/bash /home/radeco/webshare-crawler/scripts/run-crawler-and-update.sh >> /home/radeco/webshare-crawler/runtime/cron.log 2>&1
```

Wrapper používa `flock`, vykoná preflight kontrolu Node.js a `.env` a nespustí druhý
súbežný crawl/update. Volanie cez `/usr/bin/bash` nezávisí od execute bitu skriptu.
Crawler vyžaduje explicitný režim. Wrapper preto volá `node main.js --crawl`;
pôvodné volanie bez argumentov skončilo okamžite kódom 2 a databázový update sa
nikdy nevykonal.

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
- pri seriáloch addon voliteľne dopĺňa sezóny a epizódy priamo z verejného Webshare search API a výsledok lokálne cachuje,
- sekcia Filmy → Novinky používa iba overený dátum premiéry z offline TMDb matchingu.

TMDb API kľúč patrí prednostne do serverového `.env`. Pre popisy seriálov, ktoré ešte
nemajú priradené externé ID v katalógu, je v Kodi voliteľný lokálny TMDb kľúč.
Webshare meno, heslo a WST zostávajú iba v profile Kodi a nikdy sa neposielajú
katalógovému serveru.

For a bounded resolver check outside Kodi, use `python tools/probe-webshare-file-link.py --ident <known-ident>` with fresh `WEBSHARE_USERNAME` and `WEBSHARE_PASSWORD` process variables. The probe does not persist WST or the signed URL and prints only authentication status, ident, URL scheme, and hostname. It does not download media. Missing credentials fail with `LIVE_PROBE_BLOCKED_MISSING_CREDENTIALS`.

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

Crawler + SQLite update wrapper:

```bash
bash scripts/run-crawler-and-update.sh
```

## Production safety guardrail

Aktuálna search/prefix stratégia nedokáže formálne potvrdiť úplnosť. Crawler preto
vytvára manifest `run_status: incomplete`, `is_full: false` a
`reconciliation_safe: false`. Automatický update je iba inkrementálny a nikdy
nezneaktívni staršie súbory.

Full reconciliation je fail-closed a vyžaduje samostatne overený manifest,
`--allow-deactivation` aj `CATALOG_ALLOW_FULL_RECONCILIATION=true`. Tento prepínač
má v produkčnom `.env` zostať `false`. Fáza B empiricky potvrdila, že dnešné
Webshare search rozhranie neposkytuje úplný, disjunktný prefix partition.

API štandardne počúva iba na `127.0.0.1:8787` a je určené pre nginx reverse proxy cez `/api/`.
Podrobná architektúra a bezpečné nasadenie sú v `docs/CATALOG-SERVER.md`.
