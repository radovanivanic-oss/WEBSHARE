"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function cacheFile(root, key) {
  return path.join(root, `${key}.json`);
}

function createMetadataFileCache({ root, provider = "tmdb", version = "1", ttlDays = 30 } = {}) {
  const directory = path.resolve(root);
  fs.mkdirSync(directory, { recursive: true });
  const prefix = `${provider}-${version}-`;
  return {
    get(key, now = new Date().toISOString()) {
      const file = cacheFile(directory, `${prefix}${key}`);
      try {
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (record.provider !== provider || record.version !== version || record.expires_at <= now) return null;
        return record.response;
      } catch {
        return null;
      }
    },
    set(key, response, metadata = {}) {
      const file = cacheFile(directory, `${prefix}${key}`);
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ttlDays * 86400000).toISOString();
      const payload = JSON.stringify({ provider, version, endpoint: metadata.endpoint || null, language: metadata.language || null, params: metadata.params || null, response, created_at: now, expires_at: expiresAt });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, payload, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
    },
    key(value) {
      return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    },
    root: directory,
  };
}

module.exports = { createMetadataFileCache };
