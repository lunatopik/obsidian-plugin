# Writer's State Map

Minimalist Obsidian plugin for writers. **One chapter = one state of the map.**

A custom right-sidebar view renders an interactive world map. Locations and character
tokens live in the plugin's own `data.json`; the chapter you are writing is never read
or modified.

## Isolation

The plugin contributes **nothing** to your chapters. A note is identified only by its
vault-relative path, which is the key under `maps`. There is no `processFrontMatter`,
and `src/store.ts` — the module that holds all map logic — is not allowed to import
`obsidian` at all.

The single deliberate exception is the **chapter note** sidecar (see below), written by
one audited module.

The test suite enforces this boundary instead of trusting it. It scans the sources and
the built `main.js` and fails if:

- any `vault.adapter` read or write appears outside `src/storage.ts` and
  `src/note-writer.ts`;
- `store.ts` imports `obsidian` at all, or the other modules import an adapter;
- `storage.ts` can reach a path that is not `.json` (so **Export** can never write into
  your notes);
- `note-writer.ts` does not funnel every `.md` write through `isManagedPath()`;
- the number of adapter call sites in the bundle differs from the audited count.

Consequence: nothing you write can be clobbered by this plugin.

## Tests

`npm test` runs the whole suite with no Obsidian installed: the pure store and parsing
layer, plus the view layer driven through a small DOM shim (`test/dom-stub.ts`). The
popover, the character editor, the radial map and the note writer are exercised for real
— creating a location, renaming it, ticking a character, deleting it, binding a note,
dragging an avatar around the ring, and regenerating a note.

That layer earns its keep: a detached `this.plugin.t` reference once shipped and
silently killed every popover action, and a character-note binding once saved correctly
to `data.json` while the sidebar still showed *not bound* — because the row that
received the update had been detached. Two guards now prevent repeats: a source scan
that rejects aliasing a method off `this.plugin`/`this.app`/`this.storage` (getters are
allowed), and runtime assertions that drive the real code paths, including tearing the
editor's DOM out from under an open picker. The shim's `isConnected` walks the whole
subtree for the same reason.

The shim itself is held to the browser's contract, because a stub that is more
forgiving than the DOM hides bugs instead of catching them. `dataset` is a camelCase
view over the `data-*` attributes rather than a second store — the drag recogniser
writes `dataset.drag` and reads `getAttribute("data-drag")`, and a two-store stub
answers `null` for a flag that is plainly set, so every drag quietly stops recognising
what it grabbed. `adapter.list` answers direct children only: a naive `startsWith`
match also matches the queried folder itself, since its remainder is empty, and a
recursive walk is then handed its own folder as a child and recurses until the heap
gives out.

## Install for development

```bash
npm install
npm run dev      # watch build
npm run build    # type-check + production build
npm test         # store + view tests, isolation guards
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/writer-state-map/` and enable the plugin.

## Data format

Everything lives in `.obsidian/plugins/writer-state-map/data.json`:

```jsonc
{
  "schemaVersion": 1,
  "language": "ru",
  "defaultView": "map",
  "defaultCanvas": { "width": 1024, height: 768 },
  "exportPath": "Writer Maps/wsm-data.json",
  "pawns": [
    {
      "id": "tom",                // referenced from nodes[].chars
      "name": "Том",
      "initials": "Т",            // 1-3 symbols, auto-generated, always overridable
      "color": "#e05c5c",         // solid background
      "avatar": "avatars/tom.png",  // optional image background
      "notePath": "Персонажи/Том.md"  // optional link, attached by hand
    }
  ],
  "maps": {
    "Роман/Глава 1.md": {
      "map_bg": "maps/world.png",  // vault path, [[wikilink]] or ![[embed]] all work
      "map_size": [1024, 768],     // optional; defaults to the image's natural size
      "nodes": [
        {
          "id": "city_A",
          "label": "Город",        // optional, defaults to id
          "x": 150,                // design-canvas pixels, not screen pixels
          "y": 300,
          "chars": ["tom", "drug"], // character ids (names still resolve as a fallback)
          "charOffsets": {         // optional; a hand-placed nudge per character
            "drug": { "offsetX": 12, "offsetY": -8 }
          }
        }
      ]
    }
  }
}
```

`x` / `y` are in **design-canvas pixels**, not screen pixels. The view scales the whole
canvas to fit the sidebar and counter-scales nodes and tokens, so a character stays readable
no matter how narrow the panel gets. `map_size` is only needed when there is no
background image; otherwise `defaultCanvas` is the last resort.

A `charOffsets` nudge is the exception: it is added to the character's slot in **screen**
pixels and converted afterwards, so a character you placed by hand stays where you put it
however much the sidebar is resized. Offsets pointing at characters the node no longer has
are dropped on load.

Maps are **bound lazily**: an entry appears the first time you add a location, set a
background, or press **Create map** — so opening a random note does not litter the file.

