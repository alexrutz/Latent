"""Reading the GPU's power draw, and knowing when there is none to read."""

from __future__ import annotations

import subprocess
import unittest
from unittest import mock

from comfyllama import power


class PowerTests(unittest.TestCase):
    def setUp(self) -> None:
        power.reset()

    def tearDown(self) -> None:
        power.reset()

    def test_reads_watts_and_the_limit_from_nvml(self) -> None:
        """The preferred path: a library call, per device."""
        fake = mock.Mock()
        fake.nvmlDeviceGetPowerUsage.return_value = 312_400
        fake.nvmlDeviceGetEnforcedPowerLimit.return_value = 450_000

        with mock.patch.object(power, "_nvml", fake), mock.patch.object(power, "_handles", ["a"]):
            reading = power.read_power()

        self.assertEqual(reading["source"], "nvml")
        self.assertEqual(reading["gpus"], [{"watts": 312.4, "limit": 450.0}])

    def test_falls_back_to_the_management_limit(self) -> None:
        """Older drivers have no enforced limit; the other name is the same number."""
        fake = mock.Mock()
        fake.nvmlDeviceGetPowerUsage.return_value = 100_000
        fake.nvmlDeviceGetEnforcedPowerLimit.side_effect = RuntimeError("not supported")
        fake.nvmlDeviceGetPowerManagementLimit.return_value = 320_000

        with mock.patch.object(power, "_nvml", fake), mock.patch.object(power, "_handles", ["a"]):
            reading = power.read_power()

        self.assertEqual(reading["gpus"], [{"watts": 100.0, "limit": 320.0}])

    def test_reports_the_draw_even_with_no_limit_at_all(self) -> None:
        fake = mock.Mock()
        fake.nvmlDeviceGetPowerUsage.return_value = 90_000
        fake.nvmlDeviceGetEnforcedPowerLimit.side_effect = RuntimeError("no")
        fake.nvmlDeviceGetPowerManagementLimit.side_effect = RuntimeError("no")

        with mock.patch.object(power, "_nvml", fake), mock.patch.object(power, "_handles", ["a"]):
            reading = power.read_power()

        self.assertEqual(reading["gpus"], [{"watts": 90.0, "limit": None}])

    def test_reads_nvidia_smi_when_the_bindings_are_missing(self) -> None:
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="211.4, 350.00\n", stderr=""
        )
        with (
            mock.patch.object(power, "_init_nvml", return_value=False),
            mock.patch.object(power.shutil, "which", return_value="/usr/bin/nvidia-smi"),
            mock.patch.object(power.subprocess, "run", return_value=completed),
        ):
            reading = power.read_power()

        self.assertEqual(reading["source"], "nvidia-smi")
        self.assertEqual(reading["gpus"], [{"watts": 211.4, "limit": 350.0}])

    def test_skips_a_card_that_reports_nothing(self) -> None:
        """`[N/A]` is a card with nothing to say, not a broken query."""
        completed = subprocess.CompletedProcess(
            args=[], returncode=0, stdout="[N/A], [N/A]\n180.0, 250.0\n", stderr=""
        )
        with (
            mock.patch.object(power, "_init_nvml", return_value=False),
            mock.patch.object(power.shutil, "which", return_value="/usr/bin/nvidia-smi"),
            mock.patch.object(power.subprocess, "run", return_value=completed),
        ):
            reading = power.read_power()

        self.assertEqual(reading["gpus"], [{"watts": 180.0, "limit": 250.0}])

    def test_says_nothing_rather_than_zero_where_there_is_no_nvidia_gpu(self) -> None:
        """An absent reading is a fact; a zero would be a lie drawn as a chart."""
        with (
            mock.patch.object(power, "_init_nvml", return_value=False),
            mock.patch.object(power.shutil, "which", return_value=None),
        ):
            reading = power.read_power()

        self.assertEqual(reading, {"gpus": [], "source": None})

    def test_stops_asking_once_there_is_nothing_to_ask(self) -> None:
        """A CPU-only box must not pay for a subprocess every two seconds."""
        with (
            mock.patch.object(power, "_init_nvml", return_value=False),
            mock.patch.object(power.shutil, "which", return_value=None) as which,
        ):
            power.read_power()
            power.read_power()
            power.read_power()

        self.assertEqual(which.call_count, 1)

    def test_survives_nvidia_smi_failing(self) -> None:
        with (
            mock.patch.object(power, "_init_nvml", return_value=False),
            mock.patch.object(power.shutil, "which", return_value="/usr/bin/nvidia-smi"),
            mock.patch.object(
                power.subprocess, "run", side_effect=subprocess.TimeoutExpired("nvidia-smi", 4)
            ),
        ):
            self.assertEqual(power.read_power(), {"gpus": [], "source": None})

    def test_caches_briefly(self) -> None:
        """Two clients polling at once are one call, and a run is still watchable."""
        fake = mock.Mock()
        fake.nvmlDeviceGetPowerUsage.return_value = 200_000
        fake.nvmlDeviceGetEnforcedPowerLimit.return_value = 300_000

        with mock.patch.object(power, "_nvml", fake), mock.patch.object(power, "_handles", ["a"]):
            power.read_power(now=100.0)
            power.read_power(now=100.5)
            self.assertEqual(fake.nvmlDeviceGetPowerUsage.call_count, 1)

            # Past the window, it is asked again — the figure has to move within
            # a render or it answers nothing worth asking.
            power.read_power(now=101.5)
            self.assertEqual(fake.nvmlDeviceGetPowerUsage.call_count, 2)

    def test_reports_every_card(self) -> None:
        fake = mock.Mock()
        fake.nvmlDeviceGetPowerUsage.side_effect = [120_000, 340_000]
        fake.nvmlDeviceGetEnforcedPowerLimit.return_value = 350_000

        with (
            mock.patch.object(power, "_nvml", fake),
            mock.patch.object(power, "_handles", ["a", "b"]),
        ):
            reading = power.read_power()

        self.assertEqual([gpu["watts"] for gpu in reading["gpus"]], [120.0, 340.0])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
