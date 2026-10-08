import { args, main } from '../lib.ts';
import { runMarker } from '../marker.ts';

/*
 * npm --prefix ai run marker            Runs the marker here, for good (marker.ts). The server runs
 *                                       it in compose; never run both, or every book is marked twice.
 * npm --prefix ai run marker -- --dry   Says what it would start now, and does nothing.
 */

main(() => runMarker(!!args().flags.dry));
