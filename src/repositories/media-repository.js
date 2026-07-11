const { nowIso } = require("../db/catalog-db");

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rebuildMediaFts(database, mediaId) {
  const media = database.prepare("SELECT * FROM media WHERE id = ?").get(mediaId);
  if (!media) return;
  const aliases = database
    .prepare("SELECT alias FROM media_aliases WHERE media_id = ? ORDER BY alias")
    .all(mediaId)
    .map((row) => row.alias)
    .join(" ");
  database.prepare("DELETE FROM media_fts WHERE media_id = ?").run(mediaId);
  database.prepare(
    "INSERT INTO media_fts(media_id, title, original_title, aliases) VALUES (?, ?, ?, ?)"
  ).run(String(mediaId), media.title, media.original_title || "", aliases);
}

function setAppState(database, key, value) {
  database.prepare(`
    INSERT INTO app_state(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
  `).run(key, JSON.stringify(value), nowIso());
}

function getAppState(database, key, fallback = null) {
  const row = database.prepare("SELECT value_json FROM app_state WHERE key = ?").get(key);
  return row ? parseJson(row.value_json, fallback) : fallback;
}

module.exports = {
  getAppState,
  parseJson,
  rebuildMediaFts,
  setAppState,
};
