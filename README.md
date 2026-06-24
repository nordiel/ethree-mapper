# Puerto Rico Municipality Mapper

An interactive browser-based tool for visualizing and planning logistics coverage across Puerto Rico's 78 municipalities.

## Features

- **Region painting** — create named color-coded regions and assign municipalities by clicking
- **Coverage bar** — tracks how many of the 78 municipalities have been assigned
- **Municipality labels** — toggle always-on or hover-only display
- **Pins** — drop labeled pins anywhere on the map
- **Shapes** — draw custom polygon overlays by clicking vertices; double-click to close
- **Items** — upload custom images (logos, icons) and stamp them on the map; one image in the library, unlimited placements
- **Annotation label toggle** — show or hide labels for all annotations at once
- **Eraser tool** — clear region assignments or delete individual annotations
- **Export** — download the map as PNG or JPG; export region assignments as CSV or JSON
- **Persistence** — all data is saved automatically via `window.storage`

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
1. Click **+ Add** to create a region; click its color swatch to change the color
2. Select a region row, then click municipalities on the map to assign them
3. Click an already-assigned municipality again to clear it
4. Use **Eraser** to clear assignments without selecting a region

### Annotations tab
- **Pins** — click *Place Pin*, then click the map
- **Shapes** — click *Draw Shape*, click to place vertices, double-click to close; **Esc** cancels
- **Items** — click *Add Item*, upload an image and give it a label, then click *Place on Map*; click the item row in the list to toggle placement mode (sticky — place as many copies as needed); click the row again or press **Esc** to exit

### Exporting
- **CSV / JSON** — exports region → municipality assignments
- **PNG / JPG** — downloads a snapshot of the current map view

## Browser Support

Works in any modern browser (Chrome, Firefox, Safari, Edge). No dependencies, no bundler.

## Powered by

[ethree solutions](https://www.ethree.solutions/) — Confidential · Internal use only
# ethree-mapper
# ethree-mapper
