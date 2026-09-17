"""One slider across temperature, top_p and top_k.

Three places run this arithmetic: `comfyllama/scale.py` when the node executes,
the web extension so the fields show what is about to be sent, and — through
the values the node reports — any front end submitting an API-format workflow.
Two of those are in different languages, so the last test here checks they at
least agree on what the ends of the ranges mean.
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import subprocess
import unittest

from comfyllama.nodes.generation import LlamaCppSampling
from comfyllama.scale import (DEFAULT_RANGES, SCALED, clamp01, position_for,
                              scaled_value, scaled_values)

ROOT = pathlib.Path(__file__).resolve().parents[1]


class TestScaledValues(unittest.TestCase):
    def test_the_ends_are_the_ends(self):
        self.assertEqual(scaled_values(0.0), {"temperature": 0.1, "top_p": 0.5, "top_k": 10.0})
        self.assertEqual(scaled_values(1.0), {"temperature": 1.4, "top_p": 1.0, "top_k": 100.0})

    def test_the_middle_is_the_middle_of_every_range(self):
        self.assertEqual(scaled_values(0.5), {"temperature": 0.75, "top_p": 0.75, "top_k": 55.0})

    def test_it_is_linear(self):
        low = scaled_value(0.25, "temperature")
        high = scaled_value(0.75, "temperature")
        self.assertAlmostEqual(scaled_value(0.5, "temperature"), (low + high) / 2, places=4)

    def test_a_position_outside_the_slider_is_pulled_back_onto_it(self):
        self.assertEqual(scaled_value(-3, "temperature"), scaled_value(0.0, "temperature"))
        self.assertEqual(scaled_value(9, "temperature"), scaled_value(1.0, "temperature"))

    def test_nonsense_reads_as_the_start(self):
        self.assertEqual(clamp01(float("nan")), 0.0)
        self.assertEqual(clamp01("not a number"), 0.0)
        self.assertEqual(clamp01(None), 0.0)

    def test_top_k_comes_back_whole(self):
        for position in (0.0, 0.13, 0.5, 0.77, 1.0):
            value = scaled_value(position, "top_k")
            self.assertEqual(value, round(value))

    def test_the_others_are_rounded_to_something_a_widget_can_show(self):
        # 0.1 + 0.5 * 1.3 is 0.7499999999999999 in binary floating point, which
        # is not a temperature anybody typed.
        self.assertEqual(scaled_value(0.5, "temperature"), 0.75)

    def test_a_range_given_backwards_runs_backwards(self):
        """The only way to say 'this one goes the other way'."""
        ranges = {**DEFAULT_RANGES, "top_p": (1.0, 0.5)}
        self.assertEqual(scaled_value(0.0, "top_p", ranges), 1.0)
        self.assertEqual(scaled_value(1.0, "top_p", ranges), 0.5)

    def test_a_range_with_no_width_stays_put(self):
        ranges = {**DEFAULT_RANGES, "temperature": (0.8, 0.8)}
        self.assertEqual(scaled_value(0.0, "temperature", ranges), 0.8)
        self.assertEqual(scaled_value(1.0, "temperature", ranges), 0.8)


class TestPositionFor(unittest.TestCase):
    """The half that makes the two one control rather than two."""

    def test_a_value_reports_where_it_sits(self):
        self.assertAlmostEqual(position_for("temperature", 0.1), 0.0)
        self.assertAlmostEqual(position_for("temperature", 1.4), 1.0)
        self.assertAlmostEqual(position_for("temperature", 0.75), 0.5, places=4)

    def test_it_round_trips(self):
        for position in (0.0, 0.2, 0.5, 0.81, 1.0):
            for name in SCALED:
                value = scaled_value(position, name)
                self.assertAlmostEqual(
                    scaled_value(position_for(name, value), name), value, places=3,
                    msg=f"{name} at {position}")

    def test_a_value_off_the_end_reports_the_end(self):
        self.assertEqual(position_for("temperature", 99), 1.0)
        self.assertEqual(position_for("temperature", -99), 0.0)

    def test_a_range_with_no_width_has_no_position(self):
        self.assertEqual(position_for("temperature", 0.8, {"temperature": (0.8, 0.8)}), 0.0)

    def test_moving_one_field_moves_the_others_through_the_slider(self):
        """Typing a temperature is a statement about all three."""
        position = position_for("temperature", 1.4)
        self.assertEqual(scaled_values(position)["top_k"], 100.0)
        self.assertEqual(scaled_values(position)["top_p"], 1.0)


class TestSamplingNode(unittest.TestCase):
    """What the node actually puts in the request."""

    def defaults(self) -> dict:
        required = LlamaCppSampling.INPUT_TYPES()["required"]
        return {name: spec[1].get("default") for name, spec in required.items()}

    def build(self, **overrides) -> dict:
        values = self.defaults()
        values.update(overrides)
        return LlamaCppSampling().build(**values)[0]

    def test_nothing_is_sent_until_something_is_switched_on(self):
        self.assertEqual(self.build(), {})

    def test_the_fields_are_sent_on_their_own_switches(self):
        sampling = self.build(use_temperature=True, temperature=0.9, use_top_k=True, top_k=25)
        self.assertEqual(sampling, {"temperature": 0.9, "top_k": 25})

    def test_the_slider_sets_all_three(self):
        self.assertEqual(
            self.build(use_intensity=True, intensity=1.0),
            {"temperature": 1.4, "top_p": 1.0, "top_k": 100},
        )

    def test_the_slider_beats_the_fields_it_stands_for(self):
        """It is the thing being moved; the fields are what it reads out as."""
        sampling = self.build(use_intensity=True, intensity=0.0,
                              use_temperature=True, temperature=4.5,
                              use_top_p=True, top_p=0.1,
                              use_top_k=True, top_k=7)
        self.assertEqual(sampling, {"temperature": 0.1, "top_p": 0.5, "top_k": 10})

    def test_the_slider_leaves_everything_else_alone(self):
        sampling = self.build(use_intensity=True, intensity=0.5,
                              use_repeat_penalty=True, repeat_penalty=1.2)
        self.assertEqual(sampling["repeat_penalty"], 1.2)

    def test_the_range_widgets_decide_what_the_ends_mean(self):
        sampling = self.build(use_intensity=True, intensity=1.0,
                              temperature_min=0.0, temperature_max=2.0)
        self.assertEqual(sampling["temperature"], 2.0)

    def test_top_k_reaches_the_request_as_an_integer(self):
        sampling = self.build(use_intensity=True, intensity=0.37)
        self.assertIsInstance(sampling["top_k"], int)

    def test_the_new_widgets_are_appended_not_inserted(self):
        """ComfyUI stores widget values positionally; inserting shifts them all."""
        names = list(LlamaCppSampling.INPUT_TYPES()["required"])
        self.assertEqual(names[-8:], [
            "use_intensity", "intensity",
            "temperature_min", "temperature_max",
            "top_p_min", "top_p_max",
            "top_k_min", "top_k_max",
        ])
        # And the pair that had to join top_k sits directly above them.
        self.assertEqual(names[-12:-8], ["use_temperature", "temperature",
                                         "use_top_p", "top_p"])

    def test_temperature_and_top_p_can_be_overridden_at_all(self):
        """They are on the generation node too; this node has to win."""
        from comfyllama.backend import SAMPLING_KEYS, sampler_kwargs

        self.assertIn("temperature", SAMPLING_KEYS)
        self.assertIn("top_p", SAMPLING_KEYS)
        kwargs = sampler_kwargs(max_tokens=8, temperature=0.7, top_p=0.95, seed=0,
                                sampling=self.build(use_intensity=True, intensity=1.0))
        self.assertEqual(kwargs["temperature"], 1.4)
        self.assertEqual(kwargs["top_p"], 1.0)


class TestTheExtensionAgrees(unittest.TestCase):
    """The web extension runs the same maths in another language.

    It has to: the fields on the node show what the slider is about to send,
    and they are only right if both ends read the ranges the same way. Nothing
    here executes the JavaScript — it checks the one thing that silently drifts,
    which is the numbers written into both files.
    """

    def source(self) -> str:
        return (ROOT / "web" / "js" / "comfyllama.js").read_text(encoding="utf-8")

    def test_the_default_ranges_are_the_same_on_both_sides(self):
        source = self.source()
        for name, (low, high) in DEFAULT_RANGES.items():
            match = re.search(rf"\b{name}:\s*\[([-\d.]+),\s*([-\d.]+)\]", source)
            self.assertIsNotNone(match, f"{name} has no range in the extension")
            self.assertEqual((float(match.group(1)), float(match.group(2))), (low, high),
                             f"{name} disagrees between scale.py and the extension")

    def test_it_knows_the_same_three_parameters(self):
        source = self.source()
        match = re.search(r"const SCALED = \[([^\]]+)\]", source)
        self.assertIsNotNone(match)
        names = tuple(part.strip().strip('"') for part in match.group(1).split(","))
        self.assertEqual(names, SCALED)

    def test_it_rounds_top_k_and_nothing_else(self):
        self.assertIn('const INTEGER_SCALED = new Set(["top_k"])', self.source())

    @unittest.skipUnless(shutil.which("node"), "node is not installed")
    def test_it_produces_the_same_numbers(self):
        """The constants matching is not the same as the arithmetic matching.

        It caught a real one: Python's `round` sends 32.5 to 32 and
        JavaScript's `Math.round` sends it to 33, so at intensity 0.25 the node
        showed a top_k of 33 and sent 32. Nothing about the constants would
        have said so.

        Only the pure half of the extension is run — the part between the
        constants and the first line that touches a node — with a stub standing
        in for reading a widget. Skipped where there is no Node, which a
        ComfyUI install is not obliged to have.
        """
        source = self.source()
        start = source.index("const SCALED = [")
        end = source.index("let syncing = false;")
        program = (
            "const readWidget = (node, name, fallback) => "
            "(name in node ? node[name] : fallback);\n"
            + source[start:end]
            + "\nconst out = {};\n"
            "for (const p of PROBES) {\n"
            "  out[p] = SCALED.map((n) => scaledValue({}, n, p));\n"
            "}\n"
            "console.log(JSON.stringify(out));\n"
        )
        probes = [0, 0.13, 0.25, 0.33, 0.5, 0.75, 0.77, 1]
        program = f"const PROBES = {json.dumps(probes)};\n" + program

        result = subprocess.run([shutil.which("node"), "-e", program],
                                capture_output=True, text=True, check=True)
        from_js = json.loads(result.stdout)

        for position in probes:
            expected = [scaled_value(position, name) for name in SCALED]
            self.assertEqual([float(value) for value in from_js[str(position)]], expected,
                             f"the two disagree at intensity {position}")


if __name__ == "__main__":
    unittest.main()
