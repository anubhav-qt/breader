/** Phones and tablets: a touch screen and no mouse. The heavy voices can hang their browser. */
export const handheld = () => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;
