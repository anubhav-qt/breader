"""live.py's check: a round goes live only exported to take any size, as the app reads it."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

import onnx
from onnx import TensorProto, helper

import live


def model(dims):
    """A one-node ONNX model whose input is `dims`: numbers fixed, names any size."""
    x = helper.make_tensor_value_info("images", TensorProto.FLOAT, dims)
    y = helper.make_tensor_value_info("output0", TensorProto.FLOAT, dims)
    g = helper.make_graph([helper.make_node("Identity", ["images"], ["output0"])], "m", [x], [y])
    f = Path(tempfile.mkdtemp()) / "m.onnx"
    onnx.save(helper.make_model(g), str(f))
    return f


class Check(unittest.TestCase):
    def test_takes_any_size(self):
        live.check(model(["batch", 3, "height", "width"]))

    def test_refuses_the_square(self):
        with self.assertRaises(SystemExit):
            live.check(model([1, 3, 1024, 1024]))

    def test_refuses_one_at_a_time(self):
        with self.assertRaises(SystemExit):
            live.check(model([1, 3, "height", "width"]))

    def test_refuses_other_than_three_colours(self):
        with self.assertRaises(SystemExit):
            live.check(model(["batch", 1, "height", "width"]))


class Record(unittest.TestCase):
    def test_names_the_model_by_its_hash_and_size(self):
        out = Path(tempfile.mkdtemp())
        (out / "live.onnx").write_bytes(b"a model")
        live.record(out, 21)
        self.assertEqual(
            json.loads((out / "live.json").read_text("utf8")),
            {"round": 21, "sha256": hashlib.sha256(b"a model").hexdigest(), "size": 7},
        )


if __name__ == "__main__":
    unittest.main()
