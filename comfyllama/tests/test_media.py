"""Sending a clip and a sound, not only a still.

The models these nodes talk to are fully multimodal, and the pack only ever
offered them a picture. What follows is the part that has to be right for the
other two to be worth having: a clip is hundreds of frames and cannot be sent
whole, and a sound has to arrive as a container llama-server can decode.
"""

from __future__ import annotations

import io
import os
import sys
import unittest
import wave

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(REPO_ROOT))
sys.path.insert(0, REPO_ROOT)

try:
    import numpy as np
    from PIL import Image  # noqa: F401

    HAVE_IMAGING = True
except ImportError:  # pragma: no cover - depends on the environment
    HAVE_IMAGING = False

from comfyllama.images import (audio_to_content, audio_to_wav,  # noqa: E402
                               sample_frames, video_to_content)
from comfyllama.nodes.common import active_media, wants_image  # noqa: E402
from comfyllama.nodes.generation import user_content  # noqa: E402


def clip(frames: int, size: int = 8):
    """An IMAGE batch whose every frame is a different, identifiable grey."""
    array = np.zeros((frames, size, size, 3), dtype=np.float32)
    for index in range(frames):
        array[index, :, :, :] = index / max(1, frames - 1)
    return array


def tone(seconds: float = 0.1, rate: int = 8000, channels: int = 1):
    """ComfyUI's AUDIO shape: (batch, channels, samples) floats in -1..1."""
    count = int(rate * seconds)
    ramp = np.linspace(-0.5, 0.5, count, dtype=np.float32)
    waveform = np.stack([ramp] * channels)[None, ...]
    return {"waveform": waveform, "sample_rate": rate}


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are required")
class SampleFrames(unittest.TestCase):
    def test_a_short_clip_is_sent_whole(self):
        self.assertEqual(len(sample_frames(clip(5), 8)), 5)

    def test_a_long_clip_is_thinned_to_the_count_asked_for(self):
        self.assertEqual(len(sample_frames(clip(360), 8)), 8)

    def test_the_sample_spans_the_whole_clip(self):
        """First and last included, or the sample stops short of the end.

        Asserted through the pixels rather than the indices: each frame of the
        fixture is a different grey, so the first and last of the sample being
        black and white is the same statement without reaching inside.
        """
        frames = sample_frames(clip(100), 5)
        self.assertEqual(frames[0].getpixel((0, 0))[0], 0)
        self.assertEqual(frames[-1].getpixel((0, 0))[0], 255)

    def test_it_is_evenly_spaced_rather_than_the_first_n(self):
        greys = [frame.getpixel((0, 0))[0] for frame in sample_frames(clip(100), 5)]
        self.assertEqual(greys, sorted(greys))
        # Evenly spread: the middle of five is the middle of the clip.
        self.assertAlmostEqual(greys[2], 127, delta=4)

    def test_one_frame_is_the_first(self):
        self.assertEqual(len(sample_frames(clip(50), 1)), 1)

    def test_a_nonsense_count_sends_everything_rather_than_nothing(self):
        self.assertEqual(len(sample_frames(clip(6), 0)), 6)
        self.assertEqual(len(sample_frames(clip(6), -3)), 6)


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are required")
class VideoContent(unittest.TestCase):
    def test_a_clip_becomes_image_parts(self):
        parts = video_to_content(clip(30), frames=4)
        self.assertEqual(len(parts), 4)
        for part in parts:
            self.assertEqual(part["type"], "image_url")
            self.assertTrue(part["image_url"]["url"].startswith("data:image/"))


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are required")
class AudioContent(unittest.TestCase):
    def test_it_writes_a_wav_that_a_decoder_can_open(self):
        data = audio_to_wav(tone(seconds=0.25, rate=16000))
        with wave.open(io.BytesIO(data), "rb") as handle:
            self.assertEqual(handle.getframerate(), 16000)
            self.assertEqual(handle.getnchannels(), 1)
            self.assertEqual(handle.getsampwidth(), 2)
            self.assertEqual(handle.getnframes(), 4000)

    def test_stereo_stays_stereo_rather_than_twice_as_long(self):
        """The channel axis is interleaved, which is what a WAV frame is.

        Fold it the wrong way and a stereo clip becomes mono at twice the
        length — the same mistake the reference picker's decoder guards against
        on the way in.
        """
        data = audio_to_wav(tone(seconds=0.25, rate=16000, channels=2))
        with wave.open(io.BytesIO(data), "rb") as handle:
            self.assertEqual(handle.getnchannels(), 2)
            self.assertEqual(handle.getnframes(), 4000)

    def test_a_waveform_that_clips_does_not_wrap_around(self):
        loud = tone()
        loud["waveform"] = loud["waveform"] * 4.0
        data = audio_to_wav(loud)
        with wave.open(io.BytesIO(data), "rb") as handle:
            samples = np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")
        # Saturated at the ends rather than having flipped sign.
        self.assertEqual(samples.max(), 32767)
        self.assertLessEqual(samples.min(), -32767)

    def test_the_content_part_is_base64_input_audio(self):
        parts = audio_to_content(tone())
        self.assertEqual(len(parts), 1)
        self.assertEqual(parts[0]["type"], "input_audio")
        self.assertEqual(parts[0]["input_audio"]["format"], "wav")
        self.assertTrue(parts[0]["input_audio"]["data"])


