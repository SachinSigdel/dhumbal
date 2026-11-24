"""Sound effects for the Dhumbal window.

Every sound is synthesised here (no audio files ship with the game): they are written
once as small WAV files to a cache folder and played with the system's own player
(afplay on macOS, paplay/aplay on Linux, winsound on Windows). If no player is found
the game simply stays silent.
"""
from __future__ import annotations

import math
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import wave

RATE = 22050
VERSION = 2          # bump when the sounds change, so the cache is rebuilt


# ---------- tiny synthesiser ----------
def silence(seconds: float) -> list[float]:
    return [0.0] * int(RATE * seconds)


def mix_into(base: list[float], add: list[float], at: float = 0.0, gain: float = 1.0) -> list[float]:
    start = int(RATE * at)
    if len(base) < start + len(add):
        base.extend([0.0] * (start + len(add) - len(base)))
    for i, value in enumerate(add):
        base[start + i] += value * gain
    return base


def tone(freq: float, seconds: float, volume: float = 0.4, decay: float = 6.0,
         attack: float = 0.005, harmonics=(1.0, 0.35, 0.12), glide: float = 0.0) -> list[float]:
    """A soft bell-like note: a few harmonics with a quick attack and exponential decay.
    `glide` bends the pitch by that many semitones over the note."""
    out = []
    phase = [0.0] * len(harmonics)
    n = int(RATE * seconds)
    for i in range(n):
        t = i / RATE
        f = freq * 2 ** (glide * (i / n) / 12)
        env = min(1.0, t / attack) * math.exp(-decay * t)
        value = 0.0
        for h, amp in enumerate(harmonics):
            phase[h] += 2 * math.pi * f * (h + 1) / RATE
            value += amp * math.sin(phase[h])
        out.append(value * env * volume)
    return out


def noise(seconds: float, volume: float = 0.5, decay: float = 40.0, smooth: float = 0.35,
          rng: random.Random | None = None) -> list[float]:
    """A filtered noise burst: the snap of a card. Lower `smooth` = duller sound."""
    rng = rng or random.Random(1)
    out, y = [], 0.0
    for i in range(int(RATE * seconds)):
        t = i / RATE
        y += smooth * (rng.uniform(-1, 1) - y)          # one-pole low-pass
        out.append(y * math.exp(-decay * t) * volume)
    return out


def card_snap(volume: float = 0.7, seed: int = 1) -> list[float]:
    """A card landing on felt: a short bright snap over a soft thump."""
    snap = noise(0.14, volume, decay=34, smooth=0.32, rng=random.Random(seed))
    thump = tone(120, 0.16, volume * 0.35, decay=24, harmonics=(1.0,))
    return mix_into(snap, thump)


def swish(volume: float = 0.45) -> list[float]:
    """A card sliding off the table: noise that swells and fades, brightening as it goes."""
    rng = random.Random(7)
    n = int(RATE * 0.32)
    out, y = [], 0.0
    for i in range(n):
        p = i / n
        y += (0.05 + 0.22 * p) * (rng.uniform(-1, 1) - y)
        out.append(y * math.sin(math.pi * p) * volume)
    return out


def riffle(seconds: float = 1.8, riffles: int = 3) -> list[float]:
    """Three riffle shuffles: bursts of fast card ticks, each speeding up, with a pause between."""
    rng = random.Random(3)
    out = silence(seconds)
    span = seconds / riffles
    for r in range(riffles):
        start = r * span + 0.05
        t, gap = start, 0.045
        while t < start + span * 0.62:
            mix_into(out, noise(0.03, rng.uniform(0.25, 0.4), decay=90, smooth=0.35,
                                rng=random.Random(rng.random())), at=t)
            t += gap * rng.uniform(0.8, 1.15)
            gap *= 0.985                                   # ticks speed up a little through the riffle
        mix_into(out, card_snap(0.5, seed=r + 10), at=start + span * 0.66)   # the deck squared up
    return out


def chord(freqs, seconds: float, volume: float = 0.25, decay: float = 3.0, spread: float = 0.0):
    out: list[float] = []
    for k, freq in enumerate(freqs):
        mix_into(out, tone(freq, seconds - k * spread, volume, decay=decay), at=k * spread)
    return out


