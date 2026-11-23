# Product requirements

## Problem and objective

The user wants an hourly two-save cycle during roughly ten hours of daily laptop use: open Basic details, append one full stop to the current Name, save, reopen Basic details, restore the exact original Name, and save again. The proposed benefit to recruiter views is an unverified hypothesis, not a product guarantee. Phase 2 implements the coordinator, browser adapter, strict retry budget and history with local tests; live validation remains Phase 3.

## MVP scope

Free local software; Windows; dedicated Edge login; manual initial authentication; verified Basic details targeting; background browser; two-save Name cycle with exact restoration; durable recovery journal; hourly Windows task; no missed-run replay; exclusive execution; success confirmation; persistent status and diagnostic event log. Use current browser and Node installations. No AI runtime or remote hosting.

## Requirements and acceptance

1. User signs in once manually; subsequent runs reuse the separate local session until it expires.
2. Dry-run verifies the Basic details heading and unique Name field without submitting anything. URL alone cannot establish the editor identity.
3. Only Name may change: append one full stop, save, reopen and restore the exact original string, then save. All other form values must remain unchanged.
4. Each submission requires a fresh confirmation plus a reopened Name check. Success requires final persisted Name to equal the original exactly.
5. Each rolling 60-minute window permits an initial workflow attempt and at most one eligible retry. After two failures, stop until the next window; restoration shares this limit. Both saves form one workflow attempt. Follow the authoritative [retry policy](RETRY-POLICY.md). Overlapping processes cannot use the browser profile together.
6. Schedule only operates while Windows is awake and the user is signed in. Do not wake, catch up or burst requests.
7. Detect configured authentication challenges and stop. Never solve or bypass CAPTCHA, spoof identity signals, or evade detection.
8. Do not activate before verifying site permission and a supervised live save. The application does not certify terms compliance.
9. User can inspect status, pause, resume and uninstall the schedule without losing profile/session data.
10. Keep credentials and names out of event logs. Browser session and the recovery journal remain sensitive local data.
11. Persist the original and temporary Name before the first edit. Pending recovery blocks new cycles. If the observed Name differs from both recorded values, stop without overwriting it.

## Non-goals

24/7 operation while devices are off; guaranteed exact timing or recruiter visibility; auto-applying; profile improvements; resume uploads; public or undocumented API replay; password/OTP automation; CAPTCHA bypass; cloud hosting; mobile app; multi-account management; a GUI.

## Release gates

Local tests pass; actual DOM selectors verified; permission established; supervised dry-run and full two-save cycle pass; failure between saves and recovery tested; headless execution tested; schedule lifecycle checked; ten-hour pilot reviewed. Until then this remains an inactive initial implementation.

## Future work

A minimal local dashboard with an explicit default-Off On/Off control is in Phase 4 scope; outcome history is implemented in Phase 2. Scheduling will start at Windows sign-in with the shared hourly retry budget preserved across restarts. See [dashboard and scheduling requirements](DASHBOARD-AND-SCHEDULING.md), which supersede the original no-GUI scope. Desktop notifications and bounded log retention remain future work. Source is prepared in local Git; committing and publishing require the user's later instruction.
