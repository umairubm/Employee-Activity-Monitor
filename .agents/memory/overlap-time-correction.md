---
name: Overlapping-agent time correction
description: How duplicate-agent double-counted time is corrected across reporting surfaces, and the invariants correctOverlap must hold.
---

# Overlapping-agent time double-counting

Multiple agent instances on ONE PC log the same foreground activity, so their
`activity_logs` intervals overlap and naive `sum(duration_seconds)` inflates
worked/idle/productive time. Fix has two halves:

1. **Source prevention** — both desktop agents take a single-instance lock so a
   second instance refuses to start.
2. **Read-side correction** — a shared helper merges intervals per partition key
   (gaps-and-islands SQL union) to get true wall-clock coverage, then scales the
   naive component sums down to it.

**Rule: NEVER merge intervals across devices.** Key by device, or device+day.
Merging across devices would collapse legitimate concurrent work by different
people. Per-range surfaces (leaderboard, group-comparison summary) key per
device; per-day surfaces (timesheets, attendance) key by device+UTC-day.
Group totals are aggregated in JS AFTER per-device correction, never before.

**correctOverlap invariants (don't regress these):**
- `total = min(max(0, covered), worked)`; `ratio = total/worked`.
- Scale each class by `ratio`, then round with a **sum-preserving** largest-
  remainder pass — NOT independent `Math.round` per class. Independent rounding
  can overshoot (e.g. three classes each rounding up) and break "classes sum to
  total".
  **Why:** the round-preserving pass keeps round(sum) == sum(rounded).
- Do NOT re-normalize classes to sum to `total`. Callers like leaderboard/
  group-comparison deliberately populate ONLY `productiveSeconds` (others 0);
  re-normalizing would inflate productive to the whole total. Ratio-scaling each
  class independently gives them exactly `round(productive * ratio)`.
- `active = total - idle`; `idle` capped at `total`.

**How to apply:** any new reporting surface that sums durations must run the same
per-device(+day) correction. Test overlaps with `seedActivityAt` (explicit start
time); `seedActivity` staggers sequential same-day logs so normal data stays
overlap-free (ratio=1, values unchanged).
