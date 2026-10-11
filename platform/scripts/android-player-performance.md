# Actual Android Player performance collector

`android-player-performance.mjs` attaches to the signed real QA shell on ADB
`5037`, physical serial `46dcfd25`. It does not install an APK, create an account,
fund a wallet or use a Mock backend. Without `--run`, it only verifies local
artifact, signature and source pins. A contract fixture is refused by the shared
Player artifact verifier.

Only run after the real production App, HTTPS, free BOT admission and real
private account are ready. Credentials must be an owned regular file with mode
`0600`, containing only `username` and `password`. They never belong in CLI
arguments, an environment variable, Git or the saved report. Output must be a
fresh directory; the collector creates it with mode `0700` and writes evidence
with mode `0600`.

From the repository root, local preflight uses:

```sh
node platform/scripts/android-player-performance.mjs \
  --metadata /private/actual-qa/build-metadata.json \
  --platform-manifest /private/actual-release/release-build-manifest.json \
  --apksigner /actual-android-sdk/build-tools/35.0.1/apksigner \
  --output /private/fresh-performance-preflight
```

The first actual device run should select the four priority games:

```sh
node platform/scripts/android-player-performance.mjs \
  --metadata /private/actual-qa/build-metadata.json \
  --platform-manifest /private/actual-release/release-build-manifest.json \
  --apksigner /actual-android-sdk/build-tools/35.0.1/apksigner \
  --credentials-file /private/actual-player-credentials.json \
  --output /private/fresh-priority-performance \
  --adb-port 5037 --serial 46dcfd25 \
  --games priority --sample-ms 60000 --room-ms 60000 --repetitions 5 --run
```

Omit `--games` for all 11 admitted arenas. `--games run,towerlink,golf,bowling`
is equivalent to `--games priority`. `--sample-ms` is the required aggregate
active time, and `--room-ms` bounds each legitimate room observation; the actual
per-room window is at least `sample-ms / (2 * repetitions)`. The default is five
cold and five warm entries per game, producing ten freshly created own free BOT
rooms. No existing room is adopted. Warm entries retain the same WebView,
process and authenticated Player context; cold entries clear only that owned
QA WebView's HTTP cache and reload its Player document. Authentication cookies
are retained. Actual CDP memory/disk/304 reuse evidence is required for warm
cache claims, and cache delivery observed in a cold entry remains a recorded
limitation. Neither elapsed time nor a fresh process implies cold HTTP cache.

The separate `android-physical-performance-v1` report records the actual
provider, device, display refresh, thermal state, installed APK and release
pins. It observes only the exact game iframe and its default CDP execution
context. A replaced frame, realm or document fails observation. No performance
fetch wrapper is installed. Authentication precedes body observers; the
collector never retrieves login or launch-exchange bodies. Functional identity
tokens live only in the shared authority observer and are redacted from saved
evidence. Saved CDP records contain timing, transfer sizes, paths and hashes,
without request headers or API bodies.

Repository manifest inputs use the real `platform/arena/` and `platform/shared/`
prefixes. The collector requires each selected game engine and critical shared
entry inputs, rejects path escapes and symlinked sources, verifies every bound
runtime input before observation and again after cleanup, and rechecks the
manifest itself. An empty or incorrectly prefixed set cannot establish source
identity.

RAF and supported long tasks are sampled in the actual game realm. Entry,
foreground gameplay, active authority, moving authority and active idle remain
separate. A slow action does not suspend the authority heartbeat. Long RAF
intervals that cross an authority lease remain in frame statistics; eligible
duration is capped separately, so a stall cannot disappear through a lease
expiry. Dune uses the negotiated `run_inputs.processedThroughCommandSeq` and
exact `/inputs` durable decision, rather than legacy `me_last_seq` or HTTP 200.
Every action is made through trusted native/CDP input and checked against the
original room and personal authority cursor.

Motion evidence uses PNG screenshots cropped to the actual render surface,
decoded with the PNG decoder already bundled in the installed Playwright
dependency. It compares pixels, not compressed image hashes. Pairs are sparse,
at least five seconds apart, and carry exact capture times. Capture overhead
is retained in RAF measurements. A smooth empty RAF or changing scoreboard
does not prove scene motion. Three completed original match outcomes,
15 minutes and 30 accepted interactions are separate sustained physical
requirements; a player's finish alone does not count as a completed round.
Default one-minute sampling may therefore remain partial. A sustained run can
request `--sample-ms 900000 --room-ms 900000`; legitimately finished rounds are
observed until the original outcome, and authority duration is never extended.

For Run, the complete feedback phase and its cleanup precede the two original
before-motion pairs; continuous sampling starts after both phases. The other
ten games retain motion before feedback. The motion labels remain relative to
continuous sampling. A hard feedback error propagates unchanged and leaves
Run's deferred motion unexecuted; it does not become successful evidence.

Run can explicitly select `--run-feedback-resolution css`; the default remains
`device`. The CSS profile derives output pixel bounds from the original guarded
viewport and checks every received PNG against those dimensions and scale 1.
It preserves the original PNG bytes, hashes, ACKs and errors, including rejected
frames. A correctly bound positive observation can prove a captured-content
upper bound; resized pixels do not prove full-resolution equivalence, earlier
absence or physical presentation. The 100 ms feedback threshold, classifier,
three-second action deadline and other ten games' capture paths are unchanged.

The standard limits remain in `specs/mobile-quality-v1.json`: active/moving
sample at least 60 seconds, frame P95 20 ms, P99 34 ms, maximum 100 ms and frames
over 50 ms no more than 0.5%; five cold/warm entries with P95 5/2.5 seconds;
critical static 3 MiB, image 768 KiB and snapshot 64 KiB. CDP encoded transfer
lengths are recorded without modification, including nonzero 304 response
headers; actual cache reuse is reported separately. Unsupported long
tasks, absent render surface/motion, an incomplete sample, unproven cache or
missing transfer evidence stay unmeasured/partial. Source changes, errors,
threshold breaches or failed cleanup remain failures.

Network loading/ACK values are reported as uncontrolled diagnostics until a
calibrated network cohort is supplied by a future explicit adapter. Visible
local-feedback latency is currently unmeasured: a request dispatch, authority
ACK or next RAF does not establish visible input feedback. Consequently this
collector cannot produce an overall launch acceptance pass by itself. It
reports useful actual device rendering and delivery evidence while preserving
those missing gates. It does not report GPU/presented FPS, certify iPhone
Safari, evaluate probability-game math, accept content quality, establish
third-party transfers or replace a server-capacity test.

Finally, the collector releases only its own rooms, stops only the signed own
QA package, removes only its exact temporary forward and restores the original
foreground and forward inventory. A changed inherited resource fails the
readback without deleting or restoring another task's changes.
An observer response timeout remains a measurement failure but does not skip
independently authorized original-room cleanup. Unknown room scope is refused;
cleanup failures and observer failures are recorded separately. Final cleanup,
provider or resource restoration errors always produce failure and exit `1`.

Local tests require no device or server:

```sh
cd platform
node --test scripts/android-player-performance-checks.test.mjs
```

Exit `0` means local preflight passed or all declared report gates passed;
`1` is failure and `2` is honest partial evidence. A selected subset never
claims all 11 games.
