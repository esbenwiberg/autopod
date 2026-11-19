#!/usr/bin/env python3
"""Portable writer regressions; --systemd also requires a root Linux system manager."""
import hashlib
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest import mock

module = runpy.run_path(str(Path(__file__).with_name("prepare-inspection-env.py")))
native = sys.argv[1:] == ["--systemd"]
if native:
    sys.argv.pop()


class Bindings(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.packet = Path(tmp.name)
        self.objects = [{"profile's key": r"""IRIS\path "$HOME" %n"""}, {
            "objective": "Audit FIR's four CSVs.\nPATH=/not-an-assignment",
            "unicode": "北", "literal": r"\u0027",
        }]
        for (_, filename), obj in zip(module["BINDINGS"], self.objects):
            (self.packet / filename).write_text(json.dumps(obj))

    def test_render(self):
        wire, expected = module["render"](self.packet)
        lines = wire.decode("ascii").splitlines()
        self.assertEqual(len(lines), 2)
        for line, (name, _), obj, pin in zip(lines, module["BINDINGS"], self.objects, expected):
            key, value = line.split("=", 1)
            self.assertEqual(key, name)
            self.assertEqual(value[0] + value[-1], "''")
            inner = value[1:-1]
            self.assertNotIn("'", inner)
            self.assertEqual(json.loads(inner), obj)
            self.assertEqual(hashlib.sha256(inner.encode()).hexdigest(), pin)

    def test_no_receipt_or_staged_file_after_probe_failure(self):
        prepare = module["prepare"]
        with tempfile.TemporaryDirectory() as stage:
            alloc = lambda **_: tempfile.mkdtemp(dir=stage)
            with mock.patch.dict(prepare.__globals__, {
                "tempfile": mock.Mock(mkdtemp=alloc), "verify": mock.Mock(side_effect=ValueError),
            }), self.assertRaises(ValueError):
                prepare(self.packet, io.StringIO())
            output = mock.Mock()
            output.flush.side_effect = BrokenPipeError
            with mock.patch.dict(prepare.__globals__, {
                "tempfile": mock.Mock(mkdtemp=alloc), "verify": mock.Mock(),
            }), self.assertRaises(BrokenPipeError):
                prepare(self.packet, output)
            self.assertEqual(list(Path(stage).iterdir()), [])

    @unittest.skipUnless(native, "requires explicit --systemd on a disposable Linux host")
    def test_real_system_manager(self):
        output = io.StringIO()
        module["prepare"](self.packet, output)
        receipt = json.loads(output.getvalue())
        path = Path(receipt["path"])
        try:
            data, _ = module["render"](self.packet)
            self.assertEqual(path.read_bytes(), data)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(hashlib.sha256(data).hexdigest(), receipt["sha256"])
            # Historical writer: wrap compact JSON in single quotes without
            # JSON-escaping apostrophes. Independent expected values below are
            # the raw JSON the daemon *should* receive from this specific file.
            values = [json.dumps(obj, separators=(",", ":")) for obj in self.objects]
            path.write_bytes("".join(f"{key}='{v}'\n" for (key, _), v in
                                     zip(module["BINDINGS"], values)).encode())
            pins = [hashlib.sha256(v.encode()).hexdigest() for v in values]
            with self.assertRaisesRegex(ValueError, "^systemd binding mismatch$"):
                module["verify"](path, pins)
        finally:
            path.unlink()
            path.parent.rmdir()


if __name__ == "__main__":
    unittest.main()
