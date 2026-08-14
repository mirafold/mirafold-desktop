# Microsoft Store identity and packaging record

Verified against the repository and Microsoft's current documentation on
2026-08-14. This is the durable state record for the Store work. The live
walkthrough still gives Kyle exactly one action at a time; this file is not a
request to complete several dashboard steps at once.

## Direct answer about cost

Mirafold can use the Microsoft Store without buying an annual Windows
code-signing certificate.

- New **Individual and Company** Microsoft Store developer accounts have no
  registration fee when enrollment begins at
  [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com/).
  Microsoft warns that entering through older Partner Center or Visual Studio
  routes can still show the legacy registration flow.
- Microsoft signs a submitted MSIX/AppX package after certification at no
  charge. The Store also hosts that package and delivers its updates without a
  separate hosting or update-service fee.
- That free Store signature applies only to the Store-delivered package. It
  does not sign Mirafold's direct-download NSIS `.exe`; the direct installer
  remains unsigned unless the project later chooses a separate paid signing
  service or certificate.
- Submitting the existing NSIS `.exe` to the Store would not solve this. The
  Store's EXE/MSI path requires the installer and every executable it contains
  to already have a CA-trusted signature. Mirafold therefore needs the separate
  AppX/MSIX package planned here.

The relevant Microsoft sources are [developer-account enrollment](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account),
[first-app publication and Store signing](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app),
and [MSIX signing options](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview).

## The account type is a durable legal choice

The earlier plan assumed a free Individual account. That is no longer the
correct recommendation for the product currently described by this repository.
Microsoft's current [Store Policy 10.14](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
requires a Company account for a business, an organization, or any person
acting in relation to a trade or profession. Microsoft also says to use a
Company account when a reasonable customer would interpret the publisher name
as a business. Mirafold is a branded product with a planned paid tier, so the
current evidence favors a **free Company account**.

An Individual account is not a no-cost shortcut for commercial publication.
Microsoft describes it for a person publishing under their own name outside
their business, trade, or profession—for example, a hobby or non-commercial
project. Partner Center does not convert an Individual account to Company
later; changing course requires a new account. Microsoft also documents the
account type, publisher display name, and country/region as choices that cannot
ordinarily be changed after registration. No enrollment should start until the
correct legal publisher is known.

The repository does not establish whether Kyle currently operates Mirafold
through a registered entity, a documented sole proprietorship, or neither.
That real-world fact is unverified, and this document does not invent it.

### Company account consequences

Company enrollment is free and can begin with either a personal Microsoft
account or an organization's Microsoft Entra work account. Verification
requires all of the following:

- either a no-cost D-U-N-S number or accepted current business documentation;
- an exact legal entity name and address matching that evidence;
- an individual work email on the organization's domain, with domain evidence
  if Microsoft cannot match it automatically; and
- current contact and customer-support information.

Automated verification can be quick; Microsoft's current guidance says a
manual review commonly takes two to five business days. Company accounts can
later assign multiple Partner Center users. Depending on region and regulation,
seller support information can be displayed on the Store product page.

Do not paste business documents, identity documents, addresses, verification
codes, account recovery material, tax information, a D-U-N-S number, or Store
credentials into chat or this public repository. Kyle performs verification in
Microsoft's own browser flow.

### Individual account consequences

Individual enrollment is also free, but it uses a personal Microsoft account
and requires a government-issued ID plus a selfie. It publishes under the
individual's identity, supports one account user, and cannot later be converted
to Company. It is appropriate here only if Kyle establishes that Mirafold is a
personal, non-commercial project unrelated to a business or profession.

## Verified repository state

| Component | Observed state |
| --- | --- |
| Direct Windows package | `electron-builder.yml` contains only the existing per-user NSIS target. |
| Store package | No AppX/MSIX target, Store manifest, Store assets, Store build command, or Store workflow exists. Creating them is new implementation. |
| Partner Center account | External and unverified. No repository evidence establishes that an account exists. |
| Reserved product | External and unverified. No Partner Center product identity is recorded. |
| Store identity values | Missing. No placeholder identity is present or allowed to ship. |
| Runtime update separation | Existing. `src/main.js` passes Electron's `process.windowsStore` value into `src/updater.js`. Store packages never construct `electron-updater`; Help displays **Updates managed by Microsoft Store**. |
| Policy tests | Existing unit tests prove the Store/non-Store updater decision boundary. They do not prove that a real Store package sets the flag or runs correctly. |
| Packaging support | Existing dependency `electron-builder@26.15.3` contains a Windows-only `appx` target. It accepts the three Partner Center manifest identity values and automatically declares the `runFullTrust` capability required by Electron. This target is not configured in Mirafold yet. |
| Human proof | Missing. No Store package has been installed, updated, or certified on real Windows. |