### Editing by hand

The file is yours to edit. Because the plugin also saves automatically, use the
**Reload data.json from disk** command (or the button in settings) after editing, or
your changes will be overwritten by the next automatic save. A hand-edited or truncated
file is normalized on load rather than crashing the plugin.

## Characters

Characters are managed manually in the **Roster** tab, next to the map. The plugin
never scans your vault for characters - file names are enumerated only inside the
pickers, and only after you click them.

Each character optionally carries a **note path**. The tab shows the full path, opens
it on click, and can detach it again; a binding made in a sandbox character is *not*
automatically copied to the same character in your book.

Token rendering is a hybrid: the avatar (or color) is the background, and `initials`
are layered on top, so a token stays legible even when the avatar is an indistinct
thumbnail.

### How `chars` resolves

1. Exact match against a character **id** - this is what the plugin writes.
2. Fallback match against a character **name**, so `chars: ["Том", "Ян"]` keeps working.
3. Otherwise the token is rendered as *unknown* (stable hash color) and the node
   popover offers **Add to character**, which creates it and rewrites the token.

## Chapter notes

Every chapter has a note of its own, opened in a native **Note** tab in the source
editor. It mirrors the chapter's path, so `Роман/Глава 1.md` is written to
`.Writer Maps Data/Роман/Глава 1.md` — the working copy stays out of your sight, and
the note's path is derived from the chapter's, never the other way round.

The note holds a Markdown digest of that map: the characters present in each location,
which of them have left the story, and which known characters are not on the map at all.
The plugin rewrites **only** the block between `%% wsm-summary-start %%` and
`%% wsm-summary-end %%`, so anything you wrote around it survives. If a file has no
markers the block is prepended; if the markers are unbalanced the write is skipped
rather than guessed at.

Regeneration is content-driven, not time-driven: it is debounced (~1.5 s) and only fires
when the *content* of the note would change, so dragging an avatar does not touch the
file. Renaming a location, adding or removing a character, or editing the character list
regenerates the affected chapters. **Update this chapter's note** forces a rewrite.

**A note with unsaved changes is never overwritten.** The plugin's own write is
recognised by its content, so its echo coming back as a vault event cannot be mistaken
for your save, and a change made while the editor is dirty is held until you save
instead of being dropped.

The plugin does not delete or rename these files: a chapter renamed while the plugin is
off keeps its old note, and a forgotten chapter keeps its file. **Export notes to a
visible folder** copies the whole tree into `Writer Maps Export/`, folder structure
intact, for anything outside Obsidian to read.

## Map interactions

| Action | Result |
|---|---|
| Click a node | Opens the popover with a checkbox per character |
| Drag a node | Repositions it; `x` / `y` are written on pointer-up |
| Double-click empty map | Creates a location and focuses the rename field |
| Rename in popover | Writes `label` (falls back to `id` when emptied) |
| Delete location | Removes the node from the stored map |
| Drag an avatar | Nudges that character off its slot around the location |
| Shift + drag anything | Moves the whole ring instead of one character |
| Double-click an avatar | Drops its nudge and snaps it back into the ring |
| Toolbar image button | Sets or changes the background |
| **Update this chapter's note** | Rewrites the current chapter's note now |
| **Export notes to a visible folder** | Copies every note into `Writer Maps Export/` |

A location is drawn as a pin, and its characters as avatars in a ring around it, joined
by thin elastic spokes — a sun on a rubber band. The ring radius grows with the number
of characters so neighbours stay apart. Positions are written only on pointer-up, and a
gesture the browser takes away (a second finger, a system menu) persists nothing.

## Data safety

`data.json` is now the single source of truth for every chapter, so it is defended:

- **Serialized, debounced writes.** Rapid edits are coalesced and each write waits for
  the previous one, so two saves can never race.
- **`data.json.bak`.** The previous file is copied aside before it is overwritten, at
  most once a minute. Restorable from the settings tab.
- **Export / import.** Writes a copy to a path *inside the vault*, so your git or sync
  setup sees it. Import can merge or replace.
- **`schemaVersion`.** The layout is versioned so future changes stay backward-safe.

### Renamed and deleted chapters

Maps are keyed by path, so the plugin follows renames: moving `Глава 1.md` carries its
map along, and renaming a whole folder carries every map inside it. Deleting a file
never deletes its map — it becomes *orphaned* instead, so nothing is lost by accident.
Two commands deal with the rest:

- **Attach an orphaned map to a note** — for a chapter renamed while the plugin was off.
- **Remove orphaned maps** — after a confirm, drops the ones you no longer want.

## Privacy

Drafts stay drafts. The plugin does not read your chapters at all; it opens a character
note only when you click the note button yourself. The files it writes are its own
generated notes in the hidden `.Writer Maps Data/` folder — only between its marker
comments, and never over an editor you have unsaved changes in — plus a copy of them in
`Writer Maps Export/` when you ask for one.
