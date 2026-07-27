import { SeasonFutures } from "./api";

/** One labelled price. Renders nothing when we don't have it, so a partial
 *  payload closes up instead of showing empty cells. */
function Cell({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="odds-cell">
      <span className="odds-label">{label}</span>
      <span className="odds-value">{value}</span>
    </div>
  );
}

/** The season futures strip above the schedule.
 *
 * Per-game lines live on the rows themselves; this covers only the prices that
 * belong to the season as a whole.
 */
export function SeasonOdds({ futures }: { futures: SeasonFutures }) {
  return (
    <section className="odds" aria-label="Season betting odds">
      <span className="odds-group-title">Season</span>
      <div className="odds-cells">
        <Cell label="NFC South" value={futures.division} />
        <Cell label="NFC" value={futures.conference} />
        <Cell label="Super Bowl" value={futures.super_bowl} />
      </div>
      <p className="odds-note">
        {futures.provider} via ESPN · lines move, these are a snapshot
      </p>
    </section>
  );
}
