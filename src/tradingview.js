/**
 * TradingView endpoint layer: URL construction, caching, and normalisation.
 *
 * Two search surfaces exist and they are not equally good:
 *   - slug routes (/scripts/<slug>/) are curated and give genuinely on-topic results
 *   - /api/v1/scripts/?q= has poor relevance, so it is used only for `by=<username>`
 */
import { TV_ORIGIN, FACADE_ORIGIN } from './config.js';
import { parseSlugFeed, parseAuthorFeed, parseFacade, slugify, ACCESS_OPEN } from './parse.js';
import { HttpError } from './http.js';

/** Callers may pass singular or plural; the API wants plural. */
const TYPE_MAP = {
  indicator: 'indicators',
  indicators: 'indicators',
  strategy: 'strategies',
  strategies: 'strategies',
  library: 'libraries',
  libraries: 'libraries',
  all: 'all',
};

export function normalizeScriptType(t) {
  if (!t) return null;
  const key = String(t).toLowerCase();
  return TYPE_MAP[key] ?? null;
}

export class TradingView {
  constructor({ config, http, store }) {
    this.config = config;
    this.http = http;
    this.store = store;
  }

  // ---- listings ----------------------------------------------------------

  /**
   * Topical/keyword search, or the top feed when `query` is omitted.
   * `script_access=open` is always sent, so protected scripts never appear.
   */
  async searchScripts({ query = null, scriptType = null, sort = null, page = 1 } = {}) {
    const slug = query ? slugify(query) : null;
    if (query && !slug) {
      throw new Error(`Query "${query}" does not produce a usable topic slug.`);
    }
    return this.#slugFeed({
      segment: slug,
      page,
      scriptType,
      sort,
      kind: 'search',
      label: slug ?? 'top',
    });
  }

  async editorsPicks({ scriptType = null, sort = null, page = 1 } = {}) {
    return this.#slugFeed({
      segment: 'editors-picks',
      page,
      scriptType,
      sort,
      kind: 'editors_picks',
      label: 'editors-picks',
    });
  }

  async #slugFeed({ segment, page, scriptType, sort, kind, label }) {
    const type = normalizeScriptType(scriptType);
    if (scriptType && !type) {
      throw new Error(
        `Unknown script_type "${scriptType}". Use indicators, strategies, libraries or all.`
      );
    }

    const parts = ['/scripts'];
    if (segment) parts.push(segment);
    if (page && page > 1) parts.push(`page-${page}`);
    const pathname = `${parts.join('/')}/`;

    const url = new URL(pathname, TV_ORIGIN);
    url.searchParams.set('component-data-only', '1');
    if (type) url.searchParams.set('script_type', type);
    if (sort) url.searchParams.set('sort', sort);
    url.searchParams.set('script_access', 'open');

    const cacheKey = `${kind}:${url.pathname}?${url.searchParams.toString()}`;
    const cached = this.store?.getCachedSearch(cacheKey, this.config.listingTtlMs);
    if (cached) return { ...cached.payload, from_cache: true };

    const refererPath = segment ? `/scripts/${segment}/` : '/scripts/';
    let json;
    try {
      json = await this.http.getJson(url.toString(), {
        referer: new URL(refererPath, TV_ORIGIN).toString(),
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `No TradingView topic page for "${label}". Topic slugs are hyphenated single ` +
            `concepts, for example "trend-following", "scalping", "order-blocks". ` +
            `Try a broader or differently worded topic.`
        );
      }
      throw err;
    }

    const parsed = parseSlugFeed(json);
    const result = this.#finalise(parsed, { page, kind, label, type, sort });
    this.store?.putCachedSearch(cacheKey, kind, { page, type, sort, label }, result);
    return result;
  }

  /** Scripts published by one author, via the JSON API. */
  async authorScripts({ username, query = '', page = 1, perPage = 24 } = {}) {
    if (!username) throw new Error('username is required');
    const url = new URL('/api/v1/scripts/', TV_ORIGIN);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(Math.min(Math.max(perPage, 1), 24)));
    url.searchParams.set('by', username);
    url.searchParams.set('q', query ?? '');

    const cacheKey = `author:${url.searchParams.toString()}`;
    const cached = this.store?.getCachedSearch(cacheKey, this.config.listingTtlMs);
    if (cached) return { ...cached.payload, from_cache: true };

    let json;
    try {
      json = await this.http.getJson(url.toString(), {
        referer: `${TV_ORIGIN}/u/${encodeURIComponent(username)}/`,
      });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        throw new Error(
          `TradingView rejected the username "${username}". Usernames are case-insensitive ` +
            `but must match exactly otherwise, for example "TraderlifestyleYT".`
        );
      }
      throw err;
    }

    const parsed = parseAuthorFeed(json);
    const result = this.#finalise(parsed, { page, kind: 'author', label: username });
    this.store?.putCachedSearch(cacheKey, 'author', { username, query, page }, result);
    return result;
  }

  /**
   * Drop protected scripts, persist the rest, and attach result metadata.
   * Filtered items are counted rather than silently dropped.
   */
  #finalise(parsed, meta) {
    const open = parsed.items.filter((i) => i.script_access === ACCESS_OPEN);
    const filtered = parsed.items.length - open.length;
    if (this.store) this.store.upsertScripts(open);
    return {
      ...meta,
      total: parsed.total,
      returned: open.length,
      filtered_protected: filtered,
      has_more: parsed.has_more,
      heading: parsed.heading ?? null,
      items: open,
      from_cache: false,
    };
  }

  // ---- source ------------------------------------------------------------

  /**
   * Fetch Pine source. Cache-first: sources are immutable for a given version, so a
   * cached hit costs no request at all.
   */
  async getSource({ scriptIdPart, version = 'last', force = false } = {}) {
    if (!scriptIdPart) throw new Error('script_id_part is required');
    if (!/^(PUB|USER);[A-Za-z0-9]+$/i.test(scriptIdPart)) {
      throw new Error(
        `"${scriptIdPart}" is not a script_id_part. Expected the form "PUB;<hash>", which ` +
          `every search result carries. A chart URL alone is not enough: pass chart_url ` +
          `instead and it will be resolved.`
      );
    }

    if (!force) {
      const hit = this.store?.getSource(scriptIdPart, version);
      if (hit) {
        return {
          ok: true,
          from_cache: true,
          script_id_part: scriptIdPart,
          version: hit.version,
          script_name: hit.script_name,
          kind: hit.kind,
          pine_version: hit.pine_version,
          source: hit.source,
          source_chars: hit.source?.length ?? 0,
        };
      }
    }

    const known = this.store?.getScript(scriptIdPart);
    if (known && known.open_source === 0) {
      return {
        ok: false,
        protected: true,
        script_id_part: scriptIdPart,
        reason:
          'Script is closed source (invite-only or protected). TradingView never exposes ' +
          'its Pine code, so this cannot be retrieved and will not be retried.',
      };
    }

    const url = `${FACADE_ORIGIN}/pine-facade/get/${encodeURIComponent(scriptIdPart)}/${encodeURIComponent(
      String(version)
    )}?no_4xx=true`;

    let json;
    try {
      json = await this.http.getJson(url, {
        origin: TV_ORIGIN,
        referer: `${TV_ORIGIN}/`,
        sameSite: 'same-site',
        xhr: false,
      });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        this.store?.markProtected(scriptIdPart);
        return {
          ok: false,
          protected: true,
          script_id_part: scriptIdPart,
          reason: 'TradingView refused the source (closed source or invite-only).',
        };
      }
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `No script found for ${scriptIdPart} at version "${version}". Try version "last".`
        );
      }
      throw err;
    }

    const parsed = parseFacade(json, { scriptIdPart });
    if (!parsed.ok) {
      this.store?.markProtected(scriptIdPart);
      return { ...parsed, from_cache: false };
    }

    this.store?.putSource({
      script_id_part: scriptIdPart,
      version: parsed.version ?? version,
      source: parsed.source,
      pine_version: parsed.pine_version,
      kind: parsed.kind,
      script_name: parsed.script_name,
    });

    return { ...parsed, from_cache: false };
  }
}