@unittest.skipUnless(HAVE_IMAGING, "numpy and Pillow are required")
class UserContent(unittest.TestCase):
    def test_a_text_only_turn_stays_a_plain_string(self):
        # `None` here means "no parts list", which leaves the turn plain text.
        self.assertIsNone(user_content("hello"))

    def test_media_first_and_the_prompt_last(self):
        parts = user_content("what is this", clip(1), video=clip(30),
                             audio=tone(), video_frames=3)
        self.assertEqual(parts[-1], {"type": "text", "text": "what is this"})
        kinds = [part["type"] for part in parts]
        # One picture, three sampled frames, one sound, then the words.
        self.assertEqual(kinds, ["image_url"] * 4 + ["input_audio", "text"])

    def test_a_clip_alone_is_enough_to_make_it_a_parts_list(self):
        parts = user_content("describe", video=clip(10), video_frames=2)
        self.assertEqual([part["type"] for part in parts], ["image_url", "image_url", "text"])

    def test_a_sound_alone_is_enough_too(self):
        parts = user_content("transcribe", audio=tone())
        self.assertEqual([part["type"] for part in parts], ["input_audio", "text"])


class Switches(unittest.TestCase):
    """The switches in front of the clip and the sound.

    Off means the branch that produces them is never run, which is the whole
    value of them — off has to cost nothing rather than costing a decode whose
    result is thrown away.
    """

    def test_a_switched_off_clip_is_not_sent(self):
        media = active_media({"video": "a clip", "use_video": False, "audio": "a sound"})
        self.assertIsNone(media["video"])
        self.assertEqual(media["audio"], "a sound")

    def test_absent_switches_mean_on(self):
        # A workflow saved before these existed has no value for them, and used
        # whatever it had wired.
        media = active_media({"video": "a clip", "audio": "a sound"})
        self.assertEqual(media["video"], "a clip")
        self.assertEqual(media["audio"], "a sound")

    def test_a_switched_off_input_is_never_asked_for(self):
        wanted = wants_image({
            "image": None, "use_image": True,
            "video": None, "use_video": False,
            "audio": None, "use_audio": True,
        })
        self.assertEqual(wanted, ["image", "audio"])

    def test_an_input_that_already_has_a_value_is_not_asked_for_again(self):
        self.assertEqual(wants_image({"image": "here", "video": None}), ["video"])


class EveryNodeOffersWhatItReads(unittest.TestCase):
    """A node that reads a clip has to declare one, and ask for it.

    Two ways to get this silently wrong, and both were in the first draft:

    - Reading `kwargs["video"]` on a node whose `INPUT_TYPES` never offered one.
      It is always `None`, so nothing fails — the input simply does not exist
      and there is no socket to plug a clip into.
    - Declaring it `lazy` on a node whose `check_lazy_status` only ever names
      the picture. ComfyUI evaluates a lazy input when it is asked for by name
      and not before, so a clip nobody asks for stays `None` forever — wired,
      visible, and never sent.
    """

    def nodes(self):
        from comfyllama.nodes.generation import LlamaCppChat, LlamaCppVisionChat
        from comfyllama.nodes.presets import LlamaServerPresetChat
        from comfyllama.nodes.remote import LlamaServerChat, LlamaServerVisionChat

        return {
            "LlamaCppChat": LlamaCppChat,
            "LlamaCppVisionChat": LlamaCppVisionChat,
            "LlamaServerChat": LlamaServerChat,
            "LlamaServerVisionChat": LlamaServerVisionChat,
            "LlamaServerPresetChat": LlamaServerPresetChat,
        }

    def test_every_chat_node_takes_a_clip_and_a_sound(self):
        for name, node in self.nodes().items():
            with self.subTest(node=name):
                optional = node.INPUT_TYPES().get("optional", {})
                for input_name in ("video", "audio", "video_frames",
                                   "use_video", "use_audio"):
                    self.assertIn(input_name, optional)

    def test_a_lazy_clip_is_one_the_node_actually_asks_for(self):
        for name, node in self.nodes().items():
            with self.subTest(node=name):
                optional = node.INPUT_TYPES().get("optional", {})
                lazy = [
                    input_name
                    for input_name in ("video", "audio")
                    if optional.get(input_name, (None, {}))[1].get("lazy")
                ]
                if not lazy:
                    continue
                self.assertTrue(
                    hasattr(node, "check_lazy_status"),
                    f"{name} declares a lazy input but never asks for one",
                )
                asked = node().check_lazy_status(**{
                    "server": object(), "active": "Preset 1", "use_model": True,
                    "image": object(), "video": None, "audio": None,
                    "extra_1": "", "name_1": "Preset 1",
                })
                for input_name in lazy:
                    self.assertIn(input_name, asked)

    def test_a_switched_off_clip_is_still_never_asked_for(self):
        from comfyllama.nodes.presets import LlamaServerPresetChat

        asked = LlamaServerPresetChat().check_lazy_status(**{
            "server": object(), "active": "Preset 1", "use_model": True,
            "image": None, "video": None, "audio": None,
            "use_video": False, "extra_1": "", "name_1": "Preset 1",
        })
        self.assertIn("image", asked)
        self.assertIn("audio", asked)
        self.assertNotIn("video", asked)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
