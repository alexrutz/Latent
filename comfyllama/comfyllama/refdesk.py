"""Working out which reference is which, before any tensor is touched.

MiniMax H3 refers to its references *by ordinal*, inside the prompt:
`<Picture 1>`, `<Video 1>`, `<Audio 2>`. The ordinals are 1-based per type and
they come from the order the references are presented in — not from which slot
they were plugged into. Which means turning one reference off silently changes
what every later number in your prompt means. A prompt reading "the woman in
<Picture 3> wears the jacket from <Picture 4>" keeps running after you disable
<Picture 1>; it just quietly describes two different pictures.

So the ordinal is not something to type. It is something to derive. You give a
slot a short tag — `woman`, `jacket` — write `@woman` in the prompt, and this
module works out what number that turned into once the switches have had their
say. The slot is the fact; the ordinal is the view of it.

Two details of the upstream node's ordering are reproduced here exactly, and
both are easy to get wrong by hand:

- a reference video's soundtrack takes an `<Audio j>` ordinal, and it takes it
  *before* the video's own `<Video k>`. So one video-with-sound plus one
  standalone audio makes the soundtrack `<Audio 1>` and the standalone
  `<Audio 2>`, not the other way round;
- the order is all pictures, then the videos, then the standalone audio,
  whatever order the slots are in.

Nothing here imports torch, ComfyUI or anything else heavy: it is a function
from "which switches are on" to "what the prompt should say", which is the part
worth testing.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

# How many slots of each kind the node offers, matching the upstream maxima.
MAX_IMAGES = 9
MAX_VIDEOS = 3
MAX_AUDIOS = 3

# The tag syntax. `@name`, because it types cleanly on a phone keyboard.
#
# Not `{name}`: the upstream prompt input has `dynamic_prompts=True`, so braces
# already mean "pick one of these at random" and a tag written that way would be
# eaten before this ever saw it.
TAG_PATTERN = re.compile(r"@([A-Za-z0-9_-]+)")

# What the model calls each kind, in the prompt.
LABELS = {"image": "Picture", "video": "Video", "audio": "Audio"}


class SlotError(ValueError):
    """Something about the slots or the prompt that a person has to fix."""


class Slot(NamedTuple):
    """One reference position, whether or not anything is in it."""

    kind: str
    """`image`, `video` or `audio`."""
    index: int
    """1-based position among the slots of that kind, fixed for the slot's life."""
    on: bool
    tag: str
    """Empty when unnamed, which is fine — it just cannot be written as `@tag`."""
    value: Any
    """The tensor, or None. Anything falsy-but-present is still a value."""
    audio: Any = None
    """A video slot's soundtrack. Ignored for the other kinds."""

    @property
    def live(self) -> bool:
        """Switched on and actually holding something."""
        return self.on and self.value is not None


class Placement(NamedTuple):
    """Where one live reference ended up."""

    slot: Slot
    ordinal: int
    """1-based, per kind, as the prompt must refer to it."""

    @property
    def label(self) -> str:
        return f"<{LABELS[self.slot.kind]} {self.ordinal}>"


class Plan(NamedTuple):
    """The whole arrangement: what goes where, and what the prompt becomes."""

    placements: List[Placement]
    prompt: str
    """The prompt with every `@tag` replaced by the label it resolved to."""

    def by_kind(self, kind: str) -> List[Placement]:
        return [placement for placement in self.placements if placement.slot.kind == kind]

    def tags(self) -> Dict[str, str]:
        """Tag to label, for the live slots that have one."""
        return {p.slot.tag.lower(): p.label for p in self.placements if p.slot.tag}


def normalise_tag(tag: Optional[str]) -> str:
    """A tag as it will be matched: trimmed, and without a leading `@`.

    People type the `@` into the tag field as often as not, having just typed it
    in the prompt. Quietly accepting it costs nothing and saves a confusing
    "no slot is tagged @@woman".
    """
    text = str(tag or "").strip()
    while text.startswith("@"):
        text = text[1:]
    return text.strip()


def _ordinals(slots: Sequence[Slot]) -> List[Placement]:
    """Number the live slots the way the upstream node presents them.

    The audio counter is shared between a video's soundtrack and the standalone
    audio slots, and the soundtrack claims its number first. That is the single
    rule here that nobody would guess, and the reason this is a function rather
    than three `enumerate` calls.
    """
    placements: List[Placement] = []
    pictures = 0
    videos = 0
    audios = 0

    for slot in slots:
        if slot.kind != "image" or not slot.live:
            continue
        pictures += 1
        placements.append(Placement(slot, pictures))

    for slot in slots:
        if slot.kind != "video" or not slot.live:
            continue
        # The soundtrack's label is emitted before the video's own, so it takes
        # the lower number.
        if slot.audio is not None:
            audios += 1
        videos += 1
        placements.append(Placement(slot, videos))

    for slot in slots:
        if slot.kind != "audio" or not slot.live:
            continue
        audios += 1
        placements.append(Placement(slot, audios))

    return placements


