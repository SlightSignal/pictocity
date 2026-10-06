"""pictocity, frozen. Single-file entry point.

One .exe: no Node, no npm install, no Chrome. Same shape as Filmocity's
launcher, and deliberately so -- every lesson that cost a round there is
already paid for here:

  * stdout/stderr are None under --windowed. Filmocity's first exe crashed on
    this before serving a byte, because uvicorn asked sys.stdout.isatty().
    Here it matters twice over: the PARENT needs real streams, and the node
    CHILD must not inherit invalid handles, so node's output is pointed at
    the same log file rather than left to default.
  * portable mode: an pictocity_data folder beside the exe wins over the home
    directory, so a flash drive carries the app AND the documents.
  * the log lives in the data dir, so a field failure leaves something to
    read instead of a screenshot of a dialog.

The difference from Filmocity: this cannot run in-process. pictocity's server is
Node, so the exe carries a node.exe and the app tree as data and spawns it.
Workspace packages (@pictocity/core etc.) are REAL DIRECTORIES in the bundle,
not the symlinks npm creates -- symlinks point at the staging path and are
dead the moment the bundle moves.
"""
import os
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error
import json


def base_dir():
    if getattr(sys, "frozen", False):
        return getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def exe_dir():
    """Where the user sees the exe -- not the onefile extraction dir."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port(preferred=4100):
    pinned = os.environ.get("PICTOCITY_PORT")
    if pinned:
        return int(pinned)
    for p in [preferred] + list(range(4101, 4141)):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def service_ready(url, data):
    """A protected recovery library is an available service, not a startup timeout."""
    try:
        response = urllib.request.urlopen(url + "/api/health", timeout=1)
    except urllib.error.HTTPError as error:
        if error.code != 503:
            return False
        response = error
    with response:
        body = response.read(65537)
        if len(body) > 65536:
            return False
        health = json.loads(body)
    expected = os.path.normcase(os.path.abspath(data))
    actual = health.get("paths", {}).get("data")
    return health.get("app") == "Pictocity" and isinstance(actual, str) and os.path.normcase(os.path.abspath(actual)) == expected and isinstance(health.get("persistence", {}).get("ok"), bool)


def _kill_child_with_me(proc):
    """Tie the node child's lifetime to this process using a Windows job object.

    Without this, terminating the launcher orphans node.exe: it keeps running,
    keeps the port, and the next launch reports the port busy. Measured, not
    theorised -- taskkill /IM pictocity.exe left PID 25996 holding 4137 during
    testing, which is exactly the "it says the port is in use" complaint a
    user would file after force-quitting once.

    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when the last handle to the job closes
    -- which happens when this process dies, however it dies -- every process
    in the job is killed. Best-effort: if any of it fails we still have the
    ordinary terminate() on clean exit.
    """
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]; k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]; k32.SetInformationJobObject.restype = wintypes.BOOL
        k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]; k32.OpenProcess.restype = wintypes.HANDLE
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]; k32.AssignProcessToJobObject.restype = wintypes.BOOL
        k32.CloseHandle.argtypes = [wintypes.HANDLE]; k32.CloseHandle.restype = wintypes.BOOL

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t),
                        ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [("ReadOperationCount", ctypes.c_uint64),
                        ("WriteOperationCount", ctypes.c_uint64),
                        ("OtherOperationCount", ctypes.c_uint64),
                        ("ReadTransferCount", ctypes.c_uint64),
                        ("WriteTransferCount", ctypes.c_uint64),
                        ("OtherTransferCount", ctypes.c_uint64)]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                        ("IoInfo", IO_COUNTERS),
                        ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t),
                        ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
        PROCESS_SET_QUOTA, PROCESS_TERMINATE = 0x0100, 0x0001

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return
        h = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, proc.pid)
        if h:
            assigned = k32.AssignProcessToJobObject(job, h)
            k32.CloseHandle(h)
            if not assigned: k32.CloseHandle(job); return
        else: k32.CloseHandle(job); return
        # deliberately leak the job handle: it must outlive this function and
        # close only when the process exits, which is what triggers the kill.
        globals()["_JOB_HANDLE"] = job
    except Exception:
        pass


def _die(msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "Pictocity", 0x10)
    except Exception:
        pass
    print(msg, file=sys.stderr)
    sys.exit(1)


def main():
    from windows_lifetime import bind_lifetime
    bind_lifetime()
    base = base_dir()
    node = os.path.join(base, "node", "node.exe")
    app = os.path.join(base, "app")
    entry = os.path.join(app, "packages", "server", "dist", "index.js")

    missing = [n for n, p in (("node.exe", node), ("server entry", entry)) if not os.path.exists(p)]
    if missing:
        _die("Bundled files are missing: %s\nLooked under: %s\n"
             "This is a packaging fault, not a your-machine fault." % (", ".join(missing), base))
        return

    beside = os.path.join(exe_dir(), "pictocity_data")
    import argparse
    parser = argparse.ArgumentParser(description="Pictocity desktop editor")
    parser.add_argument("--data", help="Existing document data directory; no automatic move")
    options = parser.parse_args()
    data = options.data or os.environ.get("PICTOCITY_DATA") or (
        beside if os.path.isdir(beside) else os.path.join(os.path.expanduser("~"), "pictocity_data"))
    os.makedirs(data, exist_ok=True)

    # real streams for the parent, and a file the child can inherit safely
    logpath = os.path.join(data, "pictocity.log")
    try:
        sink = open(logpath, "a", encoding="utf-8", buffering=1)
    except Exception:
        sink = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = sink
    if sys.stderr is None:
        sys.stderr = sink

    port = free_port()
    url = "http://127.0.0.1:%d" % port

    env = dict(os.environ)
    env["PICTOCITY_DATA"] = data
    env["PICTOCITY_PORT"] = str(port)
    env["PICTOCITY_HOST"] = env.get("PICTOCITY_HOST", "127.0.0.1")   # never all-interfaces by default
    # Uploaded fonts must survive the onefile extraction directory being removed.
    fonts = os.environ.get("PICTOCITY_FONTS") or os.path.join(data, "fonts")
    bundled_fonts = os.path.join(base, "fonts")
    if os.path.isdir(bundled_fonts):
        # The server copies and registers these only after acquiring library
        # ownership. A refused second launch must not seed or replace fonts.
        env["PICTOCITY_BUNDLED_FONTS"] = bundled_fonts
    env["PICTOCITY_FONTS"] = fonts
    env["NODE_ENV"] = "production"
    binaries = os.path.join(base, "bin")
    if os.path.isdir(binaries):
        env["PATH"] = binaries + os.pathsep + env.get("PATH", "")
        env["PICTOCITY_FFMPEG"] = os.path.join(binaries, "ffmpeg.exe")

    proc = subprocess.Popen([node, entry], cwd=app, env=env,
                            stdout=sink, stderr=sink, stdin=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    _kill_child_with_me(proc)

    for _ in range(120):
        time.sleep(0.5)
        if proc.poll() is not None:
            if proc.returncode == 73:
                _die("Another Pictocity instance is using this library.\n\n"
                     "Close that instance before opening it again.\nYour saved work has not been changed.")
            if proc.returncode == 74:
                _die("Pictocity cannot confirm exclusive access to this library.\n\n"
                     "Review the data folder or choose another folder before opening it.\nLog:\n%s" % logpath)
            _die("pictocity's server exited immediately (code %s).\n\nLog:\n%s"
                 % (proc.returncode, logpath))
            return
        try:
            if service_ready(url, data):
                break
        except Exception:
            pass
    else:
        proc.terminate()
        _die("pictocity's server did not answer on %s within 60 seconds.\n\nLog:\n%s" % (url, logpath))
        return

    try:
        if os.environ.get("PICTOCITY_HEADLESS") == "1":
            while proc.poll() is None: time.sleep(0.5)
            return
        import webview
        # Keep downloads behind the native Save As dialog; pywebview defaults to cancelling them.
        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.create_window("Pictocity", url, width=1600, height=1000, min_size=(1100, 700), maximized=True)
        webview.start()
    except Exception:
        import webbrowser
        webbrowser.open(url)
        print("pictocity is running at %s" % url)
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    finally:
        try:
            proc.terminate()
            proc.wait(timeout=10)
        except Exception:
            try: proc.kill(); proc.wait(timeout=5)
            except Exception: pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback
        tb = traceback.format_exc()
        _die("pictocity hit an unexpected error and could not start.\n\n%s" % tb.strip().splitlines()[-1])
