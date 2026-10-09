#!/bin/bash
set -euo pipefail
umask 077
TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
TASK_JAVA="${OASIS_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
TASK_TEST="$TASK_ROOT/build/contracts"
mkdir -p "$TASK_TEST/classes"
node --test "$TASK_ROOT/test/build-config.test.mjs"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -d "$TASK_TEST/classes" \
  "$TASK_ROOT/app/src/com/tianyahuyu/oasis/player/NavigationPolicy.java" "$TASK_ROOT/test/NavigationPolicyContract.java"
"$TASK_JAVA/bin/java" -cp "$TASK_TEST/classes" NavigationPolicyContract
"$TASK_JAVA/bin/java" -cp "$TASK_TEST/classes" NavigationPolicyContract --back-script > "$TASK_TEST/back-script.js"
node "$TASK_ROOT/test/back-bridge-contract.mjs" "$TASK_TEST/back-script.js"
