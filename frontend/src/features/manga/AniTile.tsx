import type { AniCard } from '@breader/shared/manga';
import { anilist } from '../../lib/mangadex';
import { aniMeta } from './aniPick';

/** A series AniList knows and a site has, as a card: tapped, it opens where it was found (aniPick.ts). */
interface TileProps {
  card: AniCard;
  /** Said above its meta: how it's related (Sequel), when it is. */
  label?: string;
  onPick: () => void;
  sizes: string;
}

export function AniTile({ card, label, onPick, sizes }: TileProps) {
  const small = anilist.coverUrl(card.id, 256);
  const big = anilist.coverUrl(card.id, 512);
  return (
    <button type="button" className="mdx-card" onClick={onPick}>
      <span className="mdx-cover">
        {card.cover ? (
          <img src={small} srcSet={`${small} 256w, ${big} 512w`} sizes={sizes} alt="" loading="lazy" decoding="async" draggable={false} />
        ) : (
          <span className="mdx-nocover">{card.title}</span>
        )}
        {card.adult && <span className="mdx-badge">18+</span>}
      </span>
      {label && <span className="mdx-rel">{label}</span>}
      <span className="mdx-title">{card.title}</span>
      <span className="mdx-meta">{aniMeta(card)}</span>
    </button>
  );
}
