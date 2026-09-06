# MacImage

MacImage is a macOS image browsing and organization tool built with Electron. It supports folder-based image browsing, tag management, image competitions, duplicate detection, image migration, and a recoverable trash workflow.

[简体中文](readme.zh-CN.md)

## Features

- Image browsing
  - Open a folder and scan image files in the selected directory. Subdirectories are not scanned automatically.
  - Switch between list, thumbnail grid, and large-image waterfall views.
  - Sort by filename, file size, modification time, Elo rating, or random order.
  - Preview images with previous/next navigation, zooming, panning, and Finder location actions.
  - Cache thumbnails locally to reduce repeated thumbnail generation.

- Tags and categories
  - Create, edit, and delete tags, with a color, category, and single-letter shortcut for each tag.
  - Use built-in categories such as Person, Landscape, Object, Event, Emotion, Style, and Other, or create custom categories and icons.
  - Filter images by tag from the sidebar, including a quick filter for untagged images.
  - Add tags from the preview window. Tags and ratings are stored using image content fingerprints, so the metadata can remain associated after an image is moved.
  - Includes a built-in `红心` (“Heart”) tag. Press `F` while previewing an image to toggle it and advance to the next image.

- Image competition and ratings
  - Start a competition using images from the current folder.
  - Configure each group as 2–8 images competing for one winner; winners update the images’ Elo ratings.
  - Sort the gallery by Elo rating to find highly rated images.
  - Use number keys `1`–`8` to select an image in the competition window.

- Large-image waterfall review
  - Review images in a 3-card or 10-card layout.
  - Right-click an image in either layout to mark it as 1 point.
  - Assign each image a score from 1 to 3. Rated images move to the target folder when advancing. In both layouts, unrated images are deferred so the five most recent pages can be restored with Previous or the Up arrow; older pages move to trash, and any remaining deferred cleanup is committed when the app quits.
  - View per-page and cumulative counts and file sizes for collected and deleted images.

- Duplicate image detection
  - Detect byte-identical images in the current folder.
  - Review duplicate groups, reveal files in Finder, or move all but the reference image in each group to the trash folder.

- Small-image cleanup
  - Enter a threshold greater than 0 and up to 300 KB to scan the current folder for images below that size.
  - Reveal or move individual matches to trash, or confirm a batch cleanup; undo the latest batch with `Cmd + Z`.

- File organization and trash
  - Set a trash folder before deleting images. Deletion moves files to the configured folder instead of permanently removing them.
  - Undo the most recent deletion, duplicate cleanup, or waterfall operation with `Cmd + Z`.
  - Move all images in the current folder, or only tagged images, to a selected target folder.
  - Append a number to conflicting filenames instead of overwriting existing files.
  - View trash usage and permanently empty the trash from Settings.

- Quick access and recent files
  - Configure frequently used image folders and open them from the sidebar.
  - Keep up to 12 recently opened image records.

- Server image downloads
  - Fetch 1–1,000 random images from the configured Leon service and download them locally.
  - Configure the download folder and 1–10 concurrent download workers.
  - After successful downloads, the application requests deletion of the corresponding records from the server.

- Configuration management
  - Export tags, categories, and competition ratings to a JSON file.
  - Import configuration from JSON. Importing replaces the corresponding current configuration data.

## Supported image formats

`.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.webp`, `.tiff`, `.tif`, `.heic`, `.heif`

## Getting started

### Requirements

- macOS
- Node.js and npm

### Install dependencies

```bash
npm install
```

### Start the development version

```bash
npm start
```

### Build a macOS package

```bash
# Build with electron-builder
npm run build

# Explicitly build a DMG installer
npm run build:dmg
```

Build artifacts are written to `dist/`. The current packaging configuration targets Apple Silicon (`arm64`).

## Basic workflow

1. Start MacImage and click “Open Folder” to select a directory containing images.
2. On first use, open “Settings → Trash” and choose a folder for images that are removed.
3. Browse images in list, grid, or waterfall view.
4. Create and apply tags from the preview window or sidebar, then filter the gallery by tag.
5. Use Image Competition to build Elo ratings, or use Large-image Waterfall Review to distribute images between a target folder and the trash folder.
6. Export your configuration from “Settings → Data” regularly for backup.

## Keyboard shortcuts

