import { useEffect, useMemo, useState } from "react";
import { Player, fetchRoster, peekRoster } from "./api";
import { ClawMark } from "./ClawMark";

type Status = "loading" | "error" | "ready";

/** Group players by their group label, preserving the order the API sent. */
function byGroup(players: Player[]): { label: string; players: Player[] }[] {
  const groups: { label: string; players: Player[] }[] = [];
  for (const player of players) {
    let group = groups.find((g) => g.label === player.group);
    if (!group) {
      group = { label: player.group, players: [] };
      groups.push(group);
    }
    group.players.push(player);
  }
  return groups;
}

function matches(player: Player, query: string): boolean {
  if (!query) return true;
  const haystack = [
    player.name,
    player.position,
    player.position_name,
    player.depth_position,
    player.college,
    player.jersey,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // Every term must appear, so "wr georgia" narrows rather than widens.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function details(player: Player): string {
  const parts = [
    player.height,
    player.weight ? `${player.weight} lbs` : null,
    player.college,
  ];
  return parts.filter(Boolean).join(" · ");
}

function PlayerCard({ player }: { player: Player }) {
  return (
    <li className="player">
      {player.headshot ? (
        <img className="player-shot" src={player.headshot} alt="" loading="lazy" />
      ) : (
        <div className="player-shot player-shot-fallback">
          <ClawMark className="player-shot-claw" />
        </div>
      )}
      <div className="player-body">
        <h3 className="player-name">{player.name}</h3>
        <span className="player-tags">
          {player.jersey && <span className="player-number">#{player.jersey}</span>}
          {player.position && (
            <span className="player-position" title={player.position_name ?? ""}>
              {player.position}
            </span>
          )}
          {player.starter && player.depth_position && (
            <span className="player-slot">{player.depth_position}</span>
          )}
        </span>
        <span className="meta">{details(player)}</span>
      </div>
    </li>
  );
}

function SkeletonPlayer() {
  return (
    <li className="player">
      <div className="skeleton player-shot" />
      <div className="player-body">
        <div className="skeleton skeleton-line long" />
        <div className="skeleton skeleton-line short" />
      </div>
    </li>
  );
}

function RosterSection({
  label,
  players,
}: {
  label: string;
  players: Player[];
}) {
  if (players.length === 0) return null;
  return (
    <section>
      <div className="section-head">
        <h2 className="section-title">{label}</h2>
        <span className="section-badge">{players.length}</span>
        <span className="section-rule" />
      </div>
      <ul className="roster">
        {players.map((player) => (
          <PlayerCard key={player.id} player={player} />
        ))}
      </ul>
    </section>
  );
}

export function Team() {
  const preloaded = peekRoster();
  const [players, setPlayers] = useState<Player[]>(preloaded ?? []);
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");
  const [query, setQuery] = useState("");
  const [positions, setPositions] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    fetchRoster()
      .then((data) => {
        if (!active) return;
        setPlayers(data);
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

  // First-appearance order, so the chips match how the roster is sorted.
  const allPositions = useMemo(
    () =>
      Array.from(
        new Set(players.map((p) => p.position).filter((p): p is string => !!p)),
      ),
    [players],
  );

  const filtered = useMemo(
    () =>
      players.filter(
        (p) =>
          (positions.length === 0 ||
            (p.position !== null && positions.includes(p.position))) &&
          matches(p, query),
      ),
    [players, positions, query],
  );

  const togglePosition = (position: string) =>
    setPositions((current) =>
      current.includes(position)
        ? current.filter((p) => p !== position)
        : [...current, position],
    );

  const isFiltered = query !== "" || positions.length > 0;

  if (status === "error") {
    return (
      <div className="notice">
        <ClawMark className="notice-claw" />
        <h2>Roster unavailable</h2>
        <p>We couldn’t load the roster. Please try again shortly.</p>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <>
        <div className="section-head">
          <h2 className="section-title">Roster</h2>
          <span className="section-rule" />
        </div>
        <ul className="roster">
          {Array.from({ length: 8 }).map((_, i) => (
            <SkeletonPlayer key={i} />
          ))}
        </ul>
      </>
    );
  }

  const starters = filtered.filter((p) => p.starter);
  const reserves = filtered.filter((p) => !p.starter);

  return (
    <>
      <div className="roster-controls">
        <div className="search-wrap">
          <input
            type="search"
            className="roster-search"
            placeholder="Search name, position, or college…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search roster"
          />
        </div>

        <div className="chip-row" role="group" aria-label="Filter by position">
          {allPositions.map((position) => {
            const on = positions.includes(position);
            return (
              <button
                key={position}
                type="button"
                className={`chip${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() => togglePosition(position)}
              >
                {position}
              </button>
            );
          })}
          {isFiltered && (
            <button
              type="button"
              className="chip chip-clear"
              onClick={() => {
                setPositions([]);
                setQuery("");
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="notice">
          <ClawMark className="notice-claw" />
          <h2>No players match</h2>
          <p>Try a different name or clear the position filters.</p>
        </div>
      ) : (
        <>
          {byGroup(starters).map((group) => (
            <RosterSection
              key={`starters-${group.label}`}
              label={`${group.label} — Starters`}
              players={group.players}
            />
          ))}
          {byGroup(reserves).map((group) => (
            <RosterSection
              key={`reserves-${group.label}`}
              label={starters.length > 0 ? `${group.label} — Reserves` : group.label}
              players={group.players}
            />
          ))}
        </>
      )}
    </>
  );
}
