"""The buttons this package adds must stay out of the saved workflow.

ComfyUI saves widget values by position. A button that is saved holds a
`null`, and the next widget the Python side appends loads it — a `use_*`
switch comes back off and a reference disappears from a run nobody changed.
`{ serialize: false }` in `addWidget`'s options does not prevent that; the
flag has to be on the widget, which is what `keepOutOfWorkflow` does.
"""

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web" / "js"


class TestButtonsStayOutOfTheWorkflow(unittest.TestCase):
    def test_every_button_is_kept_out(self):
        for path in WEB.glob("*.js"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"addWidget\(\s*\"button\"", source):
                before = source[max(0, match.start() - 80):match.start()]
                self.assertIn(
                    "keepOutOfWorkflow(", before,
                    f"{path.name}: a button added without keepOutOfWorkflow",
                )

    def test_nodes_with_buttons_repair_old_workflows(self):
        for name in ("browser.js", "comfyllama.js"):
            source = (WEB / name).read_text(encoding="utf-8")
            self.assertIn("repairNullsOnConfigure(nodeType, nodeData)", source, name)

    @unittest.skipUnless(shutil.which("node"), "needs Node.js")
    def test_a_switch_saved_as_a_button_comes_back_on(self):
        script = ROOT / "tests" / "js" / "workflow_widgets.mjs"
        completed = subprocess.run(
            ["node", str(script)], capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("ok", completed.stdout)


if __name__ == "__main__":
    unittest.main()
