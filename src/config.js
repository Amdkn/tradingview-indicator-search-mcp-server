/**
 * Central configuration. Every knob is env-overridable; defaults are deliberately
 * conservative because the failure mode we care about is an IP ban, not slowness.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  root: ROOT,
  dbPath: process.env.IF_DB_PATH || path.join(ROOT, 'data', 'indicator_fetch.db'),

  // Pacing between consecutive requests. Randomised inside this window on every
  // request: a fixed interval is the single clearest bot signature there is.
  minDelayMs: num('IF_MIN_DELAY_MS', 1500),
  maxDelayMs: num('IF_MAX_DELAY_MS', 4500),

  // Periodic longer pause, imitating a person who stops to read something.
  breakEvery: num('IF_BREAK_EVERY', 25),
  breakMinMs: num('IF_BREAK_MIN_MS', 20_000),
  breakMaxMs: num('IF_BREAK_MAX_MS', 60_000),

  // Hard ceiling on requests per rolling calendar day (UTC), across all sessions.
  dailyBudget: num('IF_DAILY_BUDGET', 2000),

  // Retry/backoff for transient failures.
  maxRetries: num('IF_MAX_RETRIES', 4),
  backoffBaseMs: num('IF_BACKOFF_BASE_MS', 2000),
  backoffMaxMs: num('IF_BACKOFF_MAX_MS', 60_000),

  // Circuit breaker: consecutive 429/403 responses before we stop entirely.
  breakerThreshold: num('IF_BREAKER_THRESHOLD', 3),
  breakerCooldownMs: num('IF_BREAKER_COOLDOWN_MS', 15 * 60 * 1000),

  requestTimeoutMs: num('IF_REQUEST_TIMEOUT_MS', 30_000),

  // Listings drift, so they expire. Sources are immutable per version and never do.
  listingTtlMs: num('IF_LISTING_TTL_MS', 6 * 60 * 60 * 1000),

  // Harvest guardrails.
  harvestMaxScripts: num('IF_HARVEST_MAX', 200),
  harvestTimeBudgetMs: num('IF_HARVEST_TIME_BUDGET_MS', 120_000),

  // Descriptions run to several thousand characters. Listings return a snippet so a
  // single 24-item page cannot blow up an agent's context window.
  snippetChars: num('IF_SNIPPET_CHARS', 300),

  // Cookie jar refresh interval. Real browsers carry cookies; sending none is itself
  // anomalous, so we warm up against the site and reuse the jar.
  cookieMaxAgeMs: num('IF_COOKIE_MAX_AGE_MS', 12 * 60 * 60 * 1000),
};

export const TV_ORIGIN = 'https://www.tradingview.com';
export const FACADE_ORIGIN = 'https://pine-facade.tradingview.com';
