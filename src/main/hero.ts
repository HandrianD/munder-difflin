/**
 * Fetch + cache the Settings hero payload.
 *
 * Same shape as the skills catalog: served from cache when fresh, refreshed in
 * the background otherwise, and NEVER fatal — a failed fetch falls back to the
 * cached copy, then to the defaults compiled into the app. The card must render
 * instantly and offline, because it sits at the top of a dialog people open to
 * change a folder.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseHeroPayload, DEFAULT_HERO, type HeroPayload } from '../shared/heroPayload';
// PRIVATE FORK — the hero payload is compiled in, not fetched. The old build
// pulled docs/hero.json from the upstream repo over raw.githubusercontent.com
// every TTL; a private build has no business contacting that host at all. Vite
// inlines this at build time, so the card renders offline with zero requests.
import bundledHero from '../../docs/hero.json';

/**
 * Disabled on purpose: no remote hero payload in a private build.
 * `loadHero` now serves the bundled copy (or a previously cached one) and never
 * opens a socket. Kept as an explicit null rather than deleted so the TTL/cache
 * path below stays readable and the intent is greppable.
 */
const HERO_URL: string | null = null;
/** Plan copy and sponsors change on a human timescale. */
const TTL_MS = 6 * 60 * 60 * 1000;

export async function loadHero(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<{ hero: HeroPayload; fetchedAt: number; stale: boolean }> {
  let cached: { hero: HeroPayload; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) cached = JSON.parse(readFileSync(cachePath, 'utf8'));
  } catch { cached = null; }

  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: false };
  }

  // No network path: prefer the cached copy when it validates, else the payload
  // compiled into this build. Same degradation ladder the fetch path had minus
  // the fetch — never fatal, never a socket.
  try {
    const bundled = parseHeroPayload(bundledHero);
    if (bundled) return { hero: bundled, fetchedAt: cached?.fetchedAt ?? 0, stale: cached == null };
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true };
  } catch {
    if (cached) return { hero: cached.hero, fetchedAt: cached.fetchedAt, stale: true };
    return { hero: DEFAULT_HERO, fetchedAt: 0, stale: true };
  }
}
