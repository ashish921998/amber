import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Sweep a bounded page of stale pending image operations (their attached upload
// was never finalized) so unreferenced storage objects don't accumulate. The
// mutation processes at most 100 rows per run; unbounded scans are avoided.
crons.interval(
  "cleanup stale image imports",
  { hours: 6 },
  internal.items.cleanupStaleImageImports,
  {},
);

export default crons;
