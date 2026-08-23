# Signing the desktop builds

The releases are unsigned today, and the release notes say so. This is what it
would take to change that, what each option costs, and what it buys.

**Nothing here is required.** An unsigned build works; it just meets a warning
on first run. If that trade is acceptable, the honest thing is to leave it
unsigned and keep explaining it, which is what the release notes do now.

The pipeline is already wired. `scripts/desktop-build.mjs` signs when the
credentials are in the environment and builds unsigned when they are not, saying
which it did either way. Adding the secrets is the only step; no code changes.

---

## What signing is actually worth here

| | Unsigned | Signed | Signed and notarized |
|---|---|---|---|
| macOS first run | "cannot be opened because the developer cannot be verified", with no Open button in the dialogue | Same dialogue, but right-click → Open works cleanly | Opens normally |
| Windows first run | SmartScreen "unrecognised app", Run anyway is behind "More info" | Warning fades as the certificate builds reputation; EV certificates start clean | n/a |
| Cost | nothing | Apple $99/yr, Windows $200–400/yr | same |

The macOS jump from unsigned to *notarized* is the one that changes a user's
experience. Signed-but-not-notarized is barely better than unsigned, so if you
do this for macOS, do both.

---

## macOS

### The certificate you need is not the one you have

This machine currently has:

```
Apple Development: Benjamin Meadors (664XXCD8C2)   CSSMERR_TP_CERT_EXPIRED
localhost                                          CSSMERR_TP_CERT_EXPIRED
0 valid identities found
```

Two things are wrong with that, and the second matters more than the first.
They are expired — but **"Apple Development" is the wrong kind of certificate
anyway**. It signs builds for your own devices during development. Distributing
an app outside the App Store needs **"Developer ID Application"**, which is a
different certificate type and only exists for accounts in the paid Apple
Developer Program. Renewing what is there would not help.

### Steps

1. **Join the Apple Developer Program** — $99/yr, at
   [developer.apple.com/programs](https://developer.apple.com/programs/).
   Individual enrolment is fine; it puts your own name on the app rather than an
   organisation's.

2. **Create a Developer ID Application certificate.** Xcode → Settings →
   Accounts → Manage Certificates → `+` → Developer ID Application. Or through
   the portal at Certificates, Identifiers & Profiles.

3. **Export it as a .p12.** Keychain Access → My Certificates → find *Developer
   ID Application: your name* → right-click → Export. Set a password; you will
   need it in a moment. Export the certificate **with its private key** — if the
   export offers only `.cer`, you have selected the certificate rather than the
   key pair underneath it.

4. **Create an App Store Connect API key for notarization.** **The `.p8`
   downloads once.** There is no second chance to fetch it; losing it means
   revoking the key and issuing another. Save it somewhere durable before
   closing the tab.
   [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Users and
   Access → Integrations → App Store Connect API → `+`. Give it the **Developer**
   role. Download the `.p8` — *you can only download it once*. Note the Key ID
   and the Issuer ID from that page.

   An Apple ID with an app-specific password works too, but the API key is
   better: no password in a secret, and it is not tied to somebody's phone for
   two-factor.

5. **Add the repository secrets.**

   ```bash
   ./scripts/setup-signing.sh DeveloperID.p12 AuthKey_ABCD1234.p8
   ```

   It prompts for the export password, the Key ID and the Issuer ID, and sets
   all five. Every value goes in over stdin - never as an argument, where the
   process table would have it, and never printed.

   Run it yourself. The point of it being a script rather than a list of
   instructions is that the key material passes through your shell and nothing
   else: not an assistant, not a clipboard, not a CI log.

   | Secret | What |
   |---|---|
   | `MAC_CERT_P12` | base64 of the .p12 |
   | `MAC_CERT_PASSWORD` | the password you set on export |
   | `APPLE_API_KEY_BASE64` | base64 of the .p8 |
   | `APPLE_API_KEY_ID` | the Key ID, e.g. `ABCD1234XY` |
   | `APPLE_API_ISSUER` | the Issuer ID, a UUID |

   By hand instead, if you prefer: Settings → Secrets and variables → Actions,
   with `base64 -i DeveloperID.p12 | pbcopy` for the two file-shaped ones.

6. **Tag a release.** The workflow will sign, turn on the hardened runtime, and
   notarize. Notarization adds five to fifteen minutes.

### Checking it worked

```bash
codesign --verify --deep --strict --verbose=2 /Applications/boofwang.app
spctl --assess --type execute --verbose /Applications/boofwang.app
xcrun stapler validate /Applications/boofwang.app
```

`spctl` saying `accepted` and `source=Notarized Developer ID` is the goal.

---

## Windows

Harder than macOS, and the reason is worth knowing before you spend anything.

Since June 2023 the CA/Browser Forum requires code-signing private keys to live
on **hardware** — a USB token or an HSM. A `.pfx` file that CI can hold is no
longer how an ordinary OV certificate is issued. So the obvious approach, "buy a
certificate and put it in a secret", mostly does not work any more.

Three realistic routes:

**Azure Trusted Signing** — about $10/month, and the one that fits CI. Microsoft
holds the key in their HSM and you authorise signing through Azure. Requires an
Azure subscription and an identity validation. This is what I would choose.
electron-builder supports it directly through `azureSignOptions`.

**SignPath Foundation** — free for open-source projects, which boofwang is. They
issue and hold a certificate for approved projects. Slower to set up, needs an
application, and they impose build-transparency requirements you would have to
meet. Worth applying for precisely because the cost is zero.

**A hardware token you hold** — $200–400/yr, and you sign releases by hand on a
machine with the token plugged in. CI cannot do it. Fine if releases are rare.

If you go the `.pfx` route anyway (an older certificate, or an internal CA), the
pipeline already handles it: add `WIN_CERT_PFX` (base64) and
`WIN_CERT_PASSWORD` and it will be used.

**SmartScreen reputation is separate from signing.** A brand-new certificate
still triggers the warning until enough people have run the app. An EV
certificate skips that; an OV one earns it over weeks. Do not expect the warning
to vanish the day you sign.

---

## Linux

There is no equivalent to notarization. AppImages can carry a GPG signature that
almost nothing checks automatically. Distribution through Flathub gives users a
trusted install path and is a larger piece of work than signing.

Not worth doing now. The AppImage and tarball are fine as they are.

---

## If you sign nothing

Then keep the release notes honest, which they are: they explain Gatekeeper,
SmartScreen, and the Linux `dialout` group, and they say plainly that these are
what an unsigned binary from a small project looks like. That is a defensible
position for a GPL tool that people can build themselves — and the source is
right here, which is a stronger guarantee than a signature is.

What would not be defensible is signing badly: a certificate committed to the
repository, or a key in a secret that half the contributors can read. If it is
not worth doing properly, unsigned and explained is better.
