#!/usr/bin/env bash
set -euo pipefail

umask 077

if ! command -v keytool >/dev/null 2>&1; then
  echo "keytool is missing. Install/use JDK 17 first." >&2
  exit 1
fi

destination="${1:-$HOME/.config/my-looi/signing/my-looi-release.keystore}"
alias_name="${MY_LOOI_RELEASE_KEY_ALIAS:-my-looi-release}"

if [[ "$destination" != /* ]]; then
  echo "Use an absolute keystore path so builds do not depend on the current directory." >&2
  exit 1
fi
if [[ -e "$destination" ]]; then
  echo "Refusing to overwrite existing signing key: $destination" >&2
  exit 1
fi

mkdir -p "$(dirname "$destination")"
chmod 700 "$(dirname "$destination")"

cat <<'MSG'
Creating the permanent My LOOI Android release key.

IMPORTANT:
- choose strong passwords and store them safely;
- keep at least one secure backup of the keystore;
- never commit the keystore or passwords to GitHub;
- losing this key means future APKs cannot update existing My LOOI installs.
MSG

keytool -genkeypair -v \
  -keystore "$destination" \
  -alias "$alias_name" \
  -keyalg RSA \
  -keysize 4096 \
  -validity 10000 \
  -dname "CN=My LOOI Release, O=My LOOI"

chmod 600 "$destination"

cat <<MSG

Keystore created:
  $destination
Alias:
  $alias_name

The generated keystore uses the same password for the store and key unless you
later deliberately change the key password. Configure automatic builds once with:
  bash scripts/configure-release-signing.sh

You can alternatively export MY_LOOI_RELEASE_KEYSTORE, MY_LOOI_RELEASE_KEY_ALIAS,
MY_LOOI_RELEASE_STORE_PASSWORD and MY_LOOI_RELEASE_KEY_PASSWORD manually.

For Google OAuth, obtain the permanent release SHA-1 with:
  keytool -list -v -keystore '$destination' -alias '$alias_name'

Do not send or commit the keystore/passwords. The SHA-1/SHA-256 certificate fingerprints are safe to share.
MSG
