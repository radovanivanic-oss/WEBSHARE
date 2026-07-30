#!/usr/bin/env node
"use strict";

const {
  createApiClient,
  fetchSearchPage,
  loginAndGetWst,
} = require("../main");
const {
  DEFAULT_LIMITS,
  HARD_LIMITS,
  createDiscoveryConfig,
  redactText,
  runHybridDiscovery,
} = require("../lib/discovery/hybrid-discovery");

const VALUE_ARGUMENTS = new Set([
  "--staging-dir",
  "--what",
  "--start-offset",
  "--page-size",
  "--max-pages",
  "--max-requests",
  "--max-duration-ms",
  "--max-new-idents",
]);

function usage() {
  return [
    "Použitie:",
    "  node scripts/run-hybrid-discovery.js --what QUERY [options]",
    "",
    "Izolovaný staging:",
    "  --staging-dir PATH       default: runtime/hybrid-discovery",
    "  --resume                 iba operator_aborted/technical_error checkpoint",
    "",
    "Bounded recent discovery (žiadne wildcardy):",
    "  --start-offset N         default: 0",
    `  --page-size N            default: ${DEFAULT_LIMITS.pageSize}, hard max: ${HARD_LIMITS.pageSize}`,
    `  --max-pages N            default: ${DEFAULT_LIMITS.maxPages}, hard max: ${HARD_LIMITS.maxPages}`,
    `  --max-requests N         default: ${DEFAULT_LIMITS.maxRequests}, hard max: ${HARD_LIMITS.maxRequests}`,
    `  --max-duration-ms N      default: ${DEFAULT_LIMITS.maxDurationMs}, hard max: ${HARD_LIMITS.maxDurationMs}`,
    `  --max-new-idents N       default: ${DEFAULT_LIMITS.maxNewIdents}, hard max: ${HARD_LIMITS.maxNewIdents}`,
    "",
    "Tento prototyp iba zapisuje staging identy/checkpoint/manifest/log.",
    "Nevykonáva import, reconciliation, deactivation ani publication.",
  ].join("\n");
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(String(value ?? ""))) {
    throw new Error(`${label} musí byť neambiguózne desiatkové celé číslo.`);
  }
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number < minimum ||
    number > maximum
  ) {
    throw new Error(`${label} musí byť v rozsahu ${minimum}..${maximum}.`);
  }
  return number;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  const values = {
    stagingDir: undefined,
    what: null,
    startOffset: 0,
    resume: false,
    limits: { ...DEFAULT_LIMITS },
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--resume") {
      if (seen.has(argument)) throw new Error("--resume bol zadaný viackrát.");
      seen.add(argument);
      values.resume = true;
      continue;
    }
    if (!VALUE_ARGUMENTS.has(argument)) {
      throw new Error(`Neznámy hybrid discovery argument: ${argument}`);
    }
    if (seen.has(argument)) {
      throw new Error(`Argument ${argument} bol zadaný viackrát.`);
    }
    seen.add(argument);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Argument ${argument} vyžaduje hodnotu.`);
    }
    if (argument === "--staging-dir") {
      values.stagingDir = value;
    } else if (argument === "--what") {
      values.what = value;
    } else if (argument === "--start-offset") {
      values.startOffset = parseInteger(
        value,
        argument,
        0,
        1_000_000_000
      );
    } else {
      const field = {
        "--page-size": "pageSize",
        "--max-pages": "maxPages",
        "--max-requests": "maxRequests",
        "--max-duration-ms": "maxDurationMs",
        "--max-new-idents": "maxNewIdents",
      }[argument];
      values.limits[field] = parseInteger(
        value,
        argument,
        1,
        HARD_LIMITS[field]
      );
    }
    index += 1;
  }
  if (!values.what) throw new Error("Chýba povinný --what.");
  return values;
}

function createLiveDependencies() {
  const client = createApiClient();
  return {
    async authenticate({ requestMeter, signal }) {
      const username = process.env.WEBSHARE_USERNAME;
      const password = process.env.WEBSHARE_PASSWORD;
      if (!username || !password) {
        throw new Error("Chýba WEBSHARE_USERNAME alebo WEBSHARE_PASSWORD.");
      }
      return loginAndGetWst({
        username,
        password,
        signal,
        requestMeter,
        client,
      });
    },
    fetchSearchPage: async ({
      token,
      what,
      sort,
      category,
      offset,
      limit,
      signal,
      requestMeter,
    }) => {
      const session = {
        async withWst(task) {
          return task(token);
        },
      };
      return fetchSearchPage(
        client,
        session,
        {
          prefix: what,
          wildcardSuffix: "",
          sort,
          category,
          offset,
          limit,
          signal,
          requestMeter,
        },
        null
      );
    },
  };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const config = createDiscoveryConfig({
    projectRoot: process.cwd(),
    stagingDir: parsed.stagingDir,
    what: parsed.what,
    startOffset: parsed.startOffset,
    limits: parsed.limits,
  });
  const controller = new AbortController();
  const requestStop = () =>
    controller.abort(new Error("operator_aborted"));
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    const result = await runHybridDiscovery(
      config,
      createLiveDependencies(),
      {
        resume: parsed.resume,
        signal: controller.signal,
        secrets: [
          process.env.WEBSHARE_USERNAME,
          process.env.WEBSHARE_PASSWORD,
        ],
      }
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          success: result.manifest.status !== "failed",
          run_id: result.manifest.run_id,
          status: result.manifest.status,
          finished_reason: result.manifest.finished_reason,
          enumeration_complete: false,
          staging_root: config.paths.root,
        },
        null,
        2
      )}\n`
    );
    if (result.manifest.status === "failed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      `${redactText(error?.stack || error, [
        process.env.WEBSHARE_USERNAME,
        process.env.WEBSHARE_PASSWORD,
      ])}\n`
    );
    process.exitCode = 1;
  });
}

module.exports = {
  createLiveDependencies,
  main,
  parseArguments,
  parseInteger,
  usage,
};
