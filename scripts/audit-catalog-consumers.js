"use strict";

const path = require("node:path");
const { readinessFromDeployment, runCompatibility } = require("../lib/publication-audit/compatibility");

const OPTIONS = new Set(["repository-root", "core-audit-dir", "compatibility-dir", "deployment-audit-dir", "output-dir"]);

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].slice(2);
    if (!OPTIONS.has(key) || !argv[index + 1] || values[key]) {
      throw new Error("usage: --repository-root DIR --core-audit-dir DIR [--compatibility-dir DIR --deployment-audit-dir DIR] --output-dir DIR");
    }
    values[key] = path.resolve(argv[++index]);
  }
  if (!values["repository-root"] || !values["core-audit-dir"] || !values["output-dir"]) throw new Error("missing arguments");
  return {
    repositoryRoot: values["repository-root"],
    coreAuditDir: values["core-audit-dir"],
    compatibilityDir: values["compatibility-dir"],
    deploymentAuditDir: values["deployment-audit-dir"],
    outputDir: values["output-dir"],
  };
}

if (require.main === module) {
  try {
    const options = args(process.argv.slice(2));
    const manifest = options.compatibilityDir && options.deploymentAuditDir
      ? readinessFromDeployment(options)
      : runCompatibility(options);
    console.log(JSON.stringify({ run_id: manifest.run_id, readiness_verdict: manifest.readiness_verdict }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { args, runCompatibility, readinessFromDeployment };
