const crypto = require("crypto");
const fs = require("fs");
const { getCatalogConfig } = require("../src/config/catalog-config");
const { openCatalogDatabase } = require("../src/db/catalog-db");
const { displayTitleDecision } = require("../src/repositories/display-title");

function main() {
  const config = getCatalogConfig();
  const database = openCatalogDatabase(config.databasePath, { readonly: true, fileMustExist: true });
  try {
    const rows = database.prepare(`
      SELECT m.id, m.title, m.original_title, m.media_type, m.category,
        m.metadata_status, m.metadata_confidence, m.external_source, m.external_id,
        a.alias, a.language, a.source
      FROM media m LEFT JOIN media_aliases a ON a.media_id = m.id
      WHERE m.is_active = 1
      ORDER BY m.id, a.alias
    `).all();
    const byId = new Map();
    for (const row of rows) {
      if (!byId.has(row.id)) byId.set(row.id, { ...row, aliases: [] });
      if (row.alias) byId.get(row.id).aliases.push({ alias: row.alias, language: row.language, source: row.source });
    }
    const counts = { active_entities: byId.size, changed: 0, trusted_localized: 0, trusted_english: 0, native_unicode: 0, no_safe_alternative: 0 };
    const samples = [];
    for (const row of byId.values()) {
      const decision = displayTitleDecision(row, row.aliases);
      counts[decision.reason === "TRUSTED_LOCALIZED_ALIAS" ? "trusted_localized"
        : decision.reason === "TRUSTED_ENGLISH_ALIAS" ? "trusted_english"
          : decision.reason === "NATIVE_UNICODE_TITLE" ? "native_unicode" : "no_safe_alternative"] += 1;
      if (decision.displayTitle !== String(row.title || "").trim()) {
        counts.changed += 1;
        if (samples.length < 100) samples.push({ id: row.id, media_type: row.media_type, category: row.category, title: row.title, display_title: decision.displayTitle, reason: decision.reason, external_source: row.external_source, external_id: row.external_id });
      }
    }
    const report = { policy_version: require("../src/repositories/display-title").DISPLAY_TITLE_POLICY_VERSION, counts, samples };
    const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
    const output = { ...report, sha256: digest };
    const outputPath = process.env.DISPLAY_TITLE_AUDIT_OUTPUT;
    if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
    console.log(JSON.stringify(output, null, 2));
    return output;
  } finally {
    database.close();
  }
}

if (require.main === module) main();

module.exports = { main };
