# Breader AI notes: the procedure

You are working with the owner of Breader, an e-reader at breader.site. You'll read the books in its library, one whole book at a time, and make two things from each. This file is the whole job. Read all of it before the first book, and read it again at the start of every session.

## 1. What you are making

**Revisit notes.** A reader who has lost track opens Revisit and sees who's who, where's where, and the words to know, drawn only from what they have already read. You write the notes for the whole book. Every fact is pinned to the paragraph where the book reveals it, and the app shows a reader only the facts before their place. Readers see these notes, so they must be right, spoiler-free, and written in Breader's plain voice.

**Voice marks.** The app can read a book aloud with two voices, one male and one female. You mark who says every line of dialogue and who narrates every stretch of the book, so each line is read in the right voice. Readers never see the marks. They only hear them, and a wrong voice on a line is heard by everyone.

Both come from one careful read. Each finished book becomes one file, `ai/out/<sha256>.json`, which the owner loads onto the server later.

**Accuracy matters more than speed.** Take as long as a book needs, across as many sessions as it takes.

## 2. Rules that never bend

1. **Read only.** The tools read production over a read-only connection. You never write to the database, R2 or any server. You never run anything in `server/` or `infra/`, and you never deploy.
2. **Secrets.** `infra/.env` holds production passwords. Never open, print, copy, summarise or quote it, and never put its values anywhere. Only the tools read it. If any output shows something that looks like a password, key or token, stop and tell the owner.
3. **Privacy.** Book files, their text, the notes and the marks are private. They stay in `ai/work/` and `ai/out/`, which git ignores. Never commit them, upload them, paste them into a website, or send them anywhere except to the model you run on. Web searches use titles, authors, series and character names only, never passages from the book.
4. **Git.** Never commit, push, merge, rebase or switch branches. The owner does all of that.
5. **No spoilers.** A note says only what the book has shown by its paragraph, plus what earlier volumes of the same series showed. Things you learn on the web, or by reading ahead, stay out of the notes until the book shows them.
6. **No em dashes in Revisit notes. Ever.** Not the em dash (—), not the en dash (–), and not a hyphen standing in for one (" - "). Use a comma, a colon or a new sentence. Notes also have no emojis, no markdown, no slashes and no brackets. `check` rejects all of these.
7. **Never guess silently.** When you can't tell, mark the line unsure (`?`) and write why in `research.md`. Never invent a name, a fact or a source.
8. **In order.** Read and mark the parts in order. A part is finished before the next one starts: its marks file, the cast, the notes and the ledger are all updated, and `check` has no errors.

## 3. Setup

Once per machine, from the repository root:

```bash
source ~/.nvm/nvm.sh && nvm use 24
npm install
npm --prefix ai install
npm --prefix ai run selftest
npm --prefix ai run books
```

- `npm install` brings the app's packages, which the tools use. Skip it if `node_modules` is already there.
- `selftest` runs the tools on a small made-up book. If it doesn't say "Self-test passed.", stop and tell the owner.
- `books` needs `infra/.env` on this machine. If it can't read it, stop and ask the owner.
- Every command in this file runs from the repository root. Start each terminal with `nvm use 24`.

**The model.** Use the most capable model you have, at its highest thinking setting, and keep one model for a whole book. You'll give its name to `pack`.

**Before the first book**, the owner confirms that the plan this runs on doesn't let the model's provider keep or train on what it reads. Breader's privacy promise depends on it. If the owner hasn't said so, ask once.

## 4. The work, book by book

### Step 1: Fetch

```bash
npm --prefix ai run books
npm --prefix ai run fetch -- next
```

- `books` lists every book in every library, one entry per file.
  - Books someone has started come first, the most recently read at the top. Books nobody has started come after.
  - The status column shows where each book stands: new, fetched, part N of M, or packed.
- `fetch -- next` takes the first book that isn't packed, unless the owner names one (`fetch -- 3` or `fetch -- <key>`).
- If `fetch` says the book is already fetched, you're resuming it (see Resuming below).

`fetch` makes `ai/work/<key>/`:

