import { useEffect, useState } from "react";
import {
  Game,
  GameLine,
  Odds,
  Standings,
  americanOdds,
  divisionRank,
  fetchOdds,
  fetchSchedule,
  fetchStandings,
  gameDate,
  gameTime,
  peekOdds,
  peekSchedule,
  peekStandings,
} from "./api";
import { ClawMark } from "./ClawMark";
import { DivisionStrip, DivisionStripSkeleton } from "./DivisionStrip";
import { SeasonOdds, SeasonOddsSkeleton } from "./Odds";
import { navigate, pathOf } from "./router";

type Status = "loading" | "error" | "ready";

/** State of one of the two enrichments hanging off the schedule.
 *
 * "absent" is the resting state for both a failed request and a request that
 * succeeded with nothing to show: either way the placeholder comes down and
 * the tab renders the way it did before enrichments existed.
 */
type Enrichment = "loading" | "ready" | "absent";

function record(games: Game[]): string | null {
  const finals = games.filter((g) => g.outcome);
  if (finals.length === 0) return null;
  const tally = (o: string) => finals.filter((g) => g.outcome === o).length;
  const ties = tally("T");
  const base = `${tally("W")}-${tally("L")}`;
  return ties > 0 ? `${base}-${ties}` : base;
}

/** The line on one game, condensed to fit inside a schedule row.
 *
 * Panthers-oriented: "+2.5" means they're getting points. The moneyline is
 * dropped on narrow screens by CSS — spread and total are the two numbers
 * worth the width.
 */
function GameOdds({ line }: { line: GameLine }) {
  const money = americanOdds(line.money_line);
  return (
    <span className="game-odds" title={`${line.provider} line`}>
      {line.spread && <span className="game-odds-spread">{line.spread}</span>}
      {line.over_under !== null && (
        <span className="game-odds-total">O/U {line.over_under}</span>
      )}
      {money && <span className="game-odds-money">CAR {money}</span>}
    </span>
  );
}

/** Whether this row is still expecting a line.
 *
 * Mirrors the backend's own filter: it prices every game that isn't a bye,
 * carries an event id, and hasn't finished. Knowing that up front lets the row
 * hold the chip's space instead of growing a line's worth of height when the
 * odds land — which on a phone, where the chip wraps to its own line, is the
 * shift you actually notice.
 */
function expectsLine(game: Game): boolean {
  return !game.bye && Boolean(game.event_id) && game.status !== "final";
}

function GameRow({
  game,
  standings,
  line,
  oddsPending,
  standingsPending,
}: {
  game: Game;
  standings: Standings | null;
  line: GameLine | undefined;
  oddsPending: boolean;
  standingsPending: boolean;
}) {
  if (game.bye) {
    return (
      <li>
        <div className="game game-bye">
          <span className="game-week">—</span>
          <div className="game-main">
            <span className="game-opponent">Bye Week</span>
          </div>
        </div>
      </li>
    );
  }

  // Opponent's record, when we know it. Missing standings just means the row
  // renders the way it always did — and before Week 1 there is no record worth
  // printing, so seventeen rows of "0-0" are dropped rather than shown.
  const abbr = game.opponent_abbr?.toUpperCase();
  const opponent =
    abbr && !standings?.preseason ? standings?.league[abbr] : undefined;
  const divisional = Boolean(
    abbr && standings?.division.some((t) => t.abbreviation.toUpperCase() === abbr),
  );

  const body = (
    <>
      <span className="game-week">
        <small>Week</small>
        {game.week}
      </span>
      <div className="game-main">
        {game.opponent_logo && (
          <img className="game-logo" src={game.opponent_logo} alt="" loading="lazy" />
        )}
        <span className={`game-side ${game.home ? "is-home" : "is-away"}`}>
          {game.home ? "vs" : "at"}
        </span>
        <span className="game-opponent">{game.opponent}</span>
        {opponent ? (
          <span className="game-record" title={`${opponent.name} ${opponent.record}`}>
            {opponent.record}
          </span>
        ) : standingsPending && !game.bye && abbr ? (
          // Same reasoning as the odds chip: this one sits mid-row, so without
          // a placeholder everything to its right slides over when it lands.
          <span className="game-record game-record-pending" aria-hidden="true">
            <span className="skeleton ph ph-game-record" />
          </span>
        ) : null}
        {line ? (
          <GameOdds line={line} />
        ) : oddsPending && expectsLine(game) ? (
          <span className="game-odds game-odds-pending" aria-hidden="true">
            <span className="skeleton ph ph-game-odds" />
          </span>
        ) : null}
      </div>
      {game.outcome ? (
        <span className={`game-result outcome-${game.outcome.toLowerCase()}`}>
          {game.outcome} {game.team_score}–{game.opponent_score}
        </span>
      ) : (
        <span className="game-when">
          {gameDate(game.kickoff)}
          <small>
            {gameTime(game.kickoff)}
            {game.network ? ` · ${game.network}` : ""}
          </small>
        </span>
      )}
    </>
  );

  const className = `game${divisional ? " is-divisional" : ""}`;

  // A game that's been played has a recap of its own — the same charts the Live
  // tab draws — so it leads there rather than off to ESPN. Everything else is
  // still an outbound link, since there's nothing to show yet.
  if (game.event_id && game.status !== "scheduled") {
    const href = pathOf({ name: "game", eventId: game.event_id });
    return (
      <li>
        <a
          className={`${className} is-recap`}
          href={href}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            navigate({ name: "game", eventId: game.event_id! });
          }}
        >
          {body}
        </a>
      </li>
    );
  }

  if (game.url) {
    return (
      <li>
        <a className={className} href={game.url} target="_blank" rel="noreferrer">
          {body}
        </a>
      </li>
    );
  }

  return (
    <li>
      <div className={className}>{body}</div>
    </li>
  );
}

