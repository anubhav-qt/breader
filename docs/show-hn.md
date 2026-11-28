# Show HN draft

## Title (pick one, HN caps it at 80 characters)

1. Show HN: Breader, a free web reader with on-device voices, run on free tiers
2. Show HN: Breader, books and manga reader run from a ThinkPad and free tiers

## URL

https://breader.site

## First comment

HN does not allow text with a URL. Submit the URL with the text box empty,
then post this right away as the first comment, in your own words.

Hi HN, I built Breader, a reader for the web. Open it, drop in an EPUB, PDF,
text file or CBZ, and read. No install and no sign-up: your library opens with
a key only you hold, or you can log in to sync it.

A few things I cared about:

- Your place is saved to the character, not the page, so it survives any
  window size or font.
- Books start as outlines and fill with their own colour as you read. That is
  the whole progress UI.
- Read aloud runs in your browser (Piper and Kokoro voices on onnxruntime-web),
  so the text is never sent anywhere to be spoken. A model marks who speaks
  each line, so characters can get their own voices.
- Manga has its own shelf and reader. A small YOLO model I trained finds the
  panels, also in the browser, so you can read panel by panel on a phone.

It has around 10k readers now and costs me $0 a month. The setup, since I
think it is the interesting part:

- The app is static on Cloudflare Pages. It times each API server's /health
  and picks the fastest itself, so there is no load balancer.
- Home is an old ThinkPad behind a Cloudflare Tunnel. It runs the API, the
  job worker, the voice and panel engine, and a Postgres read copy.
- Supabase (Mumbai) is the only writer. Every write also lands in a
  change_log table, and each read copy pulls from it, about a second behind.
- A GCP e2-micro in Oregon (IPv6 only) serves API calls for the Americas
  from its own read copy.
- An AWS box asks the ThinkPad every minute. After 10 minutes of silence it
  wakes a sleeping Azure standby in Singapore, with Modal as its voice and
  panel engine, and lets it sleep again once home answers.
- Manga pages and covers are public and cached at Cloudflare's edge, and the
  chapters people are reading sit in R2, so most image traffic never reaches
  a server.

It is MIT licensed: https://github.com/anubhav-qt/breader

I'd love feedback on the reader itself, and on where this setup will break
first as it grows.

---

## Before posting (from HN's own pages, read 2026-11-27)

- Rewrite this in your own words. HN says: "Please don't put generated text in HN posts."
- Title starts with "Show HN:", no capitals for shouting, no exclamation marks.
- Never ask anyone to upvote or comment. HN penalises it.
- Green name means a new account. HN's pages name no Show HN limit for new
  accounts. Why your last try was blocked is not checked; comment for a while
  first so the account has some karma and history.
- If it shows [dead], others with karma can vouch for it. Many people also
  email hn@ycombinator.com to ask; HN's pages do not name that route for this.
- No earlier breader.site post shows on HN search (dead posts never show there).

## Answers to have ready (not part of the post)

- Why not one VPS? Free tiers only, and each one does what it is best at.
- What if the ThinkPad dies? Azure is woken after 10 silent minutes; pages and
  covers keep coming from Cloudflare meanwhile; Supabase holds all writes.
- Where does manga come from? Your own CBZ files, or search through a
  Suwayomi server and MangaDex, crediting the group and linking the publisher.
- Load tests: in a local Docker run, one API with 2 read copies served
  2,000 fake readers with no failures (docs/load-tests.md).
