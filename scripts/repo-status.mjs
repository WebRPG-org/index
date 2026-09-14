// Shared entry status vocabulary.
//
// The index, fork and prepare workflows all read list.json and each used to
// carry its own skip list. Those lists drifted apart, so a status could be
// skipped by one workflow and acted on by another — which is how a repository
// ends up deleted from WebRPG-org and forked again on the next run, only to
// fail in exactly the same way. Keep the vocabulary in one place.

// Entries that are never prepared again.
//
// The entries themselves stay in list.json on purpose: they are what stops the
// index workflow from discovering the same repository a second time, which
// would fork it again and repeat the same failure. They act as tombstones.
//
// - invalid_structure      no RPG Maker web structure was found; the fork is deleted
// - duplicate_name         another entry already maps to this fork
// - hidden                 hidden by hand in list.json
// - skipped_large          the upstream repository exceeds a size limit
// - unavailable            the check cannot succeed however often it runs
// - retry_exhausted        every retry failed; kept for auditing and manual revival
//
// Setting an entry back to `indexed` puts it in the queue again.
export const TERMINAL_STATUSES = [
  "invalid_structure",
  "deleted_invalid_structure",
  "duplicate_name",
  "hidden",
  "skipped_large",
  "unavailable",
  "retry_exhausted",
];

export function isTerminalStatus(entry) {
  return Boolean(entry) && TERMINAL_STATUSES.includes(entry.status);
}
