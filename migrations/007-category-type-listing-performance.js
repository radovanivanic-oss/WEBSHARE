module.exports = {
  version: 7,
  name: "category and tv listing performance",
  up(database) {
    database.exec(`
      CREATE INDEX idx_media_listing_category_type_recent
        ON media(is_active, category, media_type, updated_at DESC, id DESC);
      CREATE INDEX idx_media_tvshow_episode_lookup
        ON media(tvshow_id, media_type, is_active, id)
        WHERE tvshow_id IS NOT NULL;
      CREATE INDEX idx_files_playable_media_lookup
        ON files(is_active, is_playable_video, media_id);
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_files_playable_media_lookup;
      DROP INDEX IF EXISTS idx_media_tvshow_episode_lookup;
      DROP INDEX IF EXISTS idx_media_listing_category_type_recent;
    `);
  },
};
