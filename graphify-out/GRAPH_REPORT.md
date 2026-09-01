# Graph Report - mirafold-desktop  (2026-08-30)

## Corpus Check
- 77 files · ~102,736 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 755 nodes · 1689 edges · 40 communities (32 shown, 8 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Shell Release Coordination
- Daemon Process Lifecycle
- Desktop Window and Zoom
- APT Repository Builder
- Release Artifact Contract
- Packaged Runtime Smoke Tests
- Package Manifest Dependencies
- Linux Update Probes
- Shell Intake Preparation Tests
- Repository Hardening
- Desktop Update Orchestration
- Release Coordinator Tests
- Platform Update Installers
- Product Plans and Guides
- APT Key Creation
- GitHub APT Secret Setup
- Intake Workflow Tests
- Manual Release Workflow
- APT Key Backup
- Release Rehearsal
- Automated Shell Intake
- Architecture and Security Rules
- Daemon Bootstrap Process
- Release and CI Documentation
- Product Vocabulary
- Release Workflow Tests
- Desktop Packaging Configuration
- Release Recovery Contract
- APT Backup Tests
- APT Key Creation Tests
- Main Lifecycle Tests
- Contribution Workflow
- GitHub Action Pin Tests
- Loading Screen
- CI Workflow Tests
- Dependabot Policy Tests
- Release Documentation Tests

## God Nodes (most connected - your core abstractions)
1. `invariant()` - 87 edges
2. `createDesktopUpdater()` - 25 edges
3. `prepareReleaseCandidate()` - 24 edges
4. `invariant()` - 20 edges
5. `invariant()` - 19 edges
6. `stableVersion()` - 18 edges
7. `terminateProcessTree()` - 16 edges
8. `exerciseAppImageTransition()` - 15 edges
9. `expectedReleaseAssets()` - 15 edges
10. `validateReleasePlan()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `Desktop Pull Release Architecture` --conceptually_related_to--> `Automated Shell Intake Workflow`  [INFERRED]
  PLAN.md → .github/workflows/shell-intake.yml
- `Thin Electron Shell Boundary` --semantically_similar_to--> `Desktop-versus-Upstream Security Scope`  [INFERRED] [semantically similar]
  CLAUDE.md → SECURITY.md
- `No Renderer Bridge` --semantically_similar_to--> `No Renderer Bridge`  [INFERRED] [semantically similar]
  CLAUDE.md → SECURITY.md
- `Signed APT Archive` --references--> `Mirafold APT Archive Fingerprint`  [INFERRED]
  SECURITY.md → packaging/apt/fingerprint.txt
- `temporaryDirectory()` --calls--> `run()`  [EXTRACTED]
  test/release-contract.test.js → scripts/apt-repository.mjs

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Manual Release Delivery Pipeline** — github_workflows_release_build_job, github_workflows_release_apt_signing_job, github_workflows_release_provenance_attestation_job, github_workflows_release_atomic_publish_job [EXTRACTED 1.00]
- **Desktop Browser Trust Boundary** — claude_thin_shell_boundary, claude_child_process_daemon, claude_no_renderer_bridge, security_desktop_vs_upstream_scope [INFERRED 0.95]

## Communities (40 total, 8 thin omitted)

### Community 0 - "Shell Release Coordination"
Cohesion: 0.06
Nodes (99): commitPreparedFiles(), compareStableVersions(), dependencyClosure(), exactShellVersion(), expectedTarball(), fetchLatestShellEvidence(), installedNpmVersion(), lockRefreshArguments() (+91 more)

### Community 1 - "Daemon Process Lifecycle"
Cohesion: 0.06
Nodes (40): createStartupDeadline(), Daemon, DAEMON_BOOTSTRAP, daemonLaunchSpec(), findStartupUrl(), HERE, appendStderr(), CredentialSafeLineStream (+32 more)

### Community 2 - "Desktop Window and Zoom"
Cohesion: 0.07
Nodes (46): createBeforeQuitHandler(), adjacentScale(), createInterfaceScaleController(), apply(), select(), DEFAULT_INTERFACE_SCALE, INTERFACE_SCALES, interfaceScaleShortcut() (+38 more)

### Community 3 - "APT Repository Builder"
Cohesion: 0.11
Nodes (46): approvedFingerprint(), APT_MANAGED_MARKER, APT_REPOSITORY_URI, APT_SIGNATURE_ASSETS, APT_SOURCES_FILE, APT_UNSIGNED_ASSETS, aptMarker(), aptSources() (+38 more)

### Community 4 - "Release Artifact Contract"
Cohesion: 0.13
Nodes (43): assertBase64(), assertBlockMap(), assertExactAssetSet(), assertReleaseIdentity(), assertStableVersion(), createPlatformManifest(), expectedPlatformPayloads(), expectedReleaseAssets() (+35 more)

### Community 5 - "Packaged Runtime Smoke Tests"
Cohesion: 0.09
Nodes (39): assertCredentialSafe(), CHILD_PROBE, DAEMON_CHILD_PROBE, main(), minimalEnvironment(), packagedPaths(), parseMarkedReport(), ROOT (+31 more)

### Community 6 - "Package Manifest Dependencies"
Cohesion: 0.05
Nodes (40): electron, electron-builder, mirafold, @noble/hashes, author, dependencies, electron-updater, mirafold (+32 more)

### Community 7 - "Linux Update Probes"
Cohesion: 0.14
Nodes (37): { AppImageUpdater, AppUpdater, DebUpdater }, attachNodeTransport(), { configureRequestOptions, configureRequestUrl }, createAppAdapter(), createBadChecksumFeed(), createLoopbackUpdater(), deferred(), delay() (+29 more)

### Community 8 - "Shell Intake Preparation Tests"
Cohesion: 0.08
Nodes (32): PUBLIC_NPM_REGISTRY, REQUIRED_NPM_VERSION, GITHUB_HOSTED_BUILDER, GITHUB_WORKFLOW_BUILD_TYPE, INTAKE_SCHEMA_VERSION, SHELL_SOURCE_REPOSITORY, SHELL_SOURCE_WORKFLOW, SLSA_PROVENANCE_TYPE (+24 more)

### Community 9 - "Repository Hardening"
Cohesion: 0.16
Nodes (29): applyHardening(), assertDemonstration(), auditHardening(), compatibilityDemonstration(), createGhClient(), DEFAULT_POLICY, environmentBody(), equivalent() (+21 more)

### Community 10 - "Desktop Update Orchestration"
Cohesion: 0.15
Nodes (21): APT_MANAGED_MARKER, createDesktopUpdater(), checkForUpdates(), ensureUpdater(), externalUpdateAvailable(), helpMenuItems(), installDownloadedUpdate(), manualOutcome() (+13 more)

### Community 11 - "Release Coordinator Tests"
Cohesion: 0.15
Nodes (15): RELEASE_PLAN_SCHEMA_VERSION, BASE, candidateMain(), COMMIT, digest(), HASH, jsonText(), packagePair() (+7 more)

### Community 12 - "Platform Update Installers"
Cohesion: 0.16
Nodes (10): loadAutoUpdater(), appImageDestination(), createSafeAppImageUpdater(), createSafeNsisUpdater(), fsyncFile(), prepareAppImageReplacement(), removeStagingDirectory(), { AppImageUpdater, AppUpdater, NsisUpdater } (+2 more)

### Community 13 - "Product Plans and Guides"
Cohesion: 0.14
Nodes (15): Company Account Recommendation, Microsoft Store Identity and Packaging Record, AppX/MSIX Packaging Is Not Implemented, Completed Program Archive, Completed Phase 5: Automated Releases, Mirafold Desktop Plan, Desktop Pull Release Architecture, Phase 6: Windows Proof and Microsoft Store (+7 more)

### Community 14 - "APT Key Creation"
Cohesion: 0.17
Nodes (10): fail(), fingerprint, FINGERPRINT_FILE, KEY_HOME, KEY_IDENTITY, PUBLIC_DIRECTORY, PUBLIC_KEY, REPOSITORY_ROOT (+2 more)

### Community 15 - "GitHub APT Secret Setup"
Cohesion: 0.18
Nodes (11): ENVIRONMENTS, fail(), FINGERPRINT_FILE, KEY_HOME, KEY_IDENTITY, PUBLIC_KEY, REPOSITORY, REPOSITORY_ROOT (+3 more)

### Community 16 - "Intake Workflow Tests"
Cohesion: 0.17
Nodes (9): aptContractSource, coordinatorSource, gitAttributes, intakeSource, packageMetadata, preparationSource, releaseContractSource, sharedSource (+1 more)

### Community 17 - "Manual Release Workflow"
Cohesion: 0.25
Nodes (11): APT Archive Identity and Secret Boundary, APT Distribution Channel, Authenticated New Sessions, Desktop 0.3.2 Release Notes, Read-Only APT Signing Job, Atomic GitHub Release Publication Job, Cross-Platform Release Build Job, Draft-Then-Publish Atomicity (+3 more)

### Community 18 - "APT Key Backup"
Cohesion: 0.20
Nodes (9): BACKUP_FILE, fail(), FINGERPRINT_FILE, KEY_HOME, KEY_IDENTITY, PUBLIC_KEY, REPOSITORY_ROOT, SCRIPT_DIRECTORY (+1 more)

### Community 19 - "Release Rehearsal"
Cohesion: 0.33
Nodes (6): escapeRegularExpression(), main(), parsePassingTests(), RELEASE_REHEARSAL_CHECKS, ROOT, runReleaseRehearsal()

### Community 20 - "Automated Shell Intake"
Cohesion: 0.36
Nodes (9): Dependabot Dependency Update Policy, Shell Intake Owns Mirafold Version Movement, Automated APT Signing Job, Automated Provenance Attestation Job, Provenance-Verified npm Intake Job, Isolated Automated Release Writer, Reviewed Linux and Windows Build Job, Reviewed Package and Lock Artifact (+1 more)

### Community 21 - "Architecture and Security Rules"
Cohesion: 0.29
Nodes (8): Child-Process Daemon Architecture, No Renderer Bridge, Thin Electron Shell Boundary, Repository Working Rules, Desktop-versus-Upstream Security Scope, No Renderer Bridge, Security Policy, Signed APT Archive

### Community 22 - "Daemon Bootstrap Process"
Cohesion: 0.36
Nodes (7): { appendFileSync, readFileSync }, installLinuxPtyOwnership(), linuxProcessStartTime(), main(), path, { pathToFileURL }, stopUnownedPty()

### Community 23 - "Release and CI Documentation"
Cohesion: 0.33
Nodes (6): Path A: Automated Shell Release, main as Production Mirror, Path B: Manual Desktop Release, Release Runbook, CI Workflow, Real Windows Package Smoke Check

### Community 24 - "Product Vocabulary"
Cohesion: 0.40
Nodes (5): Daemon, Deck, Painting, Session, Mirafold Shared Vocabulary

### Community 25 - "Release Workflow Tests"
Cohesion: 0.40
Nodes (3): aptContract, releaseContract, workflow

### Community 26 - "Desktop Packaging Configuration"
Cohesion: 0.50
Nodes (4): asar Disabled, Linux deb, tar.gz, and AppImage Targets, Electron Builder Packaging Configuration, Visible Per-User NSIS Installer

### Community 27 - "Release Recovery Contract"
Cohesion: 0.50
Nodes (4): Forward-Only Bad Release Recovery, Release Identity and Recovery Contract, Release Privilege Boundaries, Seventeen-File Release Identity

### Community 31 - "Contribution Workflow"
Cohesion: 0.67
Nodes (3): Contribution Guide, Developer Certificate of Origin Sign-Off, Branch from next and PR into next

## Knowledge Gaps
- **172 isolated node(s):** `name`, `productName`, `desktopName`, `version`, `private` (+167 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `invariant()` connect `Shell Release Coordination` to `Repository Hardening`, `Packaged Runtime Smoke Tests`, `Linux Update Probes`?**
  _High betweenness centrality (0.212) - this node is a cross-community bridge._
- **Why does `createDesktopUpdater()` connect `Desktop Update Orchestration` to `Desktop Window and Zoom`, `Linux Update Probes`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `Daemon` connect `Daemon Process Lifecycle` to `Desktop Window and Zoom`, `Linux Update Probes`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **What connects `name`, `productName`, `desktopName` to the rest of the system?**
  _172 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Shell Release Coordination` be split into smaller, more focused modules?**
  _Cohesion score 0.0649152865029507 - nodes in this community are weakly interconnected._
- **Should `Daemon Process Lifecycle` be split into smaller, more focused modules?**
  _Cohesion score 0.06346153846153846 - nodes in this community are weakly interconnected._
- **Should `Desktop Window and Zoom` be split into smaller, more focused modules?**
  _Cohesion score 0.06980433632998413 - nodes in this community are weakly interconnected._