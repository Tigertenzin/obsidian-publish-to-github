# Publish to GitHub

An Obsidian plugin that publishes the active note to a GitHub repository, rewriting its
frontmatter properties and trimming private content on the way out. The note in your vault
is never modified — every change applies only to the copy that lands in the repository.

## Why this exists

Posts for my [Eleventy](https://www.11ty.dev/) blog get written in Obsidian anyway, so the
publishing step was the only part still done by hand: copy the note out of the vault, strip
the properties that are for me rather than for the site, add the ones Eleventy's frontmatter
expects, delete the working notes at the bottom, save it into the site repository's posts
folder, commit, push. This plugin is that whole routine behind one command.

Everything it does is shaped by that workflow:

- **Vault properties and site properties are different sets.** The vault ones — status
  markers, private links, anything used for organising notes — are stripped, and Eleventy's
  own (`layout`, `date`, `tags`, `permalink`, whatever the site's collections need) are
  written in with the values filled in at publish time.
- **A note is longer than a post.** Drafting notes, sources, and to-dos live below a
  horizontal rule and never leave the vault.
- **The source note stays canonical.** The vault keeps the full note with its own
  properties; only the copy sent to the repository is rewritten.
- **Posts get republished.** A post is rarely right the first time, so publishing over an
  existing file shows a diff against what is currently in the repository and takes a separate
  confirmation before overwriting it.

Nothing in it is Eleventy-specific — any repository-backed site with frontmatter-driven posts
works the same way. Point the target folder at the site's posts directory (`src/posts`,
`content/blog`, or wherever the collection reads from) and the rest is settings.

## The command

`Publish to GitHub` (command palette) walks through:

1. **Review window** — the filename the post is published under, and the complete frontmatter
   of the published copy, laid out for editing. The settings decide what it starts as; from
   there you can change any value, rename or retype any property, drop one with its trash
   button, add a new one that lives nowhere in the settings, and restore anything the settings
   stripped. It also spells out what the break marker will cut.
2. **Preview window** — shows the exact markdown that will be committed, and where. `Back`
   returns to the review window with your edits intact.
3. **Overwrite confirmation** — only when a file is already at that path. See below.

Edits in the review window apply to that one publish. Nothing there is written back to the
note or to the settings.

The **filename** field starts as the note's own name and is yours to change — posts are
usually titled one way in the vault and slugged another on the site. It accepts a name with
or without `.md`, and a name containing slashes nests the post further inside the target
folder. The full path it resolves to is shown directly underneath.

While the review window is open, the plugin checks that path in the repository and reports
what it finds: a new file, or one that is already there and would be replaced. Editing the
filename re-checks the new path.

Each property row shows where it came from — *from note*, *from settings*, or *added here* —
along with its type. Values the inputs cannot represent (nested YAML, lists of objects) are
shown read-only as *nested value* and passed through to the published copy untouched.

## Republishing over an existing post

When a file already exists at the target path — the usual case for a post being revised —
the second window becomes a review of the changes rather than a plain preview:

- A **Changes** view diffs the published copy against the file currently in the repository,
  showing added and removed lines with three lines of context and collapsing long unchanged
  runs. **Full document** switches to the complete output.
- The header carries the line counts, `+N −M`.
- Publishing is relabelled **Overwrite…** and opens a third confirmation naming the file,
  the branch, and the size of the change.

Two cases short-circuit the diff: an output identical to what is already there says so and
offers nothing to change, and a file too large for GitHub to return inline cannot be diffed,
which the window says plainly before letting you replace it.

The commit is made against the exact version the diff was built from. If the file changes on
GitHub between the diff and the confirmation, the commit is rejected rather than quietly
overwriting the newer version, and the plugin tells you to publish again.

## Settings

### GitHub connection

| Setting | Meaning |
| --- | --- |
| Repository owner / name | The target repository. |
| Branch | Branch the commit lands on. Must already exist. |
| Personal access token | Fine-grained token with **read & write** access to the repository's *Contents*. |
| Target folder | Folder inside the repository to publish into — the site's posts folder. Empty means the repository root. |
| Mirror vault folder structure | Append the note's folder path inside the vault to the target folder. |
| Commit message | Supports `{{filename}}`, `{{path}}` and `{{date}}`. |

`Test` checks that the token can reach both the repository and the branch.

The token is stored in `data.json` inside the plugin folder, in plain text — the same as every
other Obsidian plugin credential. Keep the vault out of any repository you publish.

### Properties to add

Each row is `name · type · default value · keep existing value`.

- **type** is one of text, number, checkbox, date, date & time, or list, and decides which input
  the review window shows.
- **default value** prefills that input.
- **keep existing value** on: when the note already carries the property, its own value is used
  instead of the default. Off: the default always wins, which is how you overwrite a property.

These are defaults for the review window, not fixed rules — every one of them can be changed
or overridden there before publishing. Leaving a value empty in the review window omits that
property from the published copy.

A key listed in both *properties to add* and *properties to remove* is added: the add list
states a value, so it is treated as the more specific instruction.

### Properties to remove

One property name per line. Any of these present in the note are stripped from the published
copy, and listed under *Removed by settings* in the review window with a button to restore one
for that publish.

### Content break

With the break enabled, everything from the first line matching the break marker onwards is left
out. The default marker is `---`, a horizontal rule, so a note can carry private working notes
below the rule and publish only what sits above it. The marker is matched against a whole line,
ignoring surrounding whitespace, and is only searched in the body — the frontmatter delimiters
are never mistaken for it.

**A horizontal rule is also an ordinary way to separate sections**, and the break takes the
*first* one it finds. A note that uses `---` between sections will be cut at the first of them.
So the review window always reports which line the marker was found on, how many lines are
about to be dropped, and offers the dropped content for inspection; when the cut would remove
more than half the note, it says so as a warning rather than a note. If your notes use `---`
freely, set the marker to something that cannot collide — `%%publish-break%%` uses Obsidian's
comment syntax and stays invisible in reading view.

## Building

```bash
npm install
npm run build   # type-check, then bundle to main.js
npm run dev     # rebuild on change
```

## Installing into a vault

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/publish-to-github/`, then enable the plugin in
*Settings → Community plugins*. During development, symlinking the repository into that path and
running `npm run dev` is quicker.
