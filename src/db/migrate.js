"use strict";

/**
 * migrate.js — lightweight versioned migration runner
 *
 * Convention:
 *   Migration files live in ./migrations/ and are named NNN_description.js
 *   where NNN is a zero-padded integer version number (e.g. 001, 002, …).
 *
 *   Each file must export { up(db) } and optionally { down(db) }.
 *
 * The runner:
 *   1. Creates `schema_migrations` if it doesn't exist.
 *   2. Reads all migration files, sorted ascending by version number.
 *   3. Skips already-applied versions.
 *   4. Runs each pending migration inside its own transaction.
 *   5. Records the applied version in schema_migrations.
 *
 * Usage:
 *   const Database = require('better-sqlite3');
 *   const { runMigrations } = require('./migrate');
 *   const db = new Database('path/to/aep.db');
 *   runMigrations(db);   // synchronous; throws on error
 */

const fs   = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

/**
 * Parse the version number from a filename like "001_initial_schema.js".
 * Returns NaN if the filename doesn't match the convention.
 */
function parseVersion(filename) {
  const match = filename.match(/^(\d+)_/);
  return match ? parseInt(match[1], 10) : NaN;
}

/**
 * Run all pending migrations against `db` (a better-sqlite3 Database instance).
 * @param {import('better-sqlite3').Database} db
 */
function runMigrations(db) {
  // Choose the best available journal mode for the underlying filesystem.
  //
  // Preference order:
  //   1. WAL   — best concurrent read throughput; needs auxiliary -shm/-wal files
  //   2. MEMORY — rollback journal in RAM; no auxiliary files; safe for FUSE mounts
  //   3. (default) — SQLite default if both attempts fail (very unusual)
  //
  // FUSE-mounted volumes (e.g. macOS user folders accessed from a Linux VM) often
  // reject file-deletion syscalls, which breaks WAL setup and the DELETE journal.
  // MEMORY mode avoids writing any auxiliary files while keeping full write safety
  // within each transaction.
  for (const mode of ["WAL", "MEMORY"]) {
    try {
      const result = db.pragma(`journal_mode = ${mode}`, { simple: true });
      if (result === mode.toLowerCase()) break;   // SQLite confirmed the mode
    } catch (_) {
      // try next mode
    }
  }
  db.pragma("foreign_keys = ON");

  // Bootstrap the migrations-tracking table on the very first run.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER NOT NULL PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL
    )
  `);

  // Collect already-applied versions.
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all()
      .map(row => row.version)
  );

  // Discover migration files.
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".js"))
    .filter(f => !isNaN(parseVersion(f)))
    .sort((a, b) => parseVersion(a) - parseVersion(b));

  let ranCount = 0;

  for (const file of files) {
    const version = parseVersion(file);

    if (applied.has(version)) {
      continue; // already applied — skip
    }

    const migration = require(path.join(MIGRATIONS_DIR, file));

    if (typeof migration.up !== "function") {
      throw new Error(`Migration ${file} must export an up(db) function`);
    }

    // Wrap in a transaction: either the migration fully applies or it doesn't.
    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
      ).run(version, file, new Date().toISOString());
    });

    applyMigration();

    console.log(`[migrate] Applied ${file}`);
    ranCount += 1;
  }

  if (ranCount === 0) {
    console.log("[migrate] Database is up to date.");
  } else {
    console.log(`[migrate] ${ranCount} migration(s) applied.`);
  }
}

module.exports = { runMigrations };
