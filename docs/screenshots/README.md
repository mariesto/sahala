# Recapturing screenshots

The images here are embedded in the main README — recapture them after any
visual change or they drift.

Start the dev server (`make dev`, or just `npm run dev`), then capture with
headless Chrome. URL params set UI state without persisting it:

```
http://localhost:1420/?theme=<toba|ulos|harangan|siang|pustaha>&guide=1&menu=1&icons=1&palette=1
```

`seed-recents=<comma-separated paths>` pre-fills the recents store so the
`palette=1` shot shows rows instead of the empty state.

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,900 --force-device-scale-factor=2 \
  --screenshot=hero-toba.png "http://localhost:1420/?theme=toba"
```

Current set: `hero-toba` (plain toba) · `guide-siang` (siang + guide=1) ·
`themes` (montage of ulos/harangan/pustaha) · `menu-and-picker` (crops of
menu=1 and icons=1 shots) · `quick-switcher` (crop of seed-recents +
palette=1) · `icons` (montage of `src-tauri/icons/alt/*.png`).
Montages/crops via ImageMagick (`magick montage`, `magick -crop`).
