module.exports = {
  version: 9,
  name: "series release evidence performance",
  up(database) {
    database.exec(`
      CREATE INDEX idx_media_tvshow_release_date
        ON media(tvshow_id, release_date DESC)
        WHERE tvshow_id IS NOT NULL AND is_active = 1 AND release_date IS NOT NULL;
      CREATE INDEX idx_media_tvshow_year
        ON media(tvshow_id, year DESC)
        WHERE tvshow_id IS NOT NULL AND is_active = 1 AND year IS NOT NULL;
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_media_tvshow_year;
      DROP INDEX IF EXISTS idx_media_tvshow_release_date;
    `);
  },
};
