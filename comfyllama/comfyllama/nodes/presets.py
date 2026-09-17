"""A llama-server chat node holding several system prompts to switch between.

One node carries up to :data:`MAX_SLOTS` system prompts.  ``active`` picks the
one to run, or ``passthrough`` to hand the prompt straight to the output
without contacting the server at all.  Each slot has its own optional extra
prompt input, for system prompts that expect two separate instructions.

The extra inputs, the image and the server connection are declared lazy, so the
branches belonging to inactive slots are never executed — in passthrough mode
nothing upstream of this node runs on the LLM side.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ..backend import decode_escapes
from .common import (CATEGORY_SERVER, active_image, generation_inputs,
                     image_inputs, is_changed_for_seed, thinking_input)
from .generation import _messages, user_content
from .remote import _chat, model_input

MAX_SLOTS = 6

PASSTHROUGH = "passthrough"
PASSTHROUGH_ALIASES = {PASSTHROUGH, "none", "off", "bypass", "direct"}

DEFAULT_NAMES = [f"Preset {index}" for index in range(1, MAX_SLOTS + 1)]

DEFAULT_SYSTEM_PROMPTS = {
    1: "You are a prompt engineer for image generation models. Rewrite the "
       "user's idea as a single vivid prompt. Answer with the prompt only.",
}


def slot_names(values: Dict[str, Any]) -> List[str]:
    """The slot names in order, falling back to the defaults."""
    return [str(values.get(f"name_{index}") or DEFAULT_NAMES[index - 1])
            for index in range(1, MAX_SLOTS + 1)]


def resolve_slot(active: str, names: List[str], slot_count: int) -> Optional[int]:
    """Map the ``active`` selection to a slot number, or ``None`` for passthrough.

    Matching is by name so the dropdown can show what the slots were renamed
    to; a plain number or a trailing number ("Preset 3") also works, which is
    what keeps the node usable if the web extension has not loaded.
    """
    label = (active or "").strip()
    if not label or label.lower() in PASSTHROUGH_ALIASES:
        return None

    usable = max(1, min(int(slot_count), MAX_SLOTS))
    for index in range(1, usable + 1):
        if names[index - 1].strip().lower() == label.lower():
            return index

    digits = ""
    for character in reversed(label):
        if character.isdigit():
            digits = character + digits
        elif digits:
            break
    if digits and 1 <= int(digits) <= usable:
        return int(digits)

    available = ", ".join([PASSTHROUGH] + names[:usable])
    raise ValueError(
        f"'{active}' does not match any of this node's active system prompts. "
        f"Available: {available}."
    )


def chosen_slot(use_model: bool, active: str, names: List[str],
                slot_count: int) -> Optional[int]:
    """Which preset runs, or ``None`` for passthrough.

    Two ways to say the same thing, and both are honoured. The switch is the
    one to use — picking "passthrough" out of a dropdown of system prompts was
    the clunky way to turn the model off, and that dropdown is a preset picker
    now. Its own passthrough stays because a workflow saved before the switch
    existed has no other way to say it.

    One place, because `check_lazy_status` and `generate` disagreeing about
    this would mean a passthrough that still ran the branch feeding it.
    """
    if not use_model:
        return None
    return resolve_slot(active, names, slot_count)


def join_prompt(prompt: str, extra: Optional[str], separator: str) -> str:
    """Append a slot's extra prompt to the incoming one."""
    parts = [part for part in ((prompt or "").strip(), (extra or "").strip()) if part]
    if len(parts) < 2:
        return parts[0] if parts else ""
    return decode_escapes(separator).join(parts)


def _slot_inputs() -> Dict[str, Any]:
    inputs: Dict[str, Any] = {}
    for index in range(1, MAX_SLOTS + 1):
        inputs[f"name_{index}"] = ("STRING", {
            "default": DEFAULT_NAMES[index - 1],
            "tooltip": "Shown in the 'active' dropdown. Keep the names distinct.",
        })
        inputs[f"system_{index}"] = ("STRING", {
            "default": DEFAULT_SYSTEM_PROMPTS.get(index, ""),
            "multiline": True,
        })
        inputs[f"model_{index}"] = model_input(f"'{DEFAULT_NAMES[index - 1]}'")
    return inputs


def _extra_inputs() -> Dict[str, Any]:
    return {
        f"extra_{index}": ("STRING", {
            "forceInput": True,
            "lazy": True,
            "tooltip": f"Second instruction for '{DEFAULT_NAMES[index - 1]}', "
                       "appended to the prompt. Only evaluated while that "
                       "system prompt is the active one.",
        })
        for index in range(1, MAX_SLOTS + 1)
    }