function SkeletonRow() {
  return (
    <li>
      <div className="game game-skeleton">
        <div className="skeleton skeleton-line short" />
        <div className="skeleton skeleton-line long" />
        <div className="skeleton skeleton-line short" />
      </div>
    </li>
  );
}

export function Schedule() {
  const preloaded = peekSchedule();
  const preloadedStandings = peekStandings();
  const preloadedOdds = peekOdds();

  const [games, setGames] = useState<Game[]>(preloaded ?? []);
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");
  const [standings, setStandings] = useState<Standings | null>(
    preloadedStandings ?? null,
  );
  const [odds, setOdds] = useState<Odds | null>(preloadedOdds ?? null);
  const [standingsState, setStandingsState] = useState<Enrichment>(
    preloadedStandings ? "ready" : "loading",
  );
  const [oddsState, setOddsState] = useState<Enrichment>(
    preloadedOdds ? "ready" : "loading",
  );

  // Whether this mount is the one that has to wait. On a return visit the
  // caches answer instantly, and fading in data that was already on screen a
  // moment ago is its own kind of glitch — so the animation is first-load only.
  const [firstLoad] = useState(() => !preloadedStandings || !preloadedOdds);
  const settle = firstLoad ? " settle-in" : "";

  useEffect(() => {
    let active = true;
    fetchSchedule()
      .then((data) => {
        if (!active) return;
        setGames(data);
        setStatus("ready");
      })
      .catch(() => {
        if (!active) return;
        setStatus("error");
      });

    // Standings are enrichment: they load alongside the schedule and a failure
    // is swallowed, leaving the tab exactly as it was before they existed.
    fetchStandings()
      .then((data) => {
        if (!active) return;
        setStandings(data);
        setStandingsState(data.division.length > 0 ? "ready" : "absent");
      })
      .catch(() => {
        if (active) setStandingsState("absent");
      });

    // Odds are enrichment on the same terms: a failure leaves the rows bare
    // rather than putting an error in front of the schedule.
    fetchOdds()
      .then((data) => {
        if (!active) return;
        setOdds(data);
        setOddsState(data.futures ? "ready" : "absent");
      })
      .catch(() => {
        if (active) setOddsState("absent");
      });

    return () => {
      active = false;
    };
  }, []);

  if (status === "error") {
    return (
      <div className="notice">
        <ClawMark className="notice-claw" />
        <h2>Schedule unavailable</h2>
        <p>We couldn’t load the season schedule. Please try again shortly.</p>
      </div>
    );
  }

  // Before kickoff no game has an outcome, so fall back to the record the
  // standings carry — which the strip labels with the season it belongs to.
  const panthers = standings?.division.find((t) => t.panthers);
  const summary = record(games) ?? panthers?.record ?? null;
  // A preseason table is alphabetical and every team is 0-0, so a placing
  // would be an accident of the alphabet rather than a standing.
  const rank =
    standings && !standings.preseason ? divisionRank(standings) : null;

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Schedule</h2>
        {summary ? (
          <span className={`section-badge${settle}`}>
            {summary}
            {rank && <small> · {rank} in NFC South</small>}
          </span>
        ) : (
          // Pre-kickoff the record comes from the standings, so the badge is
          // as late as they are. It holds its own width rather than elbowing
          // the rule aside once it arrives.
          standingsState === "loading" && (
            <span className="section-badge" aria-hidden="true">
              <span className="skeleton ph ph-badge" />
            </span>
          )
        )}
        <span className="section-rule" />
      </div>
      {standingsState === "loading" ? (
        <DivisionStripSkeleton />
      ) : (
        standings && (
          <div className={settle.trim()}>
            <DivisionStrip standings={standings} />
          </div>
        )
      )}
      {oddsState === "loading" ? (
        <SeasonOddsSkeleton />
      ) : (
        odds?.futures && (
          <div className={settle.trim()}>
            <SeasonOdds futures={odds.futures} />
          </div>
        )
      )}
      <ul className="game-list">
        {status === "loading"
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : games.map((game) => (
              <GameRow
                key={game.week}
                game={game}
                standings={standings}
                line={odds?.lines[game.week]}
                oddsPending={oddsState === "loading"}
                standingsPending={standingsState === "loading"}
              />
            ))}
      </ul>
    </>
  );
}
