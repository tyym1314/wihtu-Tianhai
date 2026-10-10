#!/bin/bash
set -euo pipefail
umask 077

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
# Validate all public input before creating a signing key or starting Android tools.
TASK_FLAVOR="$(node "$TASK_ROOT/validate-build.mjs" "$@")"
case "$TASK_FLAVOR" in release|qa|qa-contract) ;; *) exit 1 ;; esac
mkdir -p "$TASK_ROOT/.local"
if ! mkdir "$TASK_ROOT/.local/build.lock" 2>/dev/null; then
  echo 'Another player APK build holds the module lock; no output or signing material was changed.' >&2; exit 1
fi
trap 'rmdir "$TASK_ROOT/.local/build.lock"' EXIT
TASK_PREPARED_FLAVOR="$(node "$TASK_ROOT/build-config.mjs" "$@")"
test "$TASK_FLAVOR" = "$TASK_PREPARED_FLAVOR"
TASK_SDK="${OASIS_ANDROID_SDK:-/Users/tyym/Library/Android/sdk}"
TASK_JAVA="${OASIS_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
TASK_TOOLS="$TASK_SDK/build-tools/35.0.1"
TASK_ANDROID_JAR="$TASK_SDK/platforms/android-35/android.jar"
TASK_BUILD="$TASK_ROOT/build/$TASK_FLAVOR"
TASK_SOURCE="$TASK_ROOT/app/src/com/tianyahuyu/oasis/player"
TASK_OUTPUT="$TASK_ROOT/dist/$TASK_FLAVOR"
TASK_SIGNING_FLAVOR=qa
TASK_DEX_MODE=--debug
if [ "$TASK_FLAVOR" = release ]; then TASK_SIGNING_FLAVOR=release; TASK_DEX_MODE=--release; fi
export JAVA_HOME="$TASK_JAVA"
export PATH="$TASK_JAVA/bin:$PATH"
for task_tool in aapt2 d8 zipalign apksigner; do
  test -x "$TASK_TOOLS/$task_tool" || { echo "Missing SDK tool: $task_tool" >&2; exit 1; }
done
test -f "$TASK_ANDROID_JAR"
test -x "$TASK_JAVA/bin/javac"

node --test "$TASK_ROOT/test/build-config.test.mjs" | tee "$TASK_BUILD/configuration-checks.tap"
mkdir -p "$TASK_BUILD/classes" "$TASK_BUILD/test-classes" "$TASK_BUILD/dex" "$TASK_OUTPUT"
rm -f "$TASK_OUTPUT/build-metadata.json" "$TASK_OUTPUT/SHA256SUMS"
find "$TASK_BUILD/classes" "$TASK_BUILD/test-classes" "$TASK_BUILD/dex" -type f -delete
"$TASK_TOOLS/aapt2" compile --dir "$TASK_BUILD/generated/res" -o "$TASK_BUILD/resources.zip"
"$TASK_TOOLS/aapt2" link -o "$TASK_BUILD/base.apk" \
  --manifest "$TASK_BUILD/generated/AndroidManifest.xml" -I "$TASK_ANDROID_JAR" "$TASK_BUILD/resources.zip"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -classpath "$TASK_ANDROID_JAR" \
  -d "$TASK_BUILD/classes" "$TASK_SOURCE/"*.java "$TASK_BUILD/generated/PlayerBuildConfig.java"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -classpath "$TASK_BUILD/classes" \
  -d "$TASK_BUILD/test-classes" "$TASK_ROOT/test/NavigationPolicyContract.java"
"$TASK_JAVA/bin/java" -cp "$TASK_BUILD/classes:$TASK_BUILD/test-classes" NavigationPolicyContract \
  | tee "$TASK_BUILD/navigation-checks.json"
"$TASK_JAVA/bin/java" -cp "$TASK_BUILD/classes:$TASK_BUILD/test-classes" NavigationPolicyContract \
  --back-script > "$TASK_BUILD/back-script.js"
