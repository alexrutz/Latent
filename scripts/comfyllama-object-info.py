"""Dump the vendored nodes' definitions the way ComfyUI's /object_info does.

Latent builds its forms from `/object_info`, and its tests build them from a
fixture standing in for it. That fixture is a hand-written copy of what
`comfyllama/` declares, which is fine until one of them changes and the other
does not — at which point the tests keep passing and the form on the phone is
wrong, which is the worst of the two failure modes.

So the nodes are asked directly. This prints the same shape ComfyUI's route
returns, for the classes Latent knows about, and `comfyllamaFixture.test.ts`
compares the fixture against it.

Standalone on purpose: no ComfyUI, no torch, no llama-cpp-python. The node
classes only touch those inside their `FUNCTION`, never in `INPUT_TYPES`.
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1] / "comfyllama"
sys.path.insert(0, str(ROOT))

from comfyllama.nodes import (  # noqa: E402
    NODE_CLASS_MAPPINGS,
    NODE_DISPLAY_NAME_MAPPINGS,
)


def describe(node) -> dict:
    """One node, in `/object_info` shape."""
    spec = node.INPUT_TYPES()
    return {
        "input": {
            section: {name: list(value) for name, value in (spec.get(section) or {}).items()}
            for section in ("required", "optional")
            if spec.get(section)
        },
        "output": list(getattr(node, "RETURN_TYPES", ()) or ()),
        "output_name": list(getattr(node, "RETURN_NAMES", ()) or ()),
    }


def main() -> None:
    out = {}
    for name, node in NODE_CLASS_MAPPINGS.items():
        entry = describe(node)
        entry["display_name"] = NODE_DISPLAY_NAME_MAPPINGS.get(name, name)
        out[name] = entry
    # `default=str` because a spec may carry something that is only ever
    # rendered, and a dump that dies on one tooltip helps nobody.
    json.dump(out, sys.stdout, indent=2, sort_keys=False, default=str)


if __name__ == "__main__":
    main()
