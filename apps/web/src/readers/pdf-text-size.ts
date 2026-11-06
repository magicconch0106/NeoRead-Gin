type TextItem = { str: string; transform: number[] };

/** Dominant body size in CSS pixels at 100%, weighted by text length. */
export function pdfBodyTextSize(
  pages: { items: unknown[]; userUnit: number }[],
): number | undefined {
  const weights = new Map<number, number>();
  for (const page of pages) {
    for (const value of page.items) {
      const item = value as Partial<TextItem>;
      if (typeof item.str !== "string" || !Array.isArray(item.transform))
        continue;
      const length = item.str.replace(/\s/g, "").length;
      const size =
        Math.hypot(item.transform[2], item.transform[3]) * page.userUnit;
      if (!length || !Number.isFinite(size) || size <= 0) continue;
      const bucket = Math.round(size * 10) / 10;
      weights.set(bucket, (weights.get(bucket) ?? 0) + length);
    }
  }
  let body: number | undefined,
    weight = 0;
  for (const [size, count] of weights) {
    if (count > weight) {
      body = size;
      weight = count;
    }
  }
  return body === undefined ? undefined : body * (96 / 72);
}
