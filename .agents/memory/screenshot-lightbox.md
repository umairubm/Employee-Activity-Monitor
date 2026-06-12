---
name: Screenshot lightbox viewer
description: Shared full-size screenshot viewer with arrow-key navigation, used by both dashboard screenshot surfaces.
---

# Screenshot lightbox

A single reusable controlled component renders the full-size screenshot viewer
for BOTH dashboard screenshot surfaces: the Screenshots gallery page and the
per-session SessionScreenshots viewer inside Activity Logs. Thumbnails are plain
buttons that set a `viewerIndex`; the parent owns open state + index.

**Why:** the two surfaces previously each had their own per-thumbnail
single-image dialog. Keep them on the one shared viewer so navigation/a11y/behavior
stay consistent — don't reintroduce a bespoke dialog in either page.

**How to apply:**
- Left/Right arrow keys + on-screen buttons navigate (wrap-around). Keydown is a
  window listener gated on `open && count > 1`, cleaned up on close/unmount.
- The viewer self-reconciles when the underlying list shrinks while open (filter/
  date/group refetch): closes if count hits 0, clamps index if it overflows.
  Any new caller gets this for free — do reconciliation IN the component, not the
  call site.
- Escape + focus trap stay owned by Radix Dialog; the custom handler only consumes
  Arrow keys.
