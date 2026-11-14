// The Cache hits and Conn. wait cells of the Performance routes table (BAC-79). A figure in the
// neutral text colour (a hit ratio or a wait share is a finding, not a status), or, when the
// route's services do not report it, a faint dash that reads "no data" with a tooltip saying
// why. Never 0 percent for missing data. Wording from `cache-pool.ts` (pure).
import { NO_DATA, type ShareCell } from "~/lib/hops/cache-pool";

export function ShareCellText({ cell }: { cell: ShareCell }) {
  if (cell.text === null) {
    return (
      <span className="text-faint" title={cell.title} aria-label={`${NO_DATA}: ${cell.title}`}>
        —
      </span>
    );
  }
  return <span title={cell.title}>{cell.text}</span>;
}
