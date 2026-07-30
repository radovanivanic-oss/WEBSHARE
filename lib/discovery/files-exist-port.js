"use strict";

/**
 * Future existence-verification boundary.
 *
 * @typedef {object} FilesExistPort
 * @property {(idents: string[], options?: {signal?: AbortSignal}) =>
 *   Promise<Map<string, boolean>>} verify
 */

const FILES_EXIST_PORT_VERSION = 1;

// TODO(B.6): implement a separately bounded files_exist adapter. Hybrid
// discovery must never call this port or infer deactivation from search absence.

module.exports = {
  FILES_EXIST_PORT_VERSION,
};
