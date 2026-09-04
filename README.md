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
- **Images are pasted into the vault, not the site.** Obsidian writes an embed as
  `![[attachments/Pasted image 20260822005058.png|450]]`, which Eleventy cannot render and
  which points at a file the site repository has never seen. The plugin uploads the image and
  rewrites the embed to match.
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
   stripped. It also lists the images it will upload, and spells out what the break marker
   will cut.
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

## Images

Obsidian embeds a pasted image as a wikilink with an optional size —
`![[attachments/Pasted image 20260822005058.png|450]]` — which is neither markdown a static
site generator will render nor a path that exists in the site repository. With attachment
uploading on, publishing a post also:

1. finds every embed in the part of the note being published (images below the break are
   ignored, since they are not going anywhere),
2. resolves each one against the vault exactly the way Obsidian resolves the link, so both
   full vault paths and Obsidian's shortest-path names work,
3. uploads it into the repository's attachment folder under a URL-safe name, and
4. rewrites the embed to point at the uploaded copy.

The review window lists every image with its size, the filename it will be uploaded under,
and an alt text field — a wikilink embed carries no alt text, so this is the place to add it.
Both are editable, and the resulting URL is shown beneath. An embed whose file cannot be found
in the vault is flagged and left in the note exactly as written rather than being rewritten to
a broken link.

Images are uploaded **before** the post, so a post never lands referring to an image that
failed to upload. An image already in the repository byte for byte is skipped rather than
committed again — the plugin compares the git blob hash of the local file against the one
GitHub reports. Each upload is its own commit, so publishing a post with two new images makes
three commits.

**Sizes.** `![[image.png|450]]` has no markdown equivalent. By default the size is kept by
publishing an `<img src="…" alt="…" width="450">` tag, which any markdown renderer passes
through; set *Image sizes* to `Drop` for plain `![alt](url)` markdown instead. Embeds with no
size are always plain markdown.

**What is left alone.** Links to the web, paths already rooted at the site (`/posts/…`), note
transclusions and non-media embeds like `![[Some Note#Heading]]` or `.base` files, and
anything inside a fenced or inline code block.

## Suggestions

Fields that name something which already exists offer it rather than asking you to remember it.

- **Property names** — in both settings lists and in the review window — are suggested from the
  properties the vault actually uses, most widely used first. The review window leaves out
  names the note is already writing, and the removal list leaves out ones already listed.
- **Property values** are suggested from the values that property already takes across the
  vault, so a `layout` field offers the layouts that exist and a `status` field the statuses in
  use. List properties get their known values as clickable chips under the box instead, since a
  dropdown would fight with typing several values.
- **Repository folders** for the target and attachment folders are read from the branch itself.
  Focus an empty field to browse every folder in the repository; type to narrow it.

Everything stays a plain text field — a suggestion is a shortcut, never a restriction, so a
folder or property that does not exist yet can still be typed in. Matches on a prefix are
listed before matches anywhere in the name, and arrow keys plus Enter pick one.

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
| Personal access token | A fine-grained token limited to the one repository, with **Contents: read and write**. See below. |
| Target folder | Folder inside the repository to publish into — the site's posts folder. Focus the field to browse the folders that exist on the branch. Empty means the repository root. |
| Mirror vault folder structure | Append the note's folder path inside the vault to the target folder. |
| Commit message | Supports `{{filename}}`, `{{path}}` and `{{date}}`. |

`Test` checks that the token can reach both the repository and the branch.

### About the token

Create a **fine-grained** personal access token, not a classic one. Under *Repository access*
pick **Only select repositories** and choose the site's repository alone; under *Permissions*
grant **Contents: Read and write** — GitHub adds *Metadata: Read* automatically, and nothing
else is required. That is the whole surface: a token that can read and write files in one
repository and do nothing else, to any account, ever. Set an expiry date; the plugin says
plainly when a token has expired.

A classic token with the `repo` scope also works and is the wrong choice — it grants full
control of every repository you can reach, including private ones the plugin has no business
touching.

**Where the token lives.** Obsidian gives plugins one place to persist settings, so the token
is stored in plain text in `data.json` inside the plugin's folder in your vault. That is the
same as every other Obsidian plugin that talks to a service, and it has a consequence worth
being deliberate about: anything that copies your vault copies the token. That includes backups,
file-sync services, and Obsidian Sync when it is set to sync plugin settings. If any of those
apply, scope the token to the one repository and give it an expiry, so a copy that escapes is
worth as little as possible.

**What the plugin does with it.** The token is sent as an `Authorization` header to
`https://api.github.com`, which is a hardcoded constant — no setting can redirect it elsewhere.
It is never written into a note, a commit, or the published output, never logged, and stripped
out of any error message before that message is shown. The plugin makes no other network
requests of any kind.

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

One row per property. Any of these present in the note are stripped from the published copy,
and listed under *Removed by settings* in the review window with a button to restore one for
that publish. The name field suggests properties the vault actually uses, leaving out the ones
already on the list.

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

### Attachments

| Setting | Meaning |
| --- | --- |
| Upload embedded images | Whether to handle embeds at all. Off leaves every embed untouched. |
| Attachment folder | Folder inside the repository that images are committed to. Browses existing folders the same way. |
| Attachment URL prefix | What the rewritten embeds point at — usually the attachment folder with a leading slash, since the site serves it from the root. |
| Image sizes | Keep an Obsidian size as an `<img width>` tag, or drop it for plain markdown. |

## Building

```bash
npm install
npm run build   # type-check, then bundle to main.js
npm run dev     # rebuild on change
```

## Installing into a vault

Through [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `Tigertenzin/obsidian-publish-to-github`
as a beta plugin and it installs the latest release and keeps it updated.

By hand, take `main.js`, `manifest.json` and `styles.css` from a release into
`<vault>/.obsidian/plugins/publish-to-github/`, then enable the plugin in
*Settings → Community plugins*. During development, symlinking the repository into that path and
running `npm run dev` is quicker — note that `main.js` is a build artifact and is not committed,
so the repository alone is not installable.

## Releasing

```bash
npm version patch      # or minor / major
git push --follow-tags
```

`npm version` writes the new version into `package.json`, `manifest.json` and `versions.json`
together and tags the commit. Pushing the tag runs `.github/workflows/release.yml`, which builds
the plugin and publishes a GitHub release with `main.js`, `manifest.json` and `styles.css`
attached — the three files BRAT and Obsidian download.

Tags carry no `v` prefix, because Obsidian compares the tag against `manifest.json` exactly;
`.npmrc` sets that, and the workflow refuses to release a tag that does not match rather than
publishing something BRAT will silently decline to install.
