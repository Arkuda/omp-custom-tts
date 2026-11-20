"""One authenticated loopback service and one model worker per data directory."""

import asyncio
import hmac
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
from contextlib import contextmanager, suppress

IDLE_SECONDS = 300
SYNTHESIS_SECONDS = 300
LINE_LIMIT = 128 * 1024
ENDPOINT = "daemon-v1.json"
WORKER = Path(__file__).with_name("kokoro_ru.py")
BUSY = "Kokoro-ru: другой запрос уже выполняется"
WINSOUND = "import sys, winsound; winsound.PlaySound(sys.argv[1], winsound.SND_FILENAME | winsound.SND_NODEFAULT)"
WINDOWS_FLAGS = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


@contextmanager
def daemon_lock(root):
    fd = os.open(root / "daemon.lock", os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            yield False
        else:
            # The kernel releases the lock on close, including on process death.
            yield True


def frame(value):
    return json.dumps(value, ensure_ascii=True).encode("ascii") + b"\n"


def proof(key, role, nonce):
    return hmac.digest(key, f"{role}:{nonce}".encode("ascii"), "sha256").hex()


async def terminate(process):
    if process.returncode is None:
        with suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 0.5)
        except TimeoutError:
            with suppress(ProcessLookupError):
                process.kill()
    await process.wait()


class RequestCancelled(Exception):
    pass