def _soundtrack_ordinal(slots: Sequence[Slot], target: Slot) -> int:
    """Which `<Audio j>` a particular video's soundtrack became."""
    audios = 0
    for slot in slots:
        if slot.kind == "video" and slot.live and slot.audio is not None:
            audios += 1
            if slot is target:
                return audios
    return 0


def plan(slots: Sequence[Slot], prompt: str) -> Plan:
    """Number the live references and rewrite the prompt to match.

    Raises `SlotError` for the two mistakes worth stopping on: a tag used twice,
    and a `@tag` in the prompt that no live slot answers to. The second is the
    important one — left alone it would reach the model as the literal text
    `@woman`, which is not an error anywhere but is never what was meant.
    """
    cleaned = [slot._replace(tag=normalise_tag(slot.tag)) for slot in slots]

    seen: Dict[str, Slot] = {}
    for slot in cleaned:
        if not slot.tag or not slot.live:
            continue
        key = slot.tag.lower()
        if key in seen:
            first = seen[key]
            raise SlotError(
                f"Two switched-on slots are both tagged '@{slot.tag}' "
                f"({first.kind} {first.index} and {slot.kind} {slot.index}). "
                "Tags have to be unique, or '@' in the prompt cannot mean one thing."
            )
        seen[key] = slot

    placements = _ordinals(cleaned)
    lookup = {p.slot.tag.lower(): p.label for p in placements if p.slot.tag}

    # A video's soundtrack is reachable as `@tag-audio`, because it has an
    # ordinal of its own and there is otherwise no way to name it.
    for placement in placements:
        slot = placement.slot
        if slot.kind == "video" and slot.tag and slot.audio is not None:
            ordinal = _soundtrack_ordinal(cleaned, slot)
            lookup[f"{slot.tag.lower()}-audio"] = f"<Audio {ordinal}>"

    missing: List[str] = []

    def replace(match: "re.Match[str]") -> str:
        name = match.group(1).lower()
        if name in lookup:
            return lookup[name]
        missing.append(match.group(1))
        return match.group(0)

    rewritten = TAG_PATTERN.sub(replace, prompt or "")

    if missing:
        known = sorted(lookup)
        offer = ", ".join(f"@{name}" for name in known) if known else "none"
        raise SlotError(
            f"The prompt mentions {', '.join('@' + name for name in dict.fromkeys(missing))}, "
            f"which no switched-on slot is tagged with. Tagged and switched on right now: {offer}."
        )

    return Plan(placements, rewritten)


def reference_groups(
    slots: Sequence[Slot],
) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    """The four dicts the upstream node's `execute` expects.

    Packed, not sparse: the live references are renumbered from zero with no
    gaps. Upstream only ever reads `.values()` for pictures and standalone
    audio, so their keys are cosmetic — but a video's soundtrack is found by
    matching the numeric suffix, so those two have to be renumbered *together*
    or a video silently loses its sound.
    """
    images: Dict[str, Any] = {}
    videos: Dict[str, Any] = {}
    video_audios: Dict[str, Any] = {}
    audios: Dict[str, Any] = {}

    for slot in slots:
        if not slot.live:
            continue
        if slot.kind == "image":
            images[f"ref_image_{len(images)}"] = slot.value
        elif slot.kind == "video":
            position = len(videos)
            videos[f"ref_video_{position}"] = slot.value
            if slot.audio is not None:
                video_audios[f"ref_video_audio_{position}"] = slot.audio
        elif slot.kind == "audio":
            audios[f"ref_audio_{len(audios)}"] = slot.value

    return images, videos, video_audios, audios


def describe(plan_result: Plan) -> str:
    """A one-line summary of what the prompt's numbers ended up meaning.

    Printed to the log on every run. When a result is wrong, the first question
    is always "which picture was <Picture 2>", and this is the cheapest possible
    answer to it.
    """
    if not plan_result.placements:
        return "no references"
    parts = [
        f"{p.label}={p.slot.tag or f'{p.slot.kind} slot {p.slot.index}'}"
        for p in plan_result.placements
    ]
    return ", ".join(parts)
