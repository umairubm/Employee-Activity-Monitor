#!/usr/bin/env bash
# Sign a CI-built WorkforceAgent.app with the Workforce self-signed certificate
# and package it for release. Runs on Linux/WSL (uses rcodesign); the private
# key never goes to CI or GitHub.
#
#   bash agent/packaging/macos/sign_release.sh <ci WorkforceAgent-macos-X.app.zip> <out dir> [kit url]
#
# Key dir: $WF_SIGN_DIR (default /mnt/d/Workforce/_keys/macos-codesign) with
# key.pem + cert.pem. Every release MUST be signed with the same certificate:
# installed agents only accept updates matching designated.req, and macOS ties
# the Screen Recording / Accessibility grants to it. A new key means every Mac
# needs a manual reinstall and new permission grants.
#
# Outputs in <out dir>:
#   WorkforceAgent-macos-<ver>.app.zip      upload in the dashboard (OTA)
#   WorkforceAgent-macos-<ver>-kit.zip      manual install: app + install.command
#                                           + guard + plists + uninstaller
#   ONE-LINE-INSTALL.txt                    the Terminal one-liner for the kit,
#                                           checksum-pinned (pass the kit url)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IN="${1:?usage: sign_release.sh <app.zip> <out dir>}"
OUT="${2:?usage: sign_release.sh <app.zip> <out dir>}"
KEYS="${WF_SIGN_DIR:-/mnt/d/Workforce/_keys/macos-codesign}"
REQ="$HERE/designated.req"
RCODESIGN="${RCODESIGN:-$(command -v rcodesign || echo "$HOME/.local/bin/rcodesign")}"

# Refuse a key that does not match the pinned certificate hash.
want="$(grep -o 'H"[0-9a-f]*"' "$HERE/designated.req.txt" | tr -d 'H"')"
have="$(openssl x509 -in "$KEYS/cert.pem" -outform DER | sha1sum | cut -d' ' -f1)"
if [ "$want" != "$have" ]; then
  echo "ERROR: $KEYS/cert.pem is not the pinned signing certificate." >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -I - "$IN" "$WORK/app" <<'PY'
import os, sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
for info in z.infolist():
    z.extract(info, sys.argv[2])
    mode = (info.external_attr >> 16) & 0o777
    if mode:
        os.chmod(os.path.join(sys.argv[2], info.filename), mode)
PY
APP="$WORK/app/WorkforceAgent.app"
[ -d "$APP" ] || { echo "ERROR: no WorkforceAgent.app in $IN" >&2; exit 1; }
VERSION="$(python3 -I -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb"))["CFBundleShortVersionString"])' "$APP/Contents/Info.plist")"

"$RCODESIGN" sign \
  --pem-file "$KEYS/key.pem" --pem-file "$KEYS/cert.pem" \
  --code-requirements-path "$REQ" \
  "$APP"

KIT="$WORK/WorkforceAgent-kit"
mkdir -p "$KIT"
cp -R "$APP" "$KIT/"
cp "$HERE/install.command" "$HERE/UninstallWorkforceAgent.command" "$HERE/guard.sh" \
   "$HERE/com.workforceanalytics.agent.plist" "$HERE/com.workforceanalytics.agent.guard.plist" \
   "$KIT/"
chmod +x "$KIT/install.command" "$KIT/UninstallWorkforceAgent.command" "$KIT/guard.sh"
chmod 644 "$KIT"/*.plist

mkdir -p "$OUT"
# Zip with Unix modes so ditto/Archive Utility restore executables.
python3 -I - "$WORK/app" WorkforceAgent.app "$OUT/WorkforceAgent-macos-$VERSION.app.zip" \
  "$WORK" WorkforceAgent-kit "$OUT/WorkforceAgent-macos-$VERSION-kit.zip" <<'PY'
import os, sys, zipfile
def pack(root, top, dest):
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for base, dirs, files in os.walk(os.path.join(root, top)):
            dirs.sort()
            for name in [""] + sorted(files):
                path = os.path.join(base, name) if name else base
                arc = os.path.relpath(path, root) + ("/" if not name else "")
                info = zipfile.ZipInfo(arc)
                info.create_system = 3
                mode = os.stat(path).st_mode
                info.external_attr = (mode & 0xFFFF) << 16
                if name:
                    info.compress_type = zipfile.ZIP_DEFLATED
                    with open(path, "rb") as fh:
                        z.writestr(info, fh.read())
                else:
                    info.external_attr |= 0x10
                    z.writestr(info, b"")
a = sys.argv[1:]
pack(a[0], a[1], a[2])
pack(a[3], a[4], a[5])
PY

(cd "$OUT" && sha256sum "WorkforceAgent-macos-$VERSION.app.zip" "WorkforceAgent-macos-$VERSION-kit.zip")

# One Terminal line that installs or upgrades a Mac: download, verify the
# pinned checksum (stops on mismatch), install. No quarantine flag is set on
# curl downloads, so Gatekeeper does not prompt.
KIT_SHA="$(sha256sum "$OUT/WorkforceAgent-macos-$VERSION-kit.zip" | cut -d' ' -f1)"
KIT_URL="${3:-<KIT-URL>}"
printf '%s\n' "curl -fsSL '$KIT_URL' -o /tmp/wf-kit.zip && echo '$KIT_SHA  /tmp/wf-kit.zip' | shasum -a 256 -c - && rm -rf /tmp/wf-kit && ditto -x -k /tmp/wf-kit.zip /tmp/wf-kit && WF_NO_PAUSE=1 bash /tmp/wf-kit/WorkforceAgent-kit/install.command; rm -rf /tmp/wf-kit /tmp/wf-kit.zip" > "$OUT/ONE-LINE-INSTALL.txt"
echo "Signed $VERSION -> $OUT"
echo "One-line install (also in ONE-LINE-INSTALL.txt):"
cat "$OUT/ONE-LINE-INSTALL.txt"
