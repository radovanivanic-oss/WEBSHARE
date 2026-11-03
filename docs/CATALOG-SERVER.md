# Webshare katalógový mediálny server

## Architektúra

Crawler zostáva výhradne zdrojom surových Webshare súborov. Metadata, grouping, SQLite import a API sú samostatné obnoviteľné fázy.

```text
Webshare api/search
→ runtime/catalog-items.jsonl
→ scripts/import-catalog-jsonl.js
→ data/catalog.sqlite
→ scripts/enrich-metadata.js
→ scripts/reclassify-catalog.js
→ server/catalog-api.js
→ nginx /api/
→ Kodi addon
→ Webshare api/file_link pri prehrávaní
```

`api/file_link` sa počas importu ani enrichmentu nevolá. Databáza a API neobsahujú WST token ani Webshare heslo.

## Konfigurácia

Skopíruj potrebné hodnoty z `.env.example` do serverového `.env`. Reálne tajné hodnoty sa nesmú commitovať.

```env
CATALOG_DB_PATH=/home/radeco/webshare-crawler/data/catalog.sqlite
CATALOG_API_HOST=127.0.0.1
CATALOG_API_PORT=8787
CATALOG_API_BASE_PATH=/api
CATALOG_IMPORT_BATCH_SIZE=1000
CATALOG_API_MAX_PAGE_SIZE=100

TMDB_API_KEY=
TMDB_LANGUAGE=sk-SK
TMDB_FALLBACK_LANGUAGES=cs-CZ,en-US
TMDB_MAX_CONCURRENCY=2
TMDB_REQUEST_DELAY_MS=300
TMDB_CACHE_TTL_DAYS=30
TMDB_LIVE_REQUEST_TIMEOUT_MS=2500
TMDB_LIVE_TOTAL_TIMEOUT_MS=5000
TMDB_LIVE_CACHE_TTL_HOURS=6
TMDB_LIVE_STALE_TTL_HOURS=168
TMDB_LIVE_ERROR_TTL_MINUTES=5
TMDB_LIVE_RATE_LIMIT_PER_MINUTE=30
METADATA_AUTO_MATCH_THRESHOLD=0.90
METADATA_AMBIGUOUS_THRESHOLD=0.72
```

Ak `TMDB_API_KEY` chýba, enrichment sa bezpečne ukončí bez zmeny databázy.

## Migrácie a záloha

```bash
npm run db:migrate
npm run db:backup
node scripts/migrate-catalog.js --rollback
```

Migrácie majú verziu a checksum. Už aplikovaný migračný súbor sa nesmie meniť. Pred produkčnou migráciou sa vytvorí timestampovaná SQLite záloha v `data/backups/`.

## Import JSONL a production safety guardrail

Bežný bezpečný import je inkrementálny:

```bash
npm run catalog:import -- \
  --input runtime/catalog-items.jsonl \
  --database data/catalog.sqlite \
  --batch-size 1000
```

Import číta súbor po riadkoch, drží v RAM iba aktuálny batch, používa UPSERT podľa `ident`, zapisuje byte offset a číslo riadku a overuje fingerprint vstupu. Chybné riadky zapisuje do `runtime/catalog-import-errors.jsonl`.

`--full` povoľuje označenie starých nevidených súborov ako neaktívne, preto je
fail-closed. Vyžaduje naraz:

- manifest schémy 2 so zhodným size/fingerprint/count,
- `run_status: complete`,
- `reconciliation_safe: true`, `is_full: true` a nula failed prefixov,
- CLI prepínače `--full --allow-deactivation`,
- `CATALOG_ALLOW_FULL_RECONCILIATION=true`.

Pred deaktiváciou musí byť počet neplatných riadkov nula a počet prečítaných
riadkov sa musí zhodovať s `manifest.items`. Files a odvodené `media.is_active`
sa potom zmenia v správnom poradí v jednej transakcii.

Aktuálny crawler používa search/prefix stratégiu, ktorej úplnosť Webshare API
nevie potvrdiť. Produkčný wrapper preto používa dve bezpečné best-effort
rozšírenia: pokračuje za hlásený limit výsledkov a pri saturovanom prefixe
skúsi hlbšie znakové prefixy. Tým sa nájde viac kandidátov a zníži sa počet
chýbajúcich súborov, ale prekrývanie/fuzzy význam `what` stále neumožňuje
vyhlásiť úplný katalóg. Aj bez failed prefixov preto vytvára:

```json
{
  "run_status": "incomplete",
  "is_full": false,
  "reconciliation_safe": false,
  "completeness_reason": "prefix_strategy_not_verified"
}
```

Automatický databázový update je preto iba inkrementálny a staršie files
nezneaktívni. Pri failed prefixoch je stav `complete_with_failures`; pri páde
`aborted`.

Manuálny full manifest je núdzová operácia po nezávislej validácii vstupu:

```bash
export CATALOG_ALLOW_FULL_RECONCILIATION=true
npm run catalog:create-manifest -- \
  --confirmed-full \
  --allow-deactivation \
  --items 1639152
npm run catalog:import -- \
  --input runtime/catalog-items.jsonl \
  --manifest runtime/catalog-items.manifest.json \
  --full \
  --allow-deactivation
```

Bez všetkých guardrails skripty skončia pred otvorením databázy. Produkčné
`CATALOG_ALLOW_FULL_RECONCILIATION` má zostať `false`. Fáza B nepotvrdila
úplnosť a v2 zámerne nastavuje `reconciliation_safe=false`.

Legacy denný wrapper (po Fáze B zámerne zablokovaný no-argument guardom):

```bash
bash scripts/run-crawler-and-update.sh
```

