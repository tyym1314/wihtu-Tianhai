// Pinned start policies: paid rooms keep the shared human countdown; a solo
// human with BOTs can begin once that human has rendered and acknowledged.
export const RUN_FAIR_RULE_VERSION='pvp-run-v2.1.0';
export const RUN_PRACTICE_RULE_VERSION='pvp-run-v2.2.0';
// Only the new explicit input protocol may select this free BOT profile.
export const RUN_PRACTICE_INPUT_RULE_VERSION='pvp-run-v2.3.0';
export const RUN_SCENE_READY_POLICY='scene-ready-v1';
export const runInstantPracticeStart=version=>version===RUN_PRACTICE_RULE_VERSION||version===RUN_PRACTICE_INPUT_RULE_VERSION;
export const runRequiresSceneReady=version=>version===RUN_FAIR_RULE_VERSION||runInstantPracticeStart(version);
