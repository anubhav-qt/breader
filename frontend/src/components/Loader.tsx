import './loader.css';

interface Props {
  /** Small beside a line of text; large on its own, in a manga page's box. */
  size?: 'small' | 'large';
  className?: string;
}

const page = (back = false) => (
  <span className={back ? 'ld-pg ld-back' : 'ld-pg'}>
    {Array.from({ length: 12 }, (_, i) => <i key={i} />)}
  </span>
);

/**
 * Breader's loader: a pixel book whose right-hand page lifts, turns over the spine and lands on the
 * left, again and again. The turning page is drawn on --ld-bg, the surface it sits on.
 */
export function Loader({ size = 'small', className = '' }: Props) {
  return (
    <span className={`ld ld-${size} ${className}`} aria-hidden="true">
      {page()}
      <span className="ld-spine" />
      {page()}
      <span className="ld-leaf">{page()}{page(true)}</span>
    </span>
  );
}
