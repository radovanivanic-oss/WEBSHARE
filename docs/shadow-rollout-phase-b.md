# Fáza B.1 – Bounded Shadow Rollout Harness

## Účel

Shadow režim overuje SQLite frontier crawler na malom, pevne ohraničenom
výreze reálneho Webshare API. Nie je to produkčný crawl, import,
reconciliation ani publish. Výsledok nikdy nie je dôkazom úplnosti katalógu.

Spustenie musí byť explicitné:

```bash
node main.js --shadow-crawl
```

Samotná ENV premenná shadow režim neaktivuje.

## Bezpečnostné hranice

Predvolený zapisovateľný koreň je:

```text
runtime/shadow-phase-b/
```

Všetky zapisovateľné artefakty sú pod týmto koreňom:

```text
runtime/shadow-phase-b/crawler-state.sqlite
runtime/shadow-phase-b/crawler-state.sqlite-wal
runtime/shadow-phase-b/crawler-state.sqlite-shm
runtime/shadow-phase-b/exports/
runtime/shadow-phase-b/logs/
runtime/shadow-phase-b/shadow.lock
runtime/shadow-phase-b/report.json
```

Harness pred štartom používa `path.resolve`, `path.relative` a `realpath`.
Odmieta traversal mimo shadow root aj existujúci symlink alebo junction v
ceste. Odmieta produkčný `runtime` ako shadow root a overuje kolízie so
známymi produkčnými DB, JSONL, manifestmi, checkpointmi, seen indexom,
failed-prefix dátami a webovými exportmi.

UNC/device cesty, Windows drive-relative cesty a explicitné `..` segmenty sú
odmietnuté. Windows porovnania sú case-insensitive. Po vytvorení rootu sa
uchová jeho `(dev, ino, realpath)` identita a znovu sa kontroluje pred lockom,
DB, disk scanom, reportom a exportom. Každý disk scan odmietne aj nested
symlink/junction. Root používa mód `0700`.

Node neposkytuje prenositeľný `openat(..., O_NOFOLLOW)` pre celý adresárový
strom. Preto zostáva veľmi úzke TOCTOU okno voči procesu s právom premenovať
shadow root presne medzi poslednou kontrolou a syscallom. Harness ho zmenšuje
opakovanou kontrolou identity a privátnymi permissions; nie je to ochrana voči
privilegovanému lokálnemu útočníkovi.

Shadow vetva nevolá import, reconciliation, publish ani GitHub export.
`data/catalog.sqlite` neotvára. Log sa zapisuje iba do shadow `logs/`.

## CLI

Nový run:

```bash
node main.js --shadow-crawl \
  --shadow-root-prefix a \
  --max-prefixes 100 \
  --max-pages 300 \
  --max-items 25000 \
  --max-requests 350 \
  --max-duration-minutes 20 \
  --max-disk-bytes 1073741824 \
  --concurrency 1 \
  --page-size 100
```

Alternatívny izolovaný adresár:

```bash
node main.js --shadow-crawl --shadow-dir /safe/path/shadow-phase-b
```

Read-only status a validácia:

```bash
node main.js --status --shadow-dir runtime/shadow-phase-b
node main.js --validate-crawl --shadow-dir runtime/shadow-phase-b
```

Resume:

```bash
node main.js --resume --shadow-dir runtime/shadow-phase-b
```

Run zastavený shadow limitom navyše vyžaduje:

```bash
node main.js --resume \
  --shadow-dir runtime/shadow-phase-b \
  --resume-shadow-limited
```

Kombinácie s `--confirmed-full`, `--import`, `--publish` alebo
`--allow-deactivation` failnú pred otvorením crawler DB.

## Hard limity a defaulty

Prvý rollout používa zhodné konzervatívne defaulty a hard stropy:

| Limit | Default | Hard maximum |
|---|---:|---:|
| root prefixy | 1 | 1 |
| concurrency | 1 | 1 |
| frontier riadky (roots + deti splitu) | 100 | 100 |
| commitnuté stránky | 300 | 300 |
| HTTP requesty | 350 | 350 |
| unikátne položky | 25 000 | 25 000 |
| trvanie | 20 min | 20 min |
| shadow disk | 1 GiB | 1 GiB |
| page size | 100 | 100 |

