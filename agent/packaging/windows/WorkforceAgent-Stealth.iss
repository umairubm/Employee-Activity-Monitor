; RETIRED: this masquerading, headless installer is intentionally
; unavailable. Do not reintroduce a hidden or undiscoverable build.
;
; Use the transparent installer instead:
;   ISCC.exe windows\WorkforceAgent.iss
; For an already enrolled device's authorized maintenance update, invoke the
; resulting installer with /VERYSILENT /SUPPRESSMSGBOXES /NORESTART.

#error "WorkforceAgent-Stealth.iss is retired. Build windows\WorkforceAgent.iss and use /VERYSILENT only for an authorized upgrade."