import { useEffect, useState } from "react";
import { Game, fetchSchedule, gameDate, gameTime, peekSchedule } from "./api";
import { ClawMark } from "./ClawMark";

type Status = "loading" | "error" | "ready";

function record(games: Game[]): string | null {
  const finals = games.filter((g) => g.outcome);
  if (finals.length === 0) return null;
  const tally = (o: string) => finals.filter((g) => g.outcome === o).length;
  const ties = tally("T");
  const base = `${tally("W")}-${tally("L")}`;
  return ties > 0 ? `${base}-${ties}` : base;
}

function GameRow({ game }: { game: Game }) {
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

  if (game.url) {
    return (
      <li>
        <a className="game" href={game.url} target="_blank" rel="noreferrer">
          {body}
        </a>
      </li>
    );
  }

  return (
    <li>
      <div className="game">{body}</div>
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

  const summary = record(games);

  return (
    <>
      <div className="section-head">
        <h2 className="section-title">Schedule</h2>
        {summary && <span className="section-badge">{summary}</span>}
        <span className="section-rule" />
      </div>
      <ul className="game-list">
        {status === "loading"
          ? Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)
          : games.map((game) => <GameRow key={game.week} game={game} />)}
      </ul>
    </>
  );
}
