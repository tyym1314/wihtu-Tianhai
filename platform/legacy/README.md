# Isolated legacy presentations

Build with `npm run build:legacy` from `platform/`, or `node platform/scripts/build-legacy.mjs` from the repository root. The script copies original `src/` into `platform/.local/legacy-src/`, applies platform-only integration patches there, builds into `platform/legacy/dist/`, and verifies that every original source fingerprint is unchanged. Original standalone games and their default APIs are not rewritten.

The platform server serves `dist/thunder.html` and `dist/tiger.html` at `/play/thunder` and `/play/tiger`, with all static resources served below `/legacy/`. Art, character behavior, reels, effects, auto play and audio use the original implementations. Only wallet routing, platform profile/cap copy, clipped-win attribution and confirmed-balance handling differ in the platform copy.

The page waits for an opener or parent window of exactly `location.origin` (or the explicitly configured `VITE_OASIS_HOST_ORIGIN`). It sends `{type:'oasis.ready',game_id}` to that origin. The host sends `{type:'oasis.launch',launch_code}` from that same window. The bridge exchanges this one-time code using `POST /v1/launch/exchange` with a random `client_instance_id`, stores the returned Bearer token only in module memory, loads the authenticated profile, and then imports the original game entry point. Direct navigation displays a return-to-partner message; it never creates a standalone demo wallet. Codes/tokens are never put in URL/hash or web storage.

Old game API calls become `/api/play/{game}/{session|spin|ack|history|config}` with the Bearer header. Reset is hidden and locally denied. The backend's `SETTLEMENT_PENDING` error preserves the original retry request ID in the temporary UI copy; reload recovery still depends on the platform session API restoring the durable cycle. Session/spin/ack profile changes trigger a config refresh, updating the visible version and payout table without requiring the page to close.

The displayed wallet balance is the confirmed available balance after complete-cycle settlement. Subsequent free-spin or respin animation does not debit or credit again. The root backend supplies frozen round results and exact `freeSpinsAfter`; acknowledgement never performs settlement.

`bridge-smoke.ts` is an isolated headless Chrome test with a mock App wallet and real math fixtures. Run it from repository root using `node_modules/.bin/tsx platform/legacy/bridge-smoke.ts`. Its report and screenshots are evidence of this adapter test only. They are not production partner integration or physical-phone/audio acceptance.
