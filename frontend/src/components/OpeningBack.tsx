import { useState } from 'react';
import { IconBack } from './icons';
import './opening-back.css';

interface Props {
  onBack: () => void;
}

/**
 * Back, while a book or manga is still opening. It works once: a second tap, or one as the cover
 * fades, would go back a step further than the reader meant.
 */
export function OpeningBack({ onBack }: Props) {
  const [used, setUsed] = useState(false);
  const leave = () => {
    if (used) return;
    setUsed(true);
    onBack();
  };
  return (
    <button type="button" className="opening-back" onClick={leave} disabled={used}>
      <IconBack /> Back
    </button>
  );
}
