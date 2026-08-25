"""Input definitions shared by the node classes."""

from __future__ import annotations

from typing import Any, Dict, List

CATEGORY = "llama.cpp"
CATEGORY_SERVER = "llama.cpp/server"
CATEGORY_ADVANCED = "llama.cpp/advanced"
CATEGORY_UTILS = "llama.cpp/utils"
# General-purpose nodes that have nothing to do with llama.cpp.
CATEGORY_LATENT = "comfyllama/latent"

MAX_SEED = 0xFFFFFFFFFFFFFFFF

# Chat templates that ship with llama-cpp-python.  The list is merged with
# whatever the installed version registers, so newer templates show up
# automatically.
FALLBACK_CHAT_FORMATS: List[str] = [
    "chatml", "llama-2", "llama-3", "mistral-instruct", "mistrallite", "gemma",
    "zephyr", "vicuna", "alpaca", "qwen", "phi-3", "openchat", "chatglm3",
    "openbuddy", "redpajama-incite", "snoozy", "intel", "oasst_llama",
    "baichuan-2", "saiga",
]


def chat_formats() -> List[str]:
    """``auto`` plus every chat template known to the installed binding.

    ``auto`` means "use the template stored in the GGUF metadata", which is the
    right answer for practically every modern model.
    """
    names = set(FALLBACK_CHAT_FORMATS)
    try:
        from llama_cpp.llama_chat_format import LlamaChatCompletionHandlerRegistry

        registry = LlamaChatCompletionHandlerRegistry()
        handlers = getattr(registry, "_chat_handlers", None)
        if isinstance(handlers, dict):
            names.update(str(name) for name in handlers)
    except Exception:
        pass
    return ["auto"] + sorted(names)


def seed_input(tooltip: str = "Sampling seed. -1 draws a new random seed on every run.") -> Any:
    return ("INT", {
        "default": -1,
        "min": -1,
        "max": MAX_SEED,
        "control_after_generate": True,
        "tooltip": tooltip,
    })


def thinking_input() -> Any:
    """The reasoning switch shown on the chat nodes."""
    from ..reasoning import THINKING_MODES

    return (THINKING_MODES, {
        "default": "auto",
        "tooltip": "Reasoning models only. 'auto' leaves the model's default "
                   "alone; 'on'/'off' request thinking explicitly. The chain of "
                   "thought is always returned on the separate 'thinking' "
                   "output and kept out of 'text' and the chat history.",
    })


def image_inputs(lazy: bool = True) -> Dict[str, Any]:
    """Optional image input, its switch, and its encoding controls.

    Any chat node accepts images; whether they are understood depends on the
    model behind it having a multimodal projector.

    ``use_image`` is the switch in front of it. A graph is a fixed set of
    links, so a workflow that captions an image and a workflow that only writes
    text were otherwise two separate graphs, or one graph edited by hand each
    time — dragging the link off, and dragging it back on when the picture was
    wanted again. Off, the image is not sent; and because ``image`` is lazy, the
    branch that produced it is not executed either, so switching it off costs
    nothing rather than costing a load and an encode whose result is discarded.

    ``lazy`` is on by default and only worth turning off for a node that cannot
    implement ``check_lazy_status`` — a lazy input that nobody ever asks for
    stays ``None`` forever.
    """
    image: Dict[str, Any] = {
        "tooltip": "Optional. Sends the image (or the whole batch) with the "
                   "prompt. Needs a multimodal model: the vision loader "
                   "in-process, or llama-server started with --mmproj. "
                   "Switched off by 'use_image' without unplugging it.",
    }
    if lazy:
        image["lazy"] = True
    return {
        "image": ("IMAGE", image),
        "image_max_size": ("INT", {
            "default": 1024, "min": 0, "max": 4096, "step": 64,
            "tooltip": "Longest edge the image is scaled to before it is sent. "
                       "0 disables resizing. Ignored without an image.",
        }),
        "image_quality": ("INT", {
            "default": 90, "min": 30, "max": 100,
            "tooltip": "JPEG quality; 100 sends lossless PNG.",
        }),
        # Last, though it governs the two above it.
        #
        # ComfyUI's graph format stores widget values as a positional list, so
        # a widget inserted in the middle shifts every value after it in an
        # already-saved workflow — a size becomes a quality, silently. Appended,
        # an older workflow simply has no value for it and takes the default,
        # which is the behaviour it already had. The web extension greys out the
        # two encoding controls while this is off, so the order reads correctly
        # on the node even though it does not in this dict.
        "use_image": ("BOOLEAN", {
            "default": True,
            "label_on": "send image",
            "label_off": "no image",
            "tooltip": "Off ignores whatever is wired to 'image' and sends a "
                       "text-only prompt. The nodes feeding the image are not "
                       "run at all, so this is the cheap way to use one "
                       "workflow both with and without a picture.",
        }),
    }


def active_image(image, use_image=True):
    """The image to send, or ``None`` while the switch is off.

    One place, because "is there a picture on this turn" is asked by every
    chat node and by the vision check in front of them, and two of those
    answering differently is how a node ends up demanding a projector for an
    image it is not going to send.
    """
    return image if use_image else None


def wants_image(kwargs: Dict[str, Any]) -> List[str]:
    """The lazy ``image`` input, named only when it is switched on.

    ComfyUI evaluates a lazy input when ``check_lazy_status`` asks for it by
    name, and not before. Returning nothing here is what keeps the upstream
    branch from running while the switch is off.
    """
    if not kwargs.get("use_image", True):
        return []
    return ["image"] if "image" in kwargs and kwargs.get("image") is None else []


def generation_inputs() -> Dict[str, Any]:
    """The handful of sampling controls that belong on every generation node."""
    return {
        "max_tokens": ("INT", {
            "default": 512, "min": 0, "max": 1 << 20,
            "tooltip": "Maximum number of tokens to generate. 0 = until the "
                       "context window is full or a stop sequence is hit.",
        }),
        "temperature": ("FLOAT", {
            "default": 0.7, "min": 0.0, "max": 5.0, "step": 0.01,
            "tooltip": "0 makes sampling greedy/deterministic.",
        }),
        "top_p": ("FLOAT", {"default": 0.95, "min": 0.0, "max": 1.0, "step": 0.01}),
        "seed": seed_input(),
    }


def is_changed_for_seed(seed: int) -> Any:
    """Force a re-run when the seed is random, keep caching otherwise."""
    if seed is not None and int(seed) < 0:
        return float("nan")
    return seed
