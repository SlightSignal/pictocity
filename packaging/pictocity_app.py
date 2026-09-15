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

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                        ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD),
                        ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t),
                        ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
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
            return
        h = k32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, proc.pid)
        if h:
            k32.AssignProcessToJobObject(job, h)
            k32.CloseHandle(h)
        # deliberately leak the job handle: it must outlive this function and
        # close only when the process exits, which is what triggers the kill.
        globals()["_JOB_HANDLE"] = job
    except Exception:
        pass


def _die(msg):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, msg, "pictocity", 0x10)
    except Exception:
        pass
    print(msg, file=sys.stderr)
    sys.exit(1)


def main():
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
    data = os.environ.get("PICTOCITY_DATA") or (
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
    fonts = os.path.join(base, "fonts")
    if os.path.isdir(fonts):
        env["PICTOCITY_FONTS"] = fonts
    env["NODE_ENV"] = "production"

    proc = subprocess.Popen([node, entry], cwd=app, env=env,
                            stdout=sink, stderr=sink, stdin=subprocess.DEVNULL)
    _kill_child_with_me(proc)

    for _ in range(120):
        time.sleep(0.5)
        if proc.poll() is not None:
            _die("pictocity's server exited immediately (code %s).\n\nLog:\n%s"
                 % (proc.returncode, logpath))
            return
        try:
            urllib.request.urlopen(url + "/api/health", timeout=1)
            break
        except Exception:
            pass
    else:
        proc.terminate()
        _die("pictocity's server did not answer on %s within 60 seconds.\n\nLog:\n%s" % (url, logpath))
        return

    try:
        import webview
        webview.create_window("pictocity", url, width=1600, height=1000, min_size=(1100, 700))
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
        except Exception:
            pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback
        tb = traceback.format_exc()
        _die("pictocity hit an unexpected error and could not start.\n\n%s" % tb.strip().splitlines()[-1])
