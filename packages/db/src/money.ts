/**
 * Nanodollars cross the database boundary as decimal strings in `numeric(38,0)`
 * columns. These two functions are the only place that conversion happens.
 */

export function toNanosColumn(value: bigint): string {
  return value.toString(10);
}

export function fromNanosColumn(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  const text = typeof value === "number" ? Math.trunc(value).toString(10) : value.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`nanos column did not contain an integer: ${text}`);
  }
  return BigInt(text);
}
