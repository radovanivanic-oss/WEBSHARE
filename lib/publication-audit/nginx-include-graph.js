"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");

const DEFAULT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxFiles: 256,
  maxMatchesPerInclude: 256,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxIncludeDirectives: 1024,
  maxRecords: 256,
  maxScalarBytes: 4096,
});

const RELEVANT_PATTERNS = [
  /catalog-items\.jsonl/iu,
  /catalog-items\.manifest\.json/iu,
  /catalog-from-sqlite\.jsonl/iu,
  /catalog-from-sqlite\.manifest\.json/iu,
  /catalog-publications/iu,
  /generations/iu,
  /current\.json/iu,
  /webshare-catalog-api/iu,
  /webshare.*catalog.*api/iu,
];

function sha(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizePathForOutput(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+/gu, "/");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function lowerDrive(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function containsPath(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isWithinAny(rootList, target) {
  const real = lowerDrive(path.resolve(target));
  return rootList.some((root) => containsPath(lowerDrive(path.resolve(root)), real));
}

function boundedString(value, limits) {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= limits.maxScalarBytes) return text;
  return `${Buffer.from(text).subarray(0, limits.maxScalarBytes).toString("utf8")}...`;
}

function tokenize(text, sourceFile) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/u.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "#") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ";") {
      tokens.push({ value: ch, sourceFile });
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") {
          value += text[i + 1] || "";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      tokens.push({ value, sourceFile });
      continue;
    }
    let value = "";
    while (i < text.length && !/\s/u.test(text[i]) && !["{", "}", ";"].includes(text[i])) {
      value += text[i];
      i += 1;
    }
    tokens.push({ value, sourceFile });
  }
  return tokens;
}

function parseStatements(tokens, start = 0, nested = false) {
  const statements = [];
  let i = start;
  while (i < tokens.length) {
    if (tokens[i].value === "}") {
      if (!nested) throw new Error("NGINX_MALFORMED_CONFIG");
      return { statements, index: i + 1 };
    }
    const nameToken = tokens[i++];
    if (!nameToken || ["{", ";"].includes(nameToken.value)) throw new Error("NGINX_MALFORMED_CONFIG");
    const args = [];
    while (i < tokens.length && !["{", "}", ";"].includes(tokens[i].value)) {
      args.push(tokens[i++].value);
    }
    if (i >= tokens.length) throw new Error("NGINX_MALFORMED_CONFIG");
    if (tokens[i].value === ";") {
      i += 1;
      statements.push({ type: "directive", name: nameToken.value, args, sourceFile: nameToken.sourceFile });
      continue;
    }
    if (tokens[i].value === "{") {
      i += 1;
      const parsed = parseStatements(tokens, i, true);
      i = parsed.index;
      statements.push({
        type: "block",
        name: nameToken.value,
        args,
        sourceFile: nameToken.sourceFile,
        children: parsed.statements,
      });
      continue;
    }
    throw new Error("NGINX_MALFORMED_CONFIG");
  }
  if (nested) throw new Error("NGINX_MALFORMED_CONFIG");
  return { statements, index: i };
}

function parseNginxConfig(text, sourceFile) {
  return parseStatements(tokenize(text, sourceFile)).statements;
}

function hasGlob(pattern) {
  return /[*?\[]/u.test(pattern);
}

function globToRegExp(namePattern) {
  const escaped = namePattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "u");
}

