"""
Checks the trainer's held-back split and what it writes for YOLO (train.py), without a GPU:
    npm --prefix ai run panels-test
"""

import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np

import hard
import train


def row(page, w=100, h=150, panels=None):
    return {"page": page, "image": f"pages/{page}.png", "width": w, "height": h, "panels": panels or [[[0, 0], [50, 0], [50, 60], [0, 60]]]}


# 20 series, some with a colour edition, a few pages from two chapters each.
ROWS = [row(f"s{k}{edition}-c{c}-p{p:02}") for k in range(20) for edition in ("", "color") for c in (1, 2) for p in (1, 2)]


class SeriesOf(unittest.TestCase):
    def test_name_up_to_the_chapter(self):
        self.assertEqual(train.series_of("sbr-c30-p21"), "sbr")
        self.assertEqual(train.series_of("galaxy999-c1-p03"), "galaxy999")

    def test_a_colour_edition_is_its_ink_series(self):
        self.assertEqual(train.series_of("sbrcolor-c31-p04"), "sbr")
        self.assertEqual(train.series_of("kamuycolor-c2-p10"), "kamuy")

    def test_odd_chapters_and_names(self):
        self.assertEqual(train.series_of("onepiece-c1050.5-p03"), "onepiece")
        self.assertEqual(train.series_of("not-a-page"), "not-a-page")


class Split(unittest.TestCase):
    def test_no_series_on_both_sides(self):
        learn, held, series = train.split(ROWS, 0.15, 8)
        a = {train.series_of(r["page"]) for r in learn}
        b = {train.series_of(r["page"]) for r in held}
        self.assertFalse(a & b)
        self.assertEqual(b, set(series))

    def test_every_page_on_one_side(self):
        learn, held, _ = train.split(ROWS, 0.15, 8)
        self.assertEqual(sorted(r["page"] for r in learn + held), sorted(r["page"] for r in ROWS))

    def test_a_colour_edition_goes_with_its_ink_one(self):
        _, held, series = train.split(ROWS, 0.15, 8)
        pages = {r["page"] for r in held}
        for s in series:
            self.assertIn(f"{s}-c1-p01", pages)
            self.assertIn(f"{s}color-c1-p01", pages)

    def test_the_share_of_series(self):
        self.assertEqual(len(train.split(ROWS, 0.15, 8)[2]), 3)
        self.assertEqual(len(train.split(ROWS, 0.5, 8)[2]), 10)
        # At least one held back, whatever the share.
        self.assertEqual(len(train.split(ROWS, 0.001, 8)[2]), 1)

    def test_the_same_seed_holds_back_the_same(self):
        self.assertEqual(train.split(ROWS, 0.15, 8)[2], train.split(list(reversed(ROWS)), 0.15, 8)[2])
        self.assertNotEqual(train.split(ROWS, 0.15, 8)[2], train.split(ROWS, 0.15, 9)[2])

    def test_none_held_back(self):
        learn, held, series = train.split(ROWS, 0, 8)
        self.assertEqual((len(learn), held, series), (len(ROWS), [], []))
        self.assertEqual(train.split([], 0.15, 8), ([], [], []))


