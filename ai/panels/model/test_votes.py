"""
Checks how a round is judged against the owner's votes (votes.py), and that the guesser reads a
page with its margin and puts the panels back (guess.py), without a GPU:
    npm --prefix ai run panels-test
"""

import unittest

import numpy as np

import guess
import votes

# A panel on a page 1000 by 2000: a corner within 20 pixels is where it was.
PANEL = [[100, 100], [900, 100], [900, 700], [100, 700]]
W, H = 1000, 2000
M = guess.MARGIN


def nudged(by, corner=2):
    return [[x + by, y] if i == corner else [x, y] for i, (x, y) in enumerate(PANEL)]


class Judge(unittest.TestCase):
    def test_the_same_within_a_hundredth_of_the_page(self):
        self.assertEqual(votes.judge(PANEL, [nudged(20)], W, H), ("same", 20.0))

    def test_moved_past_it(self):
        self.assertEqual(votes.judge(PANEL, [nudged(-21)], W, H), ("moved", 21.0))

    def test_one_pair_of_corners_is_enough_to_have_moved(self):
        # The corners the owner disliked: the two lower ones pulled in by 50.
        funnel = [[100, 100], [900, 100], [850, 700], [150, 700]]
        self.assertEqual(votes.judge(funnel, [PANEL], W, H)[0], "moved")

    def test_gone_with_nothing_over_it(self):
        elsewhere = [[100, 1000], [900, 1000], [900, 1900], [100, 1900]]
        self.assertEqual(votes.judge(PANEL, [elsewhere], W, H), ("gone", None))
        self.assertEqual(votes.judge(PANEL, [], W, H), ("gone", None))

    def test_takes_the_guess_over_it(self):
        half = [[100, 100], [900, 100], [900, 390], [100, 390]]
        self.assertEqual(votes.judge(PANEL, [half, nudged(5)], W, H), ("same", 5.0))

    def test_a_vote_from_a_picture_of_another_size(self):
        self.assertEqual(votes.on_page([[50, 50], [450, 350]], 500, 1000, W, H), [[100, 100], [900, 700]])
        self.assertEqual(votes.on_page(PANEL, W, H, W, H), PANEL)


class Held(unittest.TestCase):
    def test_a_like_holds_only_the_same(self):
        self.assertEqual([votes.held(True, w) for w in ("same", "moved", "gone")], [True, False, False])

    def test_a_dislike_holds_only_changed(self):
        self.assertEqual([votes.held(False, w) for w in ("same", "moved", "gone")], [False, True, True])

    def test_adds_up(self):
        rows = [{"good": g, "what": w} for g, w in [(True, "same"), (True, "same"), (True, "moved"), (True, "gone"), (False, "moved"), (False, "same")]]
        s = votes.summary(rows)
        self.assertEqual((s["votes"], s["likes"], s["dislikes"]), (6, 4, 2))
        self.assertEqual((s["likes the same %"], s["likes moved"], s["likes gone"]), (50.0, 1, 1))
        self.assertEqual((s["dislikes changed %"], s["dislikes moved"], s["dislikes gone"], s["dislikes the same"]), (50.0, 1, 0, 1))

    def test_nothing_voted(self):
        self.assertEqual(votes.summary([])["likes the same %"], 0.0)

    def test_votes_by_their_page(self):
        a = {"chapter": "c", "n": 1, "good": True}
        b = {"chapter": "c", "n": 2, "good": False}
        c = {"chapter": "c", "n": 1, "good": False}
        self.assertEqual(votes.by_page([a, b, c]), {("c", 1): [a, c], ("c", 2): [b]})


class Told:
    """What Ultralytics hands back, as much of it as guess() reads."""

    def __init__(self, a):
        self.a = np.array(a, np.float32)

    def cpu(self):
        return self

    def numpy(self):
        return self.a


class Model:
    """A model that finds one panel, where it's told, and keeps the pictures it was shown."""

    def __init__(self, corners):
        self.corners = corners
        self.seen = []

    def predict(self, picture, **_):
        self.seen.append(picture.copy())
        xs, ys = [c[0] for c in self.corners], [c[1] for c in self.corners]
        r = type("R", (), {})()
        r.boxes = type("B", (), {"xyxy": Told([[min(xs), min(ys), max(xs), max(ys)]]), "conf": Told([0.9])})()
        r.keypoints = type("K", (), {"data": Told([[[x, y, 1] for x, y in self.corners]])})()
        return [r]


class Margin(unittest.TestCase):
    def test_from_round_22(self):
        self.assertEqual([guess.margin_of(n) for n in (7, 21, 22, 23)], [0, 0, M, M])

    def test_the_model_sees_paper_round_the_page(self):
        page = np.zeros((300, 200, 3), np.uint8)
        model = Model([[M, M], [M + 200, M], [M + 200, M + 300], [M, M + 300]])
        found = guess.guess(model, page, 200, 300, M)
        (seen,) = model.seen
        self.assertEqual(seen.shape, (300 + 2 * M, 200 + 2 * M, 3))
        at = [(0, 0), (M - 1, M - 1), (M, M), (M + 299, M + 199), (M + 300, M + 200)]
        self.assertEqual([int(seen[y, x, 0]) for y, x in at], [255, 255, 0, 0, 255])
        # Edge to edge on the page, a margin in on what the model saw.
        self.assertEqual(found[0]["quad"], [[0, 0], [200, 0], [200, 300], [0, 300]])
        self.assertEqual(found[0]["box"], (0.0, 0.0, 200.0, 300.0))

    def test_a_corner_out_in_the_margin_stays_on_the_page(self):
        page = np.zeros((300, 200, 3), np.uint8)
        found = guess.guess(Model([[M - 28, M - 10], [M + 230, M + 5], [M + 220, M + 330], [M + 100, M + 160]]), page, 200, 300, M)
        self.assertEqual(found[0]["quad"], [[0, 0], [200, 5], [200, 300], [100, 160]])

    def test_as_before_without_one(self):
        page = np.zeros((300, 200, 3), np.uint8)
        model = Model([[40, 40], [160, 40], [160, 260], [40, 260]])
        found = guess.guess(model, page, 200, 300)
        self.assertEqual(model.seen[0].shape, (300, 200, 3))
        self.assertEqual(found[0]["quad"], [[40, 40], [160, 40], [160, 260], [40, 260]])


if __name__ == "__main__":
    unittest.main()
