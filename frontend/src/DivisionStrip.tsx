import { Standings } from "./api";

/** The NFC South at a glance, above the schedule.
 *
 * Four equal columns rather than a table: the whole point is that it stays
 * readable on a phone, and a table's header row costs more than it explains
 * for four rows of two numbers.
 */
export function DivisionStrip({ standings }: { standings: Standings }) {
  if (standings.division.length === 0) return null;

  return (
    <section className="division" aria-label="NFC South standings">
      <div className="division-head">
        <span className="division-title">NFC South</span>
        <span className="division-season">
          {standings.final ? `${standings.season} final` : standings.season}
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