class Dataset(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = train.DATA, train.WORK
        train.DATA, train.WORK = root / "data", root / "yolo"
        (train.DATA / "pages").mkdir(parents=True)
        for r in ROWS[:8]:
            cv2.imwrite(str(train.DATA / r["image"]), np.full((r["height"], r["width"], 3), 255, np.uint8))

    def tearDown(self):
        train.DATA, train.WORK = self.old
        self.tmp.cleanup()

    def test_held_pages_are_judged_on_and_never_learned_from(self):
        learn, held = ROWS[:5], ROWS[5:8]
        counts = train.dataset(learn, held)
        self.assertEqual(counts, {"train": 5, "val": 3})
        names = lambda part: sorted(p.stem for p in (train.WORK / "images" / part).glob("*.png"))
        self.assertEqual(names("train"), sorted(f"{r['page']}-0" for r in learn))
        self.assertEqual(names("val"), sorted(f"{r['page']}-0" for r in held))
        self.assertEqual(len(list((train.WORK / "labels" / "val").glob("*.txt"))), 3)
        self.assertIn("val: images/val\n", (train.WORK / "panels.yaml").read_text())

    def test_corners_judged_tightly(self):
        train.dataset(ROWS[:1])
        s = train.SIGMA
        self.assertIn(f"kpt_oks_sigmas: [{s}, {s}, {s}, {s}]\n", (train.WORK / "panels.yaml").read_text())
        self.assertLess(s, 0.25)

    def test_none_held_judges_on_the_pages_learned_from(self):
        self.assertEqual(train.dataset(ROWS[:8]), {"train": 8, "val": 0})
        self.assertIn("val: images/train\n", (train.WORK / "panels.yaml").read_text())

    def test_a_label_line(self):
        train.dataset(ROWS[:1])
        line = (train.WORK / "labels" / "train" / f"{ROWS[0]['page']}-0.txt").read_text().split()
        # One class, a panel, whatever its shape; its box, then four corners each seen.
        self.assertEqual(line[0], "0")
        self.assertEqual(len(line), 1 + 4 + 4 * 3)


class Reach(unittest.TestCase):
    """The corner loss pulls in a corner far off, where YOLO's own gives up on it."""

    def setUp(self):
        import torch
        from ultralytics.utils.loss import KeypointLoss

        self.torch = torch
        self.loss = KeypointLoss(torch.full((4,), train.SIGMA))
        self.own = KeypointLoss.forward
        self.old = train.REACH
        # One panel 20 by 20 (the grid's units), its corners labelled, the first guessed `off` away.
        self.area = torch.tensor([[400.0]])
        self.gt = torch.tensor([[[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], [0.0, 20.0]]])
        self.mask = torch.ones(1, 4, dtype=torch.bool)

    def tearDown(self):
        train.REACH = self.old

    def pull(self, forward, off):
        """How hard the loss pulls the first corner back toward its label, and the loss."""
        pred = self.gt.clone()
        pred[0, 0, 1] += off
        pred.requires_grad_(True)
        value = forward(self.loss, pred, self.gt, self.mask, self.area)
        value.backward()
        return -pred.grad[0, 0, 1].item(), value.item()

    def test_yolo_own_gives_up_far_off(self):
        # A third of the panel off: YOLO's own hardly pulls at all.
        self.assertLess(abs(self.pull(self.own, 7.0)[0]), 1e-4)

    def test_far_off_is_pulled_in(self):
        train.REACH = 1.0
        pull, _ = self.pull(train.reaching, 7.0)
        self.assertLess(pull, 0)
        self.assertGreater(abs(pull), 0.01)
        # As hard as a little off: the same pull near or far, on top of the tolerance's.
        far, _ = self.pull(train.reaching, 14.0)
        self.assertAlmostEqual(far, pull, places=3)

    def test_none_off_is_smooth(self):
        train.REACH = 1.0
        pull, value = self.pull(train.reaching, 0.0)
        self.assertFalse(self.torch.isnan(self.torch.tensor(pull)))
        self.assertAlmostEqual(value, 0.0, places=3)

    def test_no_reach_is_yolo_own(self):
        train.REACH = 0.0
        for off in (0.5, 3.0, 7.0):
            self.assertAlmostEqual(self.pull(train.reaching, off)[1], self.pull(self.own, off)[1], places=6)


class Learning(unittest.TestCase):
    def test_yolo_own_unless_asked(self):
        self.assertEqual(train.learning(None), {})
        self.assertEqual(train.learning(""), {})

    def test_gently_from_the_first_step(self):
        # YOLO's own picks its optimizer and rate itself, ignoring lr0, and warms up from a big rate.
        self.assertEqual(train.learning("0.0002"), {"optimizer": "AdamW", "lr0": 0.0002, "warmup_epochs": 0})


class Slanted(unittest.TestCase):
    def test_a_straight_panel_is_not(self):
        self.assertFalse(train.slanted([[0, 0], [50, 0], [50, 60], [0, 60]], 100, 150))

    def test_a_big_leaning_one_is(self):
        self.assertTrue(train.slanted([[0, 0], [50, 0], [40, 60], [0, 60]], 100, 150))

    def test_a_small_leaning_one_is_not(self):
        self.assertFalse(train.slanted([[0, 0], [8, 0], [6, 10], [0, 10]], 100, 150))

    def test_a_hair_off_straight_is_not(self):
        self.assertFalse(train.slanted([[0, 0], [50, 1], [50, 60], [0, 60]], 100, 150))


class Bent(unittest.TestCase):
    def picture(self, quad):
        pic = np.zeros((300, 200, 3), np.uint8)
        cv2.fillPoly(pic, [np.array(quad, np.int32)], (255, 255, 255))
        return pic

    def test_none_is_as_it_was(self):
        q = [[40, 50], [160, 50], [160, 250], [40, 250]]
        pic, moved = train.bent(self.picture(q), [q], 0, 0)
        self.assertTrue(np.array_equal(pic, self.picture(q)))
        for a, b in zip(moved[0], q):
            self.assertAlmostEqual(a[0], b[0], places=4)
            self.assertAlmostEqual(a[1], b[1], places=4)

    def test_the_corners_go_with_the_picture(self):
        q = [[40, 50], [160, 50], [160, 250], [40, 250]]
        pic, moved = train.bent(self.picture(q), [q], 5, 4)
        # What's drawn where the moved panel is, is the panel: white inside, black past its corners.
        drawn = self.picture(moved[0])
        both = np.logical_and(pic[..., 0] > 127, drawn[..., 0] > 127).sum()
        either = np.logical_or(pic[..., 0] > 127, drawn[..., 0] > 127).sum()
        self.assertGreater(both / either, 0.97)
        self.assertTrue(train.slanted(moved[0], 200, 300))

    def test_kept_on_the_picture(self):
        q = [[0, 0], [200, 0], [200, 300], [0, 300]]
        _, moved = train.bent(self.picture(q), [q], 5, 5)
        for x, y in moved[0]:
            self.assertTrue(0 <= x <= 200 and 0 <= y <= 300)


class Copies(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.old = train.DATA, train.WORK, train.TILTED, train.SLANTED_COPIES, train.HARD_COPIES
        train.HARD_COPIES = 0
        train.DATA, train.WORK = root / "data", root / "yolo"
        (train.DATA / "pages").mkdir(parents=True)
        self.straight = row("a-c1-p01")
        self.leaning = row("b-c1-p01", panels=[[[0, 0], [50, 0], [40, 60], [0, 60]]])
        for r in (self.straight, self.leaning, row("c-c1-p01")):
            cv2.imwrite(str(train.DATA / r["image"]), np.full((r["height"], r["width"], 3), 255, np.uint8))

    def tearDown(self):
        train.DATA, train.WORK, train.TILTED, train.SLANTED_COPIES, train.HARD_COPIES = self.old
        self.tmp.cleanup()

    def names(self, part):
        return sorted(p.stem for p in (train.WORK / "images" / part).glob("*.png"))

    def test_none_unless_asked(self):
        train.TILTED, train.SLANTED_COPIES = 0, 0
        self.assertEqual(train.dataset([self.straight, self.leaning]), {"train": 2, "val": 0})

    def test_every_page_again_turned(self):
        train.TILTED, train.SLANTED_COPIES = 1, 0
        train.dataset([self.straight, self.leaning], [row("c-c1-p01")])
        self.assertEqual(self.names("train"), ["a-c1-p01-0", "a-c1-p01-0-turned", "b-c1-p01-0", "b-c1-p01-0-turned"])
        # Held-back pages are judged on as they are.
        self.assertEqual(self.names("val"), ["c-c1-p01-0"])
        turned = (train.WORK / "labels" / "train" / "a-c1-p01-0-turned.txt").read_text().split()
        self.assertEqual(len(turned), 1 + 4 + 4 * 3)

    def test_slanted_pages_again_as_they_are(self):
        train.TILTED, train.SLANTED_COPIES = 0, 2
        train.dataset([self.straight, self.leaning])
        self.assertEqual(self.names("train"), ["a-c1-p01-0", "b-c1-p01-0", "b-c1-p01-0-slanted-0", "b-c1-p01-0-slanted-1"])
        a = (train.WORK / "labels" / "train" / "b-c1-p01-0.txt").read_text()
        self.assertEqual((train.WORK / "labels" / "train" / "b-c1-p01-0-slanted-1.txt").read_text(), a)

    def test_about_the_share_asked(self):
        train.TILTED, train.SLANTED_COPIES = 0.5, 0
        rows = [row(f"s{k}-c1-p01") for k in range(40)]
        for r in rows:
            cv2.imwrite(str(train.DATA / r["image"]), np.full((r["height"], r["width"], 3), 255, np.uint8))
        counts = train.dataset(rows)
        self.assertTrue(50 <= counts["train"] <= 70)


    def hard(self, *pages):
        (train.DATA / "hard.json").write_text(json.dumps({"round": 20, "pages": list(pages)}))

    def test_hard_pages_learned_three_times(self):
        train.TILTED, train.SLANTED_COPIES, train.HARD_COPIES = 0, 0, 2
        self.hard("a-c1-p01", "c-c1-p01")
        train.dataset([self.straight, self.leaning], [row("c-c1-p01")])
        self.assertEqual(self.names("train"), ["a-c1-p01-0", "a-c1-p01-0-hard-0", "a-c1-p01-0-hard-1", "b-c1-p01-0"])
        # A hard page held back is judged on once, as it is.
        self.assertEqual(self.names("val"), ["c-c1-p01-0"])
        a = (train.WORK / "labels" / "train" / "a-c1-p01-0.txt").read_text()
        self.assertEqual((train.WORK / "labels" / "train" / "a-c1-p01-0-hard-1.txt").read_text(), a)

    def test_hard_list_unused_unless_asked(self):
        self.hard("a-c1-p01")
        self.assertEqual(train.dataset([self.straight, self.leaning]), {"train": 2, "val": 0})

    def test_no_hard_list_stops_the_round(self):
        train.HARD_COPIES = 2
        with self.assertRaises(SystemExit):
            train.dataset([self.straight])


class Missed(unittest.TestCase):
    square = [[0, 0], [100, 0], [100, 100], [0, 100]]
    beside = [[120, 0], [220, 0], [220, 100], [120, 100]]

    def test_none_when_every_panel_is_guessed(self):
        self.assertEqual(hard.missed([self.square, self.beside], [self.beside, self.square]), 0)

    def test_one_guess_over_two_panels_misses_both(self):
        both = [[0, 0], [220, 0], [220, 100], [0, 100]]
        self.assertEqual(hard.missed([self.square, self.beside], [both]), 2)

    def test_an_extra_guess_is_not_a_miss(self):
        self.assertEqual(hard.missed([self.square], [self.square, self.beside]), 0)


class Bending(unittest.TestCase):
    def test_upright_unless_asked(self):
        self.assertEqual(train.bending(0, 0), {"degrees": 0, "shear": 0})

    def test_turned_and_leaned_as_asked(self):
        self.assertEqual(train.bending(5, 4), {"degrees": 5, "shear": 4})


if __name__ == "__main__":
    unittest.main()
