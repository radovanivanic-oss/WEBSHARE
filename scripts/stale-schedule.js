#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");

const BEGIN = "# WEBSHARE_ISOLATED_STALE_WEEKLY_BEGIN";
const END = "# WEBSHARE_ISOLATED_STALE_WEEKLY_END";
const REPOSITORY = "/home/radeco/webshare-crawler";
const LOG = `${REPOSITORY}/runtime/stale-weekly/weekly-cron.log`;
const ENTRY = `0 3 * * * cd ${REPOSITORY} && STALE_WEEKLY_LOG=${LOG} /usr/bin/node scripts/run-weekly-stale-maintenance.js >> ${LOG} 2>&1`;

function readCrontab() {
  try { return execFileSync("crontab", ["-l"], { encoding: "utf8" }); }
  catch (error) { if (error.status === 1 && !error.stdout) return ""; throw error; }
}

function removeBlock(text) {
  const lines = String(text || "").split(/\r?\n/u);
  const result = [], block = [];
  let inside = false;
  for (const line of lines) {
    if (line === BEGIN) { inside = true; block.push(line); continue; }
    if (inside) { block.push(line); if (line === END) inside = false; continue; }
    result.push(line);
  }
  if (inside) throw new Error("STALE_SCHEDULE_MARKER_UNCLOSED");
  while (result.length && result.at(-1) === "") result.pop();
  return { text: result.length ? `${result.join("\n")}\n` : "", removed: block.length > 0 };
}

function managedBlock() { return `${BEGIN}\n${ENTRY}\n${END}`; }

function installText(existing) {
  const clean = removeBlock(existing).text;
  return `${clean}${clean ? "\n" : ""}${managedBlock()}\n`;
}

function install() {
  const existing = readCrontab(), next = installText(existing);
  execFileSync("crontab", ["-"], { input: next, encoding: "utf8" });
  return statusFromText(next);
}

function remove() {
  const existing = readCrontab(), next = removeBlock(existing).text;
  if (next !== existing) execFileSync("crontab", ["-"], { input: next, encoding: "utf8" });
  return statusFromText(next);
}

function statusFromText(text) {
  const lines = String(text || "").split(/\r?\n/u);
  const enabled = lines.includes(BEGIN) && lines.includes(END) && lines.includes(ENTRY);
  return { scheduler_enabled: enabled, cadence: "daily 03:00 UTC", time_zone: "Europe/Bratislava date semantics", cron_entry: enabled ? ENTRY : null, marker: enabled ? `${BEGIN}..${END}` : null };
}

function status() { return statusFromText(readCrontab()); }

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "status";
  let result;
  if (command === "install") result = install();
  else if (command === "remove") result = remove();
  else if (command === "status") result = status();
  else throw new Error("usage: stale-schedule.js install|status|remove");
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) { try { main(); } catch (error) { console.error(error.message || "STALE_SCHEDULE_FAILED"); process.exitCode = 1; } }

module.exports = { BEGIN, END, ENTRY, install, installText, main, managedBlock, readCrontab, remove, removeBlock, status, statusFromText };
