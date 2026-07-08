# Changelog

## 0.1.2

- Back up and restore known external state files under the user's home directory.
- Capture Continue's `~/.continue/config.yaml` as `externalState/home/.continue/config.yaml`.
- Add smoke-test coverage for Continue config backup and restore.

## 0.1.0

Initial release.

- Add backup commands for all installed extensions and one selected extension.
- Store one zip archive per extension.
- Capture installed extension files, contributed configuration values, global storage, and current workspace storage where accessible.
- Add restore command that overwrites installed extension files and captured state after confirmation.
