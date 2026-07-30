# B.5 – Hybrid Discovery Prototype

## Účel

Hybrid discovery je izolovaný prototyp na získanie potenciálne nových Webshare
`ident` hodnôt. Nie je crawler katalógu a neposkytuje dôkaz úplnosti.

Jeho jediný tok je:

```text
search recent
    ↓
izolovaný staging
    ↓
globálna deduplikácia podľa ident
    ↓
discovery checkpoint
    ↓
STOP
```

Lokálny produkčný SQLite katalóg zostáva autoritatívnym stavom aplikácie.
Discovery staging nie je zdrojom deactivation ani reconciliation rozhodnutí.

## Čo discovery robí

- vykoná jednu autentifikáciu cez existujúci bezpečný Webshare klient,
- posiela sekvenčné `search` requesty s `sort=recent`,
- používa explicitné `what`, `offset`, `limit` a `category=video`,
- posiela `what` presne, bez pridania wildcardu,
- ukladá iba validné identy,
- globálne deduplikuje identy v bounded `Set`,
- po každej stránke atomicky uloží ident snapshot a checkpoint,
- pred každým HTTP transportom durably rezervuje request slot,
- skončí pri prvom dosiahnutom limite alebo krátkej stránke,
- vždy udrží `enumeration_complete=false`.

Concurrency je pevne 1. Prototyp nemá retry slučku, auth refresh ani paralelný
worker pool.

## Čo discovery nerobí

Discovery:

- neotvára ani nemení `data/catalog.sqlite`,
- nečíta ani nemení produkčný catalog JSONL alebo jeho manifest,
- nepoužíva crawler frontier ani crawler state DB,
- nepoužíva produkčný checkpoint,
- nespúšťa produkčný ani shadow crawler,
- nevykonáva normalizáciu katalógu,
- nevykonáva import,
- nevykonáva reconciliation,
- nevykonáva deactivation,
- nevykonáva publication,
- nevolá `files_exist` ani `file_info`,
- netvrdí historickú, katalógovú alebo enumeračnú úplnosť.

Search absence nikdy nie je dôkazom odstránenia položky.

## Oddelenie od produkcie

Implementácia je v samostatnom namespace:

```text
lib/discovery/
scripts/run-hybrid-discovery.js
```

Produkčný `main.js` nemá nový discovery command branch. CLI adapter používa iba
existujúce nízkoúrovňové funkcie pre autentifikáciu a jeden search request.
Neimportuje crawler orchestrator, frontier, import ani publication kód.

Defaultný staging:

```text
runtime/hybrid-discovery/
```

Voliteľný staging musí byť priamy podadresár projektového `runtime` s názvom:

```text
hybrid-discovery
hybrid-discovery-<id>
```

Root nesmie byť:

- produkčný `runtime`,
- `data`,
- nested cesta,
- cesta s `..`,
- UNC alebo Windows device cesta,
- Windows drive-relative cesta,
- symlink alebo junction.

Pri vytvorení sa zaznamená filesystem identita staging rootu. Pred každým
zápisom sa znovu overuje device, inode/file identity a canonical realpath.
Zmena rootu alebo symlink swap spôsobí fail-closed stop.

Staging je explicitne ignorovaný Gitom.

## Staging artefakty

Úspešne inicializovaný run môže obsahovať iba:

```text
checkpoint.json
discovered-idents.json
discovery.log
manifest.json
discovery.lock        # iba počas aktívneho procesu
.tmp-*                # iba počas jedného atomického zápisu
```

`discovery.lock` používa exkluzívne vytvorenie a ownership nonce. Stale lock sa
automaticky nemaže ani nepreberá.

JSON artefakty sa zapisujú cez unique temporary file, `fsync`, rename a podľa
platformy directory `fsync`. Temporary file sa pri chybe odstráni iba v rámci
vlastného staging rootu.

## Query kontrakt

Povolená search konfigurácia je:

```text
what=<explicitná hodnota bez *>
sort=recent
category=video
offset=<checkpoint next_offset>
limit=<page_size>
```

Prototyp neobsahuje prefix splitting, alphabet, wildcard ani completeness
algoritmus. `reported_total` sa nepoužíva ako completion dôkaz.

## Limity

Každý limit je kladné celé číslo validované voči hard stropu:

