import { IconLock, IconPeople } from '../../components/icons';

/** Who can read a book being added: the reader alone, or the Shared Library too. */
export function WhoReads({ shared, many = false, onChange }: { shared: boolean; many?: boolean; onChange: (shared: boolean) => void }) {
  const label = many ? 'Who can read them?' : 'Who can read it?';
  return (
    <>
      <div className="add-label">{label}</div>
      <div className="add-choices" role="radiogroup" aria-label={label.slice(0, -1)}>
        <button type="button" role="radio" aria-checked={!shared} className={`add-choice${!shared ? ' is-on' : ''}`} onClick={() => onChange(false)}>
          <IconLock />
          <span><b>Just me</b><span>Private. Opens in any browser with your library key.</span></span>
          <i className="add-radio" />
        </button>
        <button type="button" role="radio" aria-checked={shared} className={`add-choice${shared ? ' is-on' : ''}`} onClick={() => onChange(true)}>
          <IconPeople />
          <span><b>Shared Library</b><span>Anyone using Breader can read {many ? 'them' : 'it'}. Only share books that are public domain or yours to share.</span></span>
          <i className="add-radio" />
        </button>
      </div>
    </>
  );
}
