import { Standings } from "./api";

/** The NFC South at a glance, above the schedule.
 *
 * Four equal columns rather than a table: the whole point is that it stays
 * readable on a phone, and a table's header row costs more than it explains
 * for four rows of two numbers.
 */
/** The strip's placeholder, held while standings are in flight.
 *
 * It reuses the real component's classes rather than guessing at a height, so
 * the box it holds is the box the data lands in and nothing below it moves.
 * Kept next to the strip itself so the two can't drift apart.
 */
export function DivisionStripSkeleton() {
  return (
    <section className="division" aria-hidden="true">
      <div className="division-head">
        <span className="skeleton ph ph-division-title" />
        <span className="skeleton ph ph-division-season" />
      </div>
      <ol className="division-teams">
        {Array.from({ length: 4 }).map((_, i) => (
          <li className="division-team" key={i}>
            <span className="skeleton ph ph-division-logo" />
            <span className="skeleton ph ph-division-abbr" />
            <span className="skeleton ph ph-division-record" />
            <span className="skeleton ph ph-division-streak" />
          </li>
        ))}
      </ol>
    </section>
  );
}

export function DivisionStrip({ standings }: { standings: Standings }) {
  if (standings.division.length === 0) return null;

  return (
    <section className="division" aria-label="NFC South standings">
      <div className="division-head">
        <span className="division-title">NFC South</span>
        <span className="division-season">
          {standings.final
            ? `${standings.season} final`
            : standings.preseason
              ? `${standings.season} · preseason`
              : standings.season}
        </span>
      </div>
      <ol className="division-teams">
        {standings.division.map((team) => (
          <li
            key={team.abbreviation}
            className={`division-team${team.panthers ? " is-panthers" : ""}`}
          >
            {team.logo && (
              <img
                className="division-logo"
                src={team.logo}
                alt=""
                loading="lazy"
              />
            )}
            <span className="division-abbr">{team.abbreviation}</span>
            <span className="division-record">{team.record}</span>
            {team.streak && (
              <span className="division-streak">{team.streak}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
