/*
 * The head's icons, drawn in square dots on the same 7-row grid as Doto's letters, so they sit
 * with "Aa" as if typed in it.
 */
export const PLAY = ['x....', 'xx...', 'xxx..', 'xxxx.', 'xxx..', 'xx...', 'x....'];
export const PAUSE = ['xx.xx', 'xx.xx', 'xx.xx', 'xx.xx', 'xx.xx', 'xx.xx', 'xx.xx'];
/** Focus: just the page and its lines. Off it's drawn in outline; on, the page fills and the lines show through. */
export const FOCUS = ['xxxxxx', 'x....x', 'x.xx.x', 'x....x', 'x.xx.x', 'x....x', 'xxxxxx'];
export const FOCUSED = ['xxxxxx', 'xxxxxx', 'xx..xx', 'xxxxxx', 'xx..xx', 'xxxxxx', 'xxxxxx'];
export const GROW = ['xx...xx', 'x.....x', '.......', '.......', '.......', 'x.....x', 'xx...xx'];
export const SHRINK = ['.x...x.', 'xx...xx', '.......', '.......', '.......', 'xx...xx', '.x...x.'];
export const STOP = ['.....', 'xxxxx', 'xxxxx', 'xxxxx', 'xxxxx', 'xxxxx', '.....'];
export const PLUS = ['.....', '..x..', '..x..', 'xxxxx', '..x..', '..x..', '.....'];
export const MINUS = ['.....', '.....', '.....', 'xxxxx', '.....', '.....', '.....'];
export const CHECK = ['.......', '......x', '.....x.', 'x...x..', '.x.x...', '..x....', '.......'];
export const CROSS = ['.....', 'x...x', '.x.x.', '..x..', '.x.x.', 'x...x', '.....'];
/** A voice's waveform: the voices and how they read. */
export const VOICES = ['..x....', '..x.x..', 'x.x.x.x', 'x.x.x.x', 'x.x.x.x', '..x.x..', '..x....'];
/** Search: a magnifying glass. */
export const SEARCH = ['.xxx...', 'x...x..', 'x...x..', 'x...x..', '.xxx...', '....xx.', '.....xx'];
