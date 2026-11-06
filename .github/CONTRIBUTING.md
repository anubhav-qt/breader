# Contributing to Breader

Thank you for helping. Bugs, ideas, fixes and kind words are all welcome.

## Before you start

- **A question?** Ask in [Discussions › Q&A](https://github.com/anubhav-qt/breader/discussions/categories/q-a).
- **An idea?** Share it in [Discussions › Ideas](https://github.com/anubhav-qt/breader/discussions/categories/ideas) first, so we can shape it together before anyone writes code.
- **A bug?** Open an [issue](https://github.com/anubhav-qt/breader/issues/new/choose).
- **A security problem?** Never in public. See [SECURITY.md](SECURITY.md).

## Running it

You need Node 24 and Docker.

```sh
npm install
npm run stack      # the local server and its stand-ins
npm run web        # the app on http://localhost:5173
npm test           # server tests; need the stack running
```

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
6. Open a pull request into `dev` and fill in the template.

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
