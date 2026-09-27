/**
 * Time seam over Temporal (stage 4, unflagged in Node 26): one clock read, one schema-edge
 * conversion, one formatter. `Date` and bare epoch `number`s never leave this module.
 */
export type Instant = Temporal.Instant;

/** The only clock read in the kernel, so a future injected clock replaces one function. */
export function now(): Instant {
  return Temporal.Now.instant();
}

/** The receipt boundary: receipts persist a plain epoch-ms JSON number, memory holds Instant. */
export function fromEpochMs(epochMs: number): Instant {
  return Temporal.Instant.fromEpochMilliseconds(epochMs);
}

/** Mirror of `fromEpochMs` — the write side of the receipt boundary. */
export function toEpochMs(instant: Instant): number {
  return instant.epochMilliseconds;
}

/**
 * The one formatter: `Intl.DateTimeFormat` configured at this seam instead of ad hoc at every
 * render site. Presentation-only — records and comparisons stay instants and epoch numbers.
 */
export function formatInstant(
  instant: Instant,
  options?: Intl.DateTimeFormatOptions,
  locale?: string,
) {
  return new Intl.DateTimeFormat(locale, options).format(instant);
}
