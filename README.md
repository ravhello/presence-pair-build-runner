# Presence Pair Build Runner

This public repository contains only a manual GitHub Actions build harness and
an encrypted source archive. The proprietary Presence Pair source remains in
its private repository and is never published here in plaintext.

The workflow decrypts the source inside an ephemeral GitHub-hosted macOS
runner, signs it with repository secrets, uploads an internal TestFlight build,
and removes decrypted material in an unconditional cleanup step. It does not
publish build artifacts or create a public TestFlight link.

From the local build-runner checkout, `scripts/update-encrypted-source.ps1`
packages the clean `presence-pair-ios` `HEAD`, rotates the archive password,
verifies a local decrypt round trip, and updates only the encrypted archive and
its GitHub Actions secret. No plaintext source archive or password is retained.
