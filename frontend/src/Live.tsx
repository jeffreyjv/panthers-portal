import { useEffect, useState } from "react";
import {
  GameLeader,
  LiveGame,
  LiveTeam,
  ScoringPlay,
  fetchGame,
  gameDate,
  gameTime,
  peekGame,
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
import { LiveSnapshot, useLive } from "./liveStore";
import { toggleNotifications, useNotifyState } from "./notify";
import { back, navigate } from "./router";

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

/** One named game, fetched once.
 *
 * Deliberately not the live store: that store is a poll loop around "whichever
 * game matters now", and a recap is the opposite — a game that finished, whose
 * page should settle and stay put. Passing no id keeps it idle, so the Live tab
 * pays nothing for this.
 */
function useRecap(eventId: string | undefined): LiveSnapshot {
  const [snapshot, setSnapshot] = useState<LiveSnapshot>({
    game: null,
    status: "loading",
    refreshing: false,
  });

  useEffect(() => {
    if (!eventId) return;

    // A game already read this session repaints without a skeleton, the same
    // way the other tabs come back from `peek`.
    const preloaded = peekGame(eventId);
    if (preloaded) {
      setSnapshot({ game: preloaded, status: "ready", refreshing: false });
      return;
    }

    let active = true;
    setSnapshot({ game: null, status: "loading", refreshing: false });
    fetchGame(eventId)
      .then((game) => {
        if (active) setSnapshot({ game, status: "ready", refreshing: false });
      })
      .catch(() => {
        if (active) {
          setSnapshot({ game: null, status: "error", refreshing: false });
        }
      });

    return () => {
      active = false;
    };
  }, [eventId]);

  return snapshot;
}

/** The opt-in for score notifications.
 *
 * Only offered on a game that hasn't finished — there is nothing left to
 * announce about one that has — and never shown at all where the browser has
 * no notifications or the user has already turned the site down at the
 * browser level, since neither is something a button here can fix.
 */
function NotifyToggle() {
  const state = useNotifyState();
  if (state === "unsupported" || state === "denied") return null;

  const on = state === "granted";
  return (
    <button
      type="button"
      className={`notify-toggle${on ? " is-on" : ""}`}
      onClick={toggleNotifications}
      aria-pressed={on}
      title={
        on
          ? "Scores are announced when this tab is in the background"
          : "Get a notification when someone scores"
      }
    >
      <BellIcon muted={!on} />
      {on ? "Score alerts on" : "Alert me on scores"}
    </button>
  );
}

/** The way out of the Live tab and into the conversation about the same game.
 *
 * Offered only while the ball is in play, which is the window the thread is
 * pinned in Talk. Live has no way to know whether Talk has a database behind
 * it; if it doesn't, Talk says so itself, which is the right place for that to
 * surface rather than a button here quietly disappearing.
 */
function GameThreadLink() {
  return (
    <button
      type="button"
      className="thread-link"
      onClick={() => navigate({ name: "talk" })}
      title="Talk about this game with other fans"
    >
      <ChatIcon />
      Join the game thread
    </button>
  );
}

function ChatIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3v4l4.5-4H20a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1z" />
    </svg>
  );
}

function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z" />
      <path d="M13.7 19a2 2 0 0 1-3.4 0" />
      {muted && <path d="M3.5 3.5l17 17" />}
    </svg>
  );
}

function BackToSchedule() {
  return (
    <button
      type="button"
      className="back-link"
      onClick={() => back({ name: "schedule" })}
    >
      <span aria-hidden="true">←</span> Back to schedule
    </button>
  );
}

export function Live({ eventId }: { eventId?: string }) {
  const live = useLive();
  // A link to the game that's on right now is just the Live tab with a URL, so
  // it's handed back to the shared poll rather than frozen at one snapshot.
  const current = Boolean(eventId && live.game?.event_id === eventId);
  const recap = useRecap(current ? undefined : eventId);
  const { game, status, refreshing } = !eventId || current ? live : recap;

  if (status === "loading") {
    return (
      <>
        {eventId && <BackToSchedule />}
        <div className="section-head">
          <h2 className="section-title">{eventId ? "Recap" : "Live"}</h2>
          <span className="section-rule" />
        </div>
        <Skeleton />
      </>
    );
  }

  if (status === "error" || (eventId && !game)) {
    return (
      <>
        {eventId && <BackToSchedule />}
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>{eventId ? "Game unavailable" : "Live data unavailable"}</h2>
          <p>
            {eventId
              ? "We couldn’t load this game. It may not be one of Carolina’s."
              : "We couldn’t reach the scoreboard. Please try again shortly."}
          </p>
        </div>
      </>
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

  // A recap can be years old, so it says which season it was; the live tab is
  // always this one and doesn't need telling.
  const badge = [
    eventId ? game.season : null,
    game.season_label,
    game.week ? `Week ${game.week}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={`live${refreshing ? " is-refreshing" : ""}`}>
      {eventId && <BackToSchedule />}
      <div className="section-head">
        <h2 className="section-title">
          {game.state === "in"
            ? "Live"
            : eventId
              ? "Recap"
              : game.state === "post"
                ? "Last game"
                : "Next game"}
        </h2>
        {badge && <span className="section-badge">{badge}</span>}
        <span className="section-rule" />
        {/* Only where there are still scores to come: the whole offer is
            "we'll tell you", and a finished game has nothing left to tell. */}
        {!eventId && game.state !== "post" && <NotifyToggle />}
        {/* Same condition the footnote uses for "refreshes automatically": the
            thread exists while the game is being played, and a recap of an old
            one shouldn't send anyone to a conversation that has moved on. */}
        {game.state === "in" && (!eventId || current) && <GameThreadLink />}
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
        {game.state === "in" && (!eventId || current)
          ? " · refreshes automatically"
          : ""}
      </p>
    </div>
  );
}
