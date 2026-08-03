"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createApiClient, loginAndGetWst, WebshareSession } = require("../main");
const { createCandidateMetadataConfig, runCandidateMetadata } = require("../lib/discovery/candidate-metadata");
const { meter, sourceContract } = require("./run-candidate-metadata-b22");

const SAFE = Object.freeze({ metadata_only: true, discovery_executed: false, file_exists_executed: false, sqlite_write_performed: false, import_performed: false, reactivation_performed: false, deactivation_performed: false, reconciliation_performed: false, publication_performed: false });

function parse(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!['--source-file-exists-dir', '--output-dir'].includes(args[index]) || !args[index + 1]) throw new Error('usage: --source-file-exists-dir DIR --output-dir DIR');
    values[args[index].slice(2)] = path.resolve(args[++index]);
  }
  if (!values['source-file-exists-dir'] || !values['output-dir']) throw new Error('missing arguments');
  return { source: values['source-file-exists-dir'], output: values['output-dir'] };
}

function guard(output) {
  if (path.basename(path.dirname(output)) !== 'runtime' || !/^candidate-metadata-b23-\d{8}T\d{6}Z$/u.test(path.basename(output)) || fs.existsSync(output)) throw new Error('unsafe output root');
}

async function run(options, dependencies = {}) {
  guard(options.output);
  const source = sourceContract(options.source), requestMeter = meter();
  fs.mkdirSync(options.output, { mode: 0o750 });
  fs.writeFileSync(path.join(options.output, 'source-reference.json'), `${JSON.stringify({ schema_version: 1, source_file_exists_run_id: source.runId, source_hashes: source.hashes, selected_candidates: source.ids }, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
  const username = dependencies.username ?? process.env.WEBSHARE_USERNAME, password = dependencies.password ?? process.env.WEBSHARE_PASSWORD;
  if (!username || !password) throw new Error('missing Webshare credentials');
  const client = dependencies.client || createApiClient();
  const token = await (dependencies.login || loginAndGetWst)({ username, password, client, requestMeter });
  const session = dependencies.session || new WebshareSession({ username, password }, { info() {}, warn() {}, error() {} }, { login: async () => token, apiClient: client, requestMeter });
  const config = createCandidateMetadataConfig({ root: options.output, idents: source.ids, limits: { maxCandidates: 25, maxRequests: 25, maxDurationMs: 300000 } });
  const result = await runCandidateMetadata(config, session, { secrets: [username, password] });
  if (requestMeter.state.authentication_completed !== 2 || requestMeter.state.file_info_completed !== 25 || requestMeter.state.total_requests_completed !== 27) throw new Error('request accounting mismatch');
  const runner = { schema_version: 2, ...SAFE, run_id: result.manifest.run_id, source_file_exists_run_id: source.runId, selected_candidates: 25, ...requestMeter.state, status_counters: result.manifest.counters, finished_reason: result.manifest.finished_reason };
  fs.writeFileSync(path.join(options.output, 'runner.manifest.json'), `${JSON.stringify(runner, null, 2)}\n`, { flag: 'wx', mode: 0o640 });
  return { runner, result };
}

if (require.main === module) run(parse(process.argv.slice(2))).then((value) => console.log(JSON.stringify({ run_id: value.runner.run_id, counters: value.runner.status_counters }))).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { parse, guard, run };
