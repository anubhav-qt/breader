"""
Checks the guesser takes the model's corners as they are (guess.py), the same as the app does
(frontend/src/features/reader/panelShape.test.ts), without a GPU:
    npm --prefix ai run panels-test
"""

import unittest

import guess

SLANT = [(100, 100, 0.9), (600, 140, 0.2), (580, 500, 0.9), (160, 440, 0.3)]


class QuadOf(unittest.TestCase):
    def test_every_corner_where_the_model_puts_it(self):
        self.assertEqual(guess.quad_of(SLANT, 1000, 1000), [[x, y] for x, y, _ in SLANT])

    def test_never_squared_off(self):
        wobble = [(100, 100, 1), (600, 102, 1), (599, 500, 1), (101, 498, 1)]
        self.assertEqual(guess.quad_of(wobble, 1000, 1000), [[x, y] for x, y, _ in wobble])

    def test_crossed_corners_kept(self):
        crossed = [SLANT[0], SLANT[2], SLANT[1], SLANT[3]]
        self.assertEqual(guess.quad_of(crossed, 1000, 1000), [[x, y] for x, y, _ in crossed])

    def test_whole_pixels_on_the_page(self):
        self.assertEqual(
            guess.quad_of([(-5, -3, 1), (1010.2, 10.6, 1), (1004, 1200, 1), (0.4, 999.6, 1)], 1000, 1000),
            [[0, 0], [1000, 11], [1000, 1000], [0, 1000]],
        )


class Merged(unittest.TestCase):
    def test_pieces_keep_their_own_corners(self):
        up = {"box": (100, 100, 600, 1000), "quad": [[100, 100], [600, 130], [600, 1000], [100, 1000]], "sure": 0.9, "cut": True}
        down = {"box": (100, 900, 620, 1500), "quad": [[100, 900], [600, 900], [620, 1500], [110, 1480]], "sure": 0.8, "cut": True}
        out = guess.merged([up, down])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["quad"], [[100, 100], [600, 130], [620, 1500], [110, 1480]])


if __name__ == "__main__":
    unittest.main()
