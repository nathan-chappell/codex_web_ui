# Changelog

## 1.0.5

- Changed reasoning items from expandable cards to compact static summaries in thread view.

## 1.0.4

- Added a deployment smoke test that installs the published npm package into a temporary directory, starts it on `0.0.0.0:4546` with password `codex`, verifies auth/login, and cleans up the fresh app-server socket.
- Fixed thread selection to update browser history without remounting the Next route, reducing cases where choosing a thread appears to reload the thread list.
- Improved thread item readability with better padding around reasoning rows, smaller non-final item text, and friendlier phase labels.
- Centered the underscore in the app icon/logo.
- Documented Cloudflare Tunnel usage as a tested remote-access path.

## 1.0.3

- Published the npm package under `@nchappell/codex-web-ui`.
- Updated the Docker image to install Codex Web UI from npm during image build.
- Added Docker smoke coverage for the npm-installed image path.
