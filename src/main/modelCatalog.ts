/**
 * Load the model catalog — bundled, never fetched.
 *
 * Same shape as the hero payload: a cached copy wins when fresh, otherwise the
 * catalog compiled into this build. NEVER fatal.
 *
 * PRIVATE FORK: the old build polled docs/model-catalog.json on
 * raw.githubusercontent.com (upstream) every TTL so a model could ship without a
 * release. A private build has no business contacting that host, so the JSON is
 * inlined at build time instead — same data, zero sockets. The cache read stays
 * because an older install may still have a file on disk and it costs nothing to
 * prefer it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parseModelCatalog, type ModelCatalog } from '../shared/modelCatalogPayload';
// Inlined by Vite at build time — see the note above.
import bundledCatalog from '../../docs/model-catalog.json';

/** Disabled on purpose: no remote catalog in a private build. Greppable. */
const CATALOG_URL: string | null = null;

/** Models ship on a human timescale, and a stale list costs the user nothing —
 *  every command field in the app stays editable. Six hours matches the hero
 *  payload; a launch after that refreshes from the bundled copy. */
const TTL_MS = 6 * 60 * 60 * 1000;

export interface RemoteCatalogResult {
  /** null = nothing usable came back; the caller keeps its baked catalog. */
  catalog: ModelCatalog | null;
  /** 0 when nothing has ever been fetched. */
  fetchedAt: number;
  /** True when this is a cached or absent copy rather than a fresh one. */
  stale: boolean;
}

export async function loadModelCatalog(
  cachePath: string,
  opts: { force?: boolean } = {}
): Promise<RemoteCatalogResult> {
  let cached: { catalog: ModelCatalog; fetchedAt: number } | null = null;
  try {
    if (existsSync(cachePath)) {
      const read = JSON.parse(readFileSync(cachePath, 'utf8'));
      // Re-validate on READ, not only on load. The cache is a file on disk that
      // a previous build wrote; a schema bump or a hand-edit must not reach the
      // pickers unchecked just because it once passed.
      const catalog = parseModelCatalog(read?.catalog);
      if (catalog && typeof read.fetchedAt === 'number') {
        cached = { catalog, fetchedAt: read.fetchedAt };
      }
    }
  } catch { cached = null; }

  if (cached && !opts.force && Date.now() - cached.fetchedAt < TTL_MS) {
    return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: false };
  }

  // No network path: the cached copy when it validates, else the catalog
  // compiled into this build. Same degradation ladder minus the fetch.
  try {
    const catalog = parseModelCatalog(bundledCatalog);
    if (catalog) return { catalog, fetchedAt: cached?.fetchedAt ?? 0, stale: cached == null };
    if (cached) return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: true };
    return { catalog: null, fetchedAt: 0, stale: true };
  } catch {
    if (cached) return { catalog: cached.catalog, fetchedAt: cached.fetchedAt, stale: true };
    return { catalog: null, fetchedAt: 0, stale: true };
  }
}