The Electron type bundled in this repository defines `process.windowsStore` as
true for an MSIX package, including AppX for Windows Store. The current runtime
uses that exact platform signal; no filename, environment-variable, or build-
time guess controls the update channel.

## What name reservation creates

After the correct account is verified, Partner Center's **New product → MSIX or
PWA app** flow can reserve `Mirafold` if it is available. A reservation creates
a private product record and prevents another developer from reserving that
Store name. It does not publish a listing or upload an application. Microsoft's
current [name-reservation documentation](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/reserve-your-apps-name)
says an unused reservation is removed after three months, so reservation should
happen only when the package work is ready to follow.

Reserving a different spelling merely to avoid an unavailable name would be a
product decision, not a mechanical workaround. Stop and ask Kyle if `Mirafold`
is unavailable.

## Non-secret identity values needed by the build

Once a name is reserved, Partner Center exposes the product's identity under
**Product management → Product identity**. Microsoft requires these exact
manifest values for a manually built package:

| Partner Center field | Future electron-builder field | State |
| --- | --- | --- |
| `Package/Identity/Name` | `appx.identityName` | Pending real value |
| `Package/Identity/Publisher` | `appx.publisher` | Pending real value |
| `Package/Properties/PublisherDisplayName` | `appx.publisherDisplayName` | Pending real value |

Partner Center also shows the Store ID and Package Family Name. Record those for
later installation verification, but they are not substitutes for the three
manifest values. Microsoft's [product-identity documentation](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
defines this boundary.

These identity strings are intended to appear in the public package manifest,
but this repository is public too. Kyle must review them before they are
committed. Seller IDs, user IDs, access tokens, tenant secrets, tax data, and
verification evidence are not package identity and never belong here.

## What Step 6.4 will create after identity exists

The later Store-package Step creates, rather than “fixes,” all of the following:

- a separate AppX build configuration using the real Partner Center identity;
- Store-specific icon/tile assets and a deterministic package filename;
- a Windows-native build and manifest/package verifier that keeps the Store
  artifact separate from the nine direct-release files;
- evidence that the package contains the daemon, both native Windows modules,
  and the expected full-trust packaged-classic application declaration;
- tests that the Store runtime cannot activate or contact the GitHub update
  path, and that generated Store resources carry no direct-channel feed
  configuration; and
- a real-Windows installation/runtime test, followed later by a Store-signed
  hidden-availability and Store-update test.

The direct NSIS target, Linux targets, child-process architecture, lack of
preload/IPC, project-folder selection, and provider credential ownership remain
behaviorally unchanged.

Electron apps need the restricted `runFullTrust` capability. The certification
explanation will state literally that Mirafold is a packaged classic desktop
application which launches its bundled local daemon and coding-agent child
processes, provides a real ConPTY terminal, and watches the user-selected
project folder. It does not install a service or request elevation. A manifest
that requests additional capabilities without a verified use site must fail
review before submission.

## Walkthrough state

| Gate | Required evidence | State |
| --- | --- | --- |
| Correct account type | Kyle's real legal/business status reconciled with Store Policy 10.14 | Pending; Company currently recommended |
| Account enrollment | Partner Center shows a verified Windows developer account | Pending external action |
| Name reservation | Partner Center has one `Mirafold` MSIX/PWA product | Pending external action |
| Package identity | The three exact manifest values have been reviewed for this public repo | Pending external action |
| Package build | AppX artifact and structural/runtime evidence | Not implemented |
| Certification | Partner Center certification report | Not submitted |
| Hidden Store proof | Store-signed install and Store-delivered higher-version update on real Windows | Not tested |
| Broad availability | Separate explicit approval from Kyle | Not authorized |

No Store action is currently assigned to Kyle. The active human action remains
the Windows-tester recruitment recorded in `WINDOWS-TESTING.md`. When the Store
walkthrough begins, each dashboard or identity action will be given separately,
including its dollar cost, privacy consequence, exact click or response, and
the evidence that means it is done.
