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

from kokoro_ru import frame

IDLE_SECONDS = 300
SYNTHESIS_SECONDS = 300
LINE_LIMIT = 128 * 1024
ENDPOINT = "daemon-v1.json"
WORKER = Path(__file__).with_name("kokoro_ru.py")
BUSY = "Kokoro-ru: другой запрос уже выполняется"
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


class PlaybackError(RuntimeError):
    pass


class Playback:
    def __init__(self):
        self.process = None
        self.diagnostics = None

    async def write(self, pcm):
        try:
            if self.process is None:
                self.process = await asyncio.create_subprocess_exec(
                    sys.executable, "-X", "utf8", str(WORKER), "play",
                    stdin=asyncio.subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
                    creationflags=WINDOWS_FLAGS,
                )
                self.diagnostics = asyncio.create_task(self.process.stderr.read())
            self.process.stdin.write(pcm)
            await self.process.stdin.drain()
        except OSError as error:
            if isinstance(error, BrokenPipeError | ConnectionResetError) and self.process is not None:
                await self.wait_for_exit()
            raise PlaybackError(f"Kokoro-ru: ошибка проигрывания: {error or 'канал PCM закрыт'}") from error

    async def wait_for_exit(self):
        status = await self.process.wait()
        if status:
            detail = (await self.diagnostics).decode("utf-8", errors="replace").strip()
            raise PlaybackError(f"Kokoro-ru: ошибка проигрывания: {detail or f'код {status}'}")

    async def finish(self):
        self.process.stdin.close()
        await self.wait_for_exit()

    async def close(self):
        if self.process is not None:
            await terminate(self.process)
            await self.diagnostics


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
            async def discard_output():
                # A cancelled stream can leave stdout paused at its buffer limit.
                while await self.worker.stdout.read(8192):
                    pass

            await asyncio.gather(terminate(self.worker), discard_output(), self.diagnostics)
            self.worker = None
            self.diagnostics = None

    async def ask_worker(self, request, playback):
        self.worker.stdin.write(frame(request))
        await self.worker.stdin.drain()
        if playback is None:
            return json.loads(await self.worker.stdout.readline())
        while True:
            # Time the next model frame, not time spent draining the audio device.
            async with asyncio.timeout(SYNTHESIS_SECONDS):
                reply = json.loads(await self.worker.stdout.readline())
                if not isinstance(reply, dict) or "pcm" not in reply:
                    return reply
                size = reply["pcm"]
                if type(size) is not int or size <= 0 or size % 2:
                    raise ValueError("invalid PCM frame size")
                pcm = await self.worker.stdout.readexactly(size)
            await playback.write(pcm)

    async def synthesize(self, request, disconnect, playback=None):
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
            reply = await until_cancelled(
                self.ask_worker(request, playback), disconnect,
                SYNTHESIS_SECONDS if playback is None else None,
            )
            if not isinstance(reply, dict) or not (
                (reply.get("ok") is True and (
                    (playback is None and type(reply.get("bytes")) is int and reply["bytes"] > 0)
                    or (playback is not None and playback.process is not None and reply.get("streamed") is True)
                    or (request["format"] == "markdown" and reply.get("skipped") is True)
                )) or (reply.get("ok") is False and isinstance(reply.get("error"), str))
            ):
                raise ValueError("invalid worker reply")
        except (RequestCancelled, asyncio.CancelledError, PlaybackError):
            await self.stop_worker()
            raise
        except TimeoutError:
            await self.stop_worker()
            raise RuntimeError("Kokoro-ru: таймаут синтеза (300 с)") from None
        except (OSError, ValueError, asyncio.IncompleteReadError) as error:
            await self.stop_worker()
            tail = self.tail.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"Kokoro-ru: ошибка Python worker: {tail or error}") from error
        return reply

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
            synthesis = {"text": text, "voice": voice, "format": "markdown" if kind == "auto" else "plain"}
            if target is None:
                playback = Playback()
                try:
                    reply = await self.synthesize(synthesis, disconnect, playback)
                    if "streamed" not in reply:
                        return reply
                    await until_cancelled(playback.finish(), disconnect)
                    return {"ok": True, "played": True}
                finally:
                    await playback.close()

            with tempfile.TemporaryDirectory(prefix="omp-kokoro-ru-", dir=target.parent) as temp:
                wav = Path(temp) / "speech.wav"
                reply = await self.synthesize({**synthesis, "output_path": str(wav)}, disconnect)
                if "bytes" in reply:
                    if disconnect.done():
                        raise RequestCancelled
                    wav.replace(target)
                return reply
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
