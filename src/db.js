/**
 * Local SQLite corpus. Uses Node's built-in node:sqlite, so there is no native
 * module to compile.
 *
 * The corpus is the main defence against getting banned: a source is immutable for
 * a given version, so once fetched it never needs refetching.
 */
import { DatabaseSync } from './sqlite.js';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scripts (
  script_id_part TEXT PRIMARY KEY,
  script_id      INTEGER,
  name           TEXT,
  author         TEXT,
  author_id      INTEGER,
  script_type    TEXT,
  script_access  INTEGER,
  open_source    INTEGER,
  version        TEXT,
  likes          INTEGER,
  comments       INTEGER,
  views          INTEGER,
  created_at     TEXT,
  updated_at     TEXT,
  chart_url      TEXT,
  image_url      TEXT,
  symbol         TEXT,
  interval       TEXT,
  is_picked      INTEGER,
  is_hot         INTEGER,
  description    TEXT,
  fetched_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scripts_author ON scripts(author);
CREATE INDEX IF NOT EXISTS idx_scripts_type   ON scripts(script_type);
CREATE INDEX IF NOT EXISTS idx_scripts_likes  ON scripts(likes DESC);

CREATE TABLE IF NOT EXISTS sources (
  script_id_part TEXT NOT NULL,
  version        TEXT NOT NULL,
  source         TEXT,
  pine_version   INTEGER,
  kind           TEXT,
  script_name    TEXT,
  fetched_at     INTEGER,
  PRIMARY KEY (script_id_part, version)
);

CREATE TABLE IF NOT EXISTS searches (
  cache_key  TEXT PRIMARY KEY,
  kind       TEXT,
  params     TEXT,
  total      INTEGER,
  has_more   INTEGER,
  payload    TEXT,
  fetched_at INTEGER
);

CREATE TABLE IF NOT EXISTS harvests (
  id         TEXT PRIMARY KEY,
  spec       TEXT,
  status     TEXT,
  cursor     TEXT,
  scripts_seen   INTEGER DEFAULT 0,
  sources_stored INTEGER DEFAULT 0,
  started_at INTEGER,
  updated_at INTEGER,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS request_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER,
  day     TEXT,
  host    TEXT,
  path    TEXT,
  status  INTEGER,
  ms      INTEGER,
  outcome TEXT
);
CREATE INDEX IF NOT EXISTS idx_request_log_day ON request_log(day);

CREATE TABLE IF NOT EXISTS cookies (
  host       TEXT PRIMARY KEY,
  jar        TEXT,
  updated_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(
  script_id_part UNINDEXED,
  name,
  author,
  description,
  source
);
`;

export class Store {
  /** @param {string} dbPath  Use ':memory:' in tests. */
  constructor(dbPath) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- scripts -----------------------------------------------------------

  upsertScript(s, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO scripts (
           script_id_part, script_id, name, author, author_id, script_type,
           script_access, open_source, version, likes, comments, views,
           created_at, updated_at, chart_url, image_url, symbol, interval,
           is_picked, is_hot, description, fetched_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(script_id_part) DO UPDATE SET
           script_id=excluded.script_id, name=excluded.name, author=excluded.author,
           author_id=excluded.author_id, script_type=excluded.script_type,
           script_access=excluded.script_access, open_source=excluded.open_source,
           version=excluded.version, likes=excluded.likes, comments=excluded.comments,
           views=excluded.views, created_at=excluded.created_at,
           updated_at=excluded.updated_at, chart_url=excluded.chart_url,
           image_url=excluded.image_url, symbol=excluded.symbol,
           interval=excluded.interval, is_picked=excluded.is_picked,
           is_hot=excluded.is_hot, description=excluded.description,
           fetched_at=excluded.fetched_at`
      )
      .run(
        s.script_id_part,
        s.script_id ?? null,
        s.name ?? null,
        s.author ?? null,
        s.author_id ?? null,
        s.script_type ?? null,
        s.script_access ?? null,
        s.open_source ? 1 : 0,
        s.version ?? null,
        s.likes ?? 0,
        s.comments ?? 0,
        s.views ?? 0,
        s.created_at ?? null,
        s.updated_at ?? null,
        s.chart_url ?? null,
        s.image_url ?? null,
        s.symbol ?? null,
        s.interval ?? null,
        s.is_picked ? 1 : 0,
        s.is_hot ? 1 : 0,
        s.description ?? null,
        now
      );
    this.#reindex(s.script_id_part);
  }

  upsertScripts(items, now = Date.now()) {
    for (const it of items) this.upsertScript(it, now);
    return items.length;
  }

  getScript(scriptIdPart) {
    return (
      this.db.prepare('SELECT * FROM scripts WHERE script_id_part = ?').get(scriptIdPart) ?? null
    );
  }

  /**
   * Mark a script as protected after the facade refuses it, so we never retry.
   * Inserts when the script was never listed: get_script_source can be called with a
   * bare id, and a plain UPDATE would quietly no-op and let it refetch forever.
   */
  markProtected(scriptIdPart, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO scripts (script_id_part, open_source, script_access, fetched_at)
         VALUES (?, 0, 2, ?)
         ON CONFLICT(script_id_part) DO UPDATE SET open_source = 0, script_access = 2`
      )
      .run(scriptIdPart, now);
  }

  // ---- sources -----------------------------------------------------------

  putSource(rec, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO sources (script_id_part, version, source, pine_version, kind, script_name, fetched_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(script_id_part, version) DO UPDATE SET
           source=excluded.source, pine_version=excluded.pine_version,
           kind=excluded.kind, script_name=excluded.script_name,
           fetched_at=excluded.fetched_at`
      )
      .run(
        rec.script_id_part,
        String(rec.version),
        rec.source,
        rec.pine_version ?? null,
        rec.kind ?? null,
        rec.script_name ?? null,
        now
      );
    this.#reindex(rec.script_id_part);
  }

  getSource(scriptIdPart, version) {
    if (version === undefined || version === null || version === 'last') {
      return (
        this.db
          .prepare(
            'SELECT * FROM sources WHERE script_id_part = ? ORDER BY fetched_at DESC LIMIT 1'
          )
          .get(scriptIdPart) ?? null
      );
    }
    return (
      this.db
        .prepare('SELECT * FROM sources WHERE script_id_part = ? AND version = ?')
        .get(scriptIdPart, String(version)) ?? null
    );
  }

  hasSource(scriptIdPart) {
    const row = this.db
      .prepare('SELECT 1 AS ok FROM sources WHERE script_id_part = ? LIMIT 1')
      .get(scriptIdPart);
    return Boolean(row);
  }

  /** Keep the FTS row for a script in sync with scripts + sources. */
  #reindex(scriptIdPart) {
    const s = this.getScript(scriptIdPart);
    const src = this.getSource(scriptIdPart);
    if (!s && !src) return;
    this.db.prepare('DELETE FROM corpus_fts WHERE script_id_part = ?').run(scriptIdPart);
    this.db
      .prepare(
        'INSERT INTO corpus_fts (script_id_part, name, author, description, source) VALUES (?,?,?,?,?)'
      )
      .run(
        scriptIdPart,
        s?.name ?? src?.script_name ?? '',
        s?.author ?? '',
        s?.description ?? '',
        src?.source ?? ''
      );
  }

  // ---- listing cache -----------------------------------------------------

  getCachedSearch(cacheKey, ttlMs, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM searches WHERE cache_key = ?').get(cacheKey);
    if (!row) return null;
    if (now - row.fetched_at > ttlMs) return null;
    return { ...row, payload: JSON.parse(row.payload) };
  }

  putCachedSearch(cacheKey, kind, params, result, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO searches (cache_key, kind, params, total, has_more, payload, fetched_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(cache_key) DO UPDATE SET
           total=excluded.total, has_more=excluded.has_more,
           payload=excluded.payload, fetched_at=excluded.fetched_at`
      )
      .run(
        cacheKey,
        kind,
        JSON.stringify(params),
        result.total ?? 0,
        result.has_more ? 1 : 0,
        JSON.stringify(result),
        now
      );
  }

  // ---- harvests ----------------------------------------------------------

  createHarvest(id, spec, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO harvests (id, spec, status, cursor, scripts_seen, sources_stored, started_at, updated_at)
         VALUES (?,?,?,?,0,0,?,?)`
      )
      .run(id, JSON.stringify(spec), 'running', JSON.stringify({ page: 1, pending: [] }), now, now);
    return this.getHarvest(id);
  }

  getHarvest(id) {
    const row = this.db.prepare('SELECT * FROM harvests WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, spec: JSON.parse(row.spec), cursor: JSON.parse(row.cursor) };
  }

  updateHarvest(id, patch, now = Date.now()) {
    const cur = this.getHarvest(id);
    if (!cur) throw new Error(`Unknown harvest_id: ${id}`);
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        `UPDATE harvests SET status=?, cursor=?, scripts_seen=?, sources_stored=?, updated_at=?, note=?
         WHERE id=?`
      )
      .run(
        next.status,
        JSON.stringify(next.cursor),
        next.scripts_seen,
        next.sources_stored,
        now,
        next.note ?? null,
        id
      );
    return this.getHarvest(id);
  }

  // ---- request log / budget ---------------------------------------------

  logRequest({ host, path: p, status, ms, outcome }, now = Date.now()) {
    this.db
      .prepare('INSERT INTO request_log (ts, day, host, path, status, ms, outcome) VALUES (?,?,?,?,?,?,?)')
      .run(now, utcDay(now), host, p, status ?? null, ms ?? null, outcome ?? null);
  }

  countRequestsToday(now = Date.now()) {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM request_log WHERE day = ?')
      .get(utcDay(now));
    return row?.n ?? 0;
  }

  // ---- cookies -----------------------------------------------------------

  getCookieJar(host, maxAgeMs, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM cookies WHERE host = ?').get(host);
    if (!row) return null;
    if (now - row.updated_at > maxAgeMs) return null;
    return row.jar;
  }

  putCookieJar(host, jar, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO cookies (host, jar, updated_at) VALUES (?,?,?)
         ON CONFLICT(host) DO UPDATE SET jar=excluded.jar, updated_at=excluded.updated_at`
      )
      .run(host, jar, now);
  }

  // ---- corpus query ------------------------------------------------------

  /**
   * Offline search over everything already stored. `query` runs through FTS5;
   * `sourceContains` does a literal LIKE, which is what you want for tokens the
   * FTS tokeniser would split, such as `ta.supertrend`.
   */
  queryCorpus({
    query,
    sourceContains,
    scriptType,
    author,
    withSourceOnly = false,
    minLikes = 0,
    limit = 25,
  } = {}) {
    const where = [];
    const args = [];
    let from = 'FROM scripts s LEFT JOIN sources src ON src.script_id_part = s.script_id_part';

    if (query) {
      // No alias: FTS5's MATCH operator must name the table it applies to.
      from += ` JOIN corpus_fts ON corpus_fts.script_id_part = s.script_id_part`;
      where.push('corpus_fts MATCH ?');
      args.push(query);
    }
    if (sourceContains) {
      where.push('src.source LIKE ?');
      args.push(`%${sourceContains}%`);
    }
    if (scriptType && scriptType !== 'all') {
      where.push('s.script_type = ?');
      args.push(scriptType);
    }
    if (author) {
      where.push('LOWER(s.author) = LOWER(?)');
      args.push(author);
    }
    if (withSourceOnly) where.push('src.source IS NOT NULL');
    if (minLikes > 0) {
      where.push('s.likes >= ?');
      args.push(minLikes);
    }

    const sql =
      `SELECT s.*, (src.source IS NOT NULL) AS has_source, LENGTH(src.source) AS source_chars, ` +
      `src.pine_version AS pine_version ` +
      from +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY s.likes DESC LIMIT ?`;
    args.push(limit);
    return this.db.prepare(sql).all(...args);
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    return {
      scripts: one('SELECT COUNT(*) AS n FROM scripts')?.n ?? 0,
      sources: one('SELECT COUNT(*) AS n FROM sources')?.n ?? 0,
      authors: one('SELECT COUNT(DISTINCT author) AS n FROM scripts')?.n ?? 0,
      requests_today: this.countRequestsToday(),
      requests_total: one('SELECT COUNT(*) AS n FROM request_log')?.n ?? 0,
    };
  }
}

export function utcDay(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}
