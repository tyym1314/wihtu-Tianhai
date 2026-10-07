// Pinned start policies: paid rooms keep the shared human countdown; a solo
// human with BOTs can begin once that human has rendered and acknowledged.
export const RUN_FAIR_RULE_VERSION='pvp-run-v2.1.0';
export const RUN_PRACTICE_RULE_VERSION='pvp-run-v2.2.0';
export const RUN_SCENE_READY_POLICY='scene-ready-v1';
export const runRequiresSceneReady=version=>version===RUN_FAIR_RULE_VERSION||version===RUN_PRACTICE_RULE_VERSION;
