# Contributing to Breader

Thank you for helping. Bugs, ideas, fixes and kind words are all welcome.

## Before you start

- **A question?** Ask in [Discussions › Q&A](https://github.com/anubhav-qt/breader/discussions/categories/q-a).
- **An idea?** Share it in [Discussions › Ideas](https://github.com/anubhav-qt/breader/discussions/categories/ideas) first, so we can shape it together before anyone writes code.
- **A bug?** Open an [issue](https://github.com/anubhav-qt/breader/issues/new/choose).
- **A security problem?** Never in public. See [SECURITY.md](SECURITY.md).

## Your first contribution

1. Pick an issue labelled [good first issue](https://github.com/anubhav-qt/breader/labels/good%20first%20issue). Each one says where to look and when it's done. Once you've got one in, try [help wanted](https://github.com/anubhav-qt/breader/labels/help%20wanted).
2. Comment that you'd like it, and it's yours. One at a time, please. If there's no pull request after two weeks, it goes back to the pool for someone else.
3. Stuck? Ask in the issue. No question is too small.

Fixing a typo or a broken link needs no issue: open a pull request straight away.

## Where things are

| Folder | What's in it |
| --- | --- |
| `frontend/` | The app (React, Vite). Most features live in `frontend/src/features/<name>/`, books are read in `frontend/src/books/`. |
| `server/` | The API, the worker and the voice and panel engine (Hono, Postgres via drizzle). |
| `shared/` | Types and zod schemas both sides use. |
| `ai/` | Tooling for the panel model and voices. You can ignore it for most changes. |
| `infra/` | How it runs: the local stack and production. |
| `docs/adr/` | The big decisions and why they were made. |

[CLAUDE.md](../CLAUDE.md) is a short map of how it all fits together, written for people and coding agents alike. [TODO.md](../TODO.md) has smaller work that isn't an issue yet.

## Running it

You need Node 24 and Docker.

```sh
npm install
npm run stack      # the local server and its stand-ins
npm run web        # the app on http://localhost:5173
npm test           # server tests; need the stack running
```

Working on the app alone? `npm install` then `npm run web` is enough: books you add stay in your browser, and only syncing, accounts and manga search need the stack.

More on the stack is in [infra/README.md](../infra/README.md).

## Making a change

1. Fork, then branch from `dev`.
2. Keep each change small and about one thing.
3. Add or update tests for what you change.
4. Try it in a browser yourself: every button and field you touched, with empty, very long and odd input.
5. Before you push, these must pass:
   ```sh
   npm run typecheck
   npm run lint -w frontend
   npm test
   ```
6. Open a pull request into `dev` and fill in the template. A review follows within a few days.

## How the code reads

- Simple beats clever. Plain `if`/`else` over chained ternaries and `&&`/`||` tricks.
- Clear names, small pieces, one step per line.
- Comments say why, not what.

## Commit messages

One line, no body: `<type>: <message>`, where type is `feat`, `fix`, `chore`, `docs`, `refactor`, `test` or `perf`.

```
fix: a PDF opens at the page it was left on
```

## The design

Breader has no colour of its own; the colour comes from the books. The UI shows, it doesn't explain: labels, states and short errors, no help text or empty-state messages. If a change adds something visible, open a discussion first.

## Code of conduct

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree your work is shared under the [MIT License](../LICENSE).
