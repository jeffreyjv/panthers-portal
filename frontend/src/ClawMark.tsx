/** Three-slash claw mark — the team's identity motif. */
export function ClawMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <g fill="currentColor">
        <path d="M10 4c3 8 3 20 1 34-3-13-4-25-1-34z" />
        <path d="M23 2c3 9 3 22 1 38-3-14-4-27-1-38z" />
        <path d="M36 4c3 8 3 20 1 34-3-13-4-25-1-34z" />
      </g>
    </svg>
  );
}
