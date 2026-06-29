---
name: React Fast Refresh + context/hook split
description: Why mixing a provider component and its hook in one file causes intermittent "must be used within Provider" crashes in dev.
---

# React Fast Refresh: keep hooks/context out of component files

A file that exports BOTH a React component (e.g. `AuthProvider`) AND a
non-component (a hook like `useAuth`, or the `Context` object) breaks React Fast
Refresh. Vite logs `Could not Fast Refresh ("useAuth" export is incompatible)`.

**Why:** When such a file (or one of its HMR-cascade dependents) hot-updates,
Fast Refresh can't refresh it consistently and the module graph reloads in a bad
intermediate state — the context value transiently becomes `undefined`, so any
`useContext(X)` guard throws (e.g. "useAuth must be used within an AuthProvider")
even though the Provider genuinely wraps the tree. It's a dev-only HMR artifact;
production builds are unaffected.

**How to apply:** Put the `Context` + its hook in a plain `.ts` file
(e.g. `lib/auth-context.ts`); keep only the Provider *component* in the `.tsx`.
Import the hook from the context file everywhere. This satisfies the
`react-refresh/only-export-components` rule. After fixing, restart the dev
workflow to clear the stale HMR state.
