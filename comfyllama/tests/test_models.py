"""Reading a model file's own header, and hashing it when asked."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import tempfile
import unittest
from typing import Any, Dict
from unittest import mock

from comfyllama import models


def write_safetensors(path: str, metadata: Dict[str, Any], payload: bytes = b"\x00" * 8) -> None:
    """A real safetensors file: 8 bytes of length, that much JSON, then data."""
    header = {"__metadata__": metadata, "weight": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
    encoded = json.dumps(header).encode("utf-8")
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(encoded)))
        handle.write(encoded)
        handle.write(payload)


class HeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="comfyllama-models-")
        models.reset()

    def tearDown(self) -> None:
        models.reset()
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    def test_reads_the_metadata_block(self) -> None:
        target = self.path("style.safetensors")
        write_safetensors(target, {"ss_output_name": "a style", "ss_network_dim": "32"})

        self.assertEqual(
            models.read_header(target),
            {"ss_output_name": "a style", "ss_network_dim": "32"},
        )

    def test_a_file_with_no_metadata_is_empty_not_broken(self) -> None:
        target = self.path("bare.safetensors")
        encoded = json.dumps({"weight": {"dtype": "F32"}}).encode("utf-8")
        with open(target, "wb") as handle:
            handle.write(struct.pack("<Q", len(encoded)))
            handle.write(encoded)

        self.assertEqual(models.read_header(target), {})
        self.assertFalse(models.describe(target, "bare.safetensors")["hasMetadata"])

    def test_a_pickle_or_a_truncated_download_reads_as_nothing(self) -> None:
        """A listing of forty models must not fail on one of them."""
        for name, content in [
            ("old.ckpt", b"\x80\x04\x95nonsense"),
            ("short.safetensors", b"\x01\x02\x03"),
            ("lying.safetensors", struct.pack("<Q", 1 << 60) + b"{}"),
            ("notjson.safetensors", struct.pack("<Q", 4) + b"oops"),
        ]:
            target = self.path(name)
            with open(target, "wb") as handle:
                handle.write(content)
            self.assertEqual(models.read_header(target), {}, name)

    def test_a_missing_file_reads_as_nothing(self) -> None:
        self.assertEqual(models.read_header(self.path("gone.safetensors")), {})


class TagTests(unittest.TestCase):
    """`ss_tag_frequency` is what the thing was actually trained on."""

    def test_sums_across_training_folders_and_orders_by_count(self) -> None:
        frequency = json.dumps(
            {
                "10_concept": {"a woman": 40, "red jacket": 25, "outdoors": 5},
                "5_concept_b": {"a woman": 20, "studio": 12},
            }
        )
        self.assertEqual(
            models._tags_from_frequency(frequency, 10),
            # "a woman" appears in both folders, which is exactly what makes it
            # the trigger rather than a background detail.
            ["a woman", "red jacket", "studio", "outdoors"],
        )

    def test_drops_the_repeat_counts_kohya_writes_in(self) -> None:
        frequency = json.dumps({"10_x": {"20": 99, "a cat": 3}})
        self.assertEqual(models._tags_from_frequency(frequency, 10), ["a cat"])

    def test_honours_the_limit(self) -> None:
        frequency = json.dumps({"x": {f"tag{i}": 100 - i for i in range(30)}})
        self.assertEqual(len(models._tags_from_frequency(frequency, 5)), 5)

    def test_nonsense_gives_nothing_rather_than_raising(self) -> None:
        for raw in ["", "not json", "[]", json.dumps({"x": "not a dict"})]:
            self.assertEqual(models._tags_from_frequency(raw, 10), [])


class DescribeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="comfyllama-models-")

    def tearDown(self) -> None:
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def test_pulls_the_tags_the_base_model_and_the_settings(self) -> None:
        target = os.path.join(self.dir, "style.safetensors")
        write_safetensors(
            target,
            {
                "ss_tag_frequency": json.dumps({"10_x": {"a lighthouse": 30, "storm": 10}}),
                "ss_base_model_version": "sdxl_base_v1-0",
                "ss_network_dim": "64",
                "ss_network_alpha": "32",
                "ss_clip_skip": "2",
                "ss_num_train_images": "180",
                "ss_output_name": "lighthouses",
            },
        )

        described = models.describe(target, "style.safetensors")
        self.assertEqual(described["name"], "style.safetensors")
        self.assertEqual(described["trainedTags"], ["a lighthouse", "storm"])
        self.assertEqual(described["baseModel"], "sdxl_base_v1-0")
        self.assertEqual(described["networkDim"], "64")
        self.assertEqual(described["clipSkip"], "2")
        self.assertEqual(described["title"], "lighthouses")
        self.assertTrue(described["hasMetadata"])
        self.assertIsNotNone(described["size"])

    def test_prefers_the_newer_cross_tool_fields(self) -> None:
        """`modelspec.*` is the standard; `ss_*` is what kohya has always written."""
        target = os.path.join(self.dir, "new.safetensors")
        write_safetensors(
            target,
            {
                "modelspec.architecture": "stable-diffusion-xl-v1-base/lora",
                "modelspec.title": "Proper Title",
                "modelspec.description": "How to use it.",
                "ss_base_model_version": "something older",
                "ss_output_name": "older name",
            },
        )

        described = models.describe(target, "new.safetensors")
        self.assertEqual(described["baseModel"], "stable-diffusion-xl-v1-base/lora")
        self.assertEqual(described["title"], "Proper Title")
        self.assertEqual(described["description"], "How to use it.")


class ListingTests(unittest.TestCase):
    """The names have to be the ones a `<lora:…>` tag takes, and nothing else."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="comfyllama-models-")
        models.reset()
        self.target = os.path.join(self.dir, "style.safetensors")
        write_safetensors(self.target, {"ss_output_name": "a style"})

    def tearDown(self) -> None:
        models.reset()
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def fake_paths(self, names=("style.safetensors",)):
        fake = mock.Mock()
        fake.get_filename_list.return_value = list(names)
        fake.get_full_path.side_effect = lambda folder, name: os.path.join(self.dir, name)
        return fake

    def test_lists_what_the_folder_holds(self) -> None:
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            listed = models.list_models("loras")

        self.assertEqual(listed["folder"], "loras")
        self.assertEqual([entry["name"] for entry in listed["models"]], ["style.safetensors"])
        self.assertEqual(listed["models"][0]["title"], "a style")

    def test_skips_a_model_deleted_since_comfyui_cached_the_list(self) -> None:
        paths = self.fake_paths(("style.safetensors", "gone.safetensors"))
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            listed = models.list_models("loras")

        self.assertEqual([entry["name"] for entry in listed["models"]], ["style.safetensors"])

    def test_refuses_a_folder_it_does_not_serve(self) -> None:
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            self.assertEqual(models.list_models("../../etc")["models"], [])
            self.assertIn("error", models.list_models("vae"))

    def test_says_so_outside_comfyui(self) -> None:
        with mock.patch.object(models, "_folder_paths", return_value=None):
            self.assertIn("error", models.list_models("loras"))

    def test_an_empty_folder_is_not_a_missing_one(self) -> None:
        """Configured with nothing in it, versus a key ComfyUI never heard of."""
        paths = self.fake_paths(())
        paths.get_filename_list.return_value = []
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            listed = models.list_models("loras")

        self.assertEqual(listed["models"], [])
        self.assertNotIn("error", listed)


