# Test fixtures

Real responses captured from the public TradingView endpoints this server uses. They
let the parsers be tested against the actual API shape with no network access.

## Redaction

These are **not** byte-for-byte copies. Two categories of third-party creative work
were removed before committing, because this is a public repository:

| Field | Treatment |
|---|---|
| `description` (listing feeds) | Truncated to 200 characters |
| `source` (`facade-open.json`) | Replaced with a short synthetic Pine v6 study |

Everything structural is untouched: envelope shape, key names, nesting, pagination
fields, `script_id_part` / `version` pairs, access codes, counts, symbols and
timestamps. That is what the parsers are actually tested against.

Script names and author usernames are kept. They are factual identifiers, and the
whole point of the server is to reference public scripts by name and author.

## Files

| File | Endpoint |
|---|---|
| `slug-feed-general.json` | `/scripts/page-2/?component-data-only=1` |
| `slug-feed-scalping.json` | `/scripts/scalping/page-2/?component-data-only=1` |
| `slug-feed-editors.json` | `/scripts/editors-picks/page-2/?component-data-only=1` |
| `author-feed.json` | `/api/v1/scripts/?by=<user>&page=1&per_page=24` |
| `facade-open.json` | `pine-facade/get/<id>/<version>`, open source |
| `facade-protected.json` | `pine-facade/get/<id>/<version>`, refused |

Tests must not assert on redacted content. Assert against
`fixture.source.length` rather than a hard-coded character count, and build long
strings inline when testing truncation.
