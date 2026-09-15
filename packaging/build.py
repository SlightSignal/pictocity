"""Build pictocity into one self-contained .exe.

    node packaging\\stage.mjs      # not needed; this script does it all
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
  runtime extraction plus a bundler plus postject -- three untested moving
  parts against one that shipped Filmocity tonight.
"""
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PAYLOAD = os.path.join(HERE, "_payload")
NODE_EXE = os.path.join(os.path.expanduser("~"), "Apps", "node", "node.exe")
STAGE = os.path.join(os.environ.get("TEMP", "/tmp"), "ads_stage")
PKGS = ["core", "server", "mcp", "editor"]


def rm(p):
    shutil.rmtree(p, ignore_errors=True)


def real_copy(src, dst):
    """Copy following symlinks, so nothing in the bundle points outside it."""
    shutil.copytree(src, dst, symlinks=False, dirs_exist_ok=True)


def ensure_stage():
    """Build the production dependency tree if it is absent.

    It lives in TEMP, so any cleanup removes it and the build then fails --
    which it did, and because the caller piped this script through `tail`,
    the shell saw tail's exit code, treated the failure as success, and
    copied a STALE exe onward. A build script that depends on a temp
    directory somebody else has to create is a trap; it makes its own now.
    """
    nm = os.path.join(STAGE, "node_modules")
    if os.path.isdir(nm):
        return True
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


def stage():
    if not ensure_stage():
        return False
    if not os.path.exists(NODE_EXE):
        print("CANNOT_RUN: no node.exe at %s" % NODE_EXE)
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
    real_copy(nm_src, nm_dst)
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
           "--onefile", "--name", "pictocity",
           "--distpath", os.path.join(ROOT, "dist_exe"),
           "--workpath", os.path.join(ROOT, "build_exe"),
           "--specpath", HERE, "--log-level", "WARN",
           "--python-option", "X utf8=1"]
    ico = os.path.join(os.path.expanduser("~"), "Apps", "pictocity.ico")
    if os.path.exists(ico):
        cmd += ["--icon", ico]
    for d in ("app", "node", "fonts"):
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
    exe = os.path.join(ROOT, "dist_exe", "pictocity.exe")
    if not os.path.exists(exe):
        print("BUILD REPORTED SUCCESS BUT PRODUCED NO EXE")
        return 1
    print("OK  %s  %.1f MB  in %.0fs"
          % (exe, os.path.getsize(exe) / 1048576.0, time.time() - t0))
    return 0


if __name__ == "__main__":
    print("staging payload...")
    sys.exit(0 if (stage() and freeze() == 0) else 1)
