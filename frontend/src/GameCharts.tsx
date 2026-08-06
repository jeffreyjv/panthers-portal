import { useEffect, useMemo, useRef, useState } from "react";
import {
  Drive,
  LiveTeam,
  QUARTER_SECONDS,
  StatPair,
  WinProbPoint,
  periodClock,
  periodLabel,
} from "./api";

/** Measures the element the chart will be drawn into.
 *
 * The charts render at real pixel coordinates rather than in a scaled viewBox:
 * a viewBox stretched to fit would scale the type down with the chart, so axis
 * labels end up unreadable on a phone and hairlines stop being hairlines.
 */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

/** Identity for the two sides, present on every chart carrying both.
 *
 * Colour alone is never the only channel: this box is the dependable one, and
 * the charts add direct labels on top of it.
 */
function VizLegend({
  panthers,
  opponent,
}: {
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  return (
    <ul className="viz-legend">
      <li>
        <span className="viz-swatch is-car" aria-hidden="true" />
        {panthers.short_name}
      </li>
      <li>
        <span className="viz-swatch is-opp" aria-hidden="true" />
        {opponent.short_name}
      </li>
    </ul>
  );
}

/** A chart's table twin, so no value is reachable only by hovering. */
function TableView({
  summary,
  children,
}: {
  summary: string;
  children: React.ReactNode;
}) {
  return (
    <details className="viz-table">
      <summary>{summary}</summary>
      <div className="viz-table-scroll">{children}</div>
    </details>
  );
}

// --- Win probability ---------------------------------------------------------
const WP_PAD = { top: 14, right: 46, bottom: 22, left: 36 };
const WP_HEIGHT = 232;

/** Carolina's win probability across the game.
 *
 * The fill diverges around the 50% line — blue where Carolina is favoured,
 * the opponent's colour where they aren't — because that midline is what a
 * reader is actually measuring against. The line itself stays one colour: it is
 * one series, Carolina's chances, not two.
 */
export function WinProbabilityChart({
  points,
  panthers,
  opponent,
}: {
  points: WinProbPoint[];
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [cursor, setCursor] = useState<number | null>(null);

  const plotWidth = Math.max(width - WP_PAD.left - WP_PAD.right, 10);
  const plotHeight = WP_HEIGHT - WP_PAD.top - WP_PAD.bottom;

  // Regulation always fills the axis, so a game in the first quarter doesn't
  // stretch six minutes of football across the full width and then have to
  // rescale on every refresh.
  const lastElapsed = points.length ? points[points.length - 1].elapsed : 0;
  const span = Math.max(4 * QUARTER_SECONDS, lastElapsed);
  const periods = Math.max(4, Math.ceil(span / QUARTER_SECONDS));

  const x = (elapsed: number) => WP_PAD.left + (elapsed / span) * plotWidth;
  const y = (pct: number) => WP_PAD.top + (1 - pct) * plotHeight;
  const midline = y(0.5);

  const geometry = useMemo(() => {
    if (points.length < 2 || width === 0) return null;

    const line = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.elapsed)} ${y(p.panthers_pct)}`)
      .join(" ");
    const area =
      `${line} L${x(lastElapsed)} ${midline} L${x(points[0].elapsed)} ${midline} Z`;

    return { line, area };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, width]);

  if (points.length < 2) return null;

  const active = cursor === null ? null : points[cursor];
  const latest = points[points.length - 1];
  const latestPct = Math.round(latest.panthers_pct * 100);

  /** Nearest point to a pointer position, so the hit target is the whole plot
   *  rather than the 2px line. */
  const pick = (clientX: number) => {
    const element = ref.current;
    if (!element) return;
    const bounds = element.getBoundingClientRect();
    const elapsed =
      ((clientX - bounds.left - WP_PAD.left) / plotWidth) * span;

    let best = 0;
    for (let i = 1; i < points.length; i += 1) {
      if (
        Math.abs(points[i].elapsed - elapsed) <
        Math.abs(points[best].elapsed - elapsed)
      ) {
        best = i;
      }
    }
    setCursor(best);
  };

  return (
    <section className="viz" aria-labelledby="wp-title">
      <div className="viz-head">
        <h3 className="viz-title" id="wp-title">
          Win probability
        </h3>
        <span className="viz-note">
          {panthers.short_name} {latestPct}% · ESPN model
        </span>
      </div>

      <div
        className="viz-plot"
        ref={ref}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerLeave={() => setCursor(null)}
      >
        {width > 0 && geometry && (
          <svg
            width={width}
            height={WP_HEIGHT}
            role="img"
            aria-label={`${panthers.short_name} win probability over the course of the game, currently ${latestPct} percent`}
            tabIndex={0}
            onKeyDown={(e) => {
              const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
              if (!step) return;
              e.preventDefault();
              setCursor((c) =>
                Math.min(
                  points.length - 1,
                  Math.max(0, (c === null ? points.length - 1 : c) + step),
                ),
              );
            }}
            onBlur={() => setCursor(null)}
          >
            <defs>
              {/* Splitting the one area at the midline is what makes the fill
                  say "which side of even" instead of just "how much". */}
              <clipPath id="wp-above">
                <rect
                  x={WP_PAD.left}
                  y={WP_PAD.top}
                  width={plotWidth}
                  height={midline - WP_PAD.top}
                />
              </clipPath>
              <clipPath id="wp-below">
                <rect
                  x={WP_PAD.left}
                  y={midline}
                  width={plotWidth}
                  height={WP_PAD.top + plotHeight - midline}
                />
              </clipPath>
            </defs>

            {/* Quarter bands, labelled in the middle of the band they name. */}
            {Array.from({ length: periods }).map((_, i) => {
              const boundary = (i + 1) * QUARTER_SECONDS;
              const centre = x(Math.min(boundary - QUARTER_SECONDS / 2, span));
              return (
                <g key={i}>
                  {i + 1 < periods && (
                    <line
                      className="viz-grid"
                      x1={x(boundary)}
                      x2={x(boundary)}
                      y1={WP_PAD.top}
                      y2={WP_PAD.top + plotHeight}
                    />
                  )}
                  <text
                    className="viz-tick"
                    x={centre}
                    y={WP_HEIGHT - 6}
                    textAnchor="middle"
                  >
                    {periodLabel(i + 1)}
                  </text>
                </g>
              );
            })}

            {[0, 0.5, 1].map((pct) => (
              <text
                key={pct}
                className="viz-tick"
                x={WP_PAD.left - 7}
                y={y(pct) + 3.5}
                textAnchor="end"
              >
                {pct * 100}%
              </text>
            ))}

            <path className="viz-area is-car" d={geometry.area} clipPath="url(#wp-above)" />
            <path className="viz-area is-opp" d={geometry.area} clipPath="url(#wp-below)" />

            {/* Drawn over the fills: even is the reference, so it has to stay
                visible where the area crosses it. */}
            <line
              className="viz-baseline"
              x1={WP_PAD.left}
              x2={WP_PAD.left + plotWidth}
              y1={midline}
              y2={midline}
            />

            <path className="viz-line is-car" d={geometry.line} />

            {active && (
              <g className="viz-cursor">
                <line
                  x1={x(active.elapsed)}
                  x2={x(active.elapsed)}
                  y1={WP_PAD.top}
                  y2={WP_PAD.top + plotHeight}
                />
                <circle
                  className="viz-dot is-car"
                  cx={x(active.elapsed)}
                  cy={y(active.panthers_pct)}
                  r={4.5}
                />
              </g>
            )}

            <circle
              className="viz-dot is-car"
              cx={x(latest.elapsed)}
              cy={y(latest.panthers_pct)}
              r={4.5}
            />
            {/* The one direct label the chart earns: where it ended up. */}
            <text
              className="viz-end-label"
              x={x(latest.elapsed) + 9}
              y={y(latest.panthers_pct) + 4}
            >
              {latestPct}%
            </text>
          </svg>
        )}

        {active && (
          <div
            className="viz-tooltip"
            style={{
              left: `${x(active.elapsed)}px`,
              // Flips to the left of the crosshair past the midpoint so it never
              // runs off the right edge.
              transform:
                x(active.elapsed) > WP_PAD.left + plotWidth / 2
                  ? "translate(-100%, 0)"
                  : "none",
            }}
          >
            <span className="viz-tooltip-when">
              {periodClock(active.elapsed, active.period)}
            </span>
            <span>
              <span className="viz-swatch is-car" aria-hidden="true" />
              {panthers.short_name} {Math.round(active.panthers_pct * 100)}%
            </span>
            <span>
              <span className="viz-swatch is-opp" aria-hidden="true" />
              {opponent.short_name} {100 - Math.round(active.panthers_pct * 100)}%
            </span>
          </div>
        )}
      </div>

      <VizLegend panthers={panthers} opponent={opponent} />

      <TableView summary="Win probability by quarter">
        <table className="viz-data">
          <thead>
            <tr>
              <th scope="col">Through</th>
              <th scope="col">{panthers.short_name}</th>
              <th scope="col">{opponent.short_name}</th>
            </tr>
          </thead>
          <tbody>
            {quarterEnds(points).map((point) => (
              <tr key={point.period}>
                <th scope="row">{periodLabel(point.period)}</th>
                <td>{Math.round(point.panthers_pct * 100)}%</td>
                <td>{100 - Math.round(point.panthers_pct * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableView>
    </section>
  );
}

/** The last reading in each period — 168 rows is not a table anyone reads. */
function quarterEnds(points: WinProbPoint[]): WinProbPoint[] {
  const byPeriod = new Map<number, WinProbPoint>();
  for (const point of points) byPeriod.set(point.period, point);
  return [...byPeriod.values()].sort((a, b) => a.period - b.period);
}

// --- Team stat comparison ----------------------------------------------------
/** The two sides' numbers, mirrored around their label.
 *
 * Each row is scaled to its own pair, since yards and turnovers share no scale.
 * Every value is printed at the bar's tip, so the bars are a way to see the gap
 * at a glance rather than the only way to read the number.
 */
export function StatComparison({
  stats,
  panthers,
  opponent,
}: {
  stats: StatPair[];
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  if (stats.length === 0) return null;

  return (
    <section className="viz" aria-labelledby="stats-title">
      <div className="viz-head">
        <h3 className="viz-title" id="stats-title">
          Team stats
        </h3>
        <span className="viz-note">
          {panthers.abbreviation} vs {opponent.abbreviation}
        </span>
      </div>

      <VizLegend panthers={panthers} opponent={opponent} />

      <ul className="statbars">
        {stats.map((stat) => {
          const ours = stat.panthers_value ?? 0;
          const theirs = stat.opponent_value ?? 0;
          // A row where neither side has anything yet keeps its label and its
          // zeroes rather than dividing by nothing.
          const scale = Math.max(ours, theirs) || 1;

          return (
            <li className="statbar" key={stat.key}>
              <span className="statbar-value is-car">{stat.panthers_display ?? "—"}</span>
              <span className="statbar-track is-car">
                <span
                  className="statbar-fill is-car"
                  style={{ width: `${(ours / scale) * 100}%` }}
                />
              </span>
              <span className="statbar-label">{stat.label}</span>
              <span className="statbar-track is-opp">
                <span
                  className="statbar-fill is-opp"
                  style={{ width: `${(theirs / scale) * 100}%` }}
                />
              </span>
              <span className="statbar-value is-opp">{stat.opponent_display ?? "—"}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// --- Drive chart -------------------------------------------------------------
/** Every drive as a span of field, Carolina attacking left to right.
 *
 * The backend has already put both yard lines on Carolina's scale, so Carolina's
 * drives run rightward and the opponent's leftward on the same field, every week,
 * whoever is hosting. A drive is a range rather than a magnitude — both ends are
 * data — which is why both ends are rounded.
 */
export function DriveChart({
  drives,
  panthers,
  opponent,
}: {
  drives: Drive[];
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  const plotted = drives.filter(
    (d) => d.start_yard !== null && d.end_yard !== null,
  );
  if (plotted.length === 0) return null;

  return (
    <section className="viz" aria-labelledby="drives-title">
      <div className="viz-head">
        <h3 className="viz-title" id="drives-title">
          Drive chart
        </h3>
        {/* The ring is the only encoding on this chart that isn't self-evident,
            so it gets named rather than left to be worked out. */}
        <span className="viz-note">
          {plotted.length} drives · ringed = scoring drive
        </span>
      </div>

      <VizLegend panthers={panthers} opponent={opponent} />

      <div className="drivechart">
        <div className="drivechart-axis" aria-hidden="true">
          <span className="drivechart-cell" />
          <span className="drivechart-scale">
            <span>{panthers.abbreviation}</span>
            <span>25</span>
            <span>50</span>
            <span>25</span>
            <span>{opponent.abbreviation}</span>
          </span>
          <span className="drivechart-cell" />
        </div>

        <ol className="drivechart-rows">
          {/* One underlay carries the yard lines for every row, instead of each
              row drawing its own. */}
          <span className="drivechart-grid" aria-hidden="true" />

          {plotted.map((drive) => {
            const start = drive.start_yard as number;
            const end = drive.end_yard as number;
            const left = Math.min(start, end);
            const width = Math.abs(end - start);
            const label = driveLabel(drive);

            return (
              <li className="driverow" key={drive.id}>
                <span className="driverow-period">
                  {drive.period ? periodLabel(drive.period) : ""}
                </span>
                <span className="driverow-track">
                  <span
                    className={`driverow-bar ${drive.panthers ? "is-car" : "is-opp"}${
                      drive.is_score ? " is-score" : ""
                    }`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={label}
                  />
                </span>
                <span className="driverow-result" title={label}>
                  {drive.result ?? ""}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      <TableView summary="Drive log">
        <table className="viz-data">
          <thead>
            <tr>
              <th scope="col">Qtr</th>
              <th scope="col">Team</th>
              <th scope="col">Start</th>
              <th scope="col">End</th>
              <th scope="col">Plays</th>
              <th scope="col">Yards</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {plotted.map((drive) => (
              <tr key={drive.id}>
                <td>{drive.period ? periodLabel(drive.period) : "—"}</td>
                <td>
                  <span
                    className={`viz-swatch ${drive.panthers ? "is-car" : "is-opp"}`}
                    aria-hidden="true"
                  />
                  {drive.team_abbr ?? "—"}
                </td>
                <td>{drive.start_text ?? "—"}</td>
                <td>{drive.end_text ?? "—"}</td>
                <td>{drive.plays ?? "—"}</td>
                <td>{drive.yards ?? "—"}</td>
                <td>{drive.result ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableView>
    </section>
  );
}

/** What a drive's hover text says, skipping the parts ESPN left out. */
function driveLabel(drive: Drive): string {
  const parts = [
    drive.team_abbr,
    drive.start_text && drive.end_text
      ? `${drive.start_text} → ${drive.end_text}`
      : null,
    drive.description,
    drive.result,
  ];
  return parts.filter(Boolean).join(" · ");
}

// --- Field position (live only) ----------------------------------------------
/** Where the ball is right now, on the same field the drive chart uses. */
export function FieldPosition({
  yardsToEndzone,
  panthersHaveBall,
  panthers,
  opponent,
}: {
  yardsToEndzone: number;
  panthersHaveBall: boolean;
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  // Carolina attacks 100; the opponent attacks 0. Same convention as the drives.
  const spot = panthersHaveBall ? 100 - yardsToEndzone : yardsToEndzone;

  return (
    <div className="fieldpos">
      <span className="fieldpos-end">{panthers.abbreviation}</span>
      <span className="fieldpos-track">
        <span className="fieldpos-grid" aria-hidden="true" />
        <span
          className={`fieldpos-ball ${panthersHaveBall ? "is-car" : "is-opp"}`}
          style={{ left: `${spot}%` }}
          title={`${yardsToEndzone} yards from the end zone`}
        />
      </span>
      <span className="fieldpos-end">{opponent.abbreviation}</span>
    </div>
  );
}
