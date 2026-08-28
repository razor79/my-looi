#!/usr/bin/env bash
set -euo pipefail

umask 077

keystore="${MY_LOOI_RELEASE_KEYSTORE:-$HOME/.config/my-looi/signing/my-looi-release.keystore}"
alias_name="${MY_LOOI_RELEASE_KEY_ALIAS:-my-looi-release}"
signing_env="${MY_LOOI_SIGNING_ENV:-$HOME/.config/my-looi/signing/release.env}"

if [[ "$keystore" != /* || "$signing_env" != /* ]]; then
  echo "Keystore and signing environment paths must be absolute." >&2
  exit 1
fi
if [[ ! -f "$keystore" ]]; then
  echo "Release keystore not found: $keystore" >&2
  echo "Create it first with: bash scripts/create-release-keystore.sh" >&2
  exit 1
fi

mkdir -p "$(dirname "$signing_env")"
chmod 700 "$(dirname "$signing_env")"

cat <<MSG
This stores the My LOOI release-signing credentials locally so future builds
can run without re-exporting passwords in every shell.

Keystore: $keystore
Alias:    $alias_name
Config:   $signing_env

The config is outside the repository and will be chmod 600.
MSG

IFS= read -r -s -p "Keystore password: " store_password
echo
if [[ -z "$store_password" ]]; then
  echo "Password cannot be empty." >&2
  exit 1
fi
IFS= read -r -s -p "Key password (press Enter to use the same password): " key_password
echo
if [[ -z "$key_password" ]]; then
  key_password="$store_password"
fi

if ! keytool -list \
  -keystore "$keystore" \
  -alias "$alias_name" \
  -storepass "$store_password" >/dev/null 2>&1; then
  echo "Could not open the keystore/alias with that password; nothing was saved." >&2
  unset store_password key_password
  exit 1
fi

# printf %q creates values that are safe to source from Bash even when a
# password contains spaces or shell metacharacters.
{
  printf '# Private local My LOOI release signing configuration. DO NOT COMMIT.\n'
  printf 'MY_LOOI_RELEASE_KEYSTORE=%q\n' "$keystore"
  printf 'MY_LOOI_RELEASE_KEY_ALIAS=%q\n' "$alias_name"
  printf 'MY_LOOI_RELEASE_STORE_PASSWORD=%q\n' "$store_password"
  printf 'MY_LOOI_RELEASE_KEY_PASSWORD=%q\n' "$key_password"
} > "$signing_env"
chmod 600 "$signing_env"

unset store_password key_password

cat <<MSG

Saved private signing configuration:
  $signing_env

Future builds can now load it automatically. Normally you only need:
  ./build-my-looi.sh

To remove stored passwords later:
  rm -f '$signing_env'
Then export the signing variables manually before each build instead.
MSG
