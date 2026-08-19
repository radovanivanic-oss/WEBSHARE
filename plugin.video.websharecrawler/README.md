# Webshare Atlas Kodi Addon

## Verejný statický katalóg

Webshare Atlas od verzie 0.8.18 predvolene používa verejný, verzovaný katalóg distribuovaný cez GitHub. Súkromný server preto nie je potrebný na navigáciu, vyhľadávanie ani načítanie metadata.

Katalóg je odvodený read model. Obsahuje iba metadata, verejné identy súborov a vzťahy seriál → séria → epizóda → variant. Neobsahuje WST, prihlasovacie údaje ani vyriešené stream URL.

V nastaveniach stačí ponechať zapnuté `Používať verejný katalóg`. Interný API fallback a URL override sú dostupné iba v sekcii Expert / Vývojár.

Webshare login a `api/file_link` resolver zostávajú v Kodi. Pri prehrávaní sa stále používa priame Webshare spojenie.

Webshare Atlas je Kodi video addon nad lokálnym exportom z Webshare crawlera.

Crawler ostáva oddelený:

- crawler vytvára privátny autoritatívny katalóg a exportovateľný statický read model
- addon sťahuje a overuje iba verejnú generáciu, potom používa lokálnu cache, menu, listing, históriu, obľúbené a resolver pri kliknutí
- stream URL sa nikdy neukladá do hlavného katalógu

## Architektúra

```text
Catalog
-> Indexer
-> Local Store
-> Menu
-> Listing
-> Resolver
-> Playback State
```

## Súbory

- `addon.xml` - Kodi manifest a service registrácia.
- `default.py` - menu, routing, listing, context menu a play flow.
- `service.py` - priebežné ukladanie pozície počas prehrávania.
- `resources/settings.xml` - verejný katalóg, Webshare login, TTL a stránkovanie; legacy URL override je iba v Expert / Vývojár.
- `resources/lib/catalog.py` - načítanie `.json.gz` alebo `.json`.
- `resources/lib/indexer.py` - prvé indexovanie a preindexovanie katalógu.
- `resources/lib/metadata.py` - odvodenie typu, kvality, roku, jazyka a epizód z názvu.
- `resources/lib/store.py` - SQLite lokálny index, história, obľúbené, vyhľadávania.
- `resources/lib/webshare.py` - Webshare WST login, `api/file_link` resolver a cache.

## Menu

```text
Hľadať
Rýchly výber
Filmy
Seriály
Kvalita
Roky
Jazyk
Pokračovať
Obľúbené
História
Katalóg
Nastavenia
```

## Lokálna cache

Pri prvom otvorení addon overí pointer, manifest, SHA-256 a gzip objektov a uloží platnú generáciu do Kodi profilu. Pri nedostupnosti GitHubu ponechá poslednú platnú generáciu.

Lokálna cache obsahuje:

- root media záznamy rozdelené podľa kategórie
- lokálny tokenový vyhľadávací index
- série, sezóny, epizódy a hrateľné varianty
- ident, názov, kvalita, jazyk, veľkosť a metadata pre zobrazenie

Žáner zatiaľ nie je indexovaný, lebo aktuálny crawler katalóg ho nedodáva spoľahlivo.

## Resolver

Pri prehratí:

```text
ident
-> cache ident -> resolvedUrl
-> WST cache/login
-> https://webshare.cz/api/file_link/
-> Kodi playback
```

Priame download URL sa nepoužívajú; stream sa odovzdáva iba po
úspešnom `file_link` resolveri.

## Predvolené nastavenia

- verejný statický katalóg: zapnutý
- Ubuntu/API URL: nie je potrebná pre bežnú prevádzku
- resolver cache TTL: 6 hodín
- stránkovanie: 50 položiek

## Balenie ZIP

Po každej zmene zvýš verziu v `addon.xml` a vytvor nový ZIP:

```powershell
powershell -ExecutionPolicy Bypass -File tools/package-kodi-addon.ps1
```

Výstup:

```text
plugin.video.websharecrawler.zip
```

Kodi update z lokálneho ZIPu funguje spoľahlivo vtedy, keď je verzia v `addon.xml` vyššia ako aktuálne nainštalovaná verzia.

## Stav implementácie

Hotové:

- vlastná identita a menu Webshare Atlas
- lokálny SQLite index
- gzip/json katalóg s fallbackom
- lokálne fulltextové hľadanie
- rýchle filtre
- domovská stránka s rýchlym hľadaním, uloženými filtrami a pripnutými položkami
- pokročilý lokálny filter
- pripnutie a skrytie položiek na hlavnej stránke
- filmy / seriály / kvalita / roky / jazyk
- Novinky iba podľa overeného TMDb `release_date`
- živý popis a artwork cez serverovú TMDb proxy bez TMDb kľúča v Kodi
- čisté technické názvy Webshare verzií s HDR, Dolby Vision, kodekmi, jazykom a veľkosťou
- Žánre s bezpečným fallbackom na neznáme/neurčené
- Dabing / titulky odvodené heuristicky z názvu súboru
- stránkované listingy
- obľúbené
- história
- pokračovanie v pozeraní cez Kodi service
- technické menu katalógu
- Webshare resolver cez `api/file_link`
- WST cache
- resolved URL cache

Crawler nie je touto vrstvou menený.