| File | What it is | Yours to edit |
|---|---|---|
| `text/0001.md`… | The book in parts of about 5,000 words, every paragraph with its id, every quote numbered | No |
| `book.json`, `meta.json`, `source.*` | The tools' copy of the book | No |
| `cast.json` | Everyone in the book, with their voice. Starts with the generic speakers, plus the cast of another volume of the series if one was done | Yes |
| `notes.json` | The Revisit notes. Starts empty | Yes |
| `marks/` | One marks file per part | Yes |
| `research.md` | What you learn before and while reading | Yes |
| `ledger.md` | Your running memory of the story | Yes |

Look at the first part's header and what `fetch` printed: the format, the number of parts and the quote style.

- If the style is dashes or none and the book is a novel, read 5.6 before you start.
- If a PDF's text came out garbled (words run together, pages out of order, running headers everywhere), stop and tell the owner.
- For nonfiction and other books that aren't stories, the notes still matter: often mostly terms, plus the people and places the book discusses. Quotes are usually cited words, not dialogue. See 5.1.

### Step 2: Research, before reading

Learn enough about the book to attribute every line with confidence, without letting any of it leak into the notes early.

1. **Search the web** for the title and author, then the title with "characters", then the series and volume, and the translator if it's a translation.
   - Trust sources in this order: the book itself, the publisher or author, Wikipedia, a well kept wiki for the series, then reviews.
   - Wikis and reviews are full of later volumes and spoilers. Use them for identity, gender and spelling only. Never copy their words.
2. **Pin down this edition.** Translations spell names differently (an official translation against a fan one, or name order). Always use the spelling in this book's text.
3. **Fill in `research.md`:** the book, the narration, the cast table, the traps, what you know from research that isn't revealed yet, and your sources.
4. **Put the main cast into `cast.json`,** each with evidence for their gender. The best evidence is a paragraph id where the book uses a pronoun for them, and you update it when you meet one. A web source will do until the book gives one.
5. **Series:** if `cast.json` came from another volume, keep those ids so everyone keeps their voice across the series. Check that each person still fits.
6. **The `author` entry:** if the book has a foreword, author's notes or an afterword in the author's own voice, set its gender from what you found about the author. If you can't find it, leave N.

When the web and the book disagree, the book wins. When sources disagree and the book hasn't settled it yet, keep reading. Decide when the book does, and mark the earlier lines `?` if they're still open.

**Research only.** When the owner asks for research only, scripts the owner runs do steps 3 to 5 with another model: `mark` the voice marks, then `notes` the Revisit notes. That model gets the whole book, `research.md` and `cast.json`, but none of your searching. So:
- do Step 1 and Step 2, and nothing else: no marks, no notes, no ledger;
- in `research.md`, give it what the web taught you: the narration, the cast table with every name, nickname and title the book uses for each person, the traps, and any identity the book hides and where it's revealed;
- put everyone you found into `cast.json`, each with evidence;
- run `check`, fix any errors, and tell the owner the book is ready for `mark`.

### Step 3: Read and mark, part by part

For each part, in order:

1. Read the whole of `text/NNNN.md` carefully.
2. Write `marks/NNNN.txt`: the narrator, a mark for every numbered quote, and any speech the tool didn't number (part 5, and the syntax in part 7).
3. Add everyone new to `cast.json`, whether they speak or are only named.
4. Update `notes.json` (part 6):
   - new entries at the paragraph where each first appears;
   - new names as they're revealed;
   - a new `about` version when something important changes;
   - events.
5. Update `ledger.md`: the story so far, who is on stage, the open questions as the reader sees them, and voices to remember. Keep it short enough to read in a minute. It's what lets you, or a fresh session, carry on.
6. Run `npm --prefix ai run check -- <key>`.
   - Fix every error before the next part.
   - For each warning: fix it, or keep it and write why under "Warnings kept" in `research.md`.
7. Every fifth part, run `npm --prefix ai run audit -- <key> part <n>` on the part you just marked. Read it as a script, and ask whether every bracketed line sounds like the person it's given to.

**Reading ahead** is allowed only to settle a particular line, for example when the next paragraph names who just spoke. Look no further than the next part. Nothing you see there goes into the notes early.

**Resuming.** In a new session, or after a break:
1. Read this procedure.
2. Read the book's `research.md`, `ledger.md`, `cast.json` and its last marks file.
3. Run `check`, which says which part is next.
4. Carry on from there.

