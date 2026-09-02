"""Which reference became which number, and what the prompt ended up saying.

The whole point of this module is that the ordinals move. Every test here is
some version of "switch one thing off and check the prompt still means what it
said" — which is the mistake this exists to prevent, and the one nobody notices
by looking at a video.
"""

from __future__ import annotations

import unittest

# Importing test_nodes installs the ComfyUI stubs before comfyllama is loaded.
from test_nodes import HAVE_IMAGING  # noqa: F401

from comfyllama import refdesk
from comfyllama.refdesk import Slot, SlotError


def image(index, *, on=True, tag="", value="picture"):
    return Slot(kind="image", index=index, on=on, tag=tag, value=value)


def video(index, *, on=True, tag="", value="frames", audio=None):
    return Slot(kind="video", index=index, on=on, tag=tag, value=value, audio=audio)


def audio(index, *, on=True, tag="", value="sound"):
    return Slot(kind="audio", index=index, on=on, tag=tag, value=value)


class TestNumbering(unittest.TestCase):
    def test_pictures_are_numbered_from_one_in_slot_order(self):
        result = refdesk.plan([image(1), image(2), image(3)], "")
        self.assertEqual([p.label for p in result.placements],
                         ["<Picture 1>", "<Picture 2>", "<Picture 3>"])

    def test_switching_one_off_closes_the_gap(self):
        """The behaviour this module exists because of."""
        result = refdesk.plan([image(1), image(2, on=False), image(3)], "")
        # Slot 3 is now <Picture 2>. Nothing about the slot changed; its number did.
        self.assertEqual([(p.slot.index, p.label) for p in result.placements],
                         [(1, "<Picture 1>"), (3, "<Picture 2>")])

    def test_an_empty_slot_takes_no_number_even_switched_on(self):
        result = refdesk.plan([image(1, value=None), image(2)], "")
        self.assertEqual([p.label for p in result.placements], ["<Picture 1>"])
        self.assertEqual(result.placements[0].slot.index, 2)

    def test_each_kind_counts_separately(self):
        result = refdesk.plan([image(1), video(1), audio(1)], "")
        self.assertEqual([p.label for p in result.placements],
                         ["<Picture 1>", "<Video 1>", "<Audio 1>"])

    def test_a_soundtrack_takes_its_audio_number_before_the_standalone_ones(self):
        """The rule nobody would guess, and the reason the tags are worth having.

        Upstream emits a video's soundtrack label *before* the video itself, and
        the standalone audio slots are numbered after every soundtrack — so the
        standalone clip here is <Audio 2> despite being the only thing in an
        audio slot.
        """
        result = refdesk.plan([video(1, audio="track"), audio(1)], "")
        self.assertEqual([p.label for p in result.placements], ["<Video 1>", "<Audio 2>"])

    def test_a_video_without_sound_consumes_no_audio_number(self):
        result = refdesk.plan([video(1), audio(1)], "")
        self.assertEqual([p.label for p in result.placements], ["<Video 1>", "<Audio 1>"])

    def test_pictures_come_before_videos_whatever_order_the_slots_are_in(self):
        result = refdesk.plan([audio(1), video(1), image(1)], "")
        self.assertEqual([p.slot.kind for p in result.placements],
                         ["image", "video", "audio"])


class TestTheTags(unittest.TestCase):
    def test_a_tag_becomes_the_number_it_turned_into(self):
        result = refdesk.plan(
            [image(1, tag="woman"), image(2, tag="jacket")],
            "@woman wearing @jacket",
        )
        self.assertEqual(result.prompt, "<Picture 1> wearing <Picture 2>")

    def test_the_tag_survives_switching_an_earlier_slot_off(self):
        """The same prompt, the same meaning, a different number."""
        slots = [image(1, tag="hat"), image(2, tag="woman")]
        self.assertEqual(refdesk.plan(slots, "@woman").prompt, "<Picture 2>")

        slots[0] = image(1, tag="hat", on=False)
        self.assertEqual(refdesk.plan(slots, "@woman").prompt, "<Picture 1>")

    def test_matching_ignores_case_and_a_typed_at_sign(self):
        # Phone keyboards capitalise, and people paste the '@' into the tag field.
        result = refdesk.plan([image(1, tag="@Woman")], "@woman and @WOMAN")
        self.assertEqual(result.prompt, "<Picture 1> and <Picture 1>")

    def test_a_soundtrack_is_reachable_through_its_video(self):
        result = refdesk.plan(
            [video(1, tag="street", audio="track")],
            "@street with @street-audio",
        )
        self.assertEqual(result.prompt, "<Video 1> with <Audio 1>")

    def test_numbers_written_by_hand_are_left_alone(self):
        result = refdesk.plan([image(1)], "the coat in <Picture 1>")
        self.assertEqual(result.prompt, "the coat in <Picture 1>")

    def test_an_unknown_tag_is_refused_rather_than_sent_as_text(self):
        """Otherwise the model is handed the literal '@woman' and says nothing."""
        with self.assertRaises(SlotError) as caught:
            refdesk.plan([image(1, tag="jacket")], "@woman in @jacket")
        message = str(caught.exception)
        self.assertIn("@woman", message)
        # And says what it could have meant.
        self.assertIn("@jacket", message)

    def test_a_tag_on_a_switched_off_slot_is_unknown(self):
        with self.assertRaises(SlotError):
            refdesk.plan([image(1, tag="woman", on=False)], "@woman")

    def test_the_same_tag_twice_is_refused(self):
        with self.assertRaises(SlotError) as caught:
            refdesk.plan([image(1, tag="woman"), image(2, tag="Woman")], "")
        self.assertIn("unique", str(caught.exception))

    def test_a_repeated_tag_is_allowed_when_only_one_is_switched_on(self):
        # Two slots holding variants of the same subject, one at a time, is a
        # normal way to work rather than a mistake.
        result = refdesk.plan(
            [image(1, tag="woman"), image(2, tag="woman", on=False)],
            "@woman",
        )
        self.assertEqual(result.prompt, "<Picture 1>")

    def test_an_email_address_is_not_mistaken_for_a_tag(self):
        with self.assertRaises(SlotError) as caught:
            refdesk.plan([image(1)], "a letter to me@example.com")
        # It is refused rather than silently mangled, which is the safe way to
        # be wrong: the message names what it thought was a tag.
        self.assertIn("@example", str(caught.exception))


