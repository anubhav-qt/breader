# Security policy

## Reporting a problem

Please don't open a public issue. Report it privately instead:
[Security › Report a vulnerability](https://github.com/anubhav-qt/breader/security/advisories/new).

Say what you found, how to make it happen, and what it could let someone do. You'll hear back within a week, and you'll be told when it's fixed. If you'd like credit, say so and you'll be named in the advisory.

## What's covered

Only the newest code on `dev`, which is what [breader.site](https://breader.site) runs. Older copies don't get fixes.

Of most interest:

- Reading or changing someone else's library, books, notes or place.
- Getting at a library key, or opening a shared library without its key.
- Running code through a book file (EPUB, PDF, CBZ, text).
- Anything that reaches the server's own files or settings.

## Please don't

- Test against other people's libraries or data.
- Run load or denial-of-service tests against breader.site.
- Use social engineering.
