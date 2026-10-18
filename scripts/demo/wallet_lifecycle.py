"""Finish wallet operations before shutdown; keep native children out of terminal signals."""

import signal
import subprocess
import threading
from contextlib import contextmanager


@contextmanager
def defer_default_signals():
    """CLI calls may exit after native cleanup; service handlers must finish the journal too."""
    previous = {}
    requested = []
    if threading.current_thread() is threading.main_thread():
        for signum in (signal.SIGINT, signal.SIGTERM):
            handler = signal.getsignal(signum)
            if handler in (signal.SIG_DFL, signal.default_int_handler):
                previous[signum] = handler
                signal.signal(signum, lambda number, _frame: requested.append(number))
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)
    if requested:
        raise SystemExit(128 + requested[0])


def run_native(arguments, **kwargs):
    with defer_default_signals():
        return subprocess.run(arguments, start_new_session=True, **kwargs)


def run_service(arguments, **kwargs):
    """Forward shutdown once and leave network adapters alive until the sidecar drains."""
    child = None
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            if child is not None and child.poll() is None:
                child.terminate()

    previous = {number: signal.signal(number, stop) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        child = subprocess.Popen(arguments, start_new_session=True, **kwargs)
        if stopping:
            child.terminate()
        return child.wait()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


def serve_until_stopped(server):
    """HTTPServer.shutdown must run outside its serving thread, after the current request."""
    stopping = False

    def stop(_number, _frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            threading.Thread(target=server.shutdown, daemon=True).start()

    previous = {number: signal.signal(number, stop) for number in (signal.SIGINT, signal.SIGTERM)}
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        server.server_close()
        for number, handler in previous.items():
            signal.signal(number, handler)
