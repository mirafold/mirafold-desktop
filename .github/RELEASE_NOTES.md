## Included versions

- Mirafold Desktop `0.4.0`
- Mirafold Shell `0.9.0`

## What changed

- Linux Desktop can open Pro activation in your system browser and receive the
  result privately. Pro state is encrypted using an available Secret Service
  or KWallet provider; activation requires that secure storage to be available.
- The saved Pro key reaches the bundled Shell through a one-use private pipe.
  It is kept out of the page, command-line arguments, and child environment.
- An unfinished activation can resume after restarting Desktop when its saved
  callback port remains available. The Project menu can remove Pro access from
  this device after confirmation; reconnecting requires an existing key or
  help from support.
- Activation, removal, folder changes, crashes, updates, and quit coordinate
  daemon cleanup before starting a replacement. Diagnostic output redacts keys.
- Release publication now verifies and reuses the candidate packages selected
  for acceptance, including their signed APT repository and updater metadata.

Windows remains a beta desktop package. The Linux Pro result does not establish
Windows Pro support; that installed activation proof remains separate.
