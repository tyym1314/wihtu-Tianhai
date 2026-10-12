# Actual Android Player performance collector

`android-player-performance.mjs` attaches to the signed real QA shell on ADB
`5037`, physical serial `46dcfd25`. It does not install an APK, create an account,
fund a wallet or use a Mock backend. Without `--run`, it only verifies local
artifact, signature and source pins. A contract fixture is refused by the shared
Player artifact verifier.

## Current validation state — 2026-10-12

The final native-input preparation now checks the same element's enabled state
immediately before ADB input. Its 43 focused tests passed and commit
`0ffbe49c164f2cddc04e80cb6b97f7b0adce3021` is pushed. A state change before input
keeps the original observation and retries within the existing bound. Trusted
events, document identity, clocks, feedback and performance limits are retained.
This change has not yet passed a new physical performance run.

Source09 was actually staged and all 1,210 release members verified. Staging
kept the production source08 pointer, 47 relations, processes and static assets
unchanged; it did not activate the candidate. The latest mixed A5 attempt failed
at a lossless-metadata check before any browser or measurement. Root separately
removed its own container, network and 11 secrets and independently verified
the restored protected baseline. The original failure remains failed.

The latest physical A9 run failed with
`OWNED_NATIVE_TAP_EXACT_TRUSTED_CLICK_REQUIRED`. Its original playable entry
was 11,001 ms, continuous sampling reached only 1,695 ms, and resource evidence
was not finalized. All 30 original PNGs, errors and failure remain preserved.
Root independently verified the owned room cancellation, original QA foreground
and forwards, empty real-account recovery and zero available/reserved balances;
the newly owned login was precisely revoked. Original failure audit:
`review/firstparty-release-20261010/root-phone-teardown-formal-a9-20261012/root-original-failure-audit.json`,
SHA `4b9e60c84d9bb2cbefd3f118980b836b1977511d5b29a4eaa3a761a2fa176848`.

Local Run changes now synchronize React controls at actual frame state
boundaries and correct the Run-scoped CSS priority that let global active
translation override the original `.94` feedback scale. Browser regression
passed with both CSS load orders. The feedback validator now accepts the
specified click `isPrimary=false`; down/up still require true. Trusted input,
pointer identity, event order, timing, PNG and 0.5 geometry gates remain intact.
These changes have not established a new deployed physical performance pass.

Canonical Carrom/Pool physics now use the validated ordered axis exclusions.
Ordinary server Node20 ABBA a2 results were byte-identical to the original;
average calculation times improved approximately 16%/17.5%, while P95 did not
improve in every group. This fixed-shot diagnosis is not capacity acceptance.
Full isolated release tests a2 passed 2,924/2,924 in 35.076 seconds with empty
stderr, the owned test database removed and all 11 source pins unchanged.
The two initial a1 fixture failures remain preserved; only their missing
clock/registration fields were corrected. Product commit
`6bae9b59ff625bfd0f76fa2c24a9b531e225a932` completed `build:release` and independent
build verification. The source09 package and 529,579-byte source08 delta are
prepared; production refresh and new physical results remain pending.

Mac/server mixed-capacity a1/a2/a3 refused during preflight and never entered
load. The new server a2 preparation corrects the frozen basis binding while
retaining the real admission guard. The 20,883-byte minimal APK exists;
public APK delivery and complete device, network, content and capacity release
gates remain incomplete. Confirmed production still serves source08; the local
product changes have not been deployed there.

## Collector operation

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


## Historical evidence through A8

Historical A8 (2026-10-12): the single run exited `13` after 12.250 seconds
with `Detected unsettled top-level await`. Only preflight was saved: zero PNGs,
zero rounds and no continuous performance evidence. The exact pending await is
unproven. Root removed only its own `tcp:63604`, restored the original QA
foreground and retained the inherited cloud forward. Real-account recovery was
`[]`, available/reserved wallet balances were zero, and the new owned login was
logged out. The original failure audit SHA is
`6e1dfa9d61efb8328150a1a0c1e78abebc22fbdb3288f5cfda84c699b7977784`.

The applied collector change bounds close-path waits and records sanitized
progress. Gameplay, sampling and thresholds remain unchanged. All 116 related tests, including seven new
maintained mechanism tests, passed with empty stderr;
the application receipt is 3736 bytes, SHA
`4eabc018f7ac415801ad542749f7aef3253a1ad57ab5f69f222863ff9b3c7770`.
At that point, a fresh physical performance run remained pending. The first ordinary Node20 ABBA
attempt failed during loader initialization, before any shot or timing sample.
Its seven cleanup/source/protected-state checks passed; Root original audit SHA
is `43f369b144a34134a3614d378dcc29f6dd8bf86ac6f666dd195d3f803529a5f0`.
Mac mixed-capacity preparation had not yet been executed. These statements
describe the historical A8/a1 state; the current state is recorded above.