Wrapper používa `flock` a preflight `.env`/Node/npm/syntax. Kým nie je schválený
shadow rollout v2, `node main.js` bez režimu zlyhá a vďaka `set -e` sa následný
import nespustí. Wrapper sa nesmie prepnúť na `--crawl` iba formálnym
deploymentom; vyžaduje samostatné rollout schválenie.

## Parser a grouping

Parser ukladá titul, rok, sezónu, epizódu, kvalitu, zdroj, kodeky, HDR, Dolby Vision, jazyky, dabing, titulky a release group.

```text
movie|dune-part-two|2024
episode|the-last-of-us|s01|e003
tv|the-last-of-us
```

Filmy bez roku zostávajú oddelené od filmov s rokom. Fuzzy podobnosť sa nepoužíva na automatické nevratné zlúčenie.

## Metadata enrichment

```bash
npm run metadata:enrich -- --limit 1000
npm run metadata:enrich -- --only-pending --limit 1000
npm run metadata:enrich -- --only-pending --recent-first --limit 1000
npm run metadata:enrich -- --retry-failed --limit 100
npm run metadata:enrich -- --dry-run --limit 50
```

Produkčný dávkový worker s lockom:

```bash
bash scripts/run-metadata-enrichment.sh
```

Veľkosť jednej dávky riadi `METADATA_ENRICH_BATCH_SIZE`. Súbežný druhý worker sa bezpečne ukončí.

Stavy jobov: `pending`, `processing`, `matched`, `ambiguous`, `not_found`, `temporary_error`, `permanent_error`.

TMDb odpovede sa cachujú. Epizódy rovnakého seriálu používajú spoločný TV lookup. Kandidáti priradení k rovnakému TMDb ID sa zlúčia na jeden `media` záznam; všetky Webshare verzie zostanú dostupné pod ním.

Odporúčaný postup je `--dry-run --limit 50`, následne pilot 1 000 jobov a až po kontrole výsledkov väčšie batch spracovanie.

## Reklasifikácia

```bash
npm run catalog:reclassify
node scripts/reclassify-catalog.js --limit 10000
```

Reklasifikácia nepoužíva Webshare ani TMDb requesty. Zmeny kategórie zapisuje do `classification_audit`.

## REST API

```bash
npm run api:start
```

Endpointy:

```text
GET /api/health
GET /api/categories
GET /api/media
GET /api/media/:id
GET /api/media/:id/files
GET /api/media/:id/metadata
GET /api/media/:id/episodes
GET /api/search?q=
GET /api/search/movies?q=
GET /api/search/series?q=
GET /api/filters/years
GET /api/filters/genres
GET /api/filters/languages
GET /api/filters/qualities
```

Listing podporuje `category`, `page`, `limit`, `sort`, `order`, `year`, `genre`, `language`, `quality` a `query`. Sort `release_date_desc` používa iba overený dátum premiéry z TMDb matchingu; parserový rok ani Webshare čas sa pre Novinky nepoužívajú. Server vždy obmedzí maximálnu veľkosť stránky. Detail súboru vracia `ident` a `webshare://` placeholder, nikdy WST alebo stream URL.

Endpoint `/api/media/:id/metadata` nikdy nehľadá titul podľa názvu. Použije iba vopred priradené TMDb ID, krátky timeout, jazykový fallback `sk-SK → cs-CZ → en-US`, samostatnú SQLite cache a rate limit. Nedostupné metadata vrátia bezpečný fallback; zoznam súborov ani prehrávanie tým nie sú blokované.

## Kodi

V nastaveniach addonu zapni `Používať stránkované katalógové API` a nastav napríklad `http://192.168.2.226/api`.

Pri vypnutom API režime addon naďalej používa pôvodné JSON katalógy. V API režime načíta iba jednu stránku médií a po otvorení titulu jeho Webshare verzie. Pri kliknutí použije existujúci lokálny `api/file_link` resolver.

## Produkčné nasadenie

Pripravené sú:

```text
deploy/webshare-catalog-api.service
deploy/nginx-webshare-catalog-api.conf
deploy/webshare-runtime-logrotate
scripts/install-catalog-api-server.sh
```

Bezpečné poradie:

1. deploy kódu,
2. overenie `.env`,
3. záloha databázy,
4. migrácie,
5. import JSONL,
6. kontrola počtov a API na localhoste,
7. malý TMDb pilot,
8. systemd,
9. nginx,
10. Kodi API režim.

Po nasadení možno pôvodný cron príkaz nahradiť volaním wrappera:

```cron
0 8,20 * * * /usr/bin/bash /home/radeco/webshare-crawler/scripts/run-crawler-and-update.sh >> /home/radeco/webshare-crawler/runtime/cron.log 2>&1
```

Explicitné volanie cez Bash funguje aj v prípade, že Git pracovná kópia nemá
zachovaný execute bit. Wrapper zároveň zabráni prekrývaniu cron behov.

Inštalačný skript inštaluje systemd jednotku, nginx snippet a logrotate pravidlo.
Ak nginx default server ešte neobsahuje include, skript ho vloží a pri zlyhaní
`nginx -t` obnoví zálohu.

Runtime logrotate používa dennú kontrolu, `maxsize 100M`, 14 rotácií, kompresiu
a `copytruncate`, aby nebolo potrebné reštartovať dlhý crawler.

## Monitoring

```bash
curl http://127.0.0.1:8787/api/health
bash scripts/status-server.sh
systemctl status webshare-catalog-api
journalctl -u webshare-catalog-api -n 100 --no-pager
```

Health obsahuje počty súborov, médií, metadata jobov, posledný import, enrichment, reklasifikáciu, veľkosť DB, uptime a pamäť API procesu.
