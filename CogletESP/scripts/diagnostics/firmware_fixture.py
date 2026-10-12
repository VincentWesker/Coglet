"""Execute uploader filesystem scripts in an isolated CPython test filesystem."""
import builtins
import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import binascii

request = json.load(sys.stdin)
real_open = builtins.open
with tempfile.TemporaryDirectory(prefix="coglet-upload-test-") as temporary:
    root = Path(temporary)

    def resolve(path):
        result = root / str(path).lstrip("/")
        if not result.resolve().is_relative_to(root.resolve()):
            raise ValueError("Test script attempted to escape its filesystem")
        return result

    for name, text in request["initial"].items():
        path = resolve(name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    for name in request.get("directories", []):
        resolve(name).mkdir()

    renames = []
    failed = False

    def rename(source, destination):
        global failed
        renames.append([source, destination])
        if destination == request.get("failRenameTo") and (
            not failed or request.get("failAllMatchingRenames")
        ):
            failed = True
            raise OSError("Injected rename failure")
        os.rename(resolve(source), resolve(destination))

    filesystem = types.ModuleType("os")
    filesystem.listdir = lambda path: os.listdir(resolve(path))
    filesystem.stat = lambda path: os.stat(resolve(path))
    filesystem.mkdir = lambda path: os.mkdir(resolve(path))
    filesystem.rename = rename
    filesystem.sync = lambda: None
    filesystem.statvfs = lambda path: (1, 1, 0, request.get("freeBytes", 1024 * 1024))
    sys.modules["os"] = filesystem
    sys.modules["ubinascii"] = binascii
    scope = {"open": lambda path, *args: real_open(resolve(path), *args)}
    outputs = []
    error = None
    for source in request["scripts"]:
        output = io.StringIO()
        try:
            with contextlib.redirect_stdout(output):
                exec(source, scope)
        except Exception as exception:
            error = type(exception).__name__ + ": " + str(exception)
            break
        outputs.append(output.getvalue().strip())
    files = {
        path.relative_to(root).as_posix(): path.read_text(encoding="utf-8")
        for path in root.rglob("*") if path.is_file()
    }
    print(json.dumps({"outputs": outputs, "files": files, "renames": renames, "error": error}))
