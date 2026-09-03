"""What the GPU is actually drawing, in watts.

Utilisation does not answer the question people ask of it. "GPU at 100%" means
the scheduler had work resident every sampling interval, which a kernel waiting
on memory satisfies just as well as one doing arithmetic — so a run that is
bandwidth-bound and a run that is compute-bound both read 100%, and the number
that separates them is the power draw. A 450 W card pulling 160 W at "full
utilisation" is waiting for memory; the same card pulling 430 W is working.

Read here rather than in Latent because this is the process on the machine with
the GPU in it. Latent is routinely somewhere else — a NAS at home talking to a
rented box — and `nvidia-smi` run there would report the wrong card, or none,
with no way to tell which had happened. Same reasoning as the folder browser:
the far machine is the one that knows.

Two ways of asking, in order of preference:

* **NVML**, through `pynvml`, which torch's CUDA builds already depend on. It is
  a library call against a handle we keep, so it costs microseconds and can be
  polled as often as anyone likes.
* **`nvidia-smi`**, as a subprocess, for an install where the bindings are
  missing but the driver is not. It costs tens of milliseconds, which is why it
  is second and why the answer is cached either way.

Anything else — Apple silicon, ROCm, a CPU-only box — reports nothing at all.
An absent reading is a fact the UI can state; a zero is a lie it would draw.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional

ROUTE = "/comfyllama/power"

# How long a reading stays fresh.
#
# Latent samples every two seconds while a render is running, and the point of
# the figure is to see it move within a run — so this is short enough not to
# flatten that, and long enough that two clients polling at once are one call.
CACHE_MS = 900

_cache: Optional[Dict[str, Any]] = None
_cache_at = 0.0

# Set once we have tried and failed, so a CPU-only box does not pay for a
# subprocess every two seconds forever.
_unavailable = False

_nvml: Any = None
_handles: List[Any] = []


def _init_nvml() -> bool:
    """Bring NVML up once, and keep the device handles. False if it is not there."""
    global _nvml, _handles
    if _nvml is not None:
        return True
    try:
        import pynvml  # type: ignore
    except ImportError:
        return False

    try:
        pynvml.nvmlInit()
        count = pynvml.nvmlDeviceGetCount()
        _handles = [pynvml.nvmlDeviceGetHandleByIndex(index) for index in range(count)]
    except Exception:
        # A driver mismatch raises from inside the library; treat it exactly
        # like an absent one rather than letting it reach a request handler.
        return False

    if not _handles:
        return False
    _nvml = pynvml
    return True


def _from_nvml() -> Optional[List[Dict[str, Any]]]:
    if not _init_nvml():
        return None

    gpus: List[Dict[str, Any]] = []
    for handle in _handles:
        try:
            # Milliwatts, both of them.
            watts = _nvml.nvmlDeviceGetPowerUsage(handle) / 1000.0
        except Exception:
            continue

        limit: Optional[float] = None
        for getter in ("nvmlDeviceGetEnforcedPowerLimit", "nvmlDeviceGetPowerManagementLimit"):
            # The enforced limit is the one that matters — it is what the card
            # will actually let itself reach, after any cap somebody set — and
            # it is missing on older drivers, where the management limit is the
            # same number by another name.
            try:
                limit = getattr(_nvml, getter)(handle) / 1000.0
                break
            except Exception:
                continue

        gpus.append({"watts": round(watts, 1), "limit": round(limit, 1) if limit else None})

    return gpus or None


def _from_smi() -> Optional[List[Dict[str, Any]]]:
    if shutil.which("nvidia-smi") is None:
        return None

    try:
        output = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=power.draw,power.limit",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=4,
            check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None

    gpus: List[Dict[str, Any]] = []
    for line in output.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if not parts or not parts[0]:
            continue
        try:
            watts = float(parts[0])
        except ValueError:
            # "[N/A]" on a card that does not report it, which is a card we
            # have nothing to say about rather than a failure of the query.
            continue
        try:
            limit: Optional[float] = float(parts[1]) if len(parts) > 1 else None
        except ValueError:
            limit = None
        gpus.append({"watts": round(watts, 1), "limit": round(limit, 1) if limit else None})

    return gpus or None


def read_power(now: Optional[float] = None) -> Dict[str, Any]:
    """The current draw per GPU, cached briefly.

    `{"gpus": [{"watts": 312.4, "limit": 450.0}], "source": "nvml"}`, or
    `{"gpus": [], "source": None}` where there is nothing to read.
    """
    global _cache, _cache_at, _unavailable

    moment = now if now is not None else time.monotonic()
    if _cache is not None and (moment - _cache_at) * 1000 < CACHE_MS:
        return _cache

    if _unavailable:
        return {"gpus": [], "source": None}

    gpus = _from_nvml()
    source = "nvml"
    if gpus is None:
        gpus = _from_smi()
        source = "nvidia-smi"

    if gpus is None:
        # Remembered, so a box with no NVIDIA card in it stops being asked.
        _unavailable = True
        return {"gpus": [], "source": None}

    _cache = {"gpus": gpus, "source": source}
    _cache_at = moment
    return _cache


def reset() -> None:
    """Forget everything cached. For tests, and for a driver that came back."""
    global _cache, _cache_at, _unavailable, _nvml, _handles
    _cache = None
    _cache_at = 0.0
    _unavailable = False
    _nvml = None
    _handles = []


def register_routes() -> bool:
    """Attach the power route to ComfyUI's aiohttp app. No-op outside it."""
    try:
        from aiohttp import web
        from server import PromptServer
    except ImportError:
        return False

    instance = getattr(PromptServer, "instance", None)
    routes = getattr(instance, "routes", None)
    if routes is None:
        return False

    @routes.get(ROUTE)
    async def get_power(request):  # pragma: no cover - needs a running server
        # NVML is a fast library call, but the `nvidia-smi` fallback is a
        # subprocess, and blocking the event loop for 40ms every two seconds
        # would be felt by every other request ComfyUI is serving.
        import asyncio

        return web.json_response(await asyncio.to_thread(read_power))

    return True
