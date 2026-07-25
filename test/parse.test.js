import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSlugFeed,
  parseAuthorFeed,
  parseFacade,
  slugify,
  detectPineVersion,
  extractIdFromChartUrl,
  snippet,
  toListing,
} from '../src/parse.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

describe('slugify', () => {
  it('turns a topic phrase into a TradingView slug', () => {
    expect(slugify('trend following')).toBe('trend-following');
    expect(slugify('  Order   Blocks  ')).toBe('order-blocks');
    expect(slugify("Elliott's Wave")).toBe('elliotts-wave');
    expect(slugify('RSI/MACD combo')).toBe('rsi-macd-combo');
  });

  it('returns empty for input with nothing usable', () => {
    expect(slugify('   ')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

describe('parseSlugFeed', () => {
  it('parses the general /scripts/ feed', () => {
    const r = parseSlugFeed(load('slug-feed-general.json'));
    expect(r.items).toHaveLength(24);
    expect(r.total).toBe(1000);
    expect(r.has_more).toBe(true);
    expect(r.next_path).toBe('/scripts/page-3/');
  });

  it('normalises an item with the fields needed to fetch source', () => {
    const r = parseSlugFeed(load('slug-feed-general.json'));
    const first = r.items[0];
    expect(first.script_id_part).toMatch(/^PUB;[0-9a-f]{32}$/);
    expect(first.name).toBe('MA ribbon NMF');
    expect(first.author).toBe('norinosuke');
    expect(first.script_type).toBe('indicator');
    expect(first.open_source).toBe(true);
    expect(first.likes).toBe(58);
    expect(first.symbol).toBe('JFX:USDJPY');
    expect(first.interval).toBe('15');
  });

  it('parses the editors-picks feed and flags picks', () => {
    const r = parseSlugFeed(load('slug-feed-editors.json'));
    expect(r.total).toBe(742);
    expect(r.items.every((i) => i.is_picked)).toBe(true);
  });

  it('parses a keyword feed', () => {
    const r = parseSlugFeed(load('slug-feed-scalping.json'));
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.script_id_part)).toBe(true);
  });

  it('throws a clear error on an unexpected shape', () => {
    expect(() => parseSlugFeed({ data: {} })).toThrow(/slug-feed shape/);
  });
});

describe('parseAuthorFeed', () => {
  it('parses the author API envelope', () => {
    const r = parseAuthorFeed(load('author-feed.json'));
    expect(r.total).toBe(8);
    expect(r.page_count).toBe(1);
    expect(r.has_more).toBe(false);
    expect(r.items).toHaveLength(8);
    expect(r.items[0].author).toBe('TraderlifestyleYT');
    expect(r.items[0].script_id_part).toBe('PUB;5bbd9e495f604c3682671a0e8920a188');
    expect(r.items[0].version).toBe('2');
  });

  it('throws on a missing results array', () => {
    expect(() => parseAuthorFeed({ count: 3 })).toThrow(/author-feed shape/);
  });
});

describe('parseFacade', () => {
  it('parses an open-source response', () => {
    const raw = load('facade-open.json');
    const r = parseFacade(raw, { scriptIdPart: 'PUB;abc' });
    expect(r.ok).toBe(true);
    expect(r.pine_version).toBe(6);
    expect(r.script_type).toBe('indicator'); // kind "study" maps to indicator
    expect(r.source).toBe(raw.source);
    expect(r.source_chars).toBe(raw.source.length);
  });

  it('treats a refusal as protected, not as source', () => {
    const r = parseFacade(load('facade-protected.json'), { scriptIdPart: 'PUB;xyz' });
    expect(r.ok).toBe(false);
    expect(r.protected).toBe(true);
    expect(r.reason).toMatch(/not allowed/i);
  });

  it('does not mistake an empty or malformed body for source', () => {
    expect(parseFacade(null).ok).toBe(false);
    expect(parseFacade({}).ok).toBe(false);
    expect(parseFacade({ source: 123 }).ok).toBe(false);
  });
});

describe('detectPineVersion', () => {
  it('reads the version pragma', () => {
    expect(detectPineVersion('//@version=5\nstudy("x")')).toBe(5);
    expect(detectPineVersion('// @version = 6\n')).toBe(6);
    expect(detectPineVersion('no pragma here')).toBe(null);
  });
});

describe('extractIdFromChartUrl', () => {
  it('pulls the short slug out of a chart URL', () => {
    expect(extractIdFromChartUrl('https://www.tradingview.com/script/K0SEi3Ct-TL-PbD/')).toBe(
      'K0SEi3Ct'
    );
    expect(extractIdFromChartUrl('nonsense')).toBe(null);
  });
});

describe('snippet + toListing', () => {
  it('collapses whitespace and truncates', () => {
    expect(snippet('a\n\n  b   c', 100)).toBe('a b c');
    expect(snippet('x'.repeat(500), 10)).toHaveLength(11); // 10 chars plus the ellipsis
  });

  it('keeps listings small by dropping the full description', () => {
    // Built inline rather than read from a fixture: live descriptions run to several
    // thousand characters, but fixture descriptions are truncated for redistribution.
    const item = {
      script_id_part: 'PUB;a',
      name: 'Long Winded Indicator',
      description: 'word '.repeat(2000),
    };
    const listed = toListing(item, 300);
    expect(item.description.length).toBeGreaterThan(1000);
    expect(listed.description_snippet.length).toBeLessThanOrEqual(301);
    expect(listed).not.toHaveProperty('description');
  });

  it('still produces snippets from real captured payloads', () => {
    const r = parseSlugFeed(load('slug-feed-general.json'));
    const listed = toListing(r.items[0], 300);
    expect(listed.description_snippet.length).toBeGreaterThan(0);
    expect(listed.script_id_part).toMatch(/^PUB;/);
  });
});
