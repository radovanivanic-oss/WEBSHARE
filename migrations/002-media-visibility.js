module.exports = {
  version: 2,
  name: "materialized media visibility",
  up(database) {
    database.exec(`
      ALTER TABLE media ADD COLUMN is_active INTEGER NOT NULL DEFAULT 0 CHECK(is_active IN (0,1));
      CREATE INDEX idx_media_active_category_type_year ON media(is_active, category, media_type, year);
      CREATE INDEX idx_media_tvshow_active_episode ON media(tvshow_id, is_active, season_number, episode_number);

      UPDATE media SET is_active = 1
      WHERE id IN (
        SELECT DISTINCT media_id FROM files
        WHERE media_id IS NOT NULL AND is_active = 1 AND is_playable_video = 1
      );

      UPDATE media SET is_active = 1
      WHERE id IN (
        SELECT DISTINCT episode.tvshow_id
        FROM media episode JOIN files ON files.media_id = episode.id
        WHERE episode.tvshow_id IS NOT NULL AND files.is_active = 1 AND files.is_playable_video = 1
      );
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_media_tvshow_active_episode;
      DROP INDEX IF EXISTS idx_media_active_category_type_year;
      ALTER TABLE media DROP COLUMN is_active;
    `);
  },
};
