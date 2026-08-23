#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Put the macOS signing credentials into the repository's secrets.
#
# Run this yourself. It exists so that nobody - no assistant, no CI log, no
# shell history - handles the key material on your behalf: the values go from
# your files, through base64, into `gh secret set` over stdin, and are never
# printed, never passed as arguments where `ps` could see them, and never
# written anywhere else on disk.
#
#   ./scripts/setup-signing.sh DeveloperID.p12 AuthKey_ABCD1234.p8
#
# What it needs first, in order, is in docs/signing.md. The short version:
#
#   1. A paid Apple Developer Program membership. Check before anything else at
#      developer.apple.com/account - without it the certificate below cannot be
#      created, and this is the step that costs money.
#   2. A "Developer ID Application" certificate, exported from Keychain Access
#      as a .p12 *with its private key*. Not "Apple Development", which signs
#      for your own machines only.
#   3. An App Store Connect API key with the Developer role, downloaded as .p8.
#      It can only be downloaded once. Put it somewhere you will still have it.
#
# Afterwards, tag a release and the build signs and notarizes itself.

set -euo pipefail

p12="${1:-}"
p8="${2:-}"

if [ -z "$p12" ] || [ -z "$p8" ]; then
  echo "usage: $0 <DeveloperID.p12> <AuthKey_XXXXXXXX.p8>" >&2
  exit 64
fi

for f in "$p12" "$p8"; do
  [ -f "$f" ] || { echo "no such file: $f" >&2; exit 66; }
done

command -v gh >/dev/null || { echo "gh is not installed" >&2; exit 69; }
gh auth status >/dev/null 2>&1 || { echo "gh is not signed in: run 'gh auth login'" >&2; exit 77; }

# The Key ID is in the filename Apple gives you - AuthKey_ABCD1234.p8 - so it is
# offered as a default rather than asked for blind.
guess_id="$(basename "$p8" | sed -n 's/^AuthKey_\(.*\)\.p8$/\1/p')"

echo "Certificate : $p12"
echo "API key     : $p8"
echo

read -rsp "Password you set when exporting the .p12: " p12_pass; echo
[ -n "$p12_pass" ] || { echo "that password cannot be empty - it is the one protecting the key" >&2; exit 65; }

read -rp "Key ID${guess_id:+ [$guess_id]}: " key_id
key_id="${key_id:-$guess_id}"
[ -n "$key_id" ] || { echo "the Key ID is on the same App Store Connect page as the download" >&2; exit 65; }

read -rp "Issuer ID (a UUID, on that same page): " issuer
[ -n "$issuer" ] || { echo "the Issuer ID cannot be empty" >&2; exit 65; }

echo
echo "Setting five secrets on $(gh repo view --json nameWithOwner -q .nameWithOwner):"

# Every value goes in over stdin. Passing them as arguments would put the
# certificate password and the issuer into the process table.
base64 -i "$p12" | gh secret set MAC_CERT_P12
printf '%s' "$p12_pass"  | gh secret set MAC_CERT_PASSWORD
base64 -i "$p8"  | gh secret set APPLE_API_KEY_BASE64
printf '%s' "$key_id"    | gh secret set APPLE_API_KEY_ID
printf '%s' "$issuer"    | gh secret set APPLE_API_ISSUER

unset p12_pass

echo
echo "Set. Names only, to confirm - GitHub will not show the values again either:"
gh secret list

cat <<'NEXT'

Next:

  git tag -a vX.Y.Z -m "boofwang X.Y.Z" && git push origin vX.Y.Z

The macOS leg will sign, turn on the hardened runtime and notarize, which adds
five to fifteen minutes. Then, on a downloaded build:

  spctl --assess --type execute --verbose /Applications/boofwang.app

"accepted" and "source=Notarized Developer ID" is the goal. Until then it will
say "code has no resources but signature indicates they must be present", which
is what an unsigned bundle looks like.
NEXT