| Limit | Default | Hard maximum | Význam |
|---|---:|---:|---|
| `maxPages` | 20 | 100 | maximálny počet spracovaných search stránok |
| `maxRequests` | 22 | 102 | všetky salt, login a search transport attempts |
| `maxDurationMs` | 120000 | 600000 | kumulatívny monotónny čas runu/resume |
| `maxNewIdents` | 2000 | 10000 | maximálna cardinalita globálneho ident Setu |
| `pageSize` | 100 | 100 | explicitný Webshare search limit |

Request slot sa zvýši a atomicky uloží pred transportom. Zlyhaný transport
spotrebovaný slot nevracia. Auth musí spotrebovať presne dva sloty (`salt`,
`login`) a každá stránka presne jeden search slot.

Stop reasons:

```text
max_pages
max_requests
max_duration
max_new_idents
source_exhausted
operator_aborted
technical_error
```

`source_exhausted` znamená iba pozorovanú krátku stránku. Ani tento dôvod
nenastavuje `enumeration_complete=true`.

Ak stránka obsahuje viac nových identov než zostávajúci ident budget, zapíšu sa
iba identy do presného limitu. `partial_page_offset` zostane na pôvodnom offsete
a watermark sa neposunie.

## Globálna deduplikácia

`discovered-idents.json` obsahuje bounded pole unikátnych identov. Pri štarte
alebo resume sa z neho vytvorí `Set`.

Ident:

- sa zapíše najviac raz,
- musí byť neprázdny a bez control znakov,
- môže mať maximálne 256 UTF-8 bajtov,
- sa neobohacuje o meno, URL, token alebo uploader údaje.

Snapshot cardinality nikdy nesmie prekročiť `maxNewIdents`. Resume odmietne
snapshot s duplicitami, neplatným identom alebo nesúladom run ID.

## Discovery checkpoint

Checkpoint je prevádzkový stav jedného discovery runu. Obsahuje:

- `run_id`,
- staging root a nemennú query konfiguráciu,
- pôvodné limity,
- `next_offset` a prípadný `partial_page_offset`,
- kumulatívny duration,
- pages/request counters,
- počet unikátnych, duplicitných a neplatných identov,
- status a stop reason,
- povinné `discovery_only=true`,
- povinné `enumeration_complete=false`.

Resume:

- musí použiť ten istý staging root, run ID, query a limity,
- nesmie znížiť counter,
- znovu načíta a validuje celý bounded ident snapshot,
- je povolený iba po `operator_aborted` alebo `technical_error`,
- nie je povolený po dosiahnutí limitu alebo krátkej stránke,
- nikdy neobnovuje ani neukladá WST.

Checkpoint neznamená:

- catalog completeness,
- crawler completeness,
- historical completeness,
- povolenie na import alebo publication.

## Manifest

Terminálny manifest obsahuje minimálne:

```text
run_id
started
finished
duration_ms
pages_scanned
requests_used
requests_completed
new_idents
duplicate_idents
invalid_idents
limits
finished_reason
status
query
```

Bezpečnostné polia sú vždy:

```json
{
  "discovery_only": true,
  "enumeration_complete": false,
  "catalog_complete": false,
  "historical_complete": false,
  "reconciliation_safe": false,
  "deactivation_allowed": false,
  "import_performed": false,
  "reconciliation_performed": false,
  "publication_performed": false
}
```

Tieto hodnoty sa neodvodzujú z počtu stránok, `reported_total`, krátkej stránky
ani stop reason.

## Budúce `files_exist` napojenie

`lib/discovery/files-exist-port.js` definuje iba budúcu hranicu rozhrania.

```text
TODO(B.6): samostatný bounded files_exist verification adapter
```

B.5 port nemá implementáciu a discovery ho nevolá. Budúce verification musí
mať vlastný request budget, durable stav a samostatnú deactivation policy.
Výsledok search discovery sa nesmie priamo premeniť na tombstone.

## CLI

CLI je zámerne samostatné od `main.js`:

```text
node scripts/run-hybrid-discovery.js \
  --what <explicit-query> \
  --staging-dir runtime/hybrid-discovery-<run-label> \
  --max-pages <N> \
  --max-requests <N> \
  --max-duration-ms <N> \
  --max-new-idents <N> \
  --page-size <N>
```

Samotná prítomnosť skriptu nič nespúšťa. API komunikácia nastane iba pri
explicitnom CLI spustení s credentialmi.
