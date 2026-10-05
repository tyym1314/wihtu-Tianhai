#!/bin/bash
set -euo pipefail
umask 077

TASK_ROOT="$(cd "$(dirname "$0")" && pwd)"
TASK_SDK="${OASIS_ANDROID_SDK:-/Users/tyym/Library/Android/sdk}"
TASK_JAVA="${OASIS_JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
TASK_TOOLS="$TASK_SDK/build-tools/35.0.1"
TASK_ANDROID_JAR="$TASK_SDK/platforms/android-35/android.jar"
export JAVA_HOME="$TASK_JAVA"
export PATH="$TASK_JAVA/bin:$PATH"
for task_tool in aapt2 d8 zipalign apksigner; do
  test -x "$TASK_TOOLS/$task_tool" || { echo "Missing SDK tool: $task_tool" >&2; exit 1; }
done
test -f "$TASK_ANDROID_JAR"
test -x "$TASK_JAVA/bin/javac"

mkdir -p "$TASK_ROOT/build/classes" "$TASK_ROOT/build/dex" "$TASK_ROOT/build/generated" "$TASK_ROOT/dist" "$TASK_ROOT/.local/signing"
find "$TASK_ROOT/build/classes" -type f -name '*.class' -delete
TASK_KEY="$TASK_ROOT/.local/signing/debug.jks"
TASK_PASS="$TASK_ROOT/.local/signing/password"
if [ ! -f "$TASK_KEY" ]; then
  if [ ! -f "$TASK_PASS" ]; then
    /usr/bin/openssl rand -base64 32 > "$TASK_PASS"
  fi
  "$TASK_JAVA/bin/keytool" -genkeypair -keystore "$TASK_KEY" -storetype JKS \
    -storepass:file "$TASK_PASS" -keypass:file "$TASK_PASS" \
    -alias oasis-local-debug -keyalg RSA -keysize 3072 -validity 3650 \
    -dname 'CN=OASIS Local WebView Test,OU=Development,O=Tianyahuyu,C=CN' -noprompt
fi
chmod 600 "$TASK_KEY" "$TASK_PASS"

"$TASK_TOOLS/aapt2" compile --dir "$TASK_ROOT/app/res" -o "$TASK_ROOT/build/resources.zip"
"$TASK_TOOLS/aapt2" link -o "$TASK_ROOT/build/base.apk" \
  --manifest "$TASK_ROOT/app/AndroidManifest.xml" \
  -I "$TASK_ANDROID_JAR" --java "$TASK_ROOT/build/generated" \
  "$TASK_ROOT/build/resources.zip"
"$TASK_JAVA/bin/javac" -encoding UTF-8 --release 8 -classpath "$TASK_ANDROID_JAR" \
  -d "$TASK_ROOT/build/classes" \
  "$TASK_ROOT/app/src/com/tianyahuyu/oasis/smoke/"*.java
"$TASK_JAVA/bin/jar" cf "$TASK_ROOT/build/classes.jar" -C "$TASK_ROOT/build/classes" .
"$TASK_TOOLS/d8" --debug --min-api 26 --lib "$TASK_ANDROID_JAR" \
  --output "$TASK_ROOT/build/dex" "$TASK_ROOT/build/classes.jar"
cp "$TASK_ROOT/build/base.apk" "$TASK_ROOT/build/unsigned.apk"
(cd "$TASK_ROOT/build/dex" && /usr/bin/zip -q -X "$TASK_ROOT/build/unsigned.apk" classes.dex)
"$TASK_TOOLS/zipalign" -f -p 4 "$TASK_ROOT/build/unsigned.apk" "$TASK_ROOT/build/aligned.apk"
"$TASK_TOOLS/apksigner" sign --ks "$TASK_KEY" --ks-key-alias oasis-local-debug \
  --ks-pass "file:$TASK_PASS" \
  --out "$TASK_ROOT/dist/oasis-android-smoke-1.1.1-debug.apk" "$TASK_ROOT/build/aligned.apk"
"$TASK_TOOLS/apksigner" verify --verbose "$TASK_ROOT/dist/oasis-android-smoke-1.1.1-debug.apk"
"$TASK_TOOLS/aapt2" dump badging "$TASK_ROOT/dist/oasis-android-smoke-1.1.1-debug.apk"
node "$TASK_ROOT/build-metadata.mjs"
cat "$TASK_ROOT/dist/SHA256SUMS"
printf 'APK: %s\n' "$TASK_ROOT/dist/oasis-android-smoke-1.1.1-debug.apk"
