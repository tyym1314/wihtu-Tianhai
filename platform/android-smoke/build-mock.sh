#!/bin/bash
set -euo pipefail
umask 077

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
# Validate and bind the HTTPS mock endpoint before touching any APK output.
node "$TASK_ROOT/prepare-mock-build.mjs"

TASK_SDK="${OASIS_ANDROID_SDK:-/Users/tyym/Library/Android/sdk}"
TASK_JAVA="${OASIS_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
TASK_TOOLS="$TASK_SDK/build-tools/35.0.1"
TASK_ANDROID_JAR="$TASK_SDK/platforms/android-35/android.jar"
TASK_BUILD="$TASK_ROOT/build/mock"
TASK_GENERATED="$TASK_BUILD/generated"
TASK_SOURCE="$TASK_ROOT/app/src/com/tianyahuyu/oasis/smoke"
TASK_OUTPUT="$TASK_ROOT/dist/oasis-android-mock-1.3.0-debug.apk"
export JAVA_HOME="$TASK_JAVA"
export PATH="$TASK_JAVA/bin:$PATH"
for task_tool in aapt2 d8 zipalign apksigner; do
  test -x "$TASK_TOOLS/$task_tool" || { echo "Missing SDK tool: $task_tool" >&2; exit 1; }
done
test -f "$TASK_ANDROID_JAR"
test -x "$TASK_JAVA/bin/javac"

mkdir -p "$TASK_BUILD/classes" "$TASK_BUILD/test-classes" "$TASK_BUILD/dex" "$TASK_ROOT/dist" "$TASK_ROOT/.local/signing"
find "$TASK_BUILD/classes" -type f -name '*.class' -delete
find "$TASK_BUILD/test-classes" -type f -name '*.class' -delete
TASK_KEY="$TASK_ROOT/.local/signing/mock-debug.jks"
TASK_PASS="$TASK_ROOT/.local/signing/mock-password"
if [ ! -f "$TASK_KEY" ]; then
  if [ ! -f "$TASK_PASS" ]; then /usr/bin/openssl rand -base64 32 > "$TASK_PASS"; fi
  "$TASK_JAVA/bin/keytool" -genkeypair -keystore "$TASK_KEY" -storetype JKS \
    -storepass:file "$TASK_PASS" -keypass:file "$TASK_PASS" \
    -alias oasis-isolated-mock -keyalg RSA -keysize 3072 -validity 3650 \
    -dname 'CN=OASIS Isolated Mock,OU=Development,O=Tianyahuyu,C=CN' -noprompt
fi
chmod 600 "$TASK_KEY" "$TASK_PASS"

"$TASK_TOOLS/aapt2" compile --dir "$TASK_ROOT/app/res" -o "$TASK_BUILD/resources.zip"
"$TASK_TOOLS/aapt2" link -o "$TASK_BUILD/base.apk" \
  --manifest "$TASK_GENERATED/AndroidManifest.xml" \
  -I "$TASK_ANDROID_JAR" --java "$TASK_BUILD/aapt-generated" \
  "$TASK_BUILD/resources.zip"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -classpath "$TASK_ANDROID_JAR" \
  -d "$TASK_BUILD/classes" \
  "$TASK_SOURCE/GameIconDrawable.java" "$TASK_SOURCE/MockPartnerApi.java" \
  "$TASK_GENERATED/src/com/tianyahuyu/oasis/smoke/MainActivity.java" \
  "$TASK_GENERATED/src/com/tianyahuyu/oasis/smoke/MockOrigin.java"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -classpath "$TASK_BUILD/classes" \
  -d "$TASK_BUILD/test-classes" "$TASK_ROOT/test/MockPartnerApiContract.java"
"$TASK_JAVA/bin/java" -cp "$TASK_BUILD/classes:$TASK_BUILD/test-classes" MockPartnerApiContract
"$TASK_JAVA/bin/jar" cf "$TASK_BUILD/classes.jar" -C "$TASK_BUILD/classes" .
"$TASK_TOOLS/d8" --debug --min-api 26 --lib "$TASK_ANDROID_JAR" \
  --output "$TASK_BUILD/dex" "$TASK_BUILD/classes.jar"
cp "$TASK_BUILD/base.apk" "$TASK_BUILD/unsigned.apk"
(cd "$TASK_BUILD/dex" && /usr/bin/zip -q -X "$TASK_BUILD/unsigned.apk" classes.dex)
"$TASK_TOOLS/zipalign" -f -p 4 "$TASK_BUILD/unsigned.apk" "$TASK_BUILD/aligned.apk"
"$TASK_TOOLS/apksigner" sign --ks "$TASK_KEY" --ks-key-alias oasis-isolated-mock \
  --ks-pass "file:$TASK_PASS" --out "$TASK_OUTPUT" "$TASK_BUILD/aligned.apk"
"$TASK_TOOLS/apksigner" verify --verbose "$TASK_OUTPUT"
"$TASK_TOOLS/aapt2" dump badging "$TASK_OUTPUT"
node "$TASK_ROOT/mock-build-metadata.mjs"
printf 'Local-only isolated mock APK: %s\n' "$TASK_OUTPUT"
