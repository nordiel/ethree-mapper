# Puerto Rico Municipality Mapper

An interactive browser-based tool for visualizing and planning logistics coverage across Puerto Rico's 78 municipalities.

## Features

- **Region painting** — create named color-coded regions and assign municipalities by clicking; click the color swatch to open the OS color picker and change a region's color live
- **Region labels** — toggle a single centered label per region on the map via *Show regions*
- **Coverage bar** — tracks how many of the 78 municipalities have been assigned
- **Municipality labels** — toggle always-on or hover-only display
- **Pins** — drop labeled pins anywhere on the map
- **Shapes** — draw custom polygon overlays by clicking vertices; double-click to close
- **Items** — upload custom images (logos, icons) as a reusable library; click an item row to enter sticky placement mode and stamp as many copies as needed; images persist via `localStorage`
- **Drag to reposition** — placed items can be dragged to a new location on the map
- **Annotation label toggle** — show or hide labels for all annotations at once
- **Eraser tool** — clear region assignments or delete individual annotations
- **Export map** — save and restore full map state (regions, annotations, images) as a `.emap` file; a filename prompt appears before every export
- **Export image** — download the current map view as PNG or JPG with a custom filename
- **CSV / JSON** — export region → municipality assignments
- **Auto-save** — all data persists automatically across page refreshes

## Project Structure

```
ethree-mapper/
├── index.html       # App shell and layout
├── app.js           # All application logic and state
├── data.js          # Puerto Rico GeoJSON (78 municipalities)
├── styles.css       # All styles
└── images/
    └── ethree-logos_FullColor.png
```

## Usage

Open `index.html` directly in a browser — no build step or server required.

### Regions tab
1. Click **+ Add** to create a region
2. Click the **color swatch** to open the color picker and choose any color
3. Click the **pencil icon** (appears on hover) to rename a region; press **Enter** to confirm or **Esc** to cancel
4. Select a region row, then click municipalities on the map to assign them
5. Click an already-assigned municipality again to clear it
6. Use **Eraser** to clear assignments without selecting a region
7. Toggle **Show regions** in the header to show one centered label per region on the map

### Annotations tab
- **Pins** — click *Place Pin*, then click the map
- **Shapes** — click *Draw Shape*, click to place vertices, double-click to close; **Esc** cancels
- **Items** — click *Add Item*, upload an image and give it a label, then click *Place on Map*; the image is added to the library and sticky placement begins immediately — click the map to stamp copies; click the item row again or press **Esc** to stop; drag any placed item to reposition it; the eraser removes individual instances without deleting the library entry

### Saving and sharing
- **Export / Import** — use *Export* in the Regions tab to save the full map (including images) as a `.emap` file; use *Import* to restore it on any machine
- **CSV / JSON** — lightweight export of region assignments only (no annotations or images)
- **PNG / JPG** — image snapshot of the current map; respects all visibility toggles

### Keyboard shortcuts
| Key | Action |
|-----|--------|
| **Esc** | Cancel active pin, shape, or item placement |
| **Double-click** | Close a polygon shape |

## Browser Support

Works in any modern browser (Chrome, Firefox, Safari, Edge). No dependencies, no bundler.

---

Powered by [ethree solutions](https://www.ethree.solutions/) — Confidential · Internal use only
