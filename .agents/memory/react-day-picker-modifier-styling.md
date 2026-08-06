---
name: React Day Picker modifier styling
description: Day-button state styling must be explicit when using the shared calendar wrapper.
---

React Day Picker modifiers are exposed on the custom day button, but wrapper-level
`classNames` alone is not enough for reliable selected, outside, disabled, and
today visuals. The custom day button must emit data attributes or modifier-aware
classes, and the consuming picker should explicitly style those states. When
the calendar is placed in a fluid panel, override the wrapper's default `w-fit`
with a full-width root/month/table so all seven columns align.

**Why:** Inherited muted styles and base selected-state classes can make active
dates unreadable or override a consuming page's intended range color.

**How to apply:** When changing calendar themes, update the custom DayButton
state selectors and the page-level `classNames` together; verify selected
endpoints, range-middle days, outside days, disabled days, unselected today,
and the full-width weekday/grid alignment.