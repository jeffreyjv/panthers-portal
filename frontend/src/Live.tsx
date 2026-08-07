import {
  GameLeader,
  LiveGame,
  LiveTeam,
  ScoringPlay,
  gameDate,
  gameTime,
  periodLabel,
  relativeTime,
} from "./api";
import { ClawMark } from "./ClawMark";
import {
  DriveChart,
  FieldPosition,
  StatComparison,
  WinProbabilityChart,
} from "./GameCharts";
import { useLive } from "./liveStore";

/** The clock, phrased the way the state calls for. */
function StatusBadge({ game }: { game: LiveGame }) {
  if (game.state === "in") {
    return (
      <span className="live-status is-live">
        <span className="live-pulse" aria-hidden="true" />
        {game.clock && game.period
          ? `${game.clock} · ${periodLabel(game.period)}`
          : "Live"}
      </span>
    );
  }

  if (game.state === "post") {
    return <span className="live-status is-final">{game.status_detail ?? "Final"}</span>;
  }

  return (
    <span className="live-status">
      {gameTime(game.kickoff)}
      <small>{gameDate(game.kickoff)}</small>
    </span>
  );
}

function TeamRow({ team, leading }: { team: LiveTeam; leading: boolean }) {
  return (
    <div className={`live-team${team.panthers ? " is-car" : ""}`}>
      {team.logo && <img className="live-team-logo" src={team.logo} alt="" />}
      <span className="live-team-name">
        {team.short_name}
        {team.record && <small>{team.record}</small>}
      </span>
      {/* Dropped entirely before kickoff. A placeholder dash where a score goes
          reads as a number that failed to load. */}
      {team.score !== null && (
        <span className={`live-team-score${leading ? " is-leading" : ""}`}>
          {team.score}
        </span>
      )}
    </div>
  );
}

