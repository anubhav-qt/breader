import type { ReactElement } from 'react';

/**
 * What a slot that sits beside other things takes: elements only, never bare text. A translator
 * swaps bare text for its own tags, and React then can't find it (src/translatable.test.ts).
 * Text goes in an element of its own: <span>Save</span>, not Save. An empty string shows nothing.
 */
export type Elements = ReactElement | '' | boolean | null | undefined | readonly Elements[];
