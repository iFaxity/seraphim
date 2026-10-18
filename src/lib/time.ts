/**
 * Time contract over Temporal (stage 4, unflagged in Node 26): one clock read, one schema-edge
 * conversion, one formatter. `Date` and bare epoch `number`s never leave this module;
 * instants are the platform's own `Temporal.Instant`, never an alias of ours.
 */

/** The only clock read in the kernel, so a future injected clock replaces one function. */
export function now() {
  return Temporal.Now.instant();
}

/** The receipt boundary: receipts persist a plain epoch-ms JSON number, memory holds Instant. */
export function fromEpochMs(epochMs: number) {
  return Temporal.Instant.fromEpochMilliseconds(epochMs);
}

/** Mirror of `fromEpochMs` — the write side of the receipt boundary. */
export function toEpochMs(instant: Temporal.Instant) {
  return instant.epochMilliseconds;
}

/**
 * The one formatter: `Intl.DateTimeFormat` configured at this contract instead of ad hoc at every
 * render site. Presentation-only — records and comparisons stay instants and epoch numbers.
 */
export function formatInstant(
  instant: Temporal.Instant,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
) {
  return new Intl.DateTimeFormat(locale, options).format(instant);
}
