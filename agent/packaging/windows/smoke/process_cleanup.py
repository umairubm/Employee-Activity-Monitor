"""Track this disposable test's process descendants without risking PID reuse."""

from __future__ import annotations

import threading
import time
from pathlib import Path


class OwnedProcesses:
    """Observe installer/agent descendants while their parents are still alive.

    Detached setup/new-agent processes may outlive the original agent. Keeping
    birth times lets failed runs stop those processes without an image-wide kill
    or accidentally terminating an unrelated recycled PID.
    """

    def __init__(self, installed_paths: tuple[Path, ...]) -> None:
        self.paths = {str(path.resolve()).casefold() for path in installed_paths}
        self.started = time.time()
        self.owned: dict[int, float] = {}
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self._observe, daemon=True)

    def add(self, pid: int) -> None:
        import psutil
        try:
            process = psutil.Process(pid)
            with self.lock:
                self.owned[pid] = process.create_time()
        except psutil.NoSuchProcess:
            pass

    def _observe(self) -> None:
        import psutil
        while not self.stop.wait(0.1):
            # The harness refused existing installs before this observer starts.
            # Only newly created processes from these exact install paths belong
            # to it; never collect arbitrary similarly named executables.
            for process in psutil.process_iter(["pid", "exe", "create_time"]):
                try:
                    if (
                        str(process.info["exe"]).casefold() in self.paths
                        and process.info["create_time"] >= self.started
                    ):
                        self.add(process.pid)
                except psutil.Error:
                    continue
            with self.lock:
                entries = list(self.owned.items())
            for pid, birth in entries:
                try:
                    root = psutil.Process(pid)
                    if root.create_time() != birth:
                        continue
                    for child in root.children(recursive=True):
                        self.add(child.pid)
                except psutil.Error:
                    continue

    def __enter__(self) -> "OwnedProcesses":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        import psutil
        self.stop.set()
        self.thread.join(timeout=5)
        # Children first. No taskkill /IM, profile deletion, or broad cleanup.
        for pid, birth in sorted(self.owned.items(), key=lambda item: item[1], reverse=True):
            try:
                process = psutil.Process(pid)
                if process.create_time() == birth:
                    process.kill()
                    process.wait(timeout=5)
            except psutil.Error:
                pass