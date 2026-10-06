"""Build pictocity into one self-contained .exe.

    <python> packaging\\build.py

Two stages, because a Node app with a native module cannot simply be pointed
at:

  STAGE. Assemble a clean payload under packaging/_payload:
    app/          package.json, packages/*/{package.json,dist}, node_modules
    node/         node.exe
    fonts/        the .ttf/.otf files the renderer needs
  npm's workspace links (node_modules/@pictocity/*) are SYMLINKS to absolute
  staging paths. They are replaced with real directory copies here -- a
  symlink in a distributable bundle points at a path that will not exist on
  the machine that opens it.

  FREEZE. PyInstaller onefile over a tiny Python launcher that spawns node.
  Python is the bootstrap only; the user sees one file either way. The
  alternative (Node SEA) cannot embed a .node binary, so it would need
  runtime extraction plus a bundler and postject. This Windows recipe uses
  PyInstaller and pywebview; public binary qualification is a separate gate.
"""
import os
import shutil
import subprocess
import sys
import time
import json
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAYLOAD = os.path.join(HERE, "_payload")
def resolve_node_binary(environment=None):
    """Select an explicit Node executable or the one on PATH; never run it here."""
    environment = os.environ if environment is None else environment
    explicit = environment.get("NODE_BINARY")
    if explicit:
        executable = os.path.abspath(os.path.expanduser(explicit))
        if not os.path.isfile(executable):
            raise RuntimeError("NODE_BINARY must name an existing Node executable, not a command with arguments")
        return executable
    found = shutil.which("node", path=environment.get("PATH", ""))
    return os.path.abspath(found) if found else ""


NODE_EXE = resolve_node_binary()
STAGE = os.path.join(os.environ.get("TEMP", "/tmp"), "pictocity_stage")
PKGS = ["core", "server", "mcp", "editor"]


def rm(p):
    shutil.rmtree(p, ignore_errors=True)


def real_copy(src, dst):
    """Copy following symlinks, so nothing in the bundle points outside it."""
    shutil.copytree(src, dst, symlinks=False, dirs_exist_ok=True)


def copy_runtime_dependencies(source, destination):
    """Resolve the existing production dependency graph; do not ship the development toolchain."""
    source = Path(source).absolute(); destination = Path(destination); visited = set()
    def copy(name, from_package=None, optional=False):
        if name.startswith(("@pictocity/", "@adstudio/")): return
        candidates = []
        if from_package:
            for parent in [from_package, *from_package.parents]:
                if parent == source.parent: break
                candidates.append(parent / "node_modules" / name)
        candidates.append(source / name)
        package = next((p for p in candidates if (p / "package.json").is_file()), None)
        if package is None:
            if optional: return
            raise RuntimeError("Missing existing runtime dependency: " + name)
        if package in visited: return
        meta = json.loads((package / "package.json").read_text(encoding="utf-8"))
        for field, target in (("os", "win32"), ("cpu", "x64")):
            limits = meta.get(field, [])
            if limits and ("!" + target in limits or (any(not x.startswith("!") for x in limits) and target not in limits)):
                if optional: return
                raise RuntimeError("Runtime dependency does not support this Windows x64 target: " + name)
        visited.add(package)
        target = destination / package.relative_to(source)
        shutil.copytree(package, target, symlinks=False, ignore=shutil.ignore_patterns("node_modules"))
        for dep in meta.get("dependencies", {}): copy(dep, package)
        for dep in meta.get("optionalDependencies", {}): copy(dep, package, True)
        for dep in meta.get("peerDependencies", {}): copy(dep, package, True)
    for p in ("core", "server", "mcp"):
        meta = json.loads(Path(ROOT, "packages", p, "package.json").read_text(encoding="utf-8"))
        for name in meta.get("dependencies", {}): copy(name)
    print("  %d existing runtime dependencies staged" % len(visited))