class LlamaServerPresetChat:
    """Chat against llama-server with a switchable set of system prompts."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "server": ("LLAMA_SERVER", {
                    "lazy": True,
                    "tooltip": "Not requested at all in passthrough mode.",
                }),
                "prompt": ("STRING", {"default": "", "multiline": True,
                                      "dynamicPrompts": True}),
                "active": ([PASSTHROUGH] + DEFAULT_NAMES, {
                    "default": PASSTHROUGH,
                    "tooltip": "Which system prompt to run. Use the "
                               "'use_model' switch to turn the model off "
                               "instead; 'passthrough' is still here so a "
                               "workflow saved before that switch existed "
                               "keeps meaning what it meant.",
                }),
                "slot_count": ("INT", {
                    "default": 3, "min": 1, "max": MAX_SLOTS,
                    "tooltip": "How many system prompts this node offers. The "
                               "rest are hidden and ignored.",
                }),
                "thinking": thinking_input(),
                **generation_inputs(),
            },
            # The per-slot widgets are optional on purpose. The web extension
            # hides the slots above slot_count, and a hidden widget does not
            # survive an "export (API)", so declaring them required would make
            # such a workflow fail validation with "Required input is missing".
            # Every one of them has a default here instead.
            "optional": {
                **_slot_inputs(),
                "extra_separator": ("STRING", {
                    "default": "\\n\\n",
                    "tooltip": "Put between the prompt and the extra prompt. "
                               "Escapes such as \\n are decoded.",
                }),
                **_extra_inputs(),
                "sampling": ("LLAMA_SAMPLING",),
                "grammar": ("LLAMA_GRAMMAR",),
                # Lazy like the rest: neither passthrough nor a switched-off
                # image may run the branch that produces one.
                **image_inputs(),
                # The switch, appended last.
                #
                # On by default so a workflow saved before it existed behaves
                # exactly as it did — passthrough then still comes from the
                # dropdown, as it always has. And appended rather than put up
                # beside `active` where it reads best, because ComfyUI stores
                # widget values positionally: inserted higher it would shift
                # every value after it in an already-saved workflow.
                "use_model": ("BOOLEAN", {
                    "default": True,
                    "label_on": "run the preset",
                    "label_off": "passthrough",
                    "tooltip": "Off hands the prompt straight to the output "
                               "without contacting the model. Nothing upstream "
                               "of this node on the LLM side runs at all — not "
                               "the connection, not the extra prompt, not the "
                               "image.",
                }),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("text", "thinking", "active")
    FUNCTION = "generate"
    CATEGORY = CATEGORY_SERVER
    DESCRIPTION = ("llama-server chat with several system prompts to switch "
                   "between, plus a passthrough that skips the model.")

    @classmethod
    def VALIDATE_INPUTS(cls, active):
        # Taking `active` here tells ComfyUI to skip its own combo check, so
        # renamed presets are accepted as values.
        return True

    @classmethod
    def IS_CHANGED(cls, seed=0, **kwargs):
        return is_changed_for_seed(seed)

    def check_lazy_status(self, active="", slot_count=MAX_SLOTS, use_model=True, **kwargs):
        """Only pull in the connection and the active slot's extra prompt."""
        try:
            index = chosen_slot(use_model, active, slot_names(kwargs), slot_count)
        except ValueError:
            # Let generate() raise the readable error instead of failing here.
            return []
        if index is None:
            return []

        needed = []
        if kwargs.get("server") is None:
            needed.append("server")
        wanted = [f"extra_{index}"]
        # The image branch is skipped both ways: by passthrough, above, and by
        # the switch — asking for it here is what would run it.
        if kwargs.get("use_image", True):
            wanted.append("image")
        for name in wanted:
            if name in kwargs and kwargs.get(name) is None:
                needed.append(name)
        return needed

    def generate(self, server, prompt, active, slot_count, thinking, max_tokens,
                 temperature, top_p, seed, extra_separator="\\n\\n", sampling=None,
                 grammar=None, use_image=True, image=None, image_max_size=1024,
                 image_quality=90, use_model=True, **slots):
        names = slot_names(slots)
        index = chosen_slot(use_model, active, names, slot_count)

        if index is None:
            # Bypass: hand the prompt straight to the output.
            return (prompt, "", PASSTHROUGH)

        if server is None:
            raise ValueError(
                "No llama-server connection. Connect the 'Connect to "
                "llama-server' node, or switch 'use_model' off."
            )

        system = str(slots.get(f"system_{index}") or "")
        full_prompt = join_prompt(prompt, slots.get(f"extra_{index}"), extra_separator)
        content = user_content(full_prompt, active_image(image, use_image),
                               max_size=image_max_size, quality=image_quality)
        conversation = _messages(system, full_prompt, None, content=content)
        # Each preset may name its own model, which is the point of a router.
        text, thought = _chat(server, conversation, thinking, max_tokens, temperature,
                              top_p, seed, sampling, grammar,
                              str(slots.get(f"model_{index}") or ""))
        return (text, thought, names[index - 1])
