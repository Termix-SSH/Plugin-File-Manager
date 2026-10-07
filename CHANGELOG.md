# Changelog

## Unreleased

### Added

- Cancel a download from its progress toast

### Changed

- Downloads are much faster on high-latency links: SFTP reads now use the server's largest read size, with up to 32 in flight

### Fixed

- Cancelling a large download no longer stalls browsing on servers that are slow to close the file

## 1.0.0

### Added

- Browse, upload, download, rename, move and delete files, with sudo support
- Edit files in a built-in code editor
- Preview images, PDFs, audio and video
- A trash you can restore deleted files from
- Copy files between two hosts, with the fastest route picked for you and an integrity check
- A side by side local and remote view in the desktop app
