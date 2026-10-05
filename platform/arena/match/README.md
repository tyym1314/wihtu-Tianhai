# Match Arena v2

New games use `pvp-match-v2.0.0` and `match-objectives-v2.0.0`. The server seed selects one shared objective: cascade score, collection of a specified gem color, or activation of existing special gems. All seats start with the same 6×6 board and per-column refill streams. Players diverge only through their actions.

The session still lasts 90 seconds. Score mode ranks by the existing cascade points. Collection mode ranks by original gems of the chosen color removed; special mode ranks by actual old special gems activated. Those two modes break equal objective totals by ordinary cascade points; both equal remains a tie. The visible target (1000 points / 24 gems / 4 activations) is a challenge milestone, not an early end or score cap. The HUD shows the mode, target/progress, objective units and tie-breaking score.

`rank.score` is the objective total and `rank.rawScore` is the ordinary cascade score. `view` includes a copied objective, authoritative progress and public standings, but never exposes seeds, another board or refill counters. Progress is accumulated from authoritative removed original tiles and effect records, not animation playback; invalid swaps and shuffles do not award progress.

`supportsRuleVersion` accepts only v1 and v2. `createState(seed, now, {players, ruleVersion?})` defaults to v2; explicit v1 and all persisted v1 state execute the preserved `engine-v1.mjs`, including the original HMAC domain, accepted cascade event, ranking and deadline behavior. New content never rewrites accepted v1 results.

Validation: [current content and UI evidence](qa/content-20260928/README.md). Physical iPhone acceptance, human playability and server capacity remain separate gates.