def ensure_stage():
    """Use existing dependencies; explicit --allow-install opts into npm installation.

    The default never downloads dependencies. An optional temporary stage is
    created by this recipe rather than assumed to exist from an earlier session.
    """
    global STAGE
    # Offline builds use the already verified workspace dependency tree. No implicit install.
    local = os.environ.get("PICTOCITY_DEPENDENCIES") or ROOT
    nm = os.path.join(local, "node_modules")
    if os.path.isfile(os.path.join(nm, "ws", "package.json")) and os.path.isdir(os.path.join(nm, "@napi-rs", "canvas")):
        STAGE = local
        return True
    if "--allow-install" not in sys.argv:
        print("CANNOT_RUN: no complete existing dependency tree. Build dependencies explicitly, or use --allow-install with owner authorization.")
        return False
    nm = os.path.join(STAGE, "node_modules")
    print("  no production tree at %s -- creating it" % STAGE)
    node = os.path.dirname(NODE_EXE)
    npm = os.path.join(node, "node_modules", "npm", "bin", "npm-cli.js")
    if not os.path.exists(npm):
        print("CANNOT_RUN: no npm-cli.js under %s" % node)
        return False
    os.makedirs(STAGE, exist_ok=True)
    shutil.copy2(os.path.join(ROOT, "package.json"), STAGE)
    lock = os.path.join(ROOT, "package-lock.json")
    if os.path.exists(lock):
        shutil.copy2(lock, STAGE)
    for p in PKGS:
        d = os.path.join(STAGE, "packages", p)
        os.makedirs(d, exist_ok=True)
        shutil.copy2(os.path.join(ROOT, "packages", p, "package.json"), d)
    r = subprocess.run([NODE_EXE, npm, "install", "--omit=dev", "--ignore-scripts",
                        "--no-audit", "--no-fund"], cwd=STAGE,
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.isdir(nm):
        print("CANNOT_RUN: npm install failed\n%s" % (r.stderr or r.stdout)[-600:])
        return False
    print("  production tree created")
    return True


def build_sources():
    """Compile every workspace from current source before assembling the payload."""
    npm = os.path.join(os.path.dirname(NODE_EXE), "node_modules", "npm", "bin", "npm-cli.js")
    if not os.path.isfile(NODE_EXE) or not os.path.isfile(npm):
        print("CANNOT_RUN: source compilation needs Node and its companion npm-cli.js. Set NODE_BINARY to the Node executable or add Node to PATH; provision the documented build prerequisites first.")
        return False
    env = dict(os.environ)
    env["PATH"] = os.path.dirname(NODE_EXE) + os.pathsep + env.get("PATH", "")
    result = subprocess.run([NODE_EXE, npm, "run", "build"], cwd=ROOT, env=env)
    if result.returncode:
        print("CANNOT_RUN: workspace compilation failed; no package will be staged or frozen")
        return False
    return True


def stage():
    if not ensure_stage():
        return False
    if not os.path.exists(NODE_EXE):
        print("CANNOT_RUN: Node executable missing; set NODE_BINARY or add Node to PATH")
        return False

    rm(PAYLOAD)
    app = os.path.join(PAYLOAD, "app")
    os.makedirs(app)

    shutil.copy2(os.path.join(ROOT, "package.json"), app)
    for p in PKGS:
        d = os.path.join(app, "packages", p)
        os.makedirs(d)
        shutil.copy2(os.path.join(ROOT, "packages", p, "package.json"), d)
        src_dist = os.path.join(ROOT, "packages", p, "dist")
        if os.path.isdir(src_dist):
            real_copy(src_dist, os.path.join(d, "dist"))
        else:
            print("  note: packages/%s has no dist/" % p)

    # dependencies, with the workspace symlinks resolved into real copies
    nm_src = os.path.join(STAGE, "node_modules")
    nm_dst = os.path.join(app, "node_modules")
    print("  copying dependencies (this is the slow part)...")
    copy_runtime_dependencies(nm_src, nm_dst)
    ads = os.path.join(nm_dst, "@pictocity")
    if os.path.isdir(ads):
        rm(ads)
    os.makedirs(ads)
    for p in PKGS:
        real_copy(os.path.join(app, "packages", p), os.path.join(ads, p))

    os.makedirs(os.path.join(PAYLOAD, "node"))
    shutil.copy2(NODE_EXE, os.path.join(PAYLOAD, "node", "node.exe"))

    fonts = os.path.join(ROOT, "fonts")
    if os.path.isdir(fonts):
        real_copy(fonts, os.path.join(PAYLOAD, "fonts"))
    binaries = os.path.join(ROOT, "bin")
    if not all(os.path.isfile(os.path.join(binaries, name)) for name in ("ffmpeg.exe", "ffprobe.exe")):
        print("CANNOT_RUN: video export requires existing bin/ffmpeg.exe and bin/ffprobe.exe")
        return False
    real_copy(binaries, os.path.join(PAYLOAD, "bin"))

    # prove no dangling links survived
    bad = []
    for base, dirs, files in os.walk(PAYLOAD):
        for n in dirs + files:
            fp = os.path.join(base, n)
            if os.path.islink(fp):
                bad.append(fp)
    if bad:
        print("CANNOT_RUN: %d symlink(s) survived staging, e.g. %s" % (len(bad), bad[0]))
        return False

    mb = sum(os.path.getsize(os.path.join(b, f))
             for b, _, fs in os.walk(PAYLOAD) for f in fs) / 1048576.0
    print("  payload assembled: %.1f MB, 0 symlinks" % mb)
    return True


def freeze():
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
           "--onefile", "--name", "Pictocity",
           "--distpath", os.path.join(ROOT, "dist_exe"),
           "--workpath", os.path.join(ROOT, "build_exe"),
           "--specpath", HERE, "--log-level", "WARN",
           "--python-option", "X utf8=1"]
    ico = os.path.join(ROOT, "packaging", "pictocity.ico")
    if os.path.exists(ico):
        cmd += ["--icon", ico]
    for d in ("app", "node", "fonts", "bin"):
        p = os.path.join(PAYLOAD, d)
        if os.path.isdir(p):
            cmd += ["--add-data", "%s%s%s" % (p, os.pathsep, d)]
    cmd += ["--collect-all", "webview", "--windowed",
            os.path.join(HERE, "pictocity_app.py")]
    print("freezing...")
    t0 = time.time()
    r = subprocess.run(cmd, cwd=ROOT)
    if r.returncode != 0:
        print("BUILD FAILED rc=%d" % r.returncode)
        return r.returncode
    exe = os.path.join(ROOT, "dist_exe", "Pictocity.exe")
    if not os.path.exists(exe):
        print("BUILD REPORTED SUCCESS BUT PRODUCED NO EXE")
        return 1
    print("OK  %s  %.1f MB  in %.0fs"
          % (exe, os.path.getsize(exe) / 1048576.0, time.time() - t0))
    return 0


if __name__ == "__main__":
    print("compiling current source...")
    if not build_sources():
        sys.exit(1)
    print("staging payload...")
    sys.exit(0 if (stage() and freeze() == 0) else 1)
