/**
 * The placeholder sentinel, in its own module.
 *
 * `index.ts` re-exports `tickers.ts` while `tickers.ts` needs this constant. If
 * the sentinel lived in `index.ts` that would be a circular import whose
 * resolution depends on which module the bundler happens to load first — and the
 * failure mode is `UNSET === undefined`, which would make every unset ticker
 * mint look configured. Keeping it here removes the cycle entirely.
 */
export const UNSET = "SET_ME" as const;
