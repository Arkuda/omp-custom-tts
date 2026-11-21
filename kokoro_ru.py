import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import wave
from pathlib import Path

KOKORO_REPO = "zaakirio/kokoro-ru"
KOKORO_REVISION = "d649c57b239b18c4c384378127cbf01dba039bc1"
ACCENT_REVISION = "b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855"
DEFAULT_VOICE = "sveta"
CHECKPOINTS = {
    "sveta": "model_quantized.onnx",
    "masha": "model_quantized.onnx",
    "dima": "model_dima_quantized.onnx",
}
SAMPLE_RATE = 24_000
IPA_LIMIT = 510
INTER_FRAGMENT_SILENCE = bytes(SAMPLE_RATE * 80 // 1000 * 2)
PLAYBACK_BLOCK = 2048  # samples (about 85 ms)
PARAGRAPH = re.compile(r"\n[^\S\n]*\n")
SENTENCE = re.compile(r"(?<=[.!?…]) ")
URL = re.compile(r"(?:https?://|www\.)\S*", re.IGNORECASE)
RUSSIAN = re.compile(r"[А-Яа-яЁё]")


def frame(value):
    return json.dumps(value, ensure_ascii=True).encode("ascii") + b"\n"


def voice_files(voice):
    return f"onnx/{CHECKPOINTS[voice]}", f"voices/{voice}.bin"


def ensure_voice(model_dir, voice):
    for filename in voice_files(voice):
        if (model_dir / filename).is_file():
            continue
        from huggingface_hub import hf_hub_download

        try:
            hf_hub_download(
                KOKORO_REPO, filename, revision=KOKORO_REVISION, local_dir=model_dir, token=False,
            )
        except Exception as error:
            raise RuntimeError(f"Kokoro-ru: не удалось скачать голос {voice} ({filename}): {error}") from error


def markdown_text(text):
    from markdown_it import MarkdownIt

    blocks = []
    in_table = False
    for token in MarkdownIt("commonmark").enable("table").parse(text):
        if token.type in ("table_open", "table_close"):
            in_table = token.type == "table_open"
        if token.type != "inline" or in_table:
            continue
        block = URL.sub("", "".join(
            child.content if child.type in ("text", "code_inline") else " "
            for child in token.children or ()
            if child.type in ("text", "code_inline", "softbreak", "hardbreak")
        )).strip()
        if RUSSIAN.search(block):
            blocks.append(block)
    return "\n\n".join(blocks)


def fragments(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    for paragraph in PARAGRAPH.split(text):
        normalized = " ".join(paragraph.split())
        for sentence in SENTENCE.split(normalized):
            while len(sentence) > 160:
                boundary = sentence.rfind(" ", 0, 161)
                if boundary < 1:
                    boundary = 160
                yield sentence[:boundary]
                sentence = sentence[boundary:].lstrip()
            if sentence:
                yield sentence


class Synthesizer:
    def __init__(self, model_dir):
        self.model_dir = model_dir
        self.g2p = None
        self.session = None
        self.checkpoint = None
        self.packs = {}

    def phonemes(self, text):
        if self.g2p is None:
            import ruaccent

            # RUAccent otherwise fetches unpinned resources if these directories are absent.
            accent_root = Path(ruaccent.__file__).parent
            if not all((accent_root / directory).is_dir() for directory in (
                "dictionary", "nn/nn_omograph/turbo3.1", "koziev",
            )):
                raise RuntimeError("Kokoro-ru: не хватает данных RUAccent; запусти установщик")
            sys.path.insert(0, str(self.model_dir))
            try:
                from ru_g2p import RuG2P, _TokenTypeIdsShim
            finally:
                sys.path.pop(0)
            self.vocab = json.loads((self.model_dir / "kokoro-config.json").read_text(encoding="utf-8"))["vocab"]
            self.g2p = RuG2P()
            # The upstream Transformers 5 shim shadows the fast backend that
            # RUAccent's stress predictor reads. Transformers 4 supplies these IDs.
            stress = self.g2p._accent.stress_usage_predictor
            if isinstance(stress.tokenizer, _TokenTypeIdsShim):
                stress.tokenizer = stress.tokenizer._tokenizer
        ipa, _ = self.g2p(text)
        if len(ipa) > IPA_LIMIT:
            if len(text) < 2:
                raise ValueError("Kokoro-ru: phoneme limit exceeded for one character")
            middle = len(text) // 2
            left = text.rfind(" ", 0, middle + 1)
            right = text.find(" ", middle)
            if left > 0 and (right < 0 or middle - left <= right - middle):
                boundary = left
            else:
                boundary = right if right >= 0 else middle
            yield from self.phonemes(text[:boundary].rstrip())
            yield from self.phonemes(text[boundary:].lstrip())
            return
        kept = [c for c in ipa if c in self.vocab]
        if any(c.isalpha() and unicodedata.category(c) != "Lm" for c in kept):
            yield len(ipa), [self.vocab[c] for c in kept]

    def pcm(self, voice, length, ids):
        import numpy as np
        import onnxruntime as ort

        checkpoint = CHECKPOINTS[voice]
        if self.checkpoint != checkpoint:
            self.session = None
            self.checkpoint = None
            self.session = ort.InferenceSession(
                str(self.model_dir / "onnx" / checkpoint), providers=["CPUExecutionProvider"]
            )
            self.checkpoint = checkpoint
        if voice not in self.packs:
            self.packs[voice] = np.fromfile(self.model_dir / "voices" / f"{voice}.bin", dtype="<f4").reshape(IPA_LIMIT, 256)
        audio = self.session.run(None, {
            "input_ids": np.array([[0, *ids, 0]], dtype=np.int64),
            "style": self.packs[voice][length - 1:length],
            "speed": np.ones(1, dtype=np.float32),
        })[0]
        if not audio.size or not np.isfinite(audio).all():
            raise ValueError("Kokoro-ru: model returned empty or non-finite audio")
        np.clip(audio, -1, 1, out=audio)
        audio *= 32767
        pcm = audio.astype("<i2")
        if not pcm.any():
            raise ValueError("Kokoro-ru: model returned silent PCM")
        return pcm.tobytes()

    def chunks(self, text, voice):
        first = True
        for frag in fragments(text):
            for item in self.phonemes(frag):
                if first:
                    ensure_voice(self.model_dir, voice)
                pcm = self.pcm(voice, *item)
                if not first:
                    yield INTER_FRAGMENT_SILENCE
                first = False
                yield pcm

    def render(self, chunks, target):
        first = next(chunks, None)
        if first is None:
            return None
        with wave.open(str(target), "wb") as wav:
            wav.setparams((1, 2, SAMPLE_RATE, 0, "NONE", "not compressed"))
            wav.writeframesraw(first)
            for pcm in chunks:
                wav.writeframesraw(pcm)
        return target.stat().st_size


def request(synth, message, protocol):
    text = message["text"]
    voice = message["voice"]
    fmt = message["format"]
    if voice not in CHECKPOINTS or fmt not in ("plain", "markdown"):
        raise ValueError("Kokoro-ru: invalid voice or text format")
    if fmt == "markdown":
        text = markdown_text(text)
    chunks = synth.chunks(text, voice)
    if "output_path" in message:
        size = synth.render(chunks, Path(message["output_path"]))
        if size is not None:
            return {"ok": True, "bytes": size}
    else:
        streamed = False
        for pcm in chunks:
            protocol.write(frame({"pcm": len(pcm)}))
            protocol.write(pcm)
            protocol.flush()
            streamed = True
        if streamed:
            return {"ok": True, "streamed": True}
    if fmt == "markdown":
        return {"ok": True, "skipped": True}
    raise ValueError("Kokoro-ru: нет речевых фонем")


def worker(root):
    # Keep the JSONL pipe separate from stdout, including native diagnostics.
    sys.stdout.flush()
    protocol_fd = os.dup(sys.stdout.fileno())
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    synth = Synthesizer(root / "kokoro" / KOKORO_REVISION)
    with os.fdopen(protocol_fd, "wb") as protocol:
        for line in sys.stdin:
            try:
                result = request(synth, json.loads(line), protocol)
            except Exception as error:
                result = {"ok": False, "error": str(error) or type(error).__name__}
            protocol.write(frame(result))
            protocol.flush()


def play_pcm():
    try:
        from sounddevice import RawOutputStream
    except ImportError as error:
        raise RuntimeError("не установлен sounddevice; запусти установщик Kokoro-ru") from error

    block = bytearray(PLAYBACK_BLOCK * 2)
    view = memoryview(block)
    source = sys.stdin.buffer
    count = source.readinto(block)
    if count:
        with RawOutputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16", latency="high") as output:
            while count:
                output.write(view[:count])
                count = source.readinto(block)


def setup(root):
    ready = root / "ready-v1"
    ready.unlink(missing_ok=True)
    from huggingface_hub import snapshot_download
    import ruaccent

    snapshot_download(
        KOKORO_REPO, revision=KOKORO_REVISION,
        local_dir=root / "kokoro" / KOKORO_REVISION,
        allow_patterns=[
            "ru_g2p.py", "kokoro-config.json", "espeak-data/**",
            *voice_files(DEFAULT_VOICE),
        ],
    )
    snapshot_download(
        "ruaccent/accentuator", revision=ACCENT_REVISION,
        local_dir=Path(ruaccent.__file__).parent,
        allow_patterns=[
            "dictionary/**", "nn/nn_accent/**", "nn/nn_omograph/turbo3.1/**",
            "nn/nn_yo_homograph_resolver/**", "nn/nn_stress_usage_predictor/**", "koziev/**",
        ],
    )
    with tempfile.TemporaryDirectory(prefix="omp-kokoro-ru-smoke-") as temp:
        target = Path(temp) / f"{DEFAULT_VOICE}.wav"
        request_line = json.dumps({
            "text": "Здравствуйте! Как ваши дела?", "voice": DEFAULT_VOICE,
            "format": "plain", "output_path": str(target),
        }) + "\n"
        smoke = subprocess.run(
            [sys.executable, "-X", "utf8", "-u", str(Path(__file__).resolve()), "worker", str(root)],
            input=request_line, stdout=subprocess.PIPE, encoding="utf-8", check=True, timeout=300,
            env={**os.environ, "HF_HUB_OFFLINE": "1"},
        )
        result = json.loads(smoke.stdout)
        if result.get("ok") is not True or not target.is_file() or result.get("bytes") != target.stat().st_size:
            raise RuntimeError(f"Offline smoke ({DEFAULT_VOICE}): {result}")
        print(f"Offline smoke ({DEFAULT_VOICE}): {result['bytes']} bytes")
    ready.write_text("ready\n", encoding="utf-8")


if __name__ == "__main__":
    if sys.argv[1:] == ["play"]:
        try:
            play_pcm()
        except Exception as error:
            raise SystemExit(str(error) or type(error).__name__) from error
        raise SystemExit
    if len(sys.argv) != 3 or sys.argv[1] not in ("setup", "worker"):
        raise SystemExit("Usage: kokoro_ru.py setup|worker <dataRoot> | play")
    root = Path(sys.argv[2]).resolve()
    (setup if sys.argv[1] == "setup" else worker)(root)
