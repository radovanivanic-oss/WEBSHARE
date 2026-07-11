module.exports = {
  version: 1,
  name: "initial catalog schema",
  up(database) {
    database.exec(`
      CREATE TABLE crawl_runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','partial')),
        is_full INTEGER NOT NULL DEFAULT 0 CHECK(is_full IN (0,1)),
        items_seen INTEGER NOT NULL DEFAULT 0,
        prefixes_processed INTEGER NOT NULL DEFAULT 0,
        errors_count INTEGER NOT NULL DEFAULT 0,
        source_manifest TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE import_runs (
        id INTEGER PRIMARY KEY,
        crawl_run_id INTEGER REFERENCES crawl_runs(id),
        input_path TEXT NOT NULL,
        input_size INTEGER NOT NULL,
        input_mtime_ms INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL,
        byte_offset INTEGER NOT NULL DEFAULT 0,
        line_number INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','interrupted')),
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        invalid_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE media (
        id INTEGER PRIMARY KEY,
        media_key TEXT NOT NULL UNIQUE,
        external_source TEXT,
        external_id TEXT,
        media_type TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'unknown',
        title TEXT NOT NULL,
        original_title TEXT,
        year INTEGER,
        release_date TEXT,
        season_number INTEGER,
        episode_number INTEGER,
        tvshow_id INTEGER REFERENCES media(id),
        overview TEXT,
        genres_json TEXT NOT NULL DEFAULT '[]',
        runtime_minutes INTEGER,
        rating REAL,
        vote_count INTEGER,
        countries_json TEXT NOT NULL DEFAULT '[]',
        languages_json TEXT NOT NULL DEFAULT '[]',
        director TEXT,
        cast_json TEXT NOT NULL DEFAULT '[]',
        poster_url TEXT,
        backdrop_url TEXT,
        adult INTEGER NOT NULL DEFAULT 0 CHECK(adult IN (0,1)),
        metadata_language TEXT,
        metadata_status TEXT NOT NULL DEFAULT 'local',
        metadata_confidence REAL NOT NULL DEFAULT 0,
        metadata_updated_at TEXT,
        classifier_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE candidates (
        id INTEGER PRIMARY KEY,
        candidate_key TEXT NOT NULL UNIQUE,
        lookup_key TEXT NOT NULL,
        normalized_title TEXT NOT NULL,
        parsed_year INTEGER,
        candidate_type TEXT NOT NULL,
        season_number INTEGER,
        episode_number INTEGER,
        series_key TEXT,
        parse_confidence REAL NOT NULL DEFAULT 0,
        grouping_version TEXT NOT NULL,
        file_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        media_id INTEGER REFERENCES media(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE files (
        id INTEGER PRIMARY KEY,
        ident TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        extension TEXT,
        mime TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        webshare_category TEXT,
        placeholder_url TEXT,
        created_at_webshare TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_seen_run_id INTEGER REFERENCES crawl_runs(id),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
        is_playable_video INTEGER NOT NULL DEFAULT 0 CHECK(is_playable_video IN (0,1)),
        candidate_id INTEGER REFERENCES candidates(id),
        media_id INTEGER REFERENCES media(id),
        parsed_title TEXT,
        parsed_year INTEGER,
        parsed_season INTEGER,
        parsed_episode INTEGER,
        parsed_resolution TEXT,
        parsed_source TEXT,
        parsed_video_codec TEXT,
        parsed_audio_codec TEXT,
        parsed_hdr INTEGER CHECK(parsed_hdr IN (0,1)),
        parsed_dolby_vision INTEGER CHECK(parsed_dolby_vision IN (0,1)),
        parsed_languages_json TEXT NOT NULL DEFAULT '[]',
        parsed_has_dubbing INTEGER CHECK(parsed_has_dubbing IN (0,1)),
        parsed_has_subtitles INTEGER CHECK(parsed_has_subtitles IN (0,1)),
        parsed_release_group TEXT,
        parse_confidence REAL NOT NULL DEFAULT 0,
        parse_reason TEXT,
        parse_version TEXT NOT NULL,
        img TEXT,
        stripe TEXT,
        stripe_count INTEGER NOT NULL DEFAULT 0,
        queued INTEGER NOT NULL DEFAULT 0,
        positive_votes INTEGER NOT NULL DEFAULT 0,
        negative_votes INTEGER NOT NULL DEFAULT 0,
        password_protected INTEGER NOT NULL DEFAULT 0 CHECK(password_protected IN (0,1)),
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE media_aliases (
        id INTEGER PRIMARY KEY,
        media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL,
        language TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(media_id, normalized_alias)
      );

      CREATE TABLE metadata_jobs (
        id INTEGER PRIMARY KEY,
        candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
        candidate_key TEXT NOT NULL UNIQUE,
        parsed_title TEXT NOT NULL,
        parsed_year INTEGER,
        candidate_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','processing','matched','ambiguous','not_found','temporary_error','permanent_error')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        selected_source TEXT,
        selected_external_id TEXT,
        confidence REAL,
        locked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE metadata_cache (
        cache_key TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        language TEXT,
        response_json TEXT,
        http_status INTEGER,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE classification_audit (
        id INTEGER PRIMARY KEY,
        file_id INTEGER REFERENCES files(id),
        media_id INTEGER REFERENCES media(id),
        old_category TEXT,
        new_category TEXT NOT NULL,
        reason TEXT NOT NULL,
        confidence REAL NOT NULL,
        classifier_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE VIRTUAL TABLE media_fts USING fts5(
        media_id UNINDEXED,
        title,
        original_title,
        aliases,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE UNIQUE INDEX idx_media_external ON media(external_source, external_id, media_type, season_number, episode_number)
        WHERE external_source IS NOT NULL AND external_id IS NOT NULL;
      CREATE INDEX idx_media_category_type_year ON media(category, media_type, year);
      CREATE INDEX idx_media_tvshow ON media(tvshow_id, season_number, episode_number);
      CREATE INDEX idx_candidates_lookup ON candidates(lookup_key);
      CREATE INDEX idx_candidates_series ON candidates(series_key);
      CREATE INDEX idx_candidates_status ON candidates(status, parse_confidence);
      CREATE INDEX idx_files_candidate_active ON files(candidate_id, is_active);
      CREATE INDEX idx_files_media_active ON files(media_id, is_active);
      CREATE INDEX idx_files_playable_active ON files(is_playable_video, is_active);
      CREATE INDEX idx_files_last_seen_run ON files(last_seen_run_id);
      CREATE INDEX idx_files_year ON files(parsed_year);
      CREATE INDEX idx_metadata_jobs_queue ON metadata_jobs(status, next_attempt_at);
      CREATE INDEX idx_media_aliases_normalized ON media_aliases(normalized_alias);
      CREATE INDEX idx_metadata_cache_expiry ON metadata_cache(expires_at);
      CREATE INDEX idx_classification_audit_media ON classification_audit(media_id, created_at);
    `);
  },
  down(database) {
    database.exec(`
      DROP TABLE IF EXISTS media_fts;
      DROP TABLE IF EXISTS app_state;
      DROP TABLE IF EXISTS classification_audit;
      DROP TABLE IF EXISTS metadata_cache;
      DROP TABLE IF EXISTS metadata_jobs;
      DROP TABLE IF EXISTS media_aliases;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS candidates;
      DROP TABLE IF EXISTS media;
      DROP TABLE IF EXISTS import_runs;
      DROP TABLE IF EXISTS crawl_runs;
    `);
  },
};