def buzz(seconds: float = 0.8, volume: float = 0.3) -> list[float]:
    """A soft 'caught!' buzzer: a low, slightly rough note that sags in pitch."""
    rough = tone(196, seconds, volume, decay=2.5, attack=0.02, harmonics=(1.0, 0.6, 0.45, 0.3, 0.2), glide=-3)
    return mix_into(rough, tone(185, seconds, volume * 0.6, decay=2.5, attack=0.02, harmonics=(1.0, 0.5), glide=-3))


# note frequencies
C4, E4, G4, A4, B4 = 261.63, 329.63, 392.00, 440.00, 493.88
C5, D5, E5, G5, A5, C6 = 523.25, 587.33, 659.25, 783.99, 880.00, 1046.50
EB4, AB3, F3 = 311.13, 207.65, 174.61


# how loud each sound is at its peak (0-1): kept low so the effects sit in the background
LEVELS = {
    "shuffle": 0.16, "deal": 0.10, "throw": 0.17, "pick": 0.13, "turn": 0.15, "click": 0.08,
    "nope": 0.12, "call": 0.20, "caught": 0.20, "win": 0.22, "lose": 0.20, "out": 0.20,
}


def build_sounds() -> dict[str, list[float]]:
    """All the effects, unhurried: soft attacks, long tails, notes spread well apart."""
    return {
        "shuffle": riffle(),
        "deal": card_snap(0.35, seed=5),
        "throw": card_snap(0.7, seed=2),
        "pick": swish(),
        "turn": mix_into(tone(E5, 0.6, 0.22, decay=4.5, attack=0.02),
                         tone(A5, 0.8, 0.22, decay=4, attack=0.02), at=0.22),
        "click": noise(0.05, 0.35, decay=90, smooth=0.4),
        "nope": tone(220, 0.35, 0.25, decay=8, attack=0.015, harmonics=(1.0, 0.3)),
        "call": chord([C4, G4, C5], 1.6, 0.2, decay=2.0, spread=0.12),
        "caught": buzz(0.8),
        "win": chord([C5, E5, G5, C6], 2.2, 0.2, decay=1.6, spread=0.24),
        "lose": chord([G4, EB4, C4], 1.9, 0.2, decay=1.8, spread=0.32),
        "out": mix_into(tone(AB3, 0.9, 0.28, decay=2.6, glide=-2, attack=0.02),
                        tone(F3, 1.2, 0.24, decay=2.2, attack=0.02), at=0.4),
    }


def write_wav(path: str, samples: list[float], level: float = 0.25):
    """Write mono 16-bit audio, scaled so its loudest point is `level` (0-1)."""
    peak = max(1e-9, max(abs(s) for s in samples))
    scale = level / peak
    frames = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s * scale)) * 32767)) for s in samples)
    with wave.open(path, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(frames)


# ---------- playback ----------
class Sounds:
    """Plays the game's sound effects without blocking the window."""

    def __init__(self, enabled: bool = True, folder: str | None = None):
        self.enabled = enabled
        self.folder = folder or os.path.join(tempfile.gettempdir(), f"dhumbal-sounds-{VERSION}")
        self.command = self._find_player()
        self.ready = False
        if enabled:
            self.prepare()

    @staticmethod
    def _find_player() -> list[str] | None:
        if sys.platform == "win32":
            return ["winsound"]
        for command in (["afplay"], ["paplay"], ["aplay", "-q"]):
            if shutil.which(command[0]):
                return command
        return None

    @property
    def available(self) -> bool:
        return self.command is not None

    def path(self, name: str) -> str:
        return os.path.join(self.folder, f"{name}.wav")

    def prepare(self):
        """Write any missing sound files (only the first time the game runs)."""
        if self.ready or not self.available:
            return
        try:
            os.makedirs(self.folder, exist_ok=True)
            names = ("shuffle", "deal", "throw", "pick", "turn", "click", "nope",
                     "call", "caught", "win", "lose", "out")
            if not all(os.path.exists(self.path(n)) for n in names):
                for name, samples in build_sounds().items():
                    write_wav(self.path(name), samples, LEVELS[name])
            self.ready = True
        except OSError:
            self.command = None                            # can't write the files: stay silent

    def toggle(self) -> bool:
        self.enabled = not self.enabled
        if self.enabled:
            self.prepare()
        return self.enabled

    def play(self, name: str):
        if not (self.enabled and self.available):
            return
        self.prepare()
        path = self.path(name)
        if not os.path.exists(path):
            return
        try:
            if self.command == ["winsound"]:
                import winsound
                winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
            else:
                subprocess.Popen(self.command + [path], stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL)
        except OSError:
            pass
