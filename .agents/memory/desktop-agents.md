---
name: Desktop agents (Python + Node) must stay in lockstep
description: Two agents talk to the same sync API; both must honor the secure, consent-based contract. Don't open public endpoints to make a client "work".
---

# Two desktop agents, one secure contract

There are two desktop agents that hit the same server sync API:
- `agent/` — Python (the original/canonical agent, documented in replit.md).
- `agent-node/tracker-client.mjs` — Node port, added when a developer's insecure
  client needed to be made compatible.

**Rule:** both must use the identical secure contract — enrollment token +
recorded consent on first run, per-device `x-device-id`/`x-device-secret` on every
authenticated call, and the 3-step presigned object-storage screenshot upload
(request-url → PUT bytes → POST metadata). Transparency is non-negotiable:
consent gates enrollment, a visible notice precedes every screenshot, and a
notice precedes any IT command.

**Why:** a developer asked to "make the endpoint public" so their no-auth client
would work. That would (a) create an open, unauthenticated data-ingest hole and
(b) reintroduce the covert monitoring the user explicitly dropped. The chosen
fix was always to adapt the *client* to enroll properly, never to weaken the
server. The server (`artifacts/api-server/src/routes/sync.ts`, `deviceAuth.ts`,
`syncValidation.ts`) is the source of truth — adapt clients to it.

**How to apply:** when a new/changed client appears, diff its payloads against
`lib/syncValidation.ts` and mirror `agent/api.py`. Never add a public sync route.
