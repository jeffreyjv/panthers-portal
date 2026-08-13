import { ScoreToast, dismissToast, useScoreToasts } from "./toastStore";

function Toast({ toast }: { toast: ScoreToast }) {
  return (
    <div className={`toast${toast.panthers ? " is-car" : " is-opp"}`}>
      <div className="toast-head">
        {toast.logo && <img className="toast-logo" src={toast.logo} alt="" />}
        <span className="toast-headline">
          {toast.headline}
          <small>
            {toast.team} · {toast.when}
          </small>
        </span>
        <span className="toast-score">
          <span title={toast.panthers_abbr}>{toast.panthers_score}</span>–
          <span title={toast.opponent_abbr}>{toast.opponent_score}</span>
        </span>
      </div>

      <p className="toast-text">{toast.text}</p>

      <button
        type="button"
        className="toast-close"
        onClick={() => dismissToast(toast.id)}
        aria-label="Dismiss"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

/** Scores as they happen, on whichever tab you're on.
 *
 * Rendered once at the app root rather than inside Live, because the whole
 * point is to catch a touchdown while you're reading News. `role="status"` so a
 * screen reader hears it without being yanked out of what it was reading.
 */
export function ScoreToasts() {
  const toasts = useScoreToasts();

  return (
    <div className="toasts" role="status" aria-live="polite" aria-label="Score updates">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