### Step 4: Finish

1. `npm --prefix ai run check -- <key> --final` must show no errors.
2. `audit -- <key> unsure`: read each unsure line again with its context and settle as many as you can. Aim for under 1% of lines; `pack` refuses over 3%.
3. `audit -- <key> sample 60`: check all 60 random lines against the text.
   - For each wrong line, fix it, find the cause (a misread scene, a pronoun, a missed speaker change), and audit that whole part.
   - If more than 2 of the 60 were wrong, audit every dialogue-heavy part, then sample again.
4. `audit -- <key> cast`: go over each speaker's voice, line count and evidence. For everyone marked N, ask whether that is really right.
5. `audit -- <key> notes <s:b>`: read Revisit as a reader would at about a quarter of the way in, half, three quarters and the end. Look for anything they couldn't know yet, anything wrong, and anything too thin to help.
6. Run `check -- <key> --final` again.

### Step 5: Pack and report

```bash
npm --prefix ai run pack -- <key> --by "<model name and setting>"
```

This writes `ai/out/<sha256>.json` and `ai/work/<key>/report.md`. Then tell the owner, in a few lines:
- the book;
- how many lines you marked, and how many are unsure;
- anything odd: garbled text, a gender you couldn't settle, warnings you kept.

Then take the next book.

## 5. Voice marks: how to decide

### 5.1 What counts as a line

- **Every numbered quote gets a mark:** a speaker id, or `-` if it isn't speech.
- **Not speech (`-`):**
  - scare quotes ("her so-called ‘plan’");
  - titles of books, songs, ships and shows;
  - signs, labels and slogans the narrator reads out;
  - words mentioned as words;
  - quotations a nonfiction author cites.
- **Speech without quote marks** is added by its exact words (7.2). This includes:
  - a thought the text marks as one ("I should run, she thought"), flagged `think`;
  - telepathy, and messages read aloud;
  - dash dialogue;
  - speech the tool cut wrongly.

  Italics don't show in the text files, so go by the words themselves.
- **Letters, diaries, texts and notes** shown as their own paragraphs are narration by the writer. Mark `narrator <writer>` from their first paragraph, and switch back after. A character reading one aloud in a scene is speaking it.
- **Songs and poems** a character sings or recites are that character's lines.
- **One speech over several paragraphs** gets a mark in each paragraph (the tool shows ⟪n runs on into the next paragraph⟫).

### 5.2 Finding the speaker

Work like an audiobook director going through a script. Go down this ladder and stop at the first rung that settles it:

1. **A tag in the paragraph:** “…,” said Elena. Elena said. She asked (the one woman in the scene).
2. **An action beat:** a paragraph where a character acts and a quote stands with it belongs to that character, unless the tag names someone else.
3. **Paragraphs:** a new speaker nearly always gets a new paragraph. A quote in the same paragraph as a character's action or thought is theirs.
4. **Turn-taking:** in untagged back and forth between two people the lines alternate. Count from the last tagged line, and confirm every line by its content.
5. **Content:**
   - Who asks and who answers, and who knows what.
   - Who is being addressed: "Elena, stop" is said *to* Elena, so not by her.
   - Speech habits, dialect, and the names and titles each person uses for the others.
   - Kinship terms can give the speaker away: in Korean, a girl says oppa and unnie, and a boy says hyung and noona.

Then the harder cases:

- **Crowds and unison** ("they all shouted"): `crowd`.
- **A voice the text doesn't identify:** `unknown-man` or `unknown-woman` when the text says which ("a man's voice", "she"). Otherwise `unknown`.
- **Identity reveals:** if a voice is later revealed as a known character and the reveal is meant to surprise, keep the unknown id until the reveal paragraph. Mark by who the reader knows is speaking at that point.
- **The other end of a phone, radio or recording:** the person speaking there.
- **Quoted words inside speech** (“She told me, ‘never come back,’ and left”) belong to the outer speaker, who is saying them.
- **A first-person narrator's own dialogue:** the narrator's id.
- **Animals, machines and spirits:** as the book refers to them. "It" means N.
- **Two readings that still fit after rereading:** take the likelier one, add `?`, and write one line under "Unsure lines" in `research.md`.