node "$TASK_ROOT/test/back-bridge-contract.mjs" "$TASK_BUILD/back-script.js" \
  | tee "$TASK_BUILD/back-checks.json"
node "$TASK_ROOT/test/activity-lifecycle-contract.mjs" \
  | tee "$TASK_BUILD/activity-checks.json"

mkdir -p "$TASK_ROOT/.local/signing/$TASK_SIGNING_FLAVOR"
TASK_KEY="$TASK_ROOT/.local/signing/$TASK_SIGNING_FLAVOR/key.jks"
TASK_PASS="$TASK_ROOT/.local/signing/$TASK_SIGNING_FLAVOR/password"
if [ -f "$TASK_KEY" ] && [ ! -f "$TASK_PASS" ]; then
  echo 'Signing password is missing; existing signing identity was preserved.' >&2; exit 1
fi
if [ ! -f "$TASK_KEY" ] && [ -f "$TASK_PASS" ]; then
  echo 'Signing key is missing; incomplete signing state was preserved.' >&2; exit 1
fi
if [ ! -f "$TASK_KEY" ]; then
  /usr/bin/openssl rand -base64 32 > "$TASK_PASS"
  "$TASK_JAVA/bin/keytool" -genkeypair -keystore "$TASK_KEY" -storetype JKS \
    -storepass:file "$TASK_PASS" -keypass:file "$TASK_PASS" -alias "oasis-player-$TASK_SIGNING_FLAVOR" \
    -keyalg RSA -keysize 3072 -validity 3650 \
    -dname "CN=OASIS Player $TASK_SIGNING_FLAVOR,OU=Player,O=Tianyahuyu,C=CN" -noprompt
fi
chmod 600 "$TASK_KEY" "$TASK_PASS"
"$TASK_JAVA/bin/jar" cf "$TASK_BUILD/classes.jar" -C "$TASK_BUILD/classes" .
"$TASK_TOOLS/d8" "$TASK_DEX_MODE" --min-api 26 --lib "$TASK_ANDROID_JAR" \
  --output "$TASK_BUILD/dex" "$TASK_BUILD/classes.jar"
cp "$TASK_BUILD/base.apk" "$TASK_BUILD/unsigned.apk"
(cd "$TASK_BUILD/dex" && /usr/bin/zip -q -X "$TASK_BUILD/unsigned.apk" classes.dex)
"$TASK_TOOLS/zipalign" -f -p 4 "$TASK_BUILD/unsigned.apk" "$TASK_BUILD/aligned.apk"
TASK_APK_NAME="$(node -p "require(process.argv[1]).apkName" "$TASK_BUILD/build-config.json")"
"$TASK_TOOLS/apksigner" sign --ks "$TASK_KEY" --ks-key-alias "oasis-player-$TASK_SIGNING_FLAVOR" \
  --ks-pass "file:$TASK_PASS" --v4-signing-enabled false --out "$TASK_OUTPUT/$TASK_APK_NAME" "$TASK_BUILD/aligned.apk"
rm -f "$TASK_OUTPUT/$TASK_APK_NAME.idsig"
"$TASK_TOOLS/apksigner" verify --verbose --print-certs "$TASK_OUTPUT/$TASK_APK_NAME" > "$TASK_BUILD/signature-checks.txt"
"$TASK_TOOLS/aapt2" dump badging "$TASK_OUTPUT/$TASK_APK_NAME" > "$TASK_BUILD/apk-badging.txt"
"$TASK_TOOLS/aapt2" dump xmltree --file AndroidManifest.xml "$TASK_OUTPUT/$TASK_APK_NAME" > "$TASK_BUILD/apk-manifest.txt"
node "$TASK_ROOT/build-metadata.mjs" "$TASK_FLAVOR"
printf 'Player APK: %s\n' "$TASK_OUTPUT/$TASK_APK_NAME"
