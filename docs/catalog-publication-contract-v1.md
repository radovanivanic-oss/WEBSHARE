# Catalog publication v1

The immutable generation is authoritative. A record has exactly these 20 fields: `category,direct_url,extension,id,ident,img,mime,name,needsFileLink,negative_votes,password_protected,positive_votes,queued,size,source,stripe,stripe_count,title,type,url`.

`ident` is the unique Webshare identity; `id` is the numeric SQLite row ID; `name` is a required original filename; `title` is the legacy normalized/display representation and must not be treated as release metadata; extension is lower-case without a dot; `password_protected` is integer `0|1`; `url` and `direct_url` may be null only with `needsFileLink=true`. Static URLs are never fabricated. Physical order is `ident ASC,id ASC` and is not chronology, ranking, or Novinky order.

Generations live under `catalog-publications/generations/<id>/`; `current.json` is the sole atomically replaced activation pointer. Write+validate generation first, switch pointer second, preserve prior generation, and rollback only by replacing the pointer. This document defines no production activation.
