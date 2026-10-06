# Pictocity 0.2.6 source release

This repository contains source, the procedural demo, generic test code, the original application icons and licensed Poppins fonts. It excludes installed user libraries, client documents/media, private logs and verification evidence, generated builds, dependencies and executables. Keep a backup of your working library before using another version; source tests belong in a separate data directory.

The runtime source matches the locally accepted 0.2.6 engineering release. This public preparation updates documentation, test executable lookup and Windows build-tool lookup; it does not rebuild or replace the installed desktop app. The exact historical Windows executable is `cb47850fc7ee29729145daa4cfa68f35f1a18687f15a9d40a1be3d0a2779350d` (SHA-256), which is not included here.

The local Windows checks covered same-host physical data/docs ownership, duplicate-open refusal, acknowledged edits/recovery, a copied existing library, bundled HTTP/MCP font inventory and one native ZIP save with independent member extraction. They do not establish Unix/clean-machine qualification, protection from older or external writers, power-loss transactions, complete font/PSD/ICC/CMYK/HDR fidelity, or creative/competitor parity. [RELIABILITY.md](RELIABILITY.md) retains the narrower historical scopes.

## Source setup

Use Node 22.20+ in the 22 branch, 24.12+ in the 24 branch, or 25+, then `npm ci` and `npm run build`. These branch floors match the committed development dependency graph; they are not a security-update guarantee. The root package is private for npm publishing; this is an app source repository, not an npm registry release. See [GETTING-STARTED.md](GETTING-STARTED.md) and [TESTING.md](TESTING.md).

Project source uses the MIT license in [LICENSE](../LICENSE). Poppins uses the separate SIL OFL in [fonts/OFL.txt](../fonts/OFL.txt). Keep the applicable notices with copied source/fonts. Dependency license metadata is in the lock; it is not a complete binary distribution notice audit.

## Windows packaging recipe

`packaging/build.py` is a build recipe, not a qualified installer. It compiles all workspaces, stages production dependencies and freezes a Python/pywebview launcher. It requires an explicitly provisioned Python environment with PyInstaller and pywebview, the selected Node installation including its companion `node_modules/npm/bin/npm-cli.js`, built-in licensed fonts and Windows x64 FFmpeg/ffprobe supplied under `bin/`. Native Node dependencies must match Windows x64. No Python packaging dependency lock or runtime security floor is declared by this source recipe.

The recipe selects `NODE_BINARY` (an executable path, without arguments) or `node` on PATH. Missing Node/npm refuses with a setup message. Example in PowerShell, after you have provisioned the prerequisites yourself:

```powershell
$env:NODE_BINARY = 'C:/tools/node/node.exe'
$env:PICTOCITY_DEPENDENCIES = (Get-Location).Path
python packaging/build.py
```

Use a separate build checkout: the recipe replaces its generated `_payload`, build and output directories. It does not implicitly install dependencies. `--allow-install` is an explicit opt-in for its npm installation branch; it is unnecessary when a complete dependency tree already exists. Its outputs do not become qualified release artifacts merely because the build exits successfully.

## Public Windows binary gate remains open

The historical 0.2.6 package included a Python 3.12.10 launcher and Node 24.20.0. The existing release manifest explicitly reports that the matching FFmpeg source/provenance and complete public binary/runtime notices are not yet included. Do not treat its partial FFmpeg-build/license and font notices as a cleared redistributable binary package. A future binary release needs a reviewed supported runtime/dependency selection, complete notices and applicable corresponding-source/provenance materials, a fresh build with source/artifact hashes, isolated package checks and native/clean-machine qualification. This source release makes none of those future-build claims.

## Docker

Dockerfiles are provided as unvalidated source recipes. `.dockerignore` excludes libraries, secrets, parent Git history and generated/dependency files from `COPY . .`. The Compose example mounts optional `image-tools.json`; create your own local configuration from `image-tools.example.json` or remove that mount if unused. Do not commit it. The image does not provision FFmpeg, so video export requires a separately reviewed container tool setup. Windows ownership tests do not validate the Unix socket implementation or the container recipe.
