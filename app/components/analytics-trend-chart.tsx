// Minimal hand-rolled SVG bar chart -- deliberately not a charting library.
// Phase 7D's trend data is a handful of points (at most ~13 weekly buckets
// for a 90-day period), which a few <rect> elements render perfectly well.

const CHART_HEIGHT = 120;
const BAR_GAP = 6;

export type TrendSeries = {
  label: string;
  colorVar: string;
};

export function StackedTrendChart({
  buckets,
  series,
  values,
}: {
  buckets: string[];
  series: TrendSeries[];
  // One array per series, aligned by index with `buckets`.
  values: number[][];
}) {
  const totals = buckets.map((_, bucketIndex) =>
    values.reduce((sum, seriesValues) => sum + (seriesValues[bucketIndex] ?? 0), 0),
  );
  const maxTotal = Math.max(1, ...totals);
  const barWidth = buckets.length > 0 ? 100 / buckets.length : 100;

  return (
    <div>
      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="h-32 w-full"
        role="img"
        aria-label={`${series.map((entry) => entry.label).join(" and ")} by period`}
      >
        {buckets.map((bucket, bucketIndex) => {
          const total = totals[bucketIndex];
          let stackedHeight = 0;

          return (
            <g key={bucket}>
              {series.map((entry, seriesIndex) => {
                const value = values[seriesIndex]?.[bucketIndex] ?? 0;
                const barHeight = maxTotal === 0 ? 0 : (value / maxTotal) * (CHART_HEIGHT - 4);
                const y = CHART_HEIGHT - stackedHeight - barHeight;

                stackedHeight += barHeight;

                return (
                  <rect
                    key={entry.label}
                    data-testid={`trend-bar-${entry.label.toLowerCase().replace(/\s+/g, "-")}-${bucket}`}
                    x={bucketIndex * barWidth + BAR_GAP / 4}
                    y={y}
                    width={Math.max(0, barWidth - BAR_GAP / 2)}
                    height={barHeight}
                    fill={entry.colorVar}
                  />
                );
              })}
              <title>
                {bucket}: {total}
              </title>
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-4 text-xs text-stone">
        {series.map((entry) => (
          <span key={entry.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5"
              style={{ backgroundColor: entry.colorVar }}
              aria-hidden="true"
            />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  );
}
