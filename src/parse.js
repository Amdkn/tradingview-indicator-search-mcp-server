/**
 * Pure parsers for the three TradingView response shapes. No I/O, so the tests
 * run these against real captured payloads without touching the network.
 *
 * Shapes:
 *   slug feed   /scripts/<slug>/page-N/?component-data-only=1
 *               -> data.ideas.data { total, items, next }
 *   author feed /api/v1/scripts/?by=<user>
 *               -> { count, page_size, page_count, next, results }
 *   facade      /pine-facade/get/<id>/<version>
 *               -> { source, scriptName, version, extra } | { success:false, reason }
 */

/** script_access 1 means the Pine source is publicly readable. 2 and 3 are protected. */
export const ACCESS_OPEN = 1;

export function slugify(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Normalise an item from either feed into one canonical record. */
export function normalizeItem(raw) {
  const access = raw.script_access ?? null;
  return {
    script_id_part: raw.script_id_part ?? null,
    script_id: raw.id ?? null,
    name: raw.name ?? null,
    author: raw.user?.username ?? null,
    author_id: raw.user?.id ?? null,
    script_type: raw.script_type ?? null,
    script_access: access,
    open_source: access === ACCESS_OPEN,
    version: raw.version ?? null,
    likes: raw.likes_count ?? 0,
    comments: raw.comments_count ?? 0,
    views: raw.views_count ?? 0,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
    chart_url: raw.chart_url ?? null,
    image_url: raw.image?.big ?? raw.image_url ?? null,
    symbol: raw.symbol?.name ?? null,
    interval: raw.symbol?.interval ?? null,
    is_picked: Boolean(raw.is_picked),
    is_hot: Boolean(raw.is_hot),
    description: raw.description ?? '',
  };
}

export function parseSlugFeed(json) {
  const feed = json?.data?.ideas?.data;
  if (!feed || !Array.isArray(feed.items)) {
    throw new Error('Unexpected slug-feed shape: data.ideas.data.items missing');
  }
  return {
    total: feed.total ?? 0,
    has_more: Boolean(feed.next),
    next_path: feed.next ?? null,
    heading: json?.meta?.heading ?? null,
    items: feed.items.map(normalizeItem),
  };
}

export function parseAuthorFeed(json) {
  if (!json || !Array.isArray(json.results)) {
    throw new Error('Unexpected author-feed shape: results missing');
  }
  return {
    total: json.count ?? json.results.length,
    page_count: json.page_count ?? 1,
    has_more: Boolean(json.next),
    next_path: json.next ?? null,
    items: json.results.map(normalizeItem),
  };
}

/**
 * The facade returns HTTP 200 with `{success:false}` when `no_4xx=true` is set, so a
 * naive client would happily store a refusal object as if it were source code.
 */
export function parseFacade(json, { scriptIdPart } = {}) {
  if (!json || json.success === false || typeof json.source !== 'string') {
    return {
      ok: false,
      protected: true,
      reason: json?.reason ?? 'No source returned',
      script_id_part: scriptIdPart ?? null,
    };
  }
  const kind = json.extra?.kind ?? null;
  return {
    ok: true,
    script_id_part: scriptIdPart ?? null,
    script_name: json.scriptName ?? null,
    version: json.version ?? json.lastVersionMaj ?? null,
    script_access: json.scriptAccess ?? null,
    kind,
    script_type: kind === 'strategy' ? 'strategy' : kind === 'study' ? 'indicator' : kind,
    pine_version: detectPineVersion(json.source),
    is_price_study: json.extra?.is_price_study ?? null,
    source: json.source,
    source_chars: json.source.length,
  };
}

export function detectPineVersion(source) {
  const m = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source || '');
  return m ? Number(m[1]) : null;
}

/** Pull `PUB;<hash>` out of a pasted chart URL, if the caller has one. */
export function extractIdFromChartUrl(url) {
  const m = /tradingview\.com\/script\/([A-Za-z0-9]+)/.exec(String(url || ''));
  return m ? m[1] : null;
}

/** Trim a description down so a 24-item listing cannot flood an agent's context. */
export function snippet(text, max) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max).trimEnd()}…`;
}

/** Listing view of a script: no full description, no image noise. */
export function toListing(item, snippetChars) {
  return {
    script_id_part: item.script_id_part,
    name: item.name,
    author: item.author,
    script_type: item.script_type,
    open_source: Boolean(item.open_source),
    likes: item.likes,
    version: item.version,
    symbol: item.symbol,
    interval: item.interval,
    created_at: item.created_at,
    chart_url: item.chart_url,
    description_snippet: snippet(item.description, snippetChars),
  };
}