class TestPacking(unittest.TestCase):
    def test_live_references_are_packed_with_no_gaps(self):
        images, _, _, _ = refdesk.reference_groups(
            [image(1), image(2, on=False), image(3)]
        )
        self.assertEqual(list(images), ["ref_image_0", "ref_image_1"])

    def test_a_soundtrack_keeps_its_video_when_an_earlier_video_goes(self):
        """The one packing detail that would silently lose sound.

        Upstream pairs them by the numeric suffix, so renumbering the videos
        without renumbering the soundtracks hands video 0 someone else's audio.
        """
        _, videos, video_audios, _ = refdesk.reference_groups([
            video(1, on=False, audio="first"),
            video(2, value="second-frames", audio="second"),
        ])
        self.assertEqual(list(videos), ["ref_video_0"])
        self.assertEqual(list(video_audios), ["ref_video_audio_0"])
        self.assertEqual(videos["ref_video_0"], "second-frames")
        self.assertEqual(video_audios["ref_video_audio_0"], "second")

    def test_a_video_without_sound_contributes_no_soundtrack_entry(self):
        _, videos, video_audios, _ = refdesk.reference_groups([video(1)])
        self.assertEqual(list(videos), ["ref_video_0"])
        self.assertEqual(video_audios, {})

    def test_switched_off_slots_reach_upstream_as_nothing_at_all(self):
        images, videos, video_audios, audios = refdesk.reference_groups([
            image(1, on=False), video(1, on=False, audio="x"), audio(1, on=False),
        ])
        self.assertEqual((images, videos, video_audios, audios), ({}, {}, {}, {}))


class TestTheSummary(unittest.TestCase):
    def test_it_says_which_slot_each_number_came_from(self):
        line = refdesk.describe(refdesk.plan(
            [image(1, tag="woman"), image(2)], ""
        ))
        self.assertIn("<Picture 1>=woman", line)
        # Untagged slots are named by their position, so the line is still useful.
        self.assertIn("<Picture 2>=image slot 2", line)

    def test_it_says_so_when_there_is_nothing(self):
        self.assertEqual(refdesk.describe(refdesk.plan([], "")), "no references")


class TestTheNode(unittest.TestCase):
    def test_only_switched_on_slots_are_asked_for(self):
        """Lazy inputs are what make a switch save time rather than only tidy up."""
        from comfyllama.nodes.minimax_ref import MiniMaxH3ReferencesFlat

        node = MiniMaxH3ReferencesFlat()
        wanted = node.check_lazy_status(
            image_1_on=True, image_2_on=False, video_1_on=False, audio_1_on=True,
        )
        self.assertIn("image_1", wanted)
        self.assertNotIn("image_2", wanted)
        # A switched-off video does not drag its soundtrack in either.
        self.assertNotIn("video_1", wanted)
        self.assertNotIn("video_1_audio", wanted)
        self.assertIn("audio_1", wanted)

    def test_an_input_already_in_hand_is_not_asked_for_again(self):
        from comfyllama.nodes.minimax_ref import MiniMaxH3ReferencesFlat

        node = MiniMaxH3ReferencesFlat()
        self.assertNotIn("image_1", node.check_lazy_status(image_1_on=True, image_1="here"))

    def test_a_bad_tag_is_refused_before_the_queue(self):
        from comfyllama.nodes.minimax_ref import MiniMaxH3ReferencesFlat

        result = MiniMaxH3ReferencesFlat.VALIDATE_INPUTS(
            prompt="@nobody", image_1="picture", image_1_on=True, image_1_tag="woman",
        )
        self.assertIsInstance(result, str)
        self.assertIn("@nobody", result)

    def test_a_workable_arrangement_validates(self):
        from comfyllama.nodes.minimax_ref import MiniMaxH3ReferencesFlat

        self.assertIs(
            MiniMaxH3ReferencesFlat.VALIDATE_INPUTS(
                prompt="@woman", image_1="picture", image_1_on=True, image_1_tag="woman",
            ),
            True,
        )

    def test_every_slot_the_upstream_node_offers_has_one_here(self):
        from comfyllama.nodes.minimax_ref import MiniMaxH3ReferencesFlat

        optional = MiniMaxH3ReferencesFlat.INPUT_TYPES()["optional"]
        self.assertIn("image_9", optional)
        self.assertNotIn("image_10", optional)
        self.assertIn("video_3", optional)
        self.assertIn("video_3_audio", optional)
        self.assertIn("audio_3", optional)
        # And every reference input is lazy, or the switches would not save work.
        for name in ("image_1", "video_1", "video_1_audio", "audio_1"):
            self.assertTrue(optional[name][1].get("lazy"), name)


if __name__ == "__main__":
    unittest.main()
