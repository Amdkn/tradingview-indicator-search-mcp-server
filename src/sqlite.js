/**
 * Indirection around node:sqlite.
 *
 * Bundlers that predate Node 22's built-in SQLite try to resolve `node:sqlite` as a
 * package and fail. Requiring it at runtime keeps the module invisible to static
 * analysis, so the test runner works without any bundler-specific configuration.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let mod;
try {
  mod = require('node:sqlite');
} catch (err) {
  throw new Error(
    `node:sqlite is unavailable (Node ${process.version}). indicator_fetch needs Node 22.5 ` +
      `or newer. Original error: ${err?.message ?? err}`
  );
}

export const DatabaseSync = mod.DatabaseSync;
