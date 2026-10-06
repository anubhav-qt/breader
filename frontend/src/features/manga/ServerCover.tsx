import { useEffect, useRef, useState } from 'react';
import { readServer, suwayomi } from '../../lib/suwayomi';

/**
 * A cover on the reader's own server. With no login, a picture like any other; with one, it's
 * fetched with it (a picture can't send a login), once it nears the screen.
 */
export function ServerCover({ path }: { path: string }) {
  const login = readServer();
  const open = !!login && !login.user;
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (open || !login) return;
    const el = ref.current;
    if (!el) return;
    let url = '';
    let live = true;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      io.disconnect();
      suwayomi.picture(path).then((b) => {
        if (!live) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      }, () => {});
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => { live = false; io.disconnect(); if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, open]);

  if (open) return <img src={login.url.replace(/\/+$/, '') + path} alt="" loading="lazy" decoding="async" draggable={false} />;
  return <span ref={ref} className="mdx-cover-wait">{src && <img src={src} alt="" decoding="async" draggable={false} />}</span>;
}
