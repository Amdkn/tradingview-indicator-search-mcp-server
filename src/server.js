#!/usr/bin/env node
/**
 * indicator_fetch — local MCP server for discovering TradingView indicators and
 * strategies and pulling their Pine source for backtesting.
 *
 *   claude mcp add indicator_fetch -s user -- node /ABS/PATH/indicator_fetch/src/server.js
 *
 * No TradingView account or cookie is required: every endpoint used here is public.
 * All outbound traffic is paced, capped and circuit-broken (see throttle.js).
 */

// node:sqlite is stable enough for our use but still emits an experimental warning.
// It would otherwise appear in the client's stderr on every start.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message)) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config } from './config.js';
import { Store } from './db.js';
import { Throttle } from './throttle.js';
import { HttpClient } from './http.js';
import { TradingView } from './tradingview.js';
import { createTools } from './tools.js';

const store = new Store(config.dbPath);
const throttle = new Throttle(config, { countToday: () => store.countRequestsToday() });
const http = new HttpClient({ config, throttle, store });
const tv = new TradingView({ config, http, store });
const tools = createTools({ config, tv, store, throttle, http });

const server = new McpServer({ name: 'indicator_fetch', version: '1.0.0' });

/** Wrap a plain async impl as an MCP tool handler returning JSON text content. */
function wrap(fn, { warm = false } = {}) {
  return async (args) => {
    try {
      if (warm) await http.warmUp();
      const out = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err?.message ?? String(err)}` }],
        isError: true,
      };
    }
  };
}

const SCRIPT_TYPE = z
  .enum(['indicators', 'strategies', 'libraries', 'all'])
  .optional()
  .describe('Filter by kind. Omit for everything.');

const SORT = z
  .enum(['latest_popular', 'recent_extended'])
  .optional()
  .describe('latest_popular (default, best-known first) or recent_extended (newest first).');

server.tool(
  'search_scripts',
  'Search TradingView for public indicators and strategies by topic, for example ' +
    '"trend following", "scalping", "order blocks", "mean reversion", "volume profile". ' +
    'Topic search is curated by TradingView and gives far better results than free-text ' +
    'keyword matching. Omit `query` to get the top/trending feed. Only open-source scripts ' +
    'are returned, so everything listed can have its Pine code fetched with get_script_source. ' +
    'Returns description snippets, not full descriptions.',
  {
    query: z
      .string()
      .optional()
      .describe('Topic, e.g. "trend following". Converted to a hyphenated slug automatically.'),
    script_type: SCRIPT_TYPE,
    sort: SORT,
    page: z.number().int().min(1).max(50).optional().describe('1-based page. 24 results per page.'),
  },
  wrap(tools.search_scripts, { warm: true })
);

server.tool(
  'list_editors_picks',
  "TradingView's editors' picks: the hand-curated, highest-quality community scripts. " +
    'Best starting point when you want proven, well-built indicators rather than a broad sweep.',
  {
    script_type: SCRIPT_TYPE,
    sort: SORT,
    page: z.number().int().min(1).max(50).optional().describe('1-based page. 24 results per page.'),
  },
  wrap(tools.list_editors_picks, { warm: true })
);

server.tool(
  'list_author_scripts',
  'List every public script published by one TradingView author, for example ' +
    '"TraderlifestyleYT", "LuxAlgo", "ZenAndTheArtOfTrading". Use this when you have a ' +
    'favourite author and want their catalogue. Optionally narrow with `query`.',
  {
    username: z.string().describe('Exact TradingView username (case-insensitive).'),
    query: z.string().optional().describe('Optional filter within that author\'s scripts.'),
    page: z.number().int().min(1).max(50).optional().describe('1-based page.'),
  },
  wrap(tools.list_author_scripts, { warm: true })
);

server.tool(
  'get_script_source',
  'Fetch the full Pine Script source for one script, ready to backtest or port. ' +
    'Pass `script_id_part` from any search result (form "PUB;<hash>"), or paste a ' +
    'TradingView `chart_url` and it will be resolved. Sources are cached permanently ' +
    'per version, so repeat calls cost no request. Closed-source scripts return a clear ' +
    'error rather than junk.',
  {
    script_id_part: z.string().optional().describe('e.g. "PUB;5bbd9e495f604c3682671a0e8920a188".'),
    chart_url: z
      .string()
      .optional()
      .describe('e.g. "https://www.tradingview.com/script/K0SEi3Ct-Some-Name/".'),
    version: z.string().optional().describe('Defaults to "last", which is almost always right.'),
    force: z.boolean().optional().describe('Bypass the cache and refetch. Rarely needed.'),
  },
  wrap(tools.get_script_source, { warm: true })
);

server.tool(
  'harvest_scripts',
  'Bulk-collect many scripts AND their Pine sources into the local corpus in one go, ' +
    'for example "100 trend-following strategies". This is the efficient way to build a ' +
    'backtesting library: pay the network cost once here, then use query_corpus offline. ' +
    'Runs within a wall-clock budget and checkpoints as it goes; if it returns ' +
    'status="paused" that is normal, just call again with the same harvest_id to continue. ' +
    'Returns counts and a small preview, never the source bodies.',
  {
    source: z
      .enum(['search', 'editors_picks', 'author'])
      .optional()
      .describe('Where to harvest from. Default "search".'),
    query: z.string().optional().describe('Topic, when source="search".'),
    username: z.string().optional().describe('Author, required when source="author".'),
    script_type: SCRIPT_TYPE,
    sort: SORT,
    max_scripts: z.number().int().min(1).max(200).optional().describe('Default 100, hard cap 200.'),
    fetch_sources: z
      .boolean()
      .optional()
      .describe('Default true. Set false to collect metadata only, which is much faster.'),
    time_budget_ms: z
      .number()
      .int()
      .min(5000)
      .max(600000)
      .optional()
      .describe('Wall-clock budget for this call. Default 120000.'),
    harvest_id: z.string().optional().describe('Resume a paused harvest.'),
  },
  wrap(tools.harvest_scripts, { warm: true })
);

server.tool(
  'query_corpus',
  'Search everything already collected locally. Zero network requests, instant, and it ' +
    'can search INSIDE Pine source code, which the TradingView site cannot do. Use ' +
    '`source_contains` for literal code tokens such as "ta.supertrend" or "strategy.entry", ' +
    'and `query` for full-text over names, authors and descriptions. Always try this before ' +
    'hitting the network again.',
  {
    query: z.string().optional().describe('Full-text (FTS5) over name, author, description, code.'),
    source_contains: z
      .string()
      .optional()
      .describe('Literal substring match inside Pine code, e.g. "ta.supertrend".'),
    script_type: z.enum(['indicator', 'strategy', 'library', 'all']).optional(),
    author: z.string().optional(),
    with_source_only: z.boolean().optional().describe('Only scripts whose Pine code is stored.'),
    min_likes: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional().describe('Default 25.'),
    include_source: z
      .boolean()
      .optional()
      .describe('Return full Pine code. Forces limit to 3 because sources are large.'),
  },
  wrap(tools.query_corpus)
);

server.tool(
  'fetch_status',
  'Show rate-limit health and corpus size: requests used against the daily budget, ' +
    'whether the circuit breaker has tripped, current pacing settings, and how many ' +
    'scripts and sources are stored locally. Makes no network request.',
  {},
  wrap(tools.fetch_status)
);

function shutdown() {
  try {
    store.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
