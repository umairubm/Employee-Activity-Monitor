---
name: React Day Picker modifier styling
description: Day-button state styling must be explicit when using the shared calendar wrapper.
---

React Day Picker modifiers are exposed on the custom day button, but wrapper-level
`classNames` alone is not enough for reliable selected, outside, disabled, and
today visuals. The custom day button must emit data attributes or modifier-aware
classes, and the consuming picker should explicitly style those states.

**Why:** Inherited muted styles and base selected-state classes can make active
dates unreadable or override a consuming page's intended range color.

**How to apply:** When changing calendar themes, update the custom DayButton
state selectors and the page-level `classNames` together; verify selected
endpoints, range-middle days, outside days, disabled days, and unselected today.