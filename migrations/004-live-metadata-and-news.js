module.exports = {
  version: 4,
  name: "live metadata cache and release news",
  up(database) {
    database.exec(`
      ALTER TABLE media ADD COLUMN external_url TEXT;

      CREATE TABLE metadata_live_cache (
        cache_key TEXT PRIMARY KEY,
        external_source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        language TEXT NOT NULL,
        payload_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('ok','not_found','temporary_error','invalid_response')),
        error_code TEXT,
        fetched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        stale_until TEXT NOT NULL
      );

      CREATE INDEX idx_metadata_live_cache_expiry
        ON metadata_live_cache(expires_at, stale_until);
      CREATE INDEX idx_media_news_release
        ON media(is_active, category, media_type, release_date DESC, year DESC, id DESC)
        WHERE release_date IS NOT NULL OR year IS NOT NULL;
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_media_news_release;
      DROP INDEX IF EXISTS idx_metadata_live_cache_expiry;
      DROP TABLE IF EXISTS metadata_live_cache;
      ALTER TABLE media DROP COLUMN external_url;
    `);
  },
};
