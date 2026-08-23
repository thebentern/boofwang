# Signing the desktop builds

macOS releases are signed with a Developer ID certificate and notarized. Windows
and Linux are not signed, and the release notes say so.

This records what was done for macOS, so it can be repeated when the certificate
expires or the account changes, and what the remaining platforms would cost.

The pipeline itself needs no changes. `scripts/desktop-build.mjs` signs when the
credentials are in the environment and builds unsigned when they are not, saying
which it did either way. That branch is why a contributor without a certificate
can still package the app.

---

## What signing is actually worth here

| | Unsigned | Signed | Signed and notarized |
|---|---|---|---|
| macOS first run | "cannot be opened because the developer cannot be verified", with no Open button in the dialogue | Same dialogue, but right-click → Open works cleanly | Opens normally |
| Windows first run | SmartScreen "unrecognised app", Run anyway is behind "More info" | Warning fades as the certificate builds reputation; EV certificates start clean | n/a |
| Cost | nothing | Apple $99/yr, Windows $200-400/yr | same |

The macOS jump from unsigned to *notarized* is the one that changes a user's
experience. Signed-but-not-notarized is barely better than unsigned, which is
why the pipeline treats notarization as part of the job rather than an extra.

---

## macOS - done

Signed and notarized since 0.1.2, on the personal Apple Developer account.

| | |
|---|---|
| Certificate | Developer ID Application: Benjamin Meadors (6YF6QJH524) |
| Sub-CA | G2, valid to September 2031 |
| Certificate expiry | 24 August 2031 |
| Notarization | App Store Connect API key, Developer role |

### The certificate you need is not the one Xcode gives you

An **Apple Development** certificate signs builds for your own devices during
development. Distributing outside the App Store needs **Developer ID
Application**, a different type that only exists for accounts in the paid
Apple Developer Program. Renewing an Apple Development certificate does not
help, and neither does having several of them.

Two traps when reading the keychain:

`security find-certificate -c "Developer ID"` matches **Developer ID
Certification Authority**, which is Apple's own intermediate CA and ships with
macOS. Finding it means nothing. Only `security find-identity -v -p codesigning`
proves you have a usable identity, because it lists only certificates whose
private key is also present.

An account can belong to several teams. The certificate's subject says which:
`O=` is the team's name and `OU=` its ID. Signing a personal project with an
employer's team puts the employer's name on the app and consumes one of their
Developer ID slots, so check before creating anything.

### Creating the certificate without Xcode

Xcode is not required. Command Line Tools carry `codesign`, `notarytool` and
`stapler`, which is everything the build and the checks need. The certificate
is then made through Keychain Access and the web portal.

**Keychain Access moved in macOS 26.** It is no longer in Utilities:

```bash
open "/System/Library/CoreServices/Applications/Keychain Access.app"
```

1. **Generate a CSR.** Keychain Access → Certificate Assistant → Request a
   Certificate From a Certificate Authority. Enter your email and name, leave
   the CA email empty, choose **Saved to disk** and tick **Let me specify key
   pair information**, then 2048 bits, RSA. The private key stays in the
   keychain and never becomes a file until you export it deliberately.

