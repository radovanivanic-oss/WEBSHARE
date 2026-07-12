module.exports = {
  version: 6,
  name: "media file lookup performance",
  up(database) {
    database.exec(`
      CREATE INDEX idx_files_media_playable_quality
        ON files(
          media_id,
          is_active,
          is_playable_video,
          parsed_resolution,
          size_bytes DESC
        );
    `);
  },
  down(database) {
    database.exec("DROP INDEX IF EXISTS idx_files_media_playable_quality;");
  },
};
