"use strict";

const path = require("node:path");
const { capture } = require("../lib/publication-audit/deployment-capture");

const OPTIONS = new Set([
  "repository-root",
  "output-dir",
  "nginx-bin",
  "nginx-main-config",
  "nginx-config-root",
]);

function args(argv) {
  if (argv.includes("--help")) {
    throw new Error("usage: --repository-root DIR --output-dir DIR [--nginx-bin FILE] [--nginx-main-config FILE] [--nginx-config-root DIR]");
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].slice(2);
    if (!OPTIONS.has(key) || !argv[index + 1] || values[key]) throw new Error("invalid arguments");
    values[key] = path.resolve(argv[++index]);
  }
  if (!values["repository-root"] || !values["output-dir"]) throw new Error("missing required arguments");
  return {
    repositoryRoot: values["repository-root"],
    outputDir: values["output-dir"],
    nginxBin: values["nginx-bin"],
    nginxMainConfig: values["nginx-main-config"],
    nginxConfigRoot: values["nginx-config-root"],
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(capture(args(process.argv.slice(2)))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { args };
