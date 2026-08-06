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
import { DivisionStrip } from "./DivisionStrip";
import { Injuries } from "./Injuries";
import { SeasonOdds } from "./Odds";

type Status = "loading" | "error" | "ready";

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

function GameRow({
  game,
  standings,
  line,
}: {
  game: Game;
  standings: Standings | null;
  line: GameLine | undefined;
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
  // renders the way it always did.
  const abbr = game.opponent_abbr?.toUpperCase();
  const opponent = abbr ? standings?.league[abbr] : undefined;
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
        {opponent && (
          <span className="game-record" title={`${opponent.name} ${opponent.record}`}>
            {opponent.record}
          </span>
        )}
        {line && <GameOdds line={line} />}
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
  const [games, setGames] = useState<Game[]>(preloaded ?? []);
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");
  const [standings, setStandings] = useState<Standings | null>(
    peekStandings() ?? null,
  );
  const [odds, setOdds] = useState<Odds | null>(peekOdds() ?? null);

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
        if (active) setStandings(data);
      })
      .catch(() => {});

    // Odds are enrichment on the same terms: a failure leaves the rows bare
    // rather than putting an error in front of the schedule.
    fetchOdds()
      .then((data) => {
        if (active) setOdds(data);
      })
      .catch(() => {});

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
  const rank = standings ? divisionRank(standings) : null;

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Schedule</h2>
        {summary && (
          <span className="section-badge">
            {summary}
            {rank && <small> · {rank} in NFC South</small>}
          </span>
        )}
        <span className="section-rule" />
      </div>
      {standings && <DivisionStrip standings={standings} />}
      {odds?.futures && <SeasonOdds futures={odds.futures} />}
      <ul className="game-list">
        {status === "loading"
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : games.map((game) => (
              <GameRow
                key={game.week}
                game={game}
                standings={standings}
                line={odds?.lines[game.week]}
              />
            ))}
      </ul>
      <Injuries />
    </>
  );
}
