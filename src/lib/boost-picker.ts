/** Number formatting shared by the two boost pickers. Kept out of the picker
 * kit so that file only exports components. Points formatting lives with the
 * points model in health-score.ts — see `pointsLabel` there. */

/** 12,400 → "12.4K". Metrics ride on top of thumbnails, so they have to fit in
 * a corner chip at every magnitude. */
export function metricLabel(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}
