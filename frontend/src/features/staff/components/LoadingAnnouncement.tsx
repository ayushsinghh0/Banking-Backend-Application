/** Screen-reader announcement for list loading (the skeleton itself is hidden from assistive tech) */
export function LoadingAnnouncement({ active, label }: { active: boolean; label: string }) {
  return (
    <span role="status" aria-live="polite" className="sr-only">
      {active ? label : ''}
    </span>
  );
}