function expandGlob(pattern, limits) {
  const directory = path.dirname(pattern);
  const basePattern = path.basename(pattern);
  const regexp = globToRegExp(basePattern);
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("NGINX_INCLUDE_UNREADABLE");
  }
  const matches = entries
    .filter((entry) => regexp.test(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((a, b) => normalizePathForOutput(a).localeCompare(normalizePathForOutput(b)));
  if (matches.length > limits.maxMatchesPerInclude) throw new Error("NGINX_INCLUDE_MATCH_LIMIT");
  return matches;
}

function resolveIncludePattern(pattern, sourceFile, approvedRoots, limits) {
  const base = path.isAbsolute(pattern) ? pattern : path.resolve(path.dirname(sourceFile), pattern);
  if (!isWithinAny(approvedRoots, base) && !hasGlob(base)) throw new Error("NGINX_INCLUDE_ESCAPE");
  const candidates = hasGlob(base) ? expandGlob(base, limits) : [base];
  return candidates.map((candidate) => {
    const linkPath = path.resolve(candidate);
    let stat;
    try {
      stat = fs.lstatSync(linkPath);
    } catch (error) {
      if (error.code === "ENOENT" && hasGlob(base)) return null;
      throw new Error("NGINX_INCLUDE_UNREADABLE");
    }
    let canonicalPath = linkPath;
    let symlinkSource = "";
    let symlinkTarget = "";
    if (stat.isSymbolicLink()) {
      symlinkSource = linkPath;
      try {
        canonicalPath = fs.realpathSync(linkPath);
      } catch {
        throw new Error("NGINX_SYMLINK_LOOP");
      }
      symlinkTarget = canonicalPath;
      if (!isWithinAny(approvedRoots, canonicalPath)) throw new Error("NGINX_SYMLINK_ESCAPE");
      stat = fs.statSync(canonicalPath);
    }
    if (!stat.isFile()) throw new Error("NGINX_INCLUDE_NOT_FILE");
    if (!isWithinAny(approvedRoots, canonicalPath)) throw new Error("NGINX_INCLUDE_ESCAPE");
    return { linkPath, canonicalPath: path.resolve(canonicalPath), symlinkSource, symlinkTarget };
  }).filter(Boolean);
}

function readConfigFile(filePath, approvedRoots, limits, state) {
  const absolute = path.resolve(filePath);
  if (!isWithinAny(approvedRoots, absolute)) throw new Error("NGINX_INCLUDE_ESCAPE");
  const lstat = fs.lstatSync(absolute);
  let canonical = absolute;
  let symlinkSource = "";
  let symlinkTarget = "";
  let stat = lstat;
  if (lstat.isSymbolicLink()) {
    symlinkSource = absolute;
    canonical = fs.realpathSync(absolute);
    symlinkTarget = canonical;
    if (!isWithinAny(approvedRoots, canonical)) throw new Error("NGINX_SYMLINK_ESCAPE");
    stat = fs.statSync(canonical);
  }
  if (!stat.isFile()) throw new Error("NGINX_INCLUDE_NOT_FILE");
  if (stat.size > limits.maxFileBytes) throw new Error("NGINX_FILE_OVERSIZED");
  if (state.totalBytes + stat.size > limits.maxTotalBytes) throw new Error("NGINX_TOTAL_BYTES_LIMIT");
  const buffer = fs.readFileSync(canonical);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text;
  try {
    text = decoder.decode(buffer);
  } catch {
    throw new Error("NGINX_INVALID_UTF8");
  }
  state.totalBytes += buffer.length;
  return { absolute, canonical, symlinkSource, symlinkTarget, text, digest: sha(buffer), bytes: buffer.length };
}

function directiveValues(statements, name) {
  return statements.filter((s) => s.type === "directive" && s.name === name).map((s) => s.args.join(" "));
}

function firstDirective(statements, name) {
  const value = directiveValues(statements, name).at(-1);
  return value || "";
}

function relevantText(record) {
  return [
    record.location,
    record.root,
    record.alias,
    record.proxy_pass,
    record.try_files,
    record.effective_target,
    record.config_file,
    record.source_file,
  ].join(" ");
}

function isRelevant(record) {
  const text = relevantText(record);
  if (RELEVANT_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (/^https?:\/\/(?:127\.0\.0\.1|localhost):8787(?:\/|$)/iu.test(record.proxy_pass || "")) return true;
  return false;
}

function isStaticCatalogRecord(record) {
  if (record.target_kind === "PROXY") return false;
  return /catalog-items\.jsonl|catalog-items\.manifest\.json|catalog-from-sqlite|catalog-publications|generations|current\.json/iu.test(
    relevantText(record)
  );
}

function resolveTarget(record, serverRoot) {
  if (record.proxy_pass) return { target_kind: "PROXY", effective_target: record.proxy_pass };
  if (record.alias) return { target_kind: "FILESYSTEM_ALIAS", effective_target: record.alias };
  if (record.try_files) {
    return { target_kind: "TRY_FILES", effective_target: record.try_files };
  }
  if (record.root) {
    const suffix = String(record.location || "").replace(/^\^~\s*/u, "").replace(/[~*=]/gu, "").trim();
    return { target_kind: "FILESYSTEM_ROOT", effective_target: path.posix.join(record.root.replaceAll("\\", "/"), suffix) };
  }
  if (serverRoot) return { target_kind: "FILESYSTEM_ROOT", effective_target: serverRoot };
  return { target_kind: "UNKNOWN", effective_target: "" };
}

function traverse(fileInfo, graph, context, output, chain = []) {
  const filePath = fileInfo.canonicalPath;
  const statements = fileInfo.statements;
  const includeChain = [...chain, fileInfo.linkPath || filePath].slice(-16).map(normalizePathForOutput);

  const serverDirectives = {
    root: firstDirective(statements, "root") || context.root || "",
    listen: unique([...context.listen, ...directiveValues(statements, "listen")]),
    serverNames: unique([...context.serverNames, ...directiveValues(statements, "server_name").flatMap((v) => v.split(/\s+/u))]),
  };

  for (const statement of statements) {
    if (statement.type === "directive" && statement.name === "include") {
      for (const include of graph.includeMap.get(`${filePath}:${statement.args.join(" ")}`) || []) {
        const included = graph.files.get(include.canonicalPath);
        if (included) traverse(included, graph, context, output, includeChain);
      }
    }
    if (statement.type !== "block") continue;
    if (statement.name === "http") {
      traverse({ ...fileInfo, statements: statement.children }, graph, context, output, includeChain);
    } else if (statement.name === "server") {
      const next = {
        root: firstDirective(statement.children, "root") || serverDirectives.root,
        listen: unique([...serverDirectives.listen, ...directiveValues(statement.children, "listen")]),
        serverNames: unique([
          ...serverDirectives.serverNames,
          ...directiveValues(statement.children, "server_name").flatMap((v) => v.split(/\s+/u)),
        ]),
      };
      traverse({ ...fileInfo, statements: statement.children }, graph, next, output, includeChain);
    } else if (statement.name === "location") {
      const local = {
        location: statement.args.join(" "),
        root: firstDirective(statement.children, "root") || context.root || "",
        alias: firstDirective(statement.children, "alias"),
        proxy_pass: firstDirective(statement.children, "proxy_pass"),
        try_files: firstDirective(statement.children, "try_files"),
      };
      const target = resolveTarget(local, context.root);
      const record = {
        config_file: normalizePathForOutput(fileInfo.linkPath || filePath),
        server_names: boundedString(context.serverNames.join(" "), DEFAULT_LIMITS),
        listen: boundedString(context.listen.join(" "), DEFAULT_LIMITS),
        location: boundedString(local.location, DEFAULT_LIMITS),
        root: boundedString(local.root, DEFAULT_LIMITS),
        alias: boundedString(local.alias, DEFAULT_LIMITS),
        proxy_pass: boundedString(local.proxy_pass, DEFAULT_LIMITS),
        try_files: boundedString(local.try_files, DEFAULT_LIMITS),
        include_chain: boundedString(includeChain.join(" > "), DEFAULT_LIMITS),
        active: true,
        target_kind: target.target_kind,
        effective_target: boundedString(target.effective_target, DEFAULT_LIMITS),
        source_file: normalizePathForOutput(fileInfo.linkPath || filePath),
        canonical_source_file: normalizePathForOutput(filePath),
        include_depth: includeChain.length - 1,
        symlink_source: normalizePathForOutput(fileInfo.symlinkSource || ""),
        symlink_target: normalizePathForOutput(fileInfo.symlinkTarget || ""),
        config_file_sha256: fileInfo.digest,
      };
      if (isRelevant(record)) {
        record.record_index = output.records.length;
        output.records.push(record);
      }
      traverse({ ...fileInfo, statements: statement.children }, graph, context, output, includeChain);
    }
  }
}

function resolveNginxIncludeGraph(options) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
  if (!options.mainConfigPath) throw new Error("NGINX_MAIN_CONFIG_REQUIRED");
  const mainConfigPath = path.resolve(options.mainConfigPath);
  const approvedRoots = unique([
    ...(options.approvedRoots || []),
    path.dirname(mainConfigPath),
    "/etc/nginx",
    "/usr/local/etc/nginx",
  ].map((root) => path.resolve(root)));
  const state = { totalBytes: 0, includeDirectives: 0, maxDepthObserved: 0 };
  const graph = {
    files: new Map(),
    includeMap: new Map(),
    filesExamined: 0,
    filesParsed: 0,
    includeFilesResolved: 0,
    includeGlobsExpanded: 0,
    symlinksResolved: 0,
  };

  function visit(candidate, depth, stack) {
    if (depth > limits.maxDepth) throw new Error("NGINX_INCLUDE_DEPTH_LIMIT");
    state.maxDepthObserved = Math.max(state.maxDepthObserved, depth);
    const file = readConfigFile(candidate.canonicalPath || candidate, approvedRoots, limits, state);
    file.linkPath = candidate.linkPath || file.absolute;
    file.symlinkSource = candidate.symlinkSource || file.symlinkSource;
    file.symlinkTarget = candidate.symlinkTarget || file.symlinkTarget;
    if (file.symlinkSource) graph.symlinksResolved += 1;
    const canonical = file.canonical;
    if (stack.includes(canonical)) throw new Error("NGINX_INCLUDE_CYCLE");
    if (graph.files.has(canonical)) return;
    if (graph.files.size >= limits.maxFiles) throw new Error("NGINX_FILE_COUNT_LIMIT");
    graph.filesExamined += 1;
    file.statements = parseNginxConfig(file.text, canonical);
    file.canonicalPath = canonical;
    graph.files.set(canonical, file);
    graph.filesParsed += 1;
    for (const statement of flattenStatements(file.statements)) {
      if (statement.type !== "directive" || statement.name !== "include") continue;
      state.includeDirectives += 1;
      if (state.includeDirectives > limits.maxIncludeDirectives) throw new Error("NGINX_INCLUDE_DIRECTIVE_LIMIT");
      const pattern = statement.args.join(" ");
      const includes = resolveIncludePattern(pattern, canonical, approvedRoots, limits);
      if (hasGlob(path.isAbsolute(pattern) ? pattern : path.resolve(path.dirname(canonical), pattern))) {
        graph.includeGlobsExpanded += 1;
      }
      graph.includeMap.set(`${canonical}:${pattern}`, includes);
      graph.includeFilesResolved += includes.length;
      for (const include of includes) visit(include, depth + 1, [...stack, canonical]);
    }
  }

  visit({ canonicalPath: mainConfigPath, linkPath: mainConfigPath }, 0, []);
  const mainFile = graph.files.get(fs.realpathSync(mainConfigPath));
  const output = { records: [] };
  traverse(mainFile, graph, { root: "", listen: [], serverNames: [] }, output, []);
  if (output.records.length > limits.maxRecords) throw new Error("NGINX_RECORD_LIMIT");

  return {
    records: output.records,
    graph: {
      main_config_path: normalizePathForOutput(mainConfigPath),
      approved_config_roots: approvedRoots.map(normalizePathForOutput),
      files_examined: graph.filesExamined,
      files_parsed: graph.filesParsed,
      bytes_examined: state.totalBytes,
      include_directives_examined: state.includeDirectives,
      include_files_resolved: graph.includeFilesResolved,
      include_globs_expanded: graph.includeGlobsExpanded,
      symlinks_resolved: graph.symlinksResolved,
      maximum_depth_observed: state.maxDepthObserved,
      active_config_linkage: options.activeConfigLinkage || "STANDARD_DEFAULT_WITH_ACTIVE_NGINX",
      full_graph_resolved: true,
      parser_status: "SUCCESS",
      active_static_catalog_path_found: output.records.some(isStaticCatalogRecord),
    },
  };
}

function flattenStatements(statements) {
  const out = [];
  for (const statement of statements) {
    out.push(statement);
    if (statement.children) out.push(...flattenStatements(statement.children));
  }
  return out;
}

module.exports = {
  DEFAULT_LIMITS,
  parseNginxConfig,
  resolveNginxIncludeGraph,
};
