"""One knob across temperature, top_p and top_k.

The three of them say roughly the same thing in three different units — how
much room the sampler has — and they are almost always moved together and in
the same direction. Doing that by hand means three edits and remembering which
way each one points, which is why in practice they get left where they are.

So: a single position from 0 to 1, and a range for each parameter that says
what 0 and 1 mean. The map is linear and nothing more, which is the point — it
is meant to be predictable rather than clever, and a position of 0.5 gives the
middle of every range.

The same maths runs in three places: here, when the node executes; in the web
extension, so the fields on the node show what the slider is about to send;
and, through the values the node then reports, in any front end that submits an
API-format workflow. `tests/test_scale.py` pins it down.
"""

from __future__ import annotations

import math
from typing import Dict, Mapping, Tuple

#: The parameters one slider moves, in the order they are shown.
SCALED: Tuple[str, ...] = ("temperature", "top_p", "top_k")

#: What 0 and 1 mean when nobody has said otherwise.
#:
#: Chosen so that 0 is a model that will not surprise you and 1 is one that
#: will. All three rise together — a bigger top_k is more choices, the same
#: direction a higher temperature and a higher top_p point in — so the slider
#: reads as one thing rather than as three settings in a trench coat.
DEFAULT_RANGES: Dict[str, Tuple[float, float]] = {
    "temperature": (0.1, 1.4),
    "top_p": (0.5, 1.0),
    "top_k": (10.0, 100.0),
}

#: `top_k` is a count of tokens, not a weight.
INTEGER = frozenset({"top_k"})


def _bounds(ranges: Mapping[str, Tuple[float, float]], name: str) -> Tuple[float, float]:
    low, high = ranges.get(name, DEFAULT_RANGES[name])
    return float(low), float(high)


def clamp01(position: float) -> float:
    """A slider position, kept inside the ends of its own travel."""
    try:
        value = float(position)
    except (TypeError, ValueError):
        return 0.0
    if value != value:  # NaN
        return 0.0
    return max(0.0, min(1.0, value))


def scaled_value(position: float, name: str,
                 ranges: Mapping[str, Tuple[float, float]] = DEFAULT_RANGES) -> float:
    """One parameter, at this position along its own range.

    A range given the other way round — a high number at 0 and a low one at 1 —
    is honoured rather than corrected. It is the only way to say "this one runs
    against the others", and inverting it by hand is exactly the arithmetic
    this is here to avoid.
    """
    low, high = _bounds(ranges, name)
    value = low + clamp01(position) * (high - low)
    if name in INTEGER:
        # Half rounded up, not to even. Python's `round` sends 32.5 to 32 and
        # JavaScript's `Math.round` sends it to 33 — and the extension is
        # JavaScript, so banker's rounding here would mean the field on the node
        # showing one top_k while the node sent another. These two agree or the
        # slider is a lie; see `TestTheExtensionAgrees`.
        return float(math.floor(value + 0.5))
    # Rounded because this number is shown in a widget and sent in a payload,
    # and 0.7499999999999999 is neither of those things usefully. Four places
    # is finer than any of these parameters is meaningfully read to, and it is
    # what keeps the web extension's arithmetic and this agreeing exactly.
    return round(value, 4)


def scaled_values(position: float,
                  ranges: Mapping[str, Tuple[float, float]] = DEFAULT_RANGES) -> Dict[str, float]:
    """All three, at one position."""
    return {name: scaled_value(position, name, ranges) for name in SCALED}


def position_for(name: str, value: float,
                 ranges: Mapping[str, Tuple[float, float]] = DEFAULT_RANGES) -> float:
    """Where a value sits on the slider — the inverse of :func:`scaled_value`.

    This is what makes the two halves one control rather than two: typing a
    temperature moves the slider to wherever that temperature is, and the other
    two parameters then follow it there.

    A range with no width has no answer, and 0 is the least surprising of the
    wrong ones: a slider that cannot move should read as being at its start.
    """
    low, high = _bounds(ranges, name)
    if high == low:
        return 0.0
    try:
        return clamp01((float(value) - low) / (high - low))
    except (TypeError, ValueError):
        return 0.0
