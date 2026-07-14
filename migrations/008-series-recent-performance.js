module.exports = {
  version: 8,
  name: "series recent listing performance",
  up(database) {
    database.exec(`
      CREATE INDEX idx_files_media_active_playable_recent
        ON files(media_id, is_active, is_playable_video, id DESC);
      CREATE INDEX idx_media_tvshow_active_recent
        ON media(tvshow_id, is_active, id)
        WHERE tvshow_id IS NOT NULL;
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_media_tvshow_active_recent;
      DROP INDEX IF EXISTS idx_files_media_active_playable_recent;
    `);
  },
};