| Context | Shortcut | Action |
| --- | --- | --- |
| Global | `Cmd + O` | Open a folder |
| Image preview | `←` / `↑` | Previous image |
| Image preview | `→` / `↓` | Next image |
| Image preview | `+` / `=` | Zoom in |
| Image preview | `-` | Zoom out |
| Image preview | `0` | Reset zoom |
| Image preview | `F` | Toggle the `红心` (“Heart”) tag and advance |
| Image preview | `D` / `Delete` | Move the image to the trash |
| Global | `Cmd + Z` | Undo the most recent file operation |
| Image competition | `1`–`8` | Choose the corresponding image |
| Waterfall review | `↓` / `Space` | Advance and organize the current page |
| Waterfall review | `↑` | Restore the previous pending-cleanup page |
| Competition / preview | `Esc` | Close the current window |

After assigning a single-letter shortcut to a custom tag, press that letter during image preview to toggle the tag and advance to the next image. `F` and `D` are reserved by built-in actions and cannot be assigned to tags.

## Important notes

- Deletion, duplicate cleanup, and waterfall review can move many files. Check the trash and target folders before confirming an operation.
- Emptying the trash permanently deletes its images and cannot be undone.
- Image migration moves files; it does not copy them. Files are removed from the source folder.
- Back up the current configuration before importing. Import replaces the corresponding tags, categories, or competition ratings.
- The server-image feature requires an accessible Leon service. The current endpoint is defined in `main-ipc-server-images.js` and is not configurable from the UI.
- Successfully downloaded server images are followed by a request to delete the corresponding server records. Make sure server data is backed up if necessary.
- The application only scans direct child files in the selected folder and does not scan subdirectories automatically.

## Data and cache locations

Application data and thumbnail caches are stored under Electron’s `userData` directory, including:

- `macimage.db`: SQLite database containing tags, categories, ratings, image hashes, the trash folder, quick-open folders, and related settings. Path hashes, image tags, and ratings use indexed tables; legacy aggregate JSON data is migrated automatically on first launch.
- `config.json`: the legacy JSON configuration. On the first upgrade it is migrated to `macimage.db`, and a `config.json.pre-sqlite.bak` backup is retained.
- `thumbnails/`: small grid-thumbnail cache generated from image fingerprints. Waterfall and competition views load original files directly and do not persist large previews.
- `server-downloads/`: default download folder for server images when no custom folder is selected.

Image identity uses SHA-256 over the complete file. Legacy fingerprints based on the first 64KB are upgraded as images are read, preserving existing tags and ratings. The first upgrade rereads files to calculate their identities. Metadata previously merged by a legacy fingerprint cannot be attributed retroactively, so it is preserved on the corresponding images; subsequent edits are independent. Legacy rating backups remain importable.

The main process retains pending waterfall pages. Returning to a folder after navigation, undo, or reopening the window restores its available previous pages.

On macOS, this directory is typically:

```text
~/Library/Application Support/MacImage/
```

## Project structure

| File | Purpose |
| --- | --- |
| `main.js` | Electron main process, window, menu, and application lifecycle |
| `preload.js` | Secure IPC API exposed to the renderer process |
| `store.js` | Settings and image metadata persistence, migrations, and transactions |
| `store-schema.js` | SQLite tables, indexes, and connection pragmas |
| `main-ipc-handlers.js` | Folder reading, tags, ratings, thumbnails, trash, and related IPC handlers |
| `main-ipc-file-operations.js` | Image migration and waterfall file operations |
| `main-ipc-server-images.js` | Server image downloads and server record deletion |
| `image-collection.js` | Image collection and shared metadata indexed by content hash |
| `image-query.js` | Tag filtering, field sorting, and stable random ordering without DOM dependencies |
| `renderer-state.js` | Shared renderer state and model creation |
| `renderer.js` | UI startup and event registration grouped by feature |
| `renderer-folders.js` | Directory loading, metadata updates, and recent files |
| `renderer-gallery.js` | List, grid, thumbnails, and filter controls |
| `renderer-waterfall.js` | Waterfall scoring and organization |
| `renderer-modal.js` | Image preview, zoom, navigation, tags, and undo |
| `renderer-keyboard.js` | Keyboard routing and shortcuts for preview, competition, settings, and waterfall |
| `renderer-settings.js` / `renderer-tag-settings.js` | Settings, categories, and tag management |
| `renderer-duplicates.js` | Duplicate detection and cleanup |
| `styles*.css` | UI styles |

Image queries read the current collection metadata on each call. Sorting returns a new array; random ordering stays stable while filtering or refreshing metadata, and resets when opening a folder or selecting random sort again. Load `image-query.js` before `renderer-state.js`, as shown in `index.html`.

Run `npm test` to check the models and regression cases without launching Electron.

Store migrations and normal writes share the same SQL writers. Each operation owns its transaction, so replacements and migrations commit all related changes together. Keyboard routing checks preview, competition, settings, then waterfall in that order; only the selected context handles the event.

## License

This project uses the `ISC` license. See `package.json` for details.
