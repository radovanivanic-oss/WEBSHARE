"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function updateStableJsonHash(hash, value, omitRootKey = null, root = true) {
  if (Array.isArray(value)) {
    hash.update("[");
    value.forEach((item, index) => {
      if (index) hash.update(",");
      updateStableJsonHash(hash, item, null, false);
    });
    hash.update("]");
    return;
  }
  if (value && typeof value === "object") {
    hash.update("{");
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined && !(root && key === omitRootKey))
      .sort();
    keys.forEach((key, index) => {
      if (index) hash.update(",");
      hash.update(JSON.stringify(key));
      hash.update(":");
      updateStableJsonHash(hash, value[key], null, false);
    });
    hash.update("}");
    return;
  }
  const serialized = JSON.stringify(value);
  hash.update(serialized === undefined ? "null" : serialized);
}

function stableJsonSha256(value, omitRootKey = null) {
  const hash = crypto.createHash("sha256");
  updateStableJsonHash(hash, value, omitRootKey, true);
  return hash.digest("hex");
}

function writeJsonFile(filePath, value, { flag = "w", mode = 0o640, compact = false } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o750 });
  const fd = fs.openSync(filePath, flag, mode);
  let pending = "";
  const flush = () => {
    if (!pending) return;
    fs.writeSync(fd, pending);
    pending = "";
  };
  const emit = (text) => {
    pending += text;
    if (pending.length >= 1024 * 1024) flush();
  };
  const indent = (depth) => " ".repeat(depth * 2);
  const visit = (item, depth) => {
    if (Array.isArray(item)) {
      emit("[");
      item.forEach((child, index) => {
        if (index) emit(",");
        if (!compact) emit("\n" + indent(depth + 1));
        visit(child, depth + 1);
      });
      if (!compact && item.length) emit("\n" + indent(depth));
      emit("]");
      return;
    }
    if (item && typeof item === "object") {
      const keys = Object.keys(item).filter((key) => item[key] !== undefined);
      emit("{");
      keys.forEach((key, index) => {
        if (index) emit(",");
        if (!compact) emit("\n" + indent(depth + 1));
        emit(JSON.stringify(key) + (compact ? ":" : ": "));
        visit(item[key], depth + 1);
      });
      if (!compact && keys.length) emit("\n" + indent(depth));
      emit("}");
      return;
    }
    const serialized = JSON.stringify(item);
    emit(serialized === undefined ? "null" : serialized);
  };
  try {
    visit(value, 0);
    emit("\n");
    flush();
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

const SECRET_PATTERN = /(?:wst|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]/iu;

function containsSecretMaterial(value, seen = new WeakSet()) {
  if (typeof value === "string") return SECRET_PATTERN.test(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsSecretMaterial(item, seen));
  return Object.entries(value).some(([key, child]) => SECRET_PATTERN.test(key + ":") || containsSecretMaterial(child, seen));
}

module.exports = { stableJsonSha256, writeJsonFile, containsSecretMaterial };