class AliasTests(unittest.TestCase):
    """`unet` is not a second folder — ComfyUI aliases it to the same entry."""

    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="comfyllama-models-")
        models.reset()
        write_safetensors(os.path.join(self.dir, "flux.safetensors"), {})

    def tearDown(self) -> None:
        models.reset()
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def paths_knowing(self, known: "set[str]"):
        fake = mock.Mock()

        def filenames(key):
            if key not in known:
                raise KeyError(key)
            return ["flux.safetensors"]

        fake.get_filename_list.side_effect = filenames
        fake.get_full_path.side_effect = lambda key, name: (
            os.path.join(self.dir, name) if key in known else None
        )
        return fake

    def test_uses_the_modern_key_where_it_exists(self) -> None:
        paths = self.paths_knowing({"diffusion_models"})
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            listed = models.list_models("diffusion_models")
        self.assertEqual([entry["name"] for entry in listed["models"]], ["flux.safetensors"])

    def test_falls_back_to_the_old_one_on_an_older_install(self) -> None:
        paths = self.paths_knowing({"unet"})
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            listed = models.list_models("diffusion_models")
        self.assertEqual([entry["name"] for entry in listed["models"]], ["flux.safetensors"])

    def test_unet_is_not_a_category_of_its_own(self) -> None:
        """Serving both listed the same files twice, under two names."""
        self.assertNotIn("unet", models.FOLDERS)
        paths = self.paths_knowing({"unet", "diffusion_models"})
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            self.assertIn("error", models.list_models("unet"))


class HashTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = tempfile.mkdtemp(prefix="comfyllama-models-")
        models.reset()
        self.target = os.path.join(self.dir, "style.safetensors")
        with open(self.target, "wb") as handle:
            handle.write(b"the weights")

    def tearDown(self) -> None:
        models.reset()
        for name in os.listdir(self.dir):
            os.unlink(os.path.join(self.dir, name))
        os.rmdir(self.dir)

    def fake_paths(self):
        fake = mock.Mock()
        fake.get_full_path.side_effect = lambda folder, name: os.path.join(self.dir, name)
        return fake

    def test_hashes_the_file(self) -> None:
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            digest = models.file_hash("loras", "style.safetensors")

        self.assertEqual(digest, hashlib.sha256(b"the weights").hexdigest())

    def test_reads_the_file_once_for_the_same_bytes(self) -> None:
        """Tens of seconds for a checkpoint; it must not be paid twice."""
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            first = models.file_hash("loras", "style.safetensors")
            with mock.patch("builtins.open", side_effect=AssertionError("read again")):
                second = models.file_hash("loras", "style.safetensors")

        self.assertEqual(first, second)

    def test_rehashes_when_the_file_changes(self) -> None:
        """Keyed by identity, not by name: a replaced LoRA is a different model."""
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            first = models.file_hash("loras", "style.safetensors")
            with open(self.target, "wb") as handle:
                handle.write(b"different weights entirely")
            os.utime(self.target, (0, 0))
            second = models.file_hash("loras", "style.safetensors")

        self.assertNotEqual(first, second)
        self.assertEqual(second, hashlib.sha256(b"different weights entirely").hexdigest())

    def test_nothing_for_a_model_that_is_not_there(self) -> None:
        paths = mock.Mock()
        paths.get_full_path.return_value = None
        with mock.patch.object(models, "_folder_paths", return_value=paths):
            self.assertIsNone(models.file_hash("loras", "missing.safetensors"))

    def test_nothing_for_a_folder_it_does_not_serve(self) -> None:
        with mock.patch.object(models, "_folder_paths", return_value=self.fake_paths()):
            self.assertIsNone(models.file_hash("vae", "style.safetensors"))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
