# Testing Pictocity source

Use a separate checkout/data directory and the committed `package-lock.json`. Install prerequisites explicitly before running tests; the suites do not certify a clean-machine package. Node 22.20+ in the 22 branch, 24.12+ in the 24 branch, or 25+ satisfies the locked development branch requirements. Run `npm ci`, then `npm run build`. Keep generated evidence private; `.gitignore` and `.dockerignore` exclude it.

## Self-contained source checks

```text
npm test
npm run test:history
npm run test:persistence-ui
npm run test:legacy-documents
npm run test:downloads
npm run test:data-ownership
npm run test:export-frontend
```

These entry points exercise different contracts; they are not an exhaustive suite or desktop acceptance. ZIP checks use a real Python standard-library process: set `PICTOCITY_TEST_PYTHON` to its executable, or provide `python` on Windows / `python3` on other hosts through PATH. Do not include command arguments in that variable. Process/data-ownership checks create their own temporary servers and files. OS-specific results retain their actual platform scope.

Renderer/media suites need FFmpeg and ffprobe. Put the selected tools on PATH or set `PICTOCITY_FFMPEG` and `PICTOCITY_FFPROBE` to executable paths. Do not assume the source package contains the ignored `bin/` executables.

```text
npm run test:reliability
npm run test:modern
npm run test:snapshots
npm run test:snapshot-api
npm run test:cache
npm run test:assets
npm run test:asset-deadlines
npm run test:recovery
npm run test:fonts
npm run test:cache-budget
npm run test:export-sets
npm run test:export-regressions
```

The deadline suite intentionally waits for the production deadline. The export regression runner owns isolated data and a dynamically selected port; it does not attach to the desktop library. Some fixtures inspect compiled source effects rather than a browser/native DOM, so retain that distinction when reporting results. Failures and cannot-run outcomes are not passes.

## Suites against a running test server

`test:api`, `test:mcp`, `test:font-inventory`, `test:export-mcp`, `test:security` and `test:ui` can contact a running server. Their default URL may be port 4100; **do not run them against an existing desktop or client library**. First launch a dedicated source server with a new `PICTOCITY_DATA`, separate `PICTOCITY_FONTS` and an unused `PICTOCITY_PORT`. Verify `/api/health` identifies Pictocity, healthy persistence and that exact disposable directory. Set `PICTOCITY_URL` in the test terminal to that observed server URL. Security checks additionally require the same explicit `PICTOCITY_TOKEN` and port as the isolated server.

`test:ui` needs an existing Chrome/Chromium executable via `CHROME`; puppeteer-core does not bundle a browser. The optional fallback package in the historical smoke script is not a dependency in this lock. There is no automatic browser download promised by this repository. Stop the test server you started and retain failure evidence before cleaning up your disposable data. Do not terminate unrelated processes or delete a foreign ownership socket/lock.

## Evidence and review

Hash the selected source and actual exported files when reporting a release result. Decode/probe media and independently extract ZIP members where relevant. Source-effect tests, browser automation, desktop input/save verification, normal shutdown, visual review and user approval are separate evidence. No fixture result proves Photoshop parity, print/color management or universal crash/power-loss safety.