Don't use `?` just because a line has no tag. If the turn-taking settles it, it's settled.

### 5.3 Narration

- **First person:** `narrator <id>`. The narration takes the narrator's voice.
- **Third person through one character's eyes:** `narrator third pov <id>`. The app decides the voice. You only say whose eyes the reader is behind.
- **Third person with no single point of view:** `narrator third`.
- **Mark every change where it happens:**
  - a new chapter narrator;
  - an interlude from someone else;
  - a point of view that switches at a scene break;
  - a letter, and the return from it.
- **Front matter, contents, copyright, and the translator's or editor's notes:** `narrator third`.
- **The author speaking in their own voice** (foreword, author's notes, afterword): `narrator author`.
- **Every marks file starts with a narrator line,** even when nothing changed.

### 5.4 Gender

- **M or F** for how the book presents the character at that point.
  - Pronouns come first, then what the text states, then research.
  - Honorifics are clues, not proof. A Japanese -kun is sometimes used for girls.
- **N** is for:
  - an unknown speaker, and groups;
  - "it";
  - a character the book deliberately keeps ungendered;
  - a character the book refers to as they.

  N lines are read in the narrator's voice.
- **A reveal that changes how someone should sound** (a disguise, a hidden identity) goes in `changes` in `cast.json` at the reveal paragraph. Before that, they sound as the reader believed.
  - If the reader knew the truth all along, use the true gender throughout.
- **Series:** keep ids and genders the same from volume to volume.

### 5.5 Group scenes

Light novels and school stories have scenes with many voices.
- Pin each line to one person where the text allows.
- Where it doesn't, but the gender is clear ("a girl at the back called out"), use `unknown-woman` or `unknown-man`.
- Use `crowd` only for lines said by several people at once.

### 5.6 Flags in the text, and books without quote marks

The tool finds quotes by the book's quote style, and it flags what it isn't sure of:

- **⟪n runs on into the next paragraph⟫:** normal. One speech continues. Mark each paragraph's quote.
- **⟪check: quote n never closes⟫:** either the closing mark is missing, or an apostrophe fooled the tool. Find where the speech really ends. If the numbered quote is wrong, mark it `-` and add the real speech by its words.
- **⟪check: a quote mark here pairs with nothing⟫:** a stray mark. A quote may have been missed or cut wrongly. Fix it the same way.
- **Single-quote books** (‘ ’) share their closing mark with the apostrophe. Watch for quotes that stop early at a word like boys’ and for ones that run on, and fix them the same way.
- **Dash dialogue** (—Where? —he asked): the tool numbers only the first stretch of each paragraph that opens with a dash, and flags every one.
  - Keep each numbered stretch, or mark it `-`.
  - Add the rest of the speech by its words.
- **No quote marks at all** in a novel with dialogue: add every line by its words. This is slow. Do it anyway.

## 6. Revisit notes: how to write them

### 6.1 What gets an entry

- **People:** everyone a reader needs to keep straight.
  - Anyone named who appears in more than one scene, or does something that matters.
  - Members of families, groups and classes, when a reader has to tell them apart.
  - One-line walk-ons stay in `cast.json` only.
- **Places:** countries, cities, schools, buildings, ships, worlds, and rooms that come back or matter.
- **Terms:**
  - invented words;
  - systems of magic, power or technology;
  - ranks, titles, organisations and events;
  - honorifics and foreign words the book uses without explaining;
  - jargon.

  Not ordinary English.

### 6.2 An entry

- **`id`:** lowercase words joined by hyphens, and stable. People use their `cast.json` id.
- **`names`:** first the name the book uses where it first appears, then each new name or title at the paragraph where the book reveals it (a surname, a nickname, a true identity). The app shows the latest as the heading and the others as "also".
- **`about`:** who or what it is, as the reader knows it at that paragraph.
  - One to three sentences, under 320 characters.
  - Each version replaces the one before, so write it whole.
  - Add a version when something important changes: a new role, a reveal, a death.
- **`events`:** the big beats they take part in, one sentence each (under 240 characters), at the paragraph where each happens.
  - The reader chooses to see this chapter, the last five, or everything read so far, and the events fill that in.
  - For people, one to three events in each chapter where they matter. Places and terms rarely need any.
- **`merge`:** use it when the book later reveals that two entries are one (the masked stranger is Rhaegar). On the entry that stops, set `{"at": "<reveal>", "into": "rhaegar"}`.
- **`at`:** always `section:paragraph`, exactly as the text files show it in brackets, and always the paragraph where the reader learns it, never earlier.

### 6.3 Spoilers

- Only what the book has shown by `at`, plus earlier volumes. List words that come from earlier volumes (names, places) in `earlier` so `check` knows they're allowed.
- If a character lies about who they are, `about` gives what they claim ("Says he is a wool merchant from Ferrow."). The truth is a new version at the reveal.
- Deaths, betrayals and reveals appear only at their paragraph.
- **No hints of what's to come:** "for now", "not yet", "at first", "seemingly", "little does she know", "later", "turns out", "eventually". `check` warns on these.
- `check` flags any name or capitalised word that the book hasn't used by that paragraph. Treat every one of these as a possible spoiler or mistake.

### 6.4 Breader's voice

- Calm, plain and warm. Short sentences a tired reader takes in at a glance.
- `about` is present tense: "A courier who carries sealed letters between the river towns."
- `events` are present tense too, like a recap: "Loses the Duke’s letter at the ferry crossing."
- Don't start with the entry's own name, because the heading shows it. Use other names the reader knows by then.
- Every sentence starts with a capital letter and ends with a full stop.
- Curly quotes and apostrophes. `pack` curls straight ones.
- No talk about the book ("in this chapter", "the reader", "the author").
- **No em dashes, no en dashes, no hyphen used as a dash, no emojis, no markdown, no slashes, no brackets.** Use a comma, a colon or a new sentence.

| Not this | This |
|---|---|
| A courier — and secretly a spy for the Crown. | A courier who carries letters for the Crown. *(only once the book has shown it)* |
| Elena’s brother (older), a soldier / guard. | Elena’s older brother. He guards the north gate. |
| Loses the letter, which will later cost her everything. | Loses the letter at the ferry crossing. |
| **The Lantern Oath** - a vow sworn by couriers. | A vow couriers swear to carry any letter to its end. |

## 7. File formats

### 7.1 The text files

```
## Section 12: Chapter Three

[12:0] (heading) Chapter Three

[12:2] ⟨1⟩“You’re late,”⟨/1⟩ said the man at the door. ⟨2⟩“The trains,”⟨/2⟩ she said.
```

- `[12:2]` is section 12, paragraph 2. These are the reader's own numbers, and every `at` and every mark uses them.
- Gaps in the numbers are normal: pictures, rules and empty blocks have numbers but no text.
- `⟨1⟩…⟨/1⟩` is quote 1 of that paragraph, which a mark calls `12:2.1`.
- `⟪…⟫` is a note from the tool (5.6), not the book.
- Spaces are tidied for reading. The tools match words however the spaces fall.

### 7.2 Marks: `marks/NNNN.txt`

One line per mark. Blank lines and lines starting with `#` are ignored.

| Line | Meaning |
|---|---|
| `narrator third pov elena` | The narrator from the start of this part. Always the first line |
| `narrator elena` | First person, Elena |
| `12:40 narrator marlo` | From paragraph 12:40 on, Marlo narrates |
| `12:2.1 elena` | Quote 1 of 12:2 is Elena's |
| `12:2.2 marlo ?` | Quote 2 is Marlo's, and you're unsure (write why in research.md) |
| `12:3.1 -` | Quote 1 of 12:3 isn't speech |
| `12:5 "I should never have come back" elena think` | Speech the tool didn't number, by its exact words. `think` marks a thought |
| `12:9@2 "No" marlo` | The second "No" in 12:9 |
| `rest -` | Every quote in this part not marked above isn't speech. Only for front matter and nonfiction |

- Copy the words exactly as the paragraph has them. Quote marks, capitals and spacing don't need to match.
- To change a numbered quote's extent, mark it `-` and add the right words as a new line.
- Two marks can't overlap.
- Never give a speaker with `rest`. Mark speech one line at a time.

A small file:

```
narrator third pov elena
12:1.1 marlo
12:2.1 elena
12:2.2 elena
12:3.1 -
12:5 "I should never have come back" elena think
12:9.1 marlo
12:9.2 unknown-woman
12:40 narrator elena
```

### 7.3 `cast.json`

```json
{
  "people": [
    { "id": "elena", "name": "Elena Voss", "gender": "F", "role": "Courier; narrates the odd chapters", "evidence": "3:14 “she said”; publisher page" },
    { "id": "gate-guard", "name": "A guard at the north gate", "gender": "M", "minor": true, "evidence": "7:22 “he”" },
    { "id": "masked-knight", "name": "The masked knight", "gender": "M", "evidence": "20:4 “he” (as the reader believes)",
      "changes": [{ "at": "40:12", "gender": "F", "why": "Unmasks as a woman; a surprise to the reader." }] }
  ]
}
```

- Every non-generic entry needs `evidence`.
- `minor: true` marks someone who only speaks a line or two, and never gets a Revisit entry.
- Leave the generic entries (`unknown`, `unknown-man`, `unknown-woman`, `crowd`, `author`) in place. You may set `author`'s gender.

### 7.4 `notes.json`

```json
{
  "earlier": [],
  "people": [
    {
      "id": "elena",
      "names": [{ "at": "3:12", "name": "Elena" }, { "at": "9:40", "name": "Elena Voss" }],
      "about": [
        { "at": "3:12", "text": "A courier who carries sealed letters between the river towns." },
        { "at": "31:7", "text": "A courier who now carries letters for the Crown. She trusts almost no one since the ferry." }
      ],
      "events": [
        { "at": "5:88", "text": "Loses the Duke’s letter at the ferry crossing." },
        { "at": "12:40", "text": "Finds the letter in Marlo’s coat and says nothing." }
      ]
    }
  ],
  "places": [
    { "id": "ferrow", "names": [{ "at": "3:15", "name": "Ferrow" }], "about": [{ "at": "3:15", "text": "A river town of mills and ferries, where Elena’s route begins." }] }
  ],
  "terms": [
    { "id": "lantern-oath", "names": [{ "at": "4:2", "name": "the Lantern Oath" }], "about": [{ "at": "4:2", "text": "A vow couriers swear to carry any letter to its end." }] }
  ]
}
```

### 7.5 What `pack` makes

`ai/out/<sha256>.json` holds:
- the notes and the voice marks;
- each chapter's paragraph count and text hash, so the app can tell whether its text matches;
- the model's name.

Marks are character spans of each paragraph's exact text, worked out by the tools, never by you. Don't edit the file.

## 8. Commands

Every command starts `npm --prefix ai run`, from the repository root.

| Command | What it does |
|---|---|
| `books` | Lists the books and where each stands, and saves the queue |
| `fetch -- next` | Fetches and extracts the next book (or `fetch -- <rank or key>`) |
| `check -- <key>` | Errors and warnings so far. Add `--final` before packing |
| `audit -- <key> part <n>` | A part as a script, with every line and its voice |
| `audit -- <key> sample 60` | 60 random lines with context |
| `audit -- <key> unsure` | Every line marked `?` |
| `audit -- <key> speaker <id>` | Everything one person says |
| `audit -- <key> cast` | Everyone, with their voice, their lines and the evidence |
| `audit -- <key> notes <s:b>` | Revisit as a reader at that paragraph sees it |
| `pack -- <key> --by "<model>"` | Final check, then writes the book's file for the server |
| `mark -- <key>` | The owner's, not yours: after research only, marks every part with Kimi K3 through NVIDIA, then packs |
| `notes -- <key>` | The owner's, not yours: after `mark`, writes the Revisit notes with Kimi K3 through NVIDIA, reads them through as a reader, then packs |

`<key>` can also be the book's rank in `books`, or the first letters of its key.

## 9. Stop and ask the owner when

- a tool fails, or a book won't fetch or extract;
- a PDF's text is garbled;
- you can't tell whether a book is a story, or how to treat it;
- more than 3% of a book's lines stay unsure after rereading;
- anything looks like a secret;
- you're unsure about anything in this file.
