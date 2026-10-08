import './library-switch.css';

interface Props {
  /** How many books are ticked. */
  count: number;
  /** Every one ticked is a favourite already: the button takes them off instead. */
  favourites: boolean;
  onFavourite: () => void;
  onRemove: (fromKeyboard: boolean) => void;
  onDone: () => void;
}

/**
 * While picking books to favourite or remove together, the switch between libraries becomes this
 * bar, in its place: in the header on wide screens, floating at the bottom on phones.
 */
export function BulkBar({ count, favourites, onFavourite, onRemove, onDone }: Props) {
  return (
    <div className="ls ls-bulk" role="toolbar" aria-label="Picked">
      <div className="ls-seg">
        <span className="ls-picked" role="status">{count} picked</span>
        <button type="button" className="ls-tab" disabled={count === 0} onClick={onFavourite}>
          {favourites ? 'Unfavourite' : 'Favourite'}
        </button>
        <button type="button" className="ls-tab is-danger" disabled={count === 0} onClick={(e) => onRemove(e.detail === 0)}>
          Remove
        </button>
        <button type="button" className="ls-tab is-done" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
