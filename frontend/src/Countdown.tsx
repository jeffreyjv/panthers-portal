import { useEffect, useState } from "react";
import { Game, fetchSchedule, peekSchedule } from "./api";

/** The next game that hasn't kicked off yet — the season opener until it does. */
function nextGame(games: Game[], now: number): Game | null {
  for (const game of games) {
    if (game.bye || !game.kickoff) continue;
    const kickoff = new Date(game.kickoff).getTime();
    if (!Number.isNaN(kickoff) && kickoff > now) return game;
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parts(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

function Segment({ value, unit }: { value: string; unit: string }) {
  return (
    <span className="countdown-seg">
      <span className="countdown-num">{value}</span>
      <span className="countdown-unit">{unit}</span>
    </span>
  );
}

export function Countdown() {
  const [games, setGames] = useState<Game[]>(() => peekSchedule() ?? []);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    fetchSchedule()
      .then((data) => {
        if (active) setGames(data);
      })
      .catch(() => {
        /* The schedule tab surfaces the failure; the header just stays quiet. */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const game = nextGame(games, now);
  if (!game || !game.kickoff) return null;

  const { days, hours, minutes, seconds } = parts(
    new Date(game.kickoff).getTime() - now,
  );
  const opponent = game.opponent_abbr ?? game.opponent ?? "TBD";

  return (
    <div
      className="countdown"
      title={`Kickoff ${new Date(game.kickoff).toLocaleString()}`}
    >
      <span className="countdown-label">
        Kickoff
        <small>
          {game.home ? "vs" : "at"} {opponent}
        </small>
      </span>
      <span className="countdown-clock" aria-hidden="true">
        {days > 0 && <Segment value={String(days)} unit="d" />}
        <Segment value={days > 0 ? pad(hours) : String(hours)} unit="h" />
        <Segment value={pad(minutes)} unit="m" />
        <Segment value={pad(seconds)} unit="s" />
      </span>
      {/* Ticking digits are noise for a screen reader, so announce a coarse
          version and only when the minute changes. */}
      <span className="sr-only" aria-live="polite">
        {days > 0
          ? `${days} days ${hours} hours until kickoff`
          : `${hours} hours ${minutes} minutes until kickoff`}
      </span>
    </div>
  );
}