CLI môže hodnotu iba znížiť. Vyššia hodnota je odmietnutá.
Jediný root prefix má navyše najviac 256 UTF-8 bajtov a nesmie obsahovať
control znaky, aby samotný CLI/report vstup nemohol obísť diskový budget.
`maxDiskBytes` má bezpečnostné minimum 2 MiB, aby sa konfigurácia nemohla
tváriť ako dodržaná, hoci sa do nej nezmestí ani základná atómová DB/report
operácia.

`maxPrefixes` nepočíta lease ani retry. Pred splitom sa kontroluje
`COUNT(crawl_frontier) + počet nových unikátnych detí`; tá istá podmienka sa
opakuje v `BEGIN IMMEDIATE` transakcii, ktorá vkladá deti a dokončuje parent.
Pri nedostatku budgetu sa page necommitne a parent sa vráti do `queued`.

## Stop podmienky

Limity sa kontrolujú pred lockom, pred lease, pred a po HTTP requeste, pred a po page
commite, pred splitom a pred exportom. Použité dôvody:

```text
shadow_max_prefixes
shadow_max_pages
shadow_max_requests
shadow_max_items
shadow_max_duration
shadow_max_disk
shadow_operator_abort
```

Limitný stop:

- abortne ďalšie HTTP cez `AbortSignal`;
- neleaseuje nový prefix;
- aktívny lease vráti do `queued`;
- otvorený SQLite page commit sa buď celý commitne, alebo rollbackne;
- nastaví run na `incomplete`;
- ponechá `reconciliation_safe=false`;
- uvoľní `shadow.lock`.

`SIGINT` a `SIGTERM` zostávajú kontrolované operátorské ukončenie so stavom
`aborted`, nie úspech.

Čas sa meria monotónne cez `process.hrtime.bigint()`. Diskový scan prechádza
iba shadow root, odmieta symlinky a zahŕňa state DB, WAL, SHM, exporty a logy.
Pri 90 % vznikne warning; pri limite sa run zastaví.

Každý skutočný Webshare HTTP pokus sa započíta ešte pred odoslaním. Report
oddeľuje login, search, retry a total requesty. Login zahŕňa salt aj login
request.

Request slot sa rezervuje v `shadow_run_budget` jednou SQLite `IMMEDIATE`
transakciou. Tá istá transakcia aktualizuje salt/login/search/retry counters a
per-operation attempt záznam. Rezervovaný slot sa pri network chybe ani páde
nevracia. Ak je `AbortSignal` nastavený už pred rezerváciou, transport sa
nevolá a slot sa neminie; abort medzi rezerváciou a transport callom slot
ponechá minutý (fail-closed účtovanie pokusu).

Stop priorita je deterministická:

1. `SIGINT`/`SIGTERM` → `aborted`;
2. shadow hard limit → `incomplete`;
3. technická/invariant chyba → `recovery_required`.

Medzi dvoma hard limitmi rozhoduje poradie kontrol v danom stage: duration,
disk a potom stage-specific request/page/item/prefix limit.

## Report a status

`report.json` obsahuje:

```text
shadow_mode
shadow_limits
shadow_stop_reason
shadow_started_at
shadow_finished_at
requests_total
login_requests
search_requests
retry_requests
items_unique
pages_committed
prefixes_leased
prefixes_complete
prefixes_failed
prefixes_blocked
peak_disk_bytes
duration_ms
algorithm_fingerprint
frontier_states
last_committed_page
last_error
```

Status a validate nekopírujú nič do shadow rootu a originálnu SQLite DB vôbec
neotvárajú. DB spolu s existujúcim WAL/SHM sa skopíruje do unikátneho OS temp
adresára a read-only dotazy bežia nad touto kópiou. Originálne DB/WAL/SHM,
report, manifest aj mtimes/hash zostávajú bitovo nezmenené.

## Resume pravidlá

Resume overí:

- `shadow_mode=true`;
- rovnaký canonical shadow root;
- rovnaký algorithm fingerprint;
- rovnaké alebo nižšie limity;
- nevyčerpaný kumulatívny hard limit;
- platnú a izolovanú state DB.

Počítadlá a trvanie pokračujú kumulatívne z reportu a autoritatívnej SQLite
budget tabuľky. Zvýšenie limitu
cez resume nie je povolené. Ak bol konfigurovaný limit už spotrebovaný,
resume je odmietnutý aj s `--resume-shadow-limited`.

Autoritatívne request/duration/disk counters, pôvodné limity, canonical root a
run_id sú aj v SQLite `shadow_run_budget`; report ich pri resume môže iba
zvýšiť, nie znížiť. Stavová matica:

- `aborted`: `--resume` je povolený;
- `incomplete` pre konkrétny `shadow_max_*`: vyžaduje
  `--resume-shadow-limited` a zostávajúci budget;
- `incomplete` s `blocked` prefixom: automatický resume je zakázaný;
- `complete_with_failures`: iba explicitný `--retry-failed --shadow-dir ...`;
- `recovery_required` a `complete`: automatický resume je zakázaný;
- terminálny/exportovaný `incomplete` bez queued/in-progress práce sa znovu
  neexportuje.

## Export

Jediný povolený export je:

```text
runtime/shadow-phase-b/exports/<run_id>/
  catalog-items.jsonl
  catalog-items.manifest.json
  shadow-report.json
```

Celý adresár sa najprv vytvorí ako dočasná generácia, súbory sa fsyncnú a
publikujú jedným `rename`. Pri chybe sa existujúca generácia neprepíše.
Pred exportom sa spočíta presný JSONL payload a rezervuje priestor na
JSONL/manifest/report. Temp adresár má UUID, cleanup overuje jeho pôvodnú
identitu a `SIGTERM` sa kontroluje aj tesne pred rename.

Manifest je schema 2 a vždy obsahuje:

```json
{
  "shadow_mode": true,
  "reconciliation_safe": false,
  "partition_completeness_proven": false,
  "is_full": false
}
```

Centrálny catalog import guard explicitne odmieta každý
`shadow_mode=true` manifest pre deaktiváciu, aj keby operátor nastavil
ostatné full-reconciliation opt-iny.

## Porovnanie s legacy JSONL

Nástroj:

```bash
node scripts/compare-shadow-crawl.js \
  --shadow-jsonl runtime/shadow-phase-b/exports/RUN/catalog-items.jsonl \
  --legacy-jsonl runtime/catalog-items.jsonl \
  --output-report runtime/shadow-phase-b/comparison.json
```

Oba vstupy číta streamovane. Unikátne identy drží v dočasnej SQLite DB v OS
temp adresári, nie v RAM. Reportuje overlap, shadow-only, legacy-only,
duplicitné a neplatné riadky a distribúcie extension/category/prefix.

Riadok nad 1 MiB sa zahodí ako `oversized_lines` bez neobmedzeného bufferu.
Extension a category distribúcie majú najviac 256 explicitných kľúčov plus
`__other__`; prefix je normalizovaný do pevnej malej množiny. SQLite commit
prebieha po dávkach 2000 platných riadkov. Shadow/legacy input nesmú byť
rovnaký súbor ani hardlink/symlink alias a output nesmie kolidovať so vstupom
ani prepísať existujúci report.

Každý report obsahuje:

```text
comparison_is_not_reconciliation=true
legacy_only_is_not_deletion=true
```

`legacy-only` je pri bounded výreze očakávané a nikdy neznamená odstránenie.

## Cleanup

Cleanup sa nevykonáva automaticky. Po teste sa shadow artefakty ponechajú na
audit a odstránia sa až samostatným, explicitne schváleným operátorským
príkazom. Produkčné runtime dáta sa nepoužívajú ako cleanup cieľ.

Predvolený adresár je explicitne uvedený v `.gitignore` (popri celom
`runtime/`). Produkčné cleanup/deploy skripty nemažú celý runtime, publish
kopíruje iba explicitné produkčné output/health/catalog cesty a status server
číta konkrétne produkčné súbory, nie `runtime/**`; shadow adresár sa preto
nepublikuje ani nezamieňa s produkčným runtime.

## GO kritériá

Reálny bounded shadow run je GO iba ak:

- prejdú všetky unit, recovery a shadow testy;
- žiadna produkčná cesta sa nezmení;
- SIGTERM a resume fungujú;
- request, page, item, prefix, duration a disk limity sú dodržané;
- repeated-page a saturation guard zostávajú aktívne;
- export a schema 2 manifest sú validné;
- manifest zostáva `reconciliation_safe=false`;
- comparison report neinterpretuje absenciu ako deletion.

## NO-GO kritériá

Okamžité NO-GO:

- zápis mimo shadow root;
- otvorenie `data/catalog.sqlite` na zápis;
- vznik produkčného `runtime/crawler-state.sqlite`;
- import, reconciliation alebo publish volanie;
- prekročenie request limitu;
- nefunkčný SIGTERM alebo nesprávny resume;
- akékoľvek `reconciliation_safe=true`;
- neatomický export;
- zmena produkčného JSONL alebo manifestu.