/** Score, clock, and — while a game is on — where the ball is. */
function Scoreboard({ game }: { game: LiveGame }) {
  const { panthers, opponent, situation } = game;
  const started = game.state !== "pre";
  const ours = panthers.score ?? 0;
  const theirs = opponent.score ?? 0;

  return (
    <section className="live-board" aria-label="Score">
      <div className="live-board-teams">
        <TeamRow team={panthers} leading={started && ours > theirs} />
        <TeamRow team={opponent} leading={started && theirs > ours} />
      </div>

      <div className="live-board-status">
        <StatusBadge game={game} />
        {game.broadcast && <span className="live-network">{game.broadcast}</span>}
      </div>

      {situation && (
        <div className="live-situation">
          <div className="live-situation-head">
            {situation.possession && (
              <span className="live-poss">
                <span
                  className={`viz-swatch ${
                    situation.possession === panthers.abbreviation ? "is-car" : "is-opp"
                  }`}
                  aria-hidden="true"
                />
                {situation.possession} ball
              </span>
            )}
            {situation.down_distance && (
              <span className="live-down">{situation.down_distance}</span>
            )}
            {situation.red_zone && <span className="live-redzone">Red zone</span>}
          </div>

          {situation.yards_to_endzone !== null && situation.possession && (
            <FieldPosition
              yardsToEndzone={situation.yards_to_endzone}
              panthersHaveBall={situation.possession === panthers.abbreviation}
              panthers={panthers}
              opponent={opponent}
            />
          )}

          {situation.last_play && (
            <p className="live-lastplay">
              <span>Last play</span>
              {situation.last_play}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/** Venue, forecast, line — the context around the game, in one strip. */
function GameMeta({ game }: { game: LiveGame }) {
  const place = [game.venue_city, game.venue_state].filter(Boolean).join(", ");
  const facts: [string, string][] = [];

  if (game.venue) facts.push(["Venue", game.venue]);
  if (place) facts.push(["Location", place]);
  if (game.line) facts.push(["Line", game.line]);
  if (game.over_under !== null) facts.push(["Total", String(game.over_under)]);
  if (game.temperature !== null) {
    const forecast =
      game.precipitation !== null
        ? `${game.temperature}°F · ${game.precipitation}% precip`
        : `${game.temperature}°F`;
    facts.push(["Forecast", forecast]);
  }
  if (game.attendance) facts.push(["Attendance", game.attendance.toLocaleString()]);

  if (facts.length === 0) return null;

  return (
    <section className="live-meta" aria-label="Game details">
      {facts.map(([label, value]) => (
        <div className="live-meta-cell" key={label}>
          <span className="live-meta-label">{label}</span>
          <span className="live-meta-value">{value}</span>
        </div>
      ))}
    </section>
  );
}

/** Quarter-by-quarter scoring. A table, because that is what a linescore is. */
function Linescore({ game }: { game: LiveGame }) {
  const { panthers, opponent } = game;
  const periods = Math.max(
    panthers.linescores.length,
    opponent.linescores.length,
    4,
  );
  if (panthers.linescores.length === 0 && opponent.linescores.length === 0) {
    return null;
  }

  const columns = Array.from({ length: periods }, (_, i) => i + 1);

  return (
    <section className="viz" aria-labelledby="linescore-title">
      <div className="viz-head">
        <h3 className="viz-title" id="linescore-title">
          Scoring by quarter
        </h3>
      </div>
      <div className="viz-table-scroll">
        <table className="viz-data linescore">
          <thead>
            <tr>
              <th scope="col">Team</th>
              {columns.map((period) => (
                <th scope="col" key={period}>
                  {periodLabel(period)}
                </th>
              ))}
              <th scope="col">T</th>
            </tr>
          </thead>
          <tbody>
            {[panthers, opponent].map((team) => (
              <tr key={team.id} className={team.panthers ? "is-car" : undefined}>
                <th scope="row">
                  <span
                    className={`viz-swatch ${team.panthers ? "is-car" : "is-opp"}`}
                    aria-hidden="true"
                  />
                  {team.abbreviation}
                </th>
                {columns.map((period) => (
                  <td key={period}>{team.linescores[period - 1] ?? "—"}</td>
                ))}
                <td className="linescore-total">{team.score ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The scoring summary — a log of events, so a list rather than a chart. */
function ScoringSummary({
  plays,
  panthers,
  opponent,
}: {
  plays: ScoringPlay[];
  panthers: LiveTeam;
  opponent: LiveTeam;
}) {
  if (plays.length === 0) return null;

  return (
    <section className="viz" aria-labelledby="scoring-title">
      <div className="viz-head">
        <h3 className="viz-title" id="scoring-title">
          Scoring summary
        </h3>
        <span className="viz-note">{plays.length} scores</span>
      </div>
      <ol className="scorelog">
        {plays.map((play) => (
          <li className={`scorelog-item${play.panthers ? " is-car" : ""}`} key={play.id}>
            <span className="scorelog-when">
              {periodLabel(play.period)}
              <small>{play.clock}</small>
            </span>
            <span className="scorelog-type">{play.type_abbr ?? "—"}</span>
            <span className="scorelog-text">{play.text}</span>
            <span className="scorelog-score">
              <span title={panthers.name}>{play.panthers_score}</span>–
              <span title={opponent.name}>{play.opponent_score}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LeaderCard({ leader }: { leader: GameLeader }) {
  return (
    <li className={`leadercard${leader.panthers ? " is-car" : " is-opp"}`}>
      <span className="leadercard-cat">{leader.category_label}</span>
      <div className="leadercard-who">
        {leader.headshot && (
          <img className="leadercard-shot" src={leader.headshot} alt="" loading="lazy" />
        )}
        <span className="leadercard-name">
          {leader.name}
          <small>
            {[leader.team_abbr, leader.position, leader.jersey && `#${leader.jersey}`]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </span>
      </div>
      <span className="leadercard-stat">{leader.display_value}</span>
    </li>
  );
}

function GameLeaders({ leaders }: { leaders: GameLeader[] }) {
  if (leaders.length === 0) return null;

  return (
    <section className="viz" aria-labelledby="leaders-title">
      <div className="viz-head">
        <h3 className="viz-title" id="leaders-title">
          Game leaders
        </h3>
      </div>
      <ul className="leadergrid">
        {leaders.map((leader) => (
          <LeaderCard key={`${leader.team_abbr}-${leader.category}`} leader={leader} />
        ))}
      </ul>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="live-board game-skeleton">
      <div className="skeleton skeleton-line long" />
      <div className="skeleton skeleton-line long" />
      <div className="skeleton skeleton-line short" />
    </div>
  );
}

export function Live() {
  const { game, status, refreshing } = useLive();

  if (status === "loading") {
    return (
      <>
        <div className="section-head">
          <h2 className="section-title">Live</h2>
          <span className="section-rule" />
        </div>
        <Skeleton />
      </>
    );
  }

  if (status === "error") {
    return (
      <div className="notice">
        <ClawMark className="notice-claw" />
        <h2>Live data unavailable</h2>
        <p>We couldn’t reach the scoreboard. Please try again shortly.</p>
      </div>
    );
  }

  if (!game) {
    return (
      <div className="notice">
        <ClawMark className="notice-claw" />
        <h2>No game scheduled</h2>
        <p>There’s nothing on the calendar right now. Check back next week.</p>
      </div>
    );
  }

  const badge = [game.season_label, game.week ? `Week ${game.week}` : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`live${refreshing ? " is-refreshing" : ""}`}>
      <div className="section-head">
        <h2 className="section-title">
          {game.state === "in" ? "Live" : game.state === "post" ? "Last game" : "Next game"}
        </h2>
        {badge && <span className="section-badge">{badge}</span>}
        <span className="section-rule" />
      </div>

      {game.name && <p className="live-matchup">{game.name}</p>}

      <Scoreboard game={game} />
      <GameMeta game={game} />
      <Linescore game={game} />

      <WinProbabilityChart
        points={game.win_probability}
        panthers={game.panthers}
        opponent={game.opponent}
      />
      <StatComparison
        stats={game.team_stats}
        panthers={game.panthers}
        opponent={game.opponent}
      />
      <DriveChart
        drives={game.drives}
        panthers={game.panthers}
        opponent={game.opponent}
      />
      <ScoringSummary
        plays={game.scoring_plays}
        panthers={game.panthers}
        opponent={game.opponent}
      />
      <GameLeaders leaders={game.leaders} />

      <p className="live-footnote">
        Data from ESPN{game.fetched_at ? ` · updated ${relativeTime(game.fetched_at)}` : ""}
        {game.state === "in" ? " · refreshes automatically" : ""}
      </p>
    </div>
  );
}