2. **Create the certificate** at
   [developer.apple.com/account/resources/certificates/list](https://developer.apple.com/account/resources/certificates/list)
   → `+` → Developer ID Application, and upload the CSR.

   **Check the team picker first** if you belong to more than one team.

   **Choose the G2 sub-CA.** The portal also offers "Previous Sub-CA", whose
   intermediate expires in February 2027 - a certificate issued under it is
   short-lived for no reason.

3. **Install it.** Double-clicking the downloaded `.cer` imports it into
   whichever keychain is selected in the sidebar, and if that is **iCloud** the
   import fails with:

   ```
   An error occurred. Unable to import "Developer ID Application: ...".
   Error: -25294
   ```

   `-25294` is `errSecNoSuchKeychain`. The iCloud keychain is not in the search
   list that `security list-keychains` prints and cannot take a certificate.
   Select **login** first, or skip the GUI entirely:

   ```bash
   security import ~/Downloads/developerID_application.cer \
     -k ~/Library/Keychains/login.keychain-db
   ```

4. **Confirm it is a usable identity**, not merely a certificate:

   ```bash
   security find-identity -v -p codesigning
   ```

   The Developer ID Application line must appear. It may appear twice with the
   same SHA-1, which is one identity reached through two keychain entries and
   is harmless.

5. **Export a `.p12`** from Keychain Access → **My Certificates**, with `login`
   selected. Right-click the *Developer ID Application* row → Export, and set a
   password. If Export offers only `.cer` you have selected the certificate
   rather than the key pair above it.

6. **Create an App Store Connect API key** for notarization, at
   [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → Users and
   Access → Integrations → App Store Connect API → Team Keys → `+`, with the
   **Developer** role. **The `.p8` downloads once.** Note the Key ID and the
   Issuer ID from that page.

   An Apple ID with an app-specific password works too, but the API key carries
   no password and is not tied to somebody's two-factor device.

### Setting the secrets

```bash
./scripts/setup-signing.sh DeveloperID.p12 AuthKey_ABCD1234.p8
```

It prompts for the export password, the Key ID and the Issuer ID, and sets all
five. Every value goes in over stdin - never as an argument, where the process
table would have it, and never printed.

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

Before setting them, check the `.p12` holds what you think. Use
`/usr/bin/openssl`: Homebrew's OpenSSL 3 refuses a Keychain Access export
without `-legacy`, because the export uses RC2.

```bash
/usr/bin/openssl pkcs12 -in Certificates.p12 -nokeys -clcerts | \
  /usr/bin/openssl x509 -noout -subject -dates
```

```bash
/usr/bin/openssl pkcs12 -in Certificates.p12 -nocerts -noout && echo "key present"
```

### Checking a build

A tagged release signs and notarizes both architectures. Notarization has taken
one to two minutes per architecture, not the five to fifteen Apple quotes.

```bash
spctl --assess --type execute --verbose /Applications/boofwang.app
```

`accepted` and `source=Notarized Developer ID` is the goal. Also worth running:

```bash
xcrun stapler validate /Applications/boofwang.app
```

A stapled ticket is what lets the app open on a machine with no network.

**Test on an untouched copy.** Unzipping and launching is enough. Do not try to
simulate a download by writing `com.apple.quarantine` by hand: a fabricated
quarantine record refers to a UUID that is not in LaunchServices' quarantine
database, and the app hangs in AppTranslocation before dyld finishes - no crash
report, nothing in the AMFI or syspolicy logs, just a process at `_dyld_start`
burning no CPU. That looked exactly like a signing defect for some time, and it
was the test that was broken, not the build.

### Entitlements

`build/entitlements.mac.plist` declares two keys where electron-builder's own
default declares three; the one left out is
`com.apple.security.cs.disable-library-validation`.

That is deliberate and it is verified. Library validation only rejects a library
whose Team ID differs from the app's, and every binary in the bundle - Electron
Framework, Squirrel, Mantle, ReactiveObjC and all four helpers - is signed with
`6YF6QJH524`. There is nothing for it to reject, so the exemption would weaken a
real control for nothing.

If a future dependency ships its own signed code, that stops being true and the
app will fail to launch under the hardened runtime. Add the key then, not
pre-emptively.

---

## Windows

Harder than macOS, and the reason is worth knowing before you spend anything.

Since June 2023 the CA/Browser Forum requires code-signing private keys to live
on **hardware** - a USB token or an HSM. A `.pfx` file that CI can hold is no
longer how an ordinary OV certificate is issued. So the obvious approach, "buy a
certificate and put it in a secret", mostly does not work any more.

Three realistic routes:

**Azure Trusted Signing** - about $10/month, and the one that fits CI. Microsoft
holds the key in their HSM and you authorise signing through Azure. Requires an
Azure subscription and an identity validation. This is what I would choose.
electron-builder supports it directly through `azureSignOptions`.

**SignPath Foundation** - free for open-source projects, which boofwang is. They
issue and hold a certificate for approved projects. Slower to set up, needs an
application, and they impose build-transparency requirements you would have to
meet. Worth applying for precisely because the cost is zero.

**A hardware token you hold** - $200-400/yr, and you sign releases by hand on a
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

## What would not be defensible

Signing badly: a certificate committed to the repository, or a key in a secret
that half the contributors can read. Where a platform is unsigned, saying so
plainly in the release notes is the honest position - and the source is right
here, which is a stronger guarantee than a signature is.
