/** Number formatting shared by the two boost pickers. Kept out of the picker
 * kit so that file only exports components. */

/** 12,400 → "12.4K". Metrics ride on top of thumbnails, so they have to fit in
 * a corner chip at every magnitude. */
export function metricLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}

/** Points as the creator should read them: never a rounded-up "0.0", never
 * more precision than the number deserves. */
export function pointsLabel(points: number): string {
  if (points <= 0) return "0";
  if (points < 0.1) return "<0.1";
  return points.toFixed(points < 10 ? 1 : 0);
}
