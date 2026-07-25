# Notice

## Trademarks and affiliation

This project is **not affiliated with, endorsed by, or sponsored by TradingView**.
TradingView and Pine Script are trademarks of their respective owners. The name is
used only to describe what this software interoperates with.

## Third-party content

This software retrieves publicly available content from TradingView. Two things
follow from that:

**Pine Script you collect is not yours.** Indicators and strategies published on
TradingView remain the copyright of their original authors, even when the source is
publicly readable. Read, learn from and adapt them as the author's terms allow, and
credit them if you publish anything derived from their work. This tool does not grant
you any licence to that code.

**Test fixtures here are redacted.** `test/fixtures/` contains real captured API
responses so the parsers can be tested offline, but author-written descriptions are
truncated to 200 characters and the Pine source in `facade-open.json` was replaced
with a synthetic script. No third-party script is redistributed in this repository in
full. See [`test/fixtures/README.md`](test/fixtures/README.md).

## Responsible use

The rate limiting in this server is deliberately conservative and exists so that
normal use stays well within what a human browsing the site would generate. Please do
not remove it, raise the limits aggressively, or run this from datacenter
infrastructure. You are responsible for your own compliance with TradingView's Terms
of Service.
