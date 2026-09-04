# Publish to GitHub

An Obsidian plugin that publishes the active note to a GitHub repository, rewriting its
frontmatter properties and trimming private content on the way out. The note in your vault
is never modified — every change applies only to the copy that lands in the repository.

## The command

`Publish to GitHub` (command palette) runs a two-step confirmation:

1. **Review window** — the complete frontmatter of the published copy, laid out for editing.
   The settings decide what it starts as; from there you can change any value, rename or
   retype any property, drop one with its trash button, add a new one that lives nowhere in
   the settings, and restore anything the settings stripped. It also flags when content after
   the break marker will be dropped.
2. **Preview window** — shows the exact markdown that will be committed, and where. `Back`
   returns to the review window with your edits intact; `Publish` commits.

Edits in the review window apply to that one publish. Nothing there is written back to the
note or to the settings.

Each property row shows where it came from — *from note*, *from settings*, or *added here* —
along with its type. Values the inputs cannot represent (nested YAML, lists of objects) are
shown read-only as *nested value* and passed through to the published copy untouched.

## Settings

### GitHub connection

| Setting | Meaning |
| --- | --- |
| Repository owner / name | The target repository. |
| Branch | Branch the commit lands on. Must already exist. |
| Personal access token | Fine-grained token with **read & write** access to the repository's *Contents*. |
| Target folder | Folder inside the repository to publish into. Empty means the repository root. |
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
