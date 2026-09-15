"use strict";

/*
 * B55 repository-local publication adapter.
 * The B54 coordinator owns cycle state and authorization. This adapter owns
 * only the proven AG_repo protocol and never writes production SQLite.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");

const { productionHealth, digest } = require("./maintenance-cycle");
const { validatePublicCatalog } = require("./public-catalog");

const ADAPTER_VERSION = "b55-ag-release-pointer-last-v1";
const AG_REPOSITORY = "radovanivanic-oss/AG_repo";
const POINTER_RELATIVE = "catalog/v1/current.json";
const GENERATION_ROOT = "catalog/v1/generations";

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  throw error;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      position += read;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}

function run(command, args, cwd, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: options.encoding || "utf8",
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
      stdio: options.stdio || ["ignore", "pipe", "pipe"],
      env: process.env,
    });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || "").replace(/[\r\n]+/gu, " ").slice(0, 300);
    fail(options.code || "EXTERNAL_COMMAND_FAILED", { command, detail });
  }
}

function runJson(command, args, cwd, code) {
  const output = run(command, args, cwd, { code });
  try { return JSON.parse(output); } catch { fail(code || "REMOTE_JSON_INVALID"); }
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function noSecrets(value) {
  if (/(?:wst|password|authorization|cookie|github[_ -]?token|signed[_ -]?url)\s*[:=]/iu.test(JSON.stringify(value))) fail("SECRET_MATERIAL_IN_PUBLICATION_RESULT");
}

function buildPointer(generationId, manifestSha256) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(generationId)) fail("INVALID_GENERATION_ID");
  if (!/^[a-f0-9]{64}$/u.test(manifestSha256)) fail("INVALID_MANIFEST_SHA256");
  return {
    schema: "webshare-atlas-public-catalog-current/v1",
    schema_version: 1,
    generation_id: generationId,
    generation_path: "generations/" + generationId,
    manifest_path: "generations/" + generationId + "/manifest.json",
    manifest_sha256: manifestSha256,
  };
}

function objectReferences(manifest) {
  const refs = [];
  for (const category of manifest.categories || []) for (const shard of category.shards || []) refs.push(shard);
  for (const shard of manifest.details?.shards || []) refs.push(shard);
  for (const listing of manifest.listings || []) for (const shard of listing.shards || []) refs.push(shard);
  for (const shard of manifest.files?.shards || []) refs.push(shard);
  for (const shard of manifest.episodes?.shards || []) refs.push(shard);
  const byName = new Map();
  for (const ref of refs) {
    if (!ref.name || !/^[a-f0-9]{64}\.json\.gz$/u.test(ref.name) || !/^[a-f0-9]{64}$/u.test(ref.sha256)) fail("INVALID_PUBLIC_OBJECT_REFERENCE");
    const previous = byName.get(ref.name);
    if (previous && (previous.sha256 !== ref.sha256 || previous.compressed_bytes !== ref.compressed_bytes)) fail("PUBLIC_OBJECT_REFERENCE_CONFLICT");
    if (!previous) byName.set(ref.name, ref);
  }
  return byName;
}

function validatePlanAssetLayout(cycleRoot, plan, manifestPath) {
  const cycle = path.resolve(cycleRoot);
  const root = path.dirname(path.resolve(manifestPath));
  if (!root.startsWith(cycle + path.sep)) fail("PUBLICATION_MANIFEST_OUTSIDE_CYCLE");
  const manifest = readJson(manifestPath);
  const refs = objectReferences(manifest);
  const assets = new Map();
  for (const asset of plan.assets || []) {
    if (!asset.path || !asset.sha256 || !Number.isInteger(asset.bytes)) fail("INVALID_PUBLICATION_ASSET_RECORD");
    const file = path.resolve(root, asset.path);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) fail("PUBLICATION_ASSET_MISSING", { asset: asset.path });
    const actual = { path: asset.path, file, name: path.basename(file), bytes: fs.statSync(file).size, sha256: sha256File(file) };
    if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) fail("PUBLICATION_ASSET_IDENTITY_MISMATCH", { asset: asset.path });
    if (assets.has(actual.name)) fail("DUPLICATE_PUBLICATION_ASSET_NAME", { name: actual.name });
    assets.set(actual.name, actual);
  }
  const manifestName = path.basename(manifestPath);
  const manifestAsset = assets.get(manifestName);
  if (!manifestAsset || manifestAsset.sha256 !== plan.manifest_sha256) fail("PUBLICATION_MANIFEST_NOT_BOUND");
  const objectAssets = [...assets.values()].filter((item) => item.name.endsWith(".json.gz") && item.name !== manifestName);
  if (objectAssets.length !== Number(manifest.object_count)) fail("PUBLICATION_OBJECT_COUNT_MISMATCH");
  const expectedNames = [...refs.keys()].sort();
  const actualNames = objectAssets.map((item) => item.name).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) fail("PUBLICATION_OBJECT_INVENTORY_MISMATCH");
  for (const item of objectAssets) {
    const ref = refs.get(item.name);
    if (ref.sha256 !== item.name.slice(0, 64) || item.sha256 !== ref.sha256) fail("PUBLICATION_OBJECT_HASH_REFERENCE_MISMATCH", { name: item.name });
    if (item.bytes !== ref.compressed_bytes) fail("PUBLICATION_OBJECT_SIZE_REFERENCE_MISMATCH", { name: item.name });
    JSON.parse(zlib.gunzipSync(fs.readFileSync(item.file)).toString("utf8"));
  }
  return { manifest, refs, assets: [...assets.values()].sort((a, b) => a.name.localeCompare(b.name)), objectAssets };
}

function readObject(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
}

function scanExport(genRoot, manifest, candidateIds = new Set()) {
  const object = (ref) => {
    const file = path.join(genRoot, "objects", ref.sha256 + ".json.gz");
    if (!fs.existsSync(file)) fail("PUBLIC_OBJECT_MISSING", { sha256: ref.sha256 });
    return readObject(file);
  };
  const media = new Map(), episodes = new Map(), idents = new Set(), candidateFiles = new Map();
  for (const category of manifest.categories || []) for (const ref of category.shards || []) for (const row of object(ref)) media.set(Number(row.id), { id: Number(row.id), category: row.category, media_type: row.media_type });
  for (const ref of manifest.episodes?.shards || []) for (const group of object(ref)) for (const row of group.episodes || []) episodes.set(Number(row.id), { id: Number(row.id), owner_id: Number(group.id), season_number: row.season_number, episode_number: row.episode_number, tvshow_id: row.tvshow_id });
  for (const ref of manifest.files?.shards || []) for (const group of object(ref)) {
    for (const row of group.files || []) {
      if (idents.has(row.ident)) fail("DUPLICATE_PUBLIC_SOURCE_IDENT", { ident: row.ident });
      idents.add(row.ident);
      if (candidateIds.has(row.ident)) candidateFiles.set(row.ident, { file: row, owner_id: Number(group.id) });
    }
  }
  return { media, episodes, candidateFiles, idents };
}

function publicOwner(scan, ident) {
  const hit = scan.candidateFiles?.get(ident);
  if (!hit) return null;
  const root = scan.media.get(hit.owner_id);
  if (root) return { ...hit, root, media: root, episode: null };
  const episode = scan.episodes.get(hit.owner_id);
  if (!episode) return { ...hit, root: null, media: null, episode: null };
  const tv = scan.media.get(episode.owner_id);
  return { ...hit, root: tv || null, media: tv || null, episode };
}

function expectedPublicIdents(database) {
  const db = new Database(path.resolve(database), { readonly: true, fileMustExist: true });
  try {
    const sql = "SELECT f.ident FROM files f JOIN media owner ON owner.id=f.media_id LEFT JOIN media tv ON tv.id=owner.tvshow_id WHERE f.is_active=1 AND f.is_playable_video=1 AND owner.is_active=1 AND ((owner.media_type='episode' AND owner.tvshow_id IS NOT NULL AND tv.is_active=1 AND tv.category IN ('movies','series','concerts','sports','music-videos','other')) OR (owner.media_type<>'episode' AND owner.category IN ('movies','series','concerts','sports','music-videos','other'))) ORDER BY f.media_id ASC, f.id ASC";
    const ids = new Set();
    for (const row of db.prepare(sql).iterate()) ids.add(row.ident);
    return ids;
  } finally { db.close(); }
}

function setDifference(left, right) { return [...left].filter((x) => !right.has(x)).sort(); }

function sourceAccounting(database, scan) {
  const expected = expectedPublicIdents(database);
  const actual = new Set(scan.idents.keys());
  return { expected_count: expected.size, actual_count: actual.size, missing: setDifference(expected, actual), unexpected: setDifference(actual, expected), duplicate_public_idents: 0 };
}

function candidateAccounting(cycleRoot, scan) {
  const apply = readJson(path.join(cycleRoot, "apply-result.json"));
  const sourcePlan = readJson(path.join(cycleRoot, "plan.json"));
  const candidates = new Map((sourcePlan.discovery_delta || []).map((item) => [item.ident, item]));
  const found = [], missing = [], wrongOwnership = [], wrongType = [];
  const composition = { movies: 0, series: 0, sports: 0, concerts: 0, other: 0 };
  for (const ident of apply.inserted_identifiers || []) {
    const expected = candidates.get(ident);
    const owner = publicOwner(scan, ident);
    if (!expected || !owner) { missing.push(ident); continue; }
    const actualCategory = owner.root?.category || null;
    const expectedCategory = expected.classification?.category || null;
    if (expectedCategory && actualCategory !== expectedCategory) wrongType.push({ ident, expected: expectedCategory, actual: actualCategory });
    if (expectedCategory && composition[expectedCategory] !== undefined) composition[expectedCategory]++;
    if (!owner.root) wrongOwnership.push(ident);
    found.push({ ident, expected, owner });
  }
  return { source_candidate_count: (apply.inserted_identifiers || []).length, found_count: found.length, missing, wrong_ownership: wrongOwnership, wrong_type_category: wrongType, composition, records: found };
}

function manifestSummary(manifest) {
  const categories = Object.fromEntries((manifest.categories || []).map((x) => [x.category, Number(x.record_count || 0)]));
  return {
    source_files: Number(manifest.files?.record_count || 0),
    root_media: Object.values(categories).reduce((a, b) => a + b, 0),
    categories,
    detail_entities: Number(manifest.details?.record_count || 0),
    episodes: Number(manifest.episodes?.record_count || 0),
    asset_objects: Number(manifest.object_count || 0),
    compressed_bytes: Number(manifest.object_bytes_compressed || 0),
    uncompressed_bytes: Number(manifest.object_bytes_uncompressed || 0),
  };
}

function manifestDelta(previous, current, previousObjectNames, currentObjectNames) {
  const oldSet = new Set(previousObjectNames), newSet = new Set(currentObjectNames);
  const oldSummary = manifestSummary(previous), newSummary = manifestSummary(current);
  return {
    source_files: newSummary.source_files - oldSummary.source_files,
    root_media: newSummary.root_media - oldSummary.root_media,
    detail_entities: newSummary.detail_entities - oldSummary.detail_entities,
    episodes: newSummary.episodes - oldSummary.episodes,
    movies: (newSummary.categories.movies || 0) - (oldSummary.categories.movies || 0),
    series: (newSummary.categories.series || 0) - (oldSummary.categories.series || 0),
    sports: (newSummary.categories.sports || 0) - (oldSummary.categories.sports || 0),
    concerts: (newSummary.categories.concerts || 0) - (oldSummary.categories.concerts || 0),
    music_videos: (newSummary.categories["music-videos"] || 0) - (oldSummary.categories["music-videos"] || 0),
    other: (newSummary.categories.other || 0) - (oldSummary.categories.other || 0),
    asset_count: newSummary.asset_objects - oldSummary.asset_objects,
    retained_hashes: [...newSet].filter((x) => oldSet.has(x)).sort(),
    new_hashes: [...newSet].filter((x) => !oldSet.has(x)).sort(),
    removed_hashes: [...oldSet].filter((x) => !newSet.has(x)).sort(),
    compressed_bytes: newSummary.compressed_bytes - oldSummary.compressed_bytes,
    uncompressed_bytes: newSummary.uncompressed_bytes - oldSummary.uncompressed_bytes,
  };
}

function gitRemote(cwd) { return run("git", ["remote", "get-url", "origin"], cwd).trim(); }
function assertGitRemote(cwd) {
  const remote = gitRemote(cwd);
  if (!/(?:github\.com[/:])radovanivanic-oss\/AG_repo(?:\.git)?$/u.test(remote)) fail("AG_REPOSITORY_REMOTE_MISMATCH");
  return remote;
}

function localAgBaseline(cycle, agRoot) {
  assertGitRemote(agRoot);
  if (run("git", ["status", "--porcelain"], agRoot).trim()) fail("AG_REPOSITORY_DIRTY");
  run("git", ["fetch", "origin", "main", "--quiet"], agRoot, { code: "AG_REMOTE_FETCH_FAILED" });
  const remoteHead = run("git", ["rev-parse", "origin/main"], agRoot).trim();
  if (remoteHead !== cycle.public_baseline.commit) fail("AG_REMOTE_BASELINE_CHANGED", { expected: cycle.public_baseline.commit, actual: remoteHead });
  const pointerFile = path.join(agRoot, POINTER_RELATIVE);
  const bytes = fs.readFileSync(pointerFile), pointer = JSON.parse(bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (sha !== cycle.public_baseline.pointer_sha256 || pointer.generation_id !== cycle.public_baseline.generation_id || pointer.manifest_sha256 !== cycle.public_baseline.manifest_sha256) fail("AG_POINTER_BASELINE_CHANGED");
  return { remote: gitRemote(agRoot), remoteHead, pointerFile, pointerBytes: bytes, pointer, pointerSha256: sha };
}

function remoteRelease(repo, releaseId) {
  return runJson("gh", ["release", "view", releaseId, "--repo", repo, "--json", "tagName,isDraft,isPrerelease,assets"], process.cwd(), "RELEASE_VIEW_FAILED");
}

function releaseInventory(release) {
  return new Map((release.assets || []).map((x) => [x.name, { name: x.name, size: Number(x.size || 0) }]));
}

function assertReleaseInventory(release, objectAssets) {
  if (release.tagName && release.tagName !== release._expectedTag) fail("RELEASE_TAG_MISMATCH");
  if (release.isDraft || release.isPrerelease) fail("RELEASE_NOT_PUBLIC");
  const expected = new Map(objectAssets.map((x) => [x.name, x]));
  const actual = releaseInventory(release);
  const missing = [...expected.keys()].filter((x) => !actual.has(x)).sort();
  const unexpected = [...actual.keys()].filter((x) => !expected.has(x)).sort();
  const wrongSize = [...expected.keys()].filter((x) => actual.has(x) && actual.get(x).size !== expected.get(x).bytes).sort();
  if (missing.length || unexpected.length || wrongSize.length) fail("REMOTE_RELEASE_INVENTORY_MISMATCH", { missing, unexpected, wrong_size: wrongSize });
  return { expected_count: expected.size, actual_count: actual.size, missing, unexpected, wrong_size: wrongSize };
}

function downloadRemoteAssets(repo, releaseId, objectAssets, root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o750 });
  run("gh", ["release", "download", releaseId, "--repo", repo, "--dir", root, "--pattern", "*.json.gz", "--clobber"], process.cwd(), { code: "REMOTE_RELEASE_DOWNLOAD_FAILED" });
  const actualFiles = fs.readdirSync(root).filter((x) => x.endsWith(".json.gz")).sort();
  const expected = new Map(objectAssets.map((x) => [x.name, x]));
  const actual = new Set(actualFiles);
  const missing = [...expected.keys()].filter((x) => !actual.has(x));
  const unexpected = actualFiles.filter((x) => !expected.has(x));
  if (missing.length || unexpected.length) fail("REMOTE_DOWNLOAD_INVENTORY_MISMATCH", { missing, unexpected });
  const verified = [];
  for (const asset of objectAssets) {
    const file = path.join(root, asset.name), bytes = fs.statSync(file).size, sha = sha256File(file);
    if (bytes !== asset.bytes || sha !== asset.sha256) fail("REMOTE_ASSET_HASH_MISMATCH", { name: asset.name });
    JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
    verified.push({ name: asset.name, bytes, sha256: sha });
  }
  return { path: root, count: verified.length, bytes: verified.reduce((n, x) => n + x.bytes, 0) };
}

function uploadRelease(repo, releaseId, objectAssets, release) {
  const existing = releaseInventory(release);
  const missing = objectAssets.filter((x) => !existing.has(x.name));
  for (let i = 0; i < missing.length; i += 25) run("gh", ["release", "upload", releaseId, ...missing.slice(i, i + 25).map((x) => x.file), "--repo", repo], process.cwd(), { code: "RELEASE_UPLOAD_FAILED" });
  const after = remoteRelease(repo, releaseId); after._expectedTag = releaseId;
  return { uploaded_count: missing.length, inventory: assertReleaseInventory(after, objectAssets), release: after };
}

function ensureRelease(repo, releaseId, objectAssets) {
  let release, created = false;
  try { release = remoteRelease(repo, releaseId); }
  catch (error) {
    if (error.code !== "RELEASE_VIEW_FAILED") throw error;
    try {
      run("gh", ["release", "create", releaseId, "--repo", repo, "--target", "main", "--title", releaseId, "--notes", "Immutable Webshare Atlas catalog generation."], process.cwd(), { code: "RELEASE_CREATE_FAILED" });
      created = true;
    } catch (createError) {
      // GitHub can briefly return a view miss after the release is created;
      // re-read before treating a create failure as terminal.
      try { release = remoteRelease(repo, releaseId); } catch { throw createError; }
    }
    release = remoteRelease(repo, releaseId);
  }
  release._expectedTag = releaseId;
  return { ...uploadRelease(repo, releaseId, objectAssets, release), created };
}

function rawGet(url, code) {
  const bytes = run("curl", ["--fail", "--silent", "--show-error", "--location", url], process.cwd(), { encoding: "buffer", code });
  return { url, bytes, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function remotePointerFromRaw() {
  const result = rawGet("https://raw.githubusercontent.com/radovanivanic-oss/AG_repo/main/catalog/v1/current.json", "REMOTE_POINTER_FETCH_FAILED");
  return { ...result, pointer: JSON.parse(result.bytes.toString("utf8")) };
}

function remoteManifestFromRaw(generationId) {
  const result = rawGet("https://raw.githubusercontent.com/" + AG_REPOSITORY + "/main/catalog/v1/generations/" + generationId + "/manifest.json", "REMOTE_MANIFEST_FETCH_FAILED");
  return { ...result, manifest: JSON.parse(result.bytes.toString("utf8")) };
}

function waitForRemoteManifest(generationId, expectedSha, attempts = 10) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { last = remoteManifestFromRaw(generationId); if (last.sha256 === expectedSha) return last; } catch (error) { last = error; }
    run("sleep", ["2"], process.cwd(), { code: "REMOTE_MANIFEST_WAIT_FAILED" });
  }
  fail("REMOTE_GENERATION_MANIFEST_MISMATCH", { expected: expectedSha, actual: last?.sha256 || null });
}

function waitForRemotePointer(generationId, expectedSha, attempts = 10) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { last = remotePointerFromRaw(); if (last.pointer.generation_id === generationId && last.pointer.manifest_sha256 === expectedSha) return last; } catch (error) { last = error; }
    run("sleep", ["2"], process.cwd(), { code: "REMOTE_POINTER_WAIT_FAILED" });
  }
  fail("REMOTE_POINTER_SWITCH_MISMATCH", { expected_generation: generationId, actual: last?.pointer?.generation_id || null });
}

function commitGenerationMetadata(agRoot, generationId, manifestPath) {
  const target = path.join(agRoot, GENERATION_ROOT, generationId, "manifest.json");
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
  const bytes = fs.readFileSync(manifestPath);
  if (fs.existsSync(target)) {
    if (sha256File(target) !== sha256File(manifestPath)) fail("IMMUTABLE_AG_GENERATION_MISMATCH");
  } else fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o640 });
  run("git", ["add", "--", path.relative(agRoot, target)], agRoot, { code: "AG_GENERATION_STAGE_FAILED" });
  const staged = run("git", ["diff", "--cached", "--name-only"], agRoot).trim().split(/\r?\n/u).filter(Boolean);
  if (staged.some((x) => x !== path.relative(agRoot, target))) fail("AG_GENERATION_UNEXPECTED_STAGED_FILE");
  let commit = run("git", ["rev-parse", "HEAD"], agRoot).trim();
  if (staged.length) {
    run("git", ["commit", "-m", "Add immutable catalog generation " + generationId], agRoot, { code: "AG_GENERATION_COMMIT_FAILED" });
    run("git", ["push", "origin", "main"], agRoot, { code: "AG_GENERATION_PUSH_FAILED" });
    commit = run("git", ["rev-parse", "HEAD"], agRoot).trim();
  }
  run("git", ["fetch", "origin", "main", "--quiet"], agRoot, { code: "AG_GENERATION_REMOTE_FETCH_FAILED" });
  const remoteManifest = run("git", ["show", "origin/main:" + path.relative(agRoot, target)], agRoot, { encoding: "buffer", code: "AG_GENERATION_REMOTE_MISSING" });
  if (crypto.createHash("sha256").update(remoteManifest).digest("hex") !== crypto.createHash("sha256").update(bytes).digest("hex")) fail("AG_GENERATION_REMOTE_HASH_MISMATCH");
  return { commit, path: target, sha256: sha256File(target) };
}

function switchPointer(agRoot, generationId, manifestSha256) {
  const pointer = buildPointer(generationId, manifestSha256), file = path.join(agRoot, POINTER_RELATIVE);
  fs.writeFileSync(file, JSON.stringify(pointer) + "\n", { flag: "w", mode: 0o640 });
  run("git", ["add", "--", POINTER_RELATIVE], agRoot, { code: "AG_POINTER_STAGE_FAILED" });
  const staged = run("git", ["diff", "--cached", "--name-only"], agRoot).trim().split(/\r?\n/u).filter(Boolean);
  if (staged.length !== 1 || staged[0] !== POINTER_RELATIVE) fail("AG_POINTER_UNEXPECTED_STAGED_FILE");
  run("git", ["commit", "-m", "Activate catalog generation " + generationId], agRoot, { code: "AG_POINTER_COMMIT_FAILED" });
  run("git", ["push", "origin", "main"], agRoot, { code: "AG_POINTER_PUSH_FAILED" });
  const commit = run("git", ["rev-parse", "HEAD"], agRoot).trim(), bytes = fs.readFileSync(file);
  return { pointer, commit, git_blob_sha256: run("git", ["rev-parse", "HEAD:" + POINTER_RELATIVE], agRoot).trim(), raw_sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function rollbackPointer(agRoot, previousBytes, generationId) {
  const file = path.join(agRoot, POINTER_RELATIVE);
  fs.writeFileSync(file, previousBytes, { flag: "w", mode: 0o640 });
  run("git", ["add", "--", POINTER_RELATIVE], agRoot, { code: "AG_POINTER_ROLLBACK_STAGE_FAILED" });
  run("git", ["commit", "-m", "Rollback catalog pointer after failed " + generationId + " publication"], agRoot, { code: "AG_POINTER_ROLLBACK_COMMIT_FAILED" });
  run("git", ["push", "origin", "main"], agRoot, { code: "AG_POINTER_ROLLBACK_PUSH_FAILED" });
  let remote = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      remote = remotePointerFromRaw();
      if (crypto.timingSafeEqual(remote.bytes, previousBytes)) return { performed: true, commit: run("git", ["rev-parse", "HEAD"], agRoot).trim(), raw_sha256: remote.sha256, generation_id: remote.pointer.generation_id };
    } catch {}
    run("sleep", ["2"], process.cwd(), { code: "AG_POINTER_ROLLBACK_WAIT_FAILED" });
  }
  fail("AG_POINTER_ROLLBACK_VERIFY_FAILED", { rollback: true, actual_generation: remote?.pointer?.generation_id || null });
}

function representativeRows(accounting) {
  const result = [];
  for (const category of ["movies", "series", "sports"]) for (const item of accounting.records.filter((x) => x.expected?.classification?.category === category).slice(0, 3)) {
    result.push({ ident: item.ident, category, title: item.expected?.parser?.title || item.owner.file.name, year: item.expected?.parser?.year || null, media_id: item.owner.media?.id || null, media_type: item.owner.media?.media_type || null, episode: item.owner.episode ? { season_number: item.owner.episode.season_number, episode_number: item.owner.episode.episode_number, tvshow_id: item.owner.episode.tvshow_id } : null, ownership: item.owner.root?.id || null, playable_source_reference: Boolean(item.owner.file?.needs_file_link) });
  }
  return result;
}

async function publish({ cycle, cycleRoot, plan, authorization }) {
  const root = path.resolve(cycleRoot), agRoot = path.resolve(cycle.public_baseline.repository), publicRoot = path.join(root, "publication-candidate", "catalog", "v1"), manifestPath = path.join(publicRoot, "generations", plan.generation_id, "manifest.json"), snapshotPath = path.join(root, "publication-source", "catalog.sqlite");
  if (authorization.publication_plan_sha256 !== digest(plan)) fail("PUBLICATION_AUTHORIZATION_PLAN_MISMATCH");
  if (plan.cycle_id !== cycle.cycle_id || plan.generation_id !== authorization.generation_id || plan.manifest_sha256 !== authorization.manifest_sha256) fail("PUBLICATION_BINDING_MISMATCH");
  const baseline = localAgBaseline(cycle, agRoot), live = productionHealth(cycle.production_database_path, cycle.sidecar_path);
  if (live.production_baseline_sha256 !== plan.source_database_digest) fail("PUBLICATION_SOURCE_DRIFT");
  if (!fs.existsSync(snapshotPath) || sha256File(snapshotPath) !== plan.source_snapshot_sha256) fail("PUBLICATION_SNAPSHOT_HASH_MISMATCH");
  const snapshotHealth = productionHealth(snapshotPath, cycle.sidecar_path);
  if (snapshotHealth.production_baseline_sha256 !== plan.source_database_digest) fail("PUBLICATION_SNAPSHOT_LOGICAL_MISMATCH");
  const validation = validatePublicCatalog(publicRoot);
  const layout = validatePlanAssetLayout(root, plan, manifestPath);
  const apply = readJson(path.join(root, "apply-result.json"));
  const applyPlan = readJson(path.join(root, "plan.json"));
  const scan = scanExport(path.dirname(manifestPath), layout.manifest, new Set(apply.inserted_identifiers || []));
  const sourceIds = sourceAccounting(snapshotPath, scan);
  if (sourceIds.missing.length || sourceIds.unexpected.length) fail("PUBLICATION_SOURCE_EXPORT_SET_MISMATCH", { missing: sourceIds.missing.length, unexpected: sourceIds.unexpected.length });
  const candidate = candidateAccounting(root, scan);
  const isolatedStaleCleanup = applyPlan.kind === "ISOLATED_STALE_CLEANUP_PLAN";
  const currentDbRecovery = plan.recovery === true && applyPlan.kind === "B54_CURRENT_DB_RECOVERY_PLAN";
  if (!isolatedStaleCleanup && !currentDbRecovery && (candidate.source_candidate_count !== (applyPlan.discovery_delta || []).length || candidate.missing.length || candidate.wrong_ownership.length || candidate.wrong_type_category.length || candidate.found_count !== candidate.source_candidate_count)) fail("B55_CANDIDATE_PUBLIC_ACCOUNTING_MISMATCH", { expected: (applyPlan.discovery_delta || []).length, actual: candidate.source_candidate_count, missing: candidate.missing, wrong_ownership: candidate.wrong_ownership, wrong_type_category: candidate.wrong_type_category });
  const previousManifest = readJson(path.join(agRoot, "catalog/v1/generations", baseline.pointer.generation_id, "manifest.json"));
  const delta = manifestDelta(previousManifest, layout.manifest, [...objectReferences(previousManifest).keys()], [...layout.refs.keys()]);
  if (isolatedStaleCleanup) {
    const deactivated = new Set((applyPlan.deactivations || []).map((item) => item.ident));
    const stillPublic = [...deactivated].filter((ident) => scan.idents.has(ident));
    if (apply.deactivated !== deactivated.size || stillPublic.length) fail("STALE_PUBLIC_SOURCE_ACCOUNTING_MISMATCH", { expected_deactivated: deactivated.size, actual_deactivated: apply.deactivated, still_public: stillPublic.length });
    if (delta.source_files !== -deactivated.size) fail("PUBLICATION_UNEXPECTED_SOURCE_DELTA", { delta: delta.source_files, deactivated: deactivated.size });
  } else if (!currentDbRecovery && delta.source_files !== candidate.source_candidate_count) fail("PUBLICATION_UNEXPECTED_SOURCE_DELTA", { delta: delta.source_files, candidates: candidate.source_candidate_count });
  const release = ensureRelease(AG_REPOSITORY, plan.release_id, layout.objectAssets);
  const remoteAssets = downloadRemoteAssets(AG_REPOSITORY, plan.release_id, layout.objectAssets, path.join(root, "remote-verification", plan.generation_id + "-" + Date.now()));
  const generation = commitGenerationMetadata(agRoot, plan.generation_id, manifestPath);
  const remoteManifest = waitForRemoteManifest(plan.generation_id, plan.manifest_sha256);
  let switched = false, pointerResult;
  try {
    pointerResult = switchPointer(agRoot, plan.generation_id, plan.manifest_sha256);
    switched = true;
    const remotePointer = waitForRemotePointer(plan.generation_id, plan.manifest_sha256);
    const finalRemote = downloadRemoteAssets(AG_REPOSITORY, plan.release_id, layout.objectAssets, path.join(root, "remote-verification", plan.generation_id + "-post-" + Date.now()));
    const result = { adapter_version: ADAPTER_VERSION, repository: AG_REPOSITORY, generation_id: plan.generation_id, release_id: plan.release_id, source_database_digest: live.production_baseline_sha256, source_snapshot_sha256: plan.source_snapshot_sha256, source_snapshot_logical_digest: snapshotHealth.production_baseline_sha256, local_validation: validation, source_export_accounting: sourceIds, b55_candidate_accounting: { ...candidate, records: undefined }, b53_to_b55_delta: { ...delta, retained_hashes: delta.retained_hashes.length, new_hashes: delta.new_hashes.length, removed_hashes: delta.removed_hashes.length }, release: { created: release.created, uploaded_count: release.uploaded_count, asset_count: release.inventory.actual_count, remote_rehashed_assets: remoteAssets.count, remote_post_switch_rehashed_assets: finalRemote.count }, immutable_generation_commit: generation.commit, pointer_switch: pointerResult, remote_pointer: { generation_id: remotePointer.pointer.generation_id, manifest_sha256: remotePointer.pointer.manifest_sha256, raw_sha256: remotePointer.sha256 }, previous_pointer: { generation_id: baseline.pointer.generation_id, manifest_sha256: baseline.pointer.manifest_sha256, raw_sha256: baseline.pointerSha256 }, representatives: representativeRows(candidate), consumer_validation: { pre_switch: true, post_switch: true, manifest_sha256: remoteManifest.sha256, release_object_contract: "GitHub Release content-addressed objects" }, safety: { production_db_mutated: false, pointer_last: true, b39_leakage: 0, automatic_publication: authorization.automatic === true } };
    noSecrets(result);
    return result;
  } catch (error) {
    if (switched) {
      const rollback = rollbackPointer(agRoot, baseline.pointerBytes, plan.generation_id);
      error.rollbackPerformed = true;
      error.rollback = rollback;
    }
    throw error;
  }
}

module.exports = { ADAPTER_VERSION, AG_REPOSITORY, buildPointer, objectReferences, validatePlanAssetLayout, scanExport, publicOwner, sourceAccounting, candidateAccounting, manifestSummary, manifestDelta, setDifference, representativeRows, publish };
