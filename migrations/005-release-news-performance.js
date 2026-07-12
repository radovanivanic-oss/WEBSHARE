module.exports = {
  version: 5,
  name: "release news performance",
  up(database) {
    database.exec(`
      CREATE INDEX idx_media_news_sort
        ON media(
          is_active,
          category,
          COALESCE(release_date, printf('%04d-01-01', year)) DESC,
          id DESC
        )
        WHERE release_date IS NOT NULL OR year IS NOT NULL;
    `);
  },
  down(database) {
    database.exec("DROP INDEX IF EXISTS idx_media_news_sort;");
  },
};
