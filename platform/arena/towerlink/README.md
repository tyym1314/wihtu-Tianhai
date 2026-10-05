# Tower Link

Current rule: `towerlink-v2.2.0`; pinned playable legacy: `towerlink-v2.1.0`. Map content: `towerlink-maps-v2.2.0`.

Six competitive maps cover three real road topologies: central bridgehead, outer-ring flank and inner/outer supply web. Every seat has rotationally identical roads, travel times and starting resources. Room seed selects one map from its player-count pair; the complete map remains in serialized state. Twelve existing training lessons keep their original maps, objectives and training version.

`createState(seed, now, {players, ruleVersion})` defaults to current and delegates explicit 2.1 to the full preserved engine. All state operations dispatch by persisted rule version; unsupported versions fail closed. Pending armies, upgrades, commands and old results are never rewritten into a new map.

Rules, evidence, repeatable commands and remaining acceptance limitations: [content QA](./qa/content-20260928/README.md), [content audit](./qa/content-20260928/audit.md).
