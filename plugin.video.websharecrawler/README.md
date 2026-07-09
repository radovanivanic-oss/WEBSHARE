# Webshare Atlas Kodi Addon

Webshare Atlas je Kodi video addon nad lokálnym exportom z Webshare crawlera.

Crawler ostáva oddelený:

- crawler vytvára iba katalóg `videos_all.json` a `videos_all.json.gz`
- addon robí lokálny index, menu, listing, históriu, obľúbené a resolver pri kliknutí
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
- `resources/settings.xml` - URL katalógu, Webshare login, TTL a stránkovanie.
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

## Indexovanie

Pri prvom otvorení addon vytvorí SQLite index v Kodi profile.

Indexuje:

- ident
- názov
- typ: film / epizóda
- rok
- kvalitu: 2160p / 1080p / 720p / SD / neznáma
- jazyk: CZ / SK / CZ/SK / EN / Multi / neznámy
- dabing/titulky: CZ dabing / SK dabing / titulky / neznáme
- žáner: zatiaľ placeholder podľa dostupných dát, inak neznáme
- seriálový názov
- sériu a epizódu
- veľkosť
- zdroj
- fulltextové pole

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

Nepoužíva sa:

```text
https://webshare.cz/dl/{id}/{wst}
```

## Default nastavenia

- primárny katalóg: `http://192.168.2.226/videos_all.json.gz`
- fallback katalóg: `http://192.168.2.226/videos_all.json`
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
- Novinky a Najnovšie pridané podľa lokálneho poradia katalógu
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
