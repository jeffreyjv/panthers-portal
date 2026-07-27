import { useEffect, useState } from "react";
import { Injury, fetchInjuries, gameDate, peekInjuries } from "./api";
import { ClawMark } from "./ClawMark";

type Status = "loading" | "error" | "ready";

/** Status -> the modifier class that colours its pill.
 *
 * Keyed on ESPN's exact wording. Anything unrecognized falls back to the
 * neutral pill rather than going unstyled.
 */
const STATUS_CLASS: Record<string, string> = {
  "Injured Reserve": "is-ir",
  Out: "is-out",
  Doubtful: "is-doubtful",
  Questionable: "is-questionable",
  "Day-To-Day": "is-questionable",
};

/** Short form for the pill: the table gets crowded at "Injured Reserve". */
const STATUS_LABEL: Record<string, string> = {
  "Injured Reserve": "IR",
  "Day-To-Day": "DTD",
};

/** "Knee · Surgery", collapsing to whichever half we actually have. */
function ailment(injury: Injury): string | null {
  const parts = [injury.body_part, injury.detail].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

function InjuryRow({ injury }: { injury: Injury }) {
  const label = STATUS_LABEL[injury.status] ?? injury.status;
  const detail = ailment(injury);

  const body = (
    <>
      {injury.headshot ? (
        <img className="injury-shot" src={injury.headshot} alt="" loading="lazy" />
      ) : (
        <div className="injury-shot injury-shot-fallback">
          <ClawMark className="injury-shot-claw" />
        </div>
      )}
      <div className="injury-main">
        <span className="injury-name">
          {injury.name}
          {injury.position && (
            <span className="injury-position">{injury.position}</span>
          )}
        </span>
        {detail && <span className="injury-ailment">{detail}</span>}
        {injury.comment && <p className="injury-comment">{injury.comment}</p>}
      </div>
      <div className="injury-status">
        <span
          className={`injury-pill ${STATUS_CLASS[injury.status] ?? "is-other"}`}
          title={injury.status}
        >
          {label}
        </span>
        {injury.return_date && (
          <small className="injury-return">
            Est. {gameDate(injury.return_date)}
          </small>
        )}
      </div>
    </>
  );

  if (injury.url) {
    return (
      <li>
        <a className="injury" href={injury.url} target="_blank" rel="noreferrer">
          {body}
        </a>
      </li>
    );
  }

  return (
    <li>
      <div className="injury">{body}</div>
    </li>
  );
}

function SkeletonRow() {
  return (
    <li>
      <div className="injury">
        <div className="skeleton injury-shot" />
        <div className="injury-main">
          <div className="skeleton skeleton-line long" />
          <div className="skeleton skeleton-line short" />
        </div>
      </div>
    </li>
  );
}

/** The injury report.
 *
 * Enrichment on the Schedule tab, so it renders nothing at all when the fetch
 * fails — losing the report should not put an error box between the fan and
 * the schedule they came for.
 */
export function Injuries() {
  const preloaded = peekInjuries();
  const [injuries, setInjuries] = useState<Injury[]>(preloaded ?? []);
  const [status, setStatus] = useState<Status>(preloaded ? "ready" : "loading");

  useEffect(() => {
    let active = true;
    fetchInjuries()
      .then((data) => {
        if (!active) return;
        setInjuries(data);
        setStatus("ready");
      })
      .catch(() => {
        if (active) setStatus("error");
      });

    return () => {
      active = false;
    };
  }, []);

  if (status === "error") return null;

  return (
    <section className="injury-report">
      <div className="section-head">
        <h2 className="section-title">Injury Report</h2>
        {status === "ready" && injuries.length > 0 && (
          <span className="section-badge">{injuries.length}</span>
        )}
        <span className="section-rule" />
      </div>

      {status === "ready" && injuries.length === 0 ? (
        <p className="injury-clean">
          <ClawMark className="injury-clean-claw" />
          Nobody on the report. Fully healthy.
        </p>
      ) : (
        <ul className="injury-list">
          {status === "loading"
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonRow key={i} />)
            : injuries.map((injury) => (
                <InjuryRow key={injury.id} injury={injury} />
              ))}
        </ul>
      )}
    </section>
  );
}
