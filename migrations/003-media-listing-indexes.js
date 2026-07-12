module.exports = {
  version: 3,
  name: "catalog API listing indexes",
  up(database) {
    database.exec(`
      CREATE INDEX idx_media_listing_recent
        ON media(is_active, category, updated_at DESC, id DESC);
      CREATE INDEX idx_media_listing_title
        ON media(is_active, category, title COLLATE NOCASE, id);
      CREATE INDEX idx_media_listing_year
        ON media(is_active, category, year DESC, id DESC);
      CREATE INDEX idx_media_listing_rating
        ON media(is_active, category, rating DESC, id DESC);
    `);
  },
  down(database) {
    database.exec(`
      DROP INDEX IF EXISTS idx_media_listing_rating;
      DROP INDEX IF EXISTS idx_media_listing_year;
      DROP INDEX IF EXISTS idx_media_listing_title;
      DROP INDEX IF EXISTS idx_media_listing_recent;
    `);
  },
};
