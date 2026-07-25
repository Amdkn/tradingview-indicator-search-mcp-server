#!/usr/bin/env node
/**
 * Live smoke test. Makes a handful of real requests through the full stack,
 * including the real throttle, so expect it to take a little under a minute.
 *
 *   npm run smoke
 */
import { config } from '../src/config.js';
import { Store } from '../src/db.js';
import { Throttle } from '../src/throttle.js';
import { HttpClient } from '../src/http.js';
import { TradingView } from '../src/tradingview.js';
import { createTools } from '../src/tools.js';

const cfg = { ...config, dbPath: process.env.IF_DB_PATH || ':memory:' };
const store = new Store(cfg.dbPath);
const throttle = new Throttle(cfg, { countToday: () => store.countRequestsToday() });
const http = new HttpClient({ config: cfg, throttle, store });
const tv = new TradingView({ config: cfg, http, store });
const tools = createTools({ config: cfg, tv, store, throttle, http });

const started = Date.now();
const step = (msg) => console.log(`\n[${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

await http.warmUp();

step('1. search_scripts query="trend following" script_type=strategies');
const search = await tools.search_scripts({
  query: 'trend following',
  script_type: 'strategies',
});
console.log(`   topic=${search.topic} total=${search.total_available} returned=${search.returned}`);
for (const s of search.items.slice(0, 3)) {
  console.log(`   - ${s.name} | ${s.author} | ${s.script_type} | ${s.likes} likes`);
}

step('2. cache check: identical search should make no request');
const before = store.countRequestsToday();
const again = await tools.search_scripts({ query: 'trend following', script_type: 'strategies' });
console.log(`   from_cache=${again.from_cache} requests_delta=${store.countRequestsToday() - before}`);

step('3. list_editors_picks');
const picks = await tools.list_editors_picks({});
console.log(`   total=${picks.total_available} returned=${picks.returned}`);
console.log(`   - ${picks.items[0]?.name} | ${picks.items[0]?.author}`);

step('4. list_author_scripts username=TraderlifestyleYT');
const author = await tools.list_author_scripts({ username: 'TraderlifestyleYT' });
console.log(`   total=${author.total_available} returned=${author.returned}`);

step('5. get_script_source for the first search hit');
const target = search.items[0];
const src = await tools.get_script_source({ script_id_part: target.script_id_part });
if (src.ok) {
  console.log(`   ${src.name} | pine v${src.pine_version} | ${src.source_chars} chars`);
  console.log(`   head: ${src.source.split('\n').slice(0, 2).join(' / ').slice(0, 120)}`);
} else {
  console.log(`   protected: ${src.reason}`);
}

step('6. get_script_source again (cache, no request)');
const before2 = store.countRequestsToday();
const cached = await tools.get_script_source({ script_id_part: target.script_id_part });
console.log(`   from_cache=${cached.from_cache} requests_delta=${store.countRequestsToday() - before2}`);

step('7. query_corpus offline, source_contains="strategy.entry"');
const corpus = tools.query_corpus({ source_contains: 'strategy.entry', limit: 5 });
console.log(`   matched=${corpus.matched} corpus=${JSON.stringify(corpus.corpus)}`);

step('8. fetch_status');
console.log(JSON.stringify(tools.fetch_status().throttle, null, 2));

step(`DONE in ${((Date.now() - started) / 1000).toFixed(1)}s`);
store.close();