async def until_cancelled(awaitable, disconnect, timeout=None):
    work = asyncio.create_task(awaitable)
    try:
        done, _ = await asyncio.wait((work, disconnect), timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if disconnect in done:
            raise RequestCancelled
        if work not in done:
            raise TimeoutError
        return work.result()
    finally:
        if not work.done():
            work.cancel()
        await asyncio.gather(work, return_exceptions=True)


class Daemon:
    def __init__(self, root, idle_seconds):
        self.root = root
        self.key = secrets.token_bytes(32)
        self.idle_seconds = idle_seconds
        self.idle = None
        self.closing = asyncio.Event()
        self.connections = set()
        self.active = False
        self.worker = None
        self.diagnostics = None
        self.tail = bytearray()

    def arm_idle(self):
        self.idle = asyncio.get_running_loop().call_later(self.idle_seconds, self.closing.set)

    async def read_diagnostics(self, stream):
        while data := await stream.read(8192):
            self.tail.extend(data)
            del self.tail[:-8192]

    async def stop_worker(self):
        if self.worker is not None:
            await terminate(self.worker)
            await self.diagnostics
            self.worker = None
            self.diagnostics = None

    async def ask_worker(self, request):
        self.worker.stdin.write(frame(request))
        await self.worker.stdin.drain()
        return await self.worker.stdout.readline()

    async def synthesize(self, request, disconnect):
        if disconnect.done():
            raise RequestCancelled
        if self.worker is None or self.worker.returncode is not None:
            await self.stop_worker()
            self.tail.clear()
            self.worker = await asyncio.create_subprocess_exec(
                sys.executable, "-X", "utf8", "-u", str(WORKER), "worker", str(self.root),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                creationflags=WINDOWS_FLAGS, limit=LINE_LIMIT,
            )
            self.diagnostics = asyncio.create_task(self.read_diagnostics(self.worker.stderr))
        try:
            if disconnect.done():
                raise RequestCancelled
            reply = json.loads(await until_cancelled(self.ask_worker(request), disconnect, SYNTHESIS_SECONDS))
            if not isinstance(reply, dict) or not (
                (reply.get("ok") is True and (
                    type(reply.get("bytes")) is int and reply["bytes"] > 0
                    or request["format"] == "markdown" and reply.get("skipped") is True
                )) or (reply.get("ok") is False and isinstance(reply.get("error"), str))
            ):
                raise ValueError("invalid worker reply")
        except (RequestCancelled, asyncio.CancelledError):
            await self.stop_worker()
            raise
        except TimeoutError:
            await self.stop_worker()
            raise RuntimeError("Kokoro-ru: таймаут синтеза (300 с)") from None
        except (OSError, ValueError) as error:
            await self.stop_worker()
            tail = self.tail.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"Kokoro-ru: ошибка Python worker: {tail or error}") from error
        return reply

    async def play(self, path, disconnect):
        args = [sys.executable, "-X", "utf8", "-c", WINSOUND, str(path)] if os.name == "nt" else ["/usr/bin/afplay", str(path)]
        try:
            player = await asyncio.create_subprocess_exec(
                *args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=WINDOWS_FLAGS,
            )
            try:
                status = await until_cancelled(player.wait(), disconnect)
            finally:
                await terminate(player)
        except OSError as error:
            raise RuntimeError(f"Kokoro-ru: ошибка проигрывания: {error}") from error
        if status:
            raise RuntimeError(f"Kokoro-ru: ошибка проигрывания (код {status})")

    async def run(self, request, disconnect):
        kind, text, voice = request.get("kind"), request.get("text"), request.get("voice")
        if (kind not in ("manual", "auto", "save") or voice not in ("sveta", "masha", "dima")
                or not isinstance(text, str) or not text.strip() or len(text.encode("utf-16-le", "surrogatepass")) > 30_000):
            return {"ok": False, "error": "Kokoro-ru: неверный запрос озвучки"}
        target = None
        if kind == "save":
            path = request.get("target")
            if not isinstance(path, str) or not Path(path).is_absolute() or not path.lower().endswith(".wav"):
                return {"ok": False, "error": "Kokoro-ru: ожидается абсолютный путь WAV"}
            target = Path(path)
        if self.active:
            return {"ok": True, "skipped": True} if kind == "auto" else {"ok": False, "error": BUSY}
        self.active = True
        self.idle.cancel()
        try:
            with tempfile.TemporaryDirectory(prefix="omp-kokoro-ru-", dir=target.parent if target else None) as temp:
                wav = Path(temp) / "speech.wav"
                reply = await self.synthesize({
                    "text": text, "voice": voice, "format": "markdown" if kind == "auto" else "plain",
                    "output_path": str(wav),
                }, disconnect)
                if "bytes" not in reply:
                    return reply
                if disconnect.done():
                    raise RequestCancelled
                if target is not None:
                    wav.replace(target)
                    return reply
                await self.play(wav, disconnect)
                return {"ok": True, "played": True}
        except RequestCancelled:
            return {"ok": True, "skipped": True}
        except (OSError, RuntimeError, ValueError) as error:
            return {"ok": False, "error": str(error)}
        finally:
            self.active = False
            if not self.closing.is_set():
                self.arm_idle()

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.connections.add(task)
        try:
            async with asyncio.timeout(3):
                hello = json.loads(await reader.readline())
                if not isinstance(hello, dict):
                    return
                nonce, auth = hello.get("nonce"), hello.get("auth")
                if (not isinstance(nonce, str) or len(nonce) != 32 or not nonce.isascii()
                        or not isinstance(auth, str) or not auth.isascii()
                        or not hmac.compare_digest(auth, proof(self.key, "client", nonce))):
                    return
                if self.closing.is_set():
                    return
                if not self.active:
                    self.idle.cancel()
                    self.arm_idle()
                writer.write(frame({"proof": proof(self.key, "server", nonce)}))
                await writer.drain()
                request = json.loads(await reader.readline())
            if not isinstance(request, dict) or self.closing.is_set():
                return
            disconnect = asyncio.create_task(reader.read(1))
            try:
                reply = await self.run(request, disconnect)
                writer.write(frame(reply))
                await writer.drain()
            finally:
                disconnect.cancel()
                await asyncio.gather(disconnect, return_exceptions=True)
        except (OSError, UnicodeError, ValueError, TimeoutError):
            pass
        finally:
            writer.close()
            with suppress(OSError):
                await writer.wait_closed()
            self.connections.discard(task)

    async def serve(self):
        server = await asyncio.start_server(self.handle, "127.0.0.1", 0, limit=LINE_LIMIT)
        endpoint = self.root / ENDPOINT
        try:
            port = server.sockets[0].getsockname()[1]
            with tempfile.NamedTemporaryFile(dir=self.root, prefix=".daemon-", delete=False) as file:
                pending = Path(file.name)
                file.write(frame({"port": port, "key": self.key.hex(), "pid": os.getpid()}))
            try:
                pending.replace(endpoint)
            finally:
                pending.unlink(missing_ok=True)
            self.arm_idle()
            await self.closing.wait()
        finally:
            self.closing.set()
            if self.idle is not None:
                self.idle.cancel()
            server.close()
            clients = tuple(self.connections)
            for client in clients:
                client.cancel()
            await asyncio.gather(*clients, return_exceptions=True)
            await server.wait_closed()
            await self.stop_worker()
            endpoint.unlink(missing_ok=True)


def daemon(root, idle_seconds=IDLE_SECONDS):
    with daemon_lock(root) as acquired:
        if acquired:
            asyncio.run(Daemon(root, idle_seconds).serve())


if __name__ == "__main__":
    daemon(Path(sys.argv[1]).resolve())
