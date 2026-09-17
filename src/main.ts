import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";

// Frontend also runs in a plain browser (screenshot tooling) — gate
// everything that needs the Tauri runtime.
const IN_TAURI = "__TAURI_INTERNALS__" in window;

const md = new MarkdownIt({
  linkify: true,
  breaks: false,
  highlight: (str, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang }).value;
      } catch {
        // fall through to default escaping
      }
    }
    return "";
  },
}).use(taskLists);

const previewEl = document.querySelector<HTMLElement>("#preview")!;
const previewPane = document.querySelector<HTMLElement>("#preview-pane")!;
const fileNameEl = document.querySelector<HTMLElement>("#file-name")!;
const saveStateEl = document.querySelector<HTMLElement>("#save-state")!;
const docStatsEl = document.querySelector<HTMLElement>("#doc-stats")!;
const cursorPosEl = document.querySelector<HTMLElement>("#cursor-pos")!;

let currentPath: string | null = null;
let renderTimer: ReturnType<typeof setTimeout> | undefined;
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

const AUTO_SAVE_DELAY = 1000;

const WELCOME = `# Horas! 🙌

Welcome to **Sahala** — a tiny markdown editor.

- Open a file with **⌘O** — or just drop one on the window; after that, auto-save has your back
- **⌘P** brings back your recent files — Sahala also reopens your last file on launch
- **⌘\\\\** docks a markdown guide — click any syntax chip to insert it
- Type on the left, watch the right; drag the divider to resize
- Click the filename to rename it; themes follow your macOS appearance

| Feature | Status |
| ------- | ------ |
| Live preview | ✅ |
| Recent files (⌘P) | ✅ |
| Markdown guide (⌘\\\\) | ✅ |
| GFM tables & task lists | ✅ |
`;

// ── Save state (filename pill) ───────────────
type SaveState = "unsaved" | "edited" | "saving" | "saved" | "error";

function nowHM(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function setSaveState(state: SaveState, detail = "") {
  saveStateEl.dataset.state = state;
  saveStateEl.textContent =
    state === "unsaved"
      ? "Not saved — ⌘S"
      : state === "edited"
        ? "Edited"
        : state === "saving"
          ? "Saving…"
          : state === "saved"
            ? `Saved · ${detail || nowHM()}`
            : "Save failed";
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

async function setWindowTitle(name: string) {
  if (!IN_TAURI) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(name);
  } catch {
    // non-fatal
  }
}

// ── Render + document stats ──────────────────
function render(text: string) {
  previewEl.innerHTML = md.render(text);
  const words = text.trim().length ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  const read = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));
  docStatsEl.textContent = `${words.toLocaleString("en-US")} ${words === 1 ? "word" : "words"} · ${chars.toLocaleString("en-US")} chars · ~${read} min read`;
}

// Colors come from CSS variables so the active theme restyles the
// editor's syntax highlighting without reconfiguring CodeMirror.
const markdownHighlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--syn-heading)", fontWeight: "700" },
  { tag: tags.strong, color: "var(--syn-emphasis)", fontWeight: "700" },
  { tag: tags.emphasis, color: "var(--syn-emphasis)", fontStyle: "italic" },
  { tag: tags.strikethrough, color: "var(--ink-2)", textDecoration: "line-through" },
  { tag: tags.link, color: "var(--link)" },
  { tag: tags.url, color: "var(--link)", textDecoration: "underline" },
  { tag: tags.monospace, color: "var(--syn-code)" },
  { tag: tags.quote, color: "var(--ink-2)", fontStyle: "italic" },
  { tag: tags.processingInstruction, color: "var(--syn-mark)" },
  { tag: tags.labelName, color: "var(--ink-2)" },
  { tag: tags.contentSeparator, color: "var(--syn-mark)" },
  // Tokens produced by nested language parsers inside fenced code blocks.
  { tag: tags.keyword, color: "var(--syn-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syn-string)" },
  { tag: tags.comment, color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], color: "var(--syn-literal)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syn-heading)" },
  { tag: [tags.typeName, tags.className], color: "var(--syn-code)" },
  { tag: [tags.operator, tags.punctuation], color: "var(--ink-2)" },
]);

function updateCursorPos(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  cursorPosEl.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

const view = new EditorView({
  state: EditorState.create({
    doc: WELCOME,
    extensions: [
      basicSetup,
      markdown({ codeLanguages: languages }),
      syntaxHighlighting(markdownHighlight),
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) updateCursorPos(update.state);
        if (!update.docChanged) return;
        setSaveState(currentPath ? "edited" : "unsaved");
        clearTimeout(renderTimer);
        renderTimer = setTimeout(() => render(update.state.doc.toString()), 60);
        clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(autoSave, AUTO_SAVE_DELAY);
      }),
    ],
  }),
  parent: document.querySelector("#editor-pane")!,
});

render(WELCOME);
updateCursorPos(view.state);
setSaveState("unsaved");

// ── Scroll sync (two-way, toggleable) ────────
const syncToggleEl = document.querySelector<HTMLButtonElement>("#sync-toggle")!;
let syncScroll = localStorage.getItem("sahala:sync") !== "off";

// Two-way sync without feedback: the pane the user is actually scrolling
// "owns" the link until it goes quiet; scroll events on the other pane in
// that window are echoes and get dropped. A per-event flag released on the
// next frame is not enough — echoes can land later and bounce the panes
// off each other (visible as jitter on slow scrolls).
let syncDriver: "editor" | "preview" | null = null;
let syncDriverTimer: ReturnType<typeof setTimeout> | undefined;

function claimSyncDriver(who: "editor" | "preview"): boolean {
  if (syncDriver && syncDriver !== who) return false;
  syncDriver = who;
  clearTimeout(syncDriverTimer);
  syncDriverTimer = setTimeout(() => (syncDriver = null), 150);
  return true;
}

function updateSyncToggle() {
  syncToggleEl.textContent = `Sync scroll · ${syncScroll ? "on" : "off"}`;
  syncToggleEl.classList.toggle("on", syncScroll);
}

function ratioSync(src: HTMLElement, dst: HTMLElement) {
  const max = src.scrollHeight - src.clientHeight;
  if (max <= 0) return;
  const target = (src.scrollTop / max) * (dst.scrollHeight - dst.clientHeight);
  if (Math.abs(dst.scrollTop - target) < 1) return; // close enough — no micro-nudges
  dst.scrollTop = target;
}

view.scrollDOM.addEventListener("scroll", () => {
  if (!syncScroll || !claimSyncDriver("editor")) return;
  ratioSync(view.scrollDOM, previewPane);
});

previewPane.addEventListener("scroll", () => {
  if (!syncScroll || !claimSyncDriver("preview")) return;
  ratioSync(previewPane, view.scrollDOM);
});

syncToggleEl.addEventListener("click", () => {
  syncScroll = !syncScroll;
  localStorage.setItem("sahala:sync", syncScroll ? "on" : "off");
  updateSyncToggle();
  view.focus();
});

updateSyncToggle();

// ── File handling ────────────────────────────
function loadDocument(text: string, path: string | null) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  // The dispatch above schedules an auto-save against the old path — cancel it.
  clearTimeout(autoSaveTimer);
  currentPath = path;
  if (path) addRecent(path);
  const name = path ? baseName(path) : "untitled.md";
  fileNameEl.textContent = name;
  setWindowTitle(name);
  render(text);
  setSaveState(path ? "saved" : "unsaved");
}

async function autoSave() {
  if (!currentPath) return; // untitled: needs one manual ⌘S to pick a path
  setSaveState("saving");
  try {
    await invoke("write_file", {
      path: currentPath,
      contents: view.state.doc.toString(),
    });
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
    console.error("Auto-save failed:", e);
  }
}

async function openFile() {
  if (!IN_TAURI) return;
  const path = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
  });
  if (typeof path !== "string") return;
  const text = await invoke<string>("read_file", { path });
  loadDocument(text, path);
}

async function saveFile() {
  if (!IN_TAURI) return;
  let path = currentPath;
  if (!path) {
    path = await save({
      defaultPath: fileNameEl.textContent || "untitled.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!path) return;
  }
  setSaveState("saving");
  try {
    await invoke("write_file", { path, contents: view.state.doc.toString() });
    currentPath = path;
    addRecent(path);
    const name = baseName(path);
    fileNameEl.textContent = name;
    setWindowTitle(name);
    setSaveState("saved");
  } catch (e) {
    setSaveState("error");
    console.error("Save failed:", e);
  }
}

document.querySelector("#btn-open")!.addEventListener("click", openFile);

// ── Filename: click-to-rename ────────────────
fileNameEl.addEventListener("click", () => {
  const current = fileNameEl.textContent ?? "untitled.md";
  const input = document.createElement("input");
  input.id = "file-rename";
  input.value = current;
  fileNameEl.replaceWith(input);
  input.focus();
  const dot = current.lastIndexOf(".");
  input.setSelectionRange(0, dot > 0 ? dot : current.length);

  let done = false;
  const finish = async (commit: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim().replace(/[/\\:]/g, "-");
    input.replaceWith(fileNameEl);
    if (!commit || !name || name === current) return;
    if (currentPath && IN_TAURI) {
      const dir = currentPath.slice(0, currentPath.lastIndexOf("/") + 1);
      const newPath = dir + name;
      try {
        await invoke("rename_file", { from: currentPath, to: newPath });
        removeRecent(currentPath);
        addRecent(newPath);
        currentPath = newPath;
        fileNameEl.textContent = name;
        setWindowTitle(name);
      } catch (e) {
        setSaveState("error");
        console.error("Rename failed:", e);
      }
    } else {
      // Untitled: display name becomes the default at first save.
      fileNameEl.textContent = name;
      setWindowTitle(name);
    }
    view.focus();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
});

// ── Recent files + quick switcher (⌘P) ──────
// Persistence is plain localStorage: a JSON array of absolute paths,
// most-recent-first, capped — no database needed at this scale.
const RECENTS_KEY = "sahala:recents";
const RECENTS_MAX = 15;

function getRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function addRecent(path: string) {
  const list = [path, ...getRecents().filter((p) => p !== path)].slice(0, RECENTS_MAX);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
}

function removeRecent(path: string) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(getRecents().filter((p) => p !== path)));
}

// Open a known path directly (palette, drag-drop, Finder, session restore).
async function openPath(path: string): Promise<boolean> {
  try {
    const text = await invoke<string>("read_file", { path });
    loadDocument(text, path);
    return true;
  } catch {
    removeRecent(path); // moved or deleted — self-evict
    return false;
  }
}

const paletteEl = document.querySelector<HTMLElement>("#palette")!;
const paletteInput = document.querySelector<HTMLInputElement>("#palette-input")!;
const paletteList = document.querySelector<HTMLElement>("#palette-list")!;
let paletteSel = 0;
let paletteMatches: string[] = [];

function fuzzyScore(query: string, path: string): number {
  const q = query.toLowerCase();
  if (!q) return 1;
  const base = (path.split("/").pop() ?? "").toLowerCase();
  const full = path.toLowerCase();
  if (base.startsWith(q)) return 4;
  if (base.includes(q)) return 3;
  if (full.includes(q)) return 2;
  let i = 0;
  for (const ch of full) if (ch === q[i]) i++;
  return i >= q.length ? 1 : 0;
}

function renderPalette() {
  const q = paletteInput.value.trim();
  paletteMatches = getRecents()
    .map((p) => [p, fuzzyScore(q, p)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]) // stable: recency preserved within a score
    .map(([p]) => p);
  paletteSel = Math.min(paletteSel, Math.max(0, paletteMatches.length - 1));

  paletteList.innerHTML = "";
  if (paletteMatches.length === 0) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = getRecents().length
      ? "No matches"
      : "No recent files yet — open one with ⌘O";
    paletteList.appendChild(empty);
    return;
  }
  paletteMatches.forEach((p, i) => {
    const row = document.createElement("button");
    row.className = `palette-row${i === paletteSel ? " selected" : ""}`;
    const name = document.createElement("span");
    name.className = "p-name";
    name.textContent = p.split("/").pop() ?? p;
    const dir = document.createElement("span");
    dir.className = "p-dir";
    dir.textContent = p.slice(0, p.lastIndexOf("/")).replace(/^\/Users\/[^/]+/, "~");
    row.append(name, dir);
    row.addEventListener("click", () => pickPalette(i));
    paletteList.appendChild(row);
  });
}

async function pickPalette(i: number) {
  const path = paletteMatches[i];
  if (!path) return;
  if (await openPath(path)) closePalette();
  else renderPalette(); // stale row evicted — keep the palette open
}

function openPalette() {
  paletteSel = 0;
  paletteInput.value = "";
  renderPalette();
  paletteEl.hidden = false;
  paletteInput.focus();
}

function closePalette() {
  paletteEl.hidden = true;
  view.focus();
}

const isPaletteOpen = () => !paletteEl.hidden;

paletteInput.addEventListener("input", () => {
  paletteSel = 0;
  renderPalette();
});
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteSel = Math.min(paletteSel + 1, paletteMatches.length - 1);
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteSel = Math.max(paletteSel - 1, 0);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    pickPalette(paletteSel);
  }
  // Escape bubbles up to the window handler.
});
paletteEl.addEventListener("mousedown", (e) => {
  if (e.target === paletteEl) closePalette();
});

// ── Themes ───────────────────────────────────
type ThemeMode = "dark" | "light";
type ThemeDef = { value: string; label: string; mode: ThemeMode; dots: [string, string, string] };

const THEMES: ThemeDef[] = [
  { value: "toba", label: "Toba", mode: "dark", dots: ["#14161a", "#d4a24e", "#d6dae2"] },
  { value: "ulos", label: "Ulos", mode: "dark", dots: ["#171114", "#e05555", "#e6dbde"] },
  { value: "harangan", label: "Harangan", mode: "dark", dots: ["#111614", "#66c288", "#d5ded7"] },
  { value: "siang", label: "Siang", mode: "light", dots: ["#ffffff", "#0969da", "#1f2328"] },
  { value: "pustaha", label: "Pustaha", mode: "light", dots: ["#f6efe2", "#a0562b", "#43382a"] },
];

const themeBtn = document.querySelector<HTMLButtonElement>("#btn-theme")!;
const themeNameEl = document.querySelector<HTMLElement>("#theme-name")!;
const themeSwatchesEl = document.querySelector<HTMLElement>("#theme-swatches")!;
const themeMenuEl = document.querySelector<HTMLElement>("#theme-menu")!;
const osDark = window.matchMedia("(prefers-color-scheme: dark)");

function themeDef(value: string): ThemeDef {
  return THEMES.find((t) => t.value === value) ?? THEMES[0];
}

let followOS = localStorage.getItem("sahala:follow-os") !== "off";

function preferredFor(mode: ThemeMode): string {
  return localStorage.getItem(`sahala:theme-${mode}`) ?? (mode === "dark" ? "toba" : "siang");
}

// Migrate a pre-existing single saved theme into the preferred pair.
{
  const legacy = localStorage.getItem("sahala:theme");
  if (legacy && THEMES.some((t) => t.value === legacy)) {
    const mode = themeDef(legacy).mode;
    if (!localStorage.getItem(`sahala:theme-${mode}`)) {
      localStorage.setItem(`sahala:theme-${mode}`, legacy);
    }
  }
}

function swatchDots(el: HTMLElement, def: ThemeDef) {
  el.innerHTML = "";
  for (const c of def.dots) {
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = c;
    el.appendChild(dot);
  }
}

function applyTheme(value: string, persist = true) {
  const def = themeDef(value);
  document.documentElement.dataset.theme = def.value;
  themeNameEl.textContent = def.label;
  swatchDots(themeSwatchesEl, def);
  if (persist) localStorage.setItem("sahala:theme", def.value);
  if (!themeMenuEl.hidden) buildThemeMenu();
}

function pickTheme(value: string) {
  const def = themeDef(value);
  localStorage.setItem(`sahala:theme-${def.mode}`, def.value);
  applyTheme(def.value);
}

function buildThemeMenu() {
  themeMenuEl.innerHTML = "";
  const active = document.documentElement.dataset.theme;
  for (const t of THEMES) {
    const item = document.createElement("button");
    item.className = "theme-item";
    const sw = document.createElement("span");
    sw.className = "swatches";
    swatchDots(sw, t);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = t.label;
    const tag = document.createElement("span");
    tag.className = "mode-tag";
    tag.textContent = t.mode;
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = t.value === active ? "✓" : "";
    item.append(sw, name, tag, check);
    item.addEventListener("click", () => {
      pickTheme(t.value);
      closeThemeMenu();
      view.focus();
    });
    themeMenuEl.appendChild(item);
  }

  const sep1 = document.createElement("div");
  sep1.className = "menu-separator";
  themeMenuEl.appendChild(sep1);

  const follow = document.createElement("button");
  follow.className = `menu-item${followOS ? " checked" : ""}`;
  follow.innerHTML = `<span class="box">${followOS ? "✓" : ""}</span><span>Follow system appearance</span>`;
  follow.addEventListener("click", () => {
    followOS = !followOS;
    localStorage.setItem("sahala:follow-os", followOS ? "on" : "off");
    if (followOS) applyTheme(preferredFor(osDark.matches ? "dark" : "light"));
    buildThemeMenu();
  });
  themeMenuEl.appendChild(follow);

  const sep2 = document.createElement("div");
  sep2.className = "menu-separator";
  themeMenuEl.appendChild(sep2);

  const iconItem = document.createElement("button");
  iconItem.className = "menu-item";
  iconItem.innerHTML = `<span class="box">ᯘ</span><span>App icon…</span>`;
  iconItem.addEventListener("click", () => {
    closeThemeMenu();
    openIconModal();
  });
  themeMenuEl.appendChild(iconItem);
}

function openThemeMenu() {
  buildThemeMenu();
  const rect = themeBtn.getBoundingClientRect();
  themeMenuEl.style.top = `${rect.bottom + 6}px`;
  themeMenuEl.style.right = `${window.innerWidth - rect.right}px`;
  themeMenuEl.hidden = false;
}

function closeThemeMenu() {
  themeMenuEl.hidden = true;
}

themeBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (themeMenuEl.hidden) openThemeMenu();
  else closeThemeMenu();
});

document.addEventListener("mousedown", (e) => {
  if (!themeMenuEl.hidden && !themeMenuEl.contains(e.target as Node) && e.target !== themeBtn) {
    closeThemeMenu();
  }
});

osDark.addEventListener("change", () => {
  if (followOS) applyTheme(preferredFor(osDark.matches ? "dark" : "light"));
});

// Initial theme: follow OS (preferred per mode) unless disabled.
if (followOS) {
  applyTheme(preferredFor(osDark.matches ? "dark" : "light"), false);
} else {
  applyTheme(localStorage.getItem("sahala:theme") ?? "toba", false);
}

// ── Markdown guide panel (docked) ────────────
// Each row pairs raw syntax with its live-rendered result (same md
// instance as the preview, so examples always match what Sahala does).
type InsertSpec =
  | { kind: "wrap"; before: string; after: string; placeholder: string }
  | { kind: "prefix"; text: string }
  | { kind: "block"; text: string };

type GuideRow = { code: string; note?: string; render?: boolean; ins?: InsertSpec };

const GUIDE: { title: string; rows: GuideRow[] }[] = [
  {
    title: "Headings",
    rows: [
      { code: "# Heading 1", ins: { kind: "prefix", text: "# " } },
      { code: "## Heading 2", ins: { kind: "prefix", text: "## " } },
      {
        code: "### Heading 3",
        note: "Up to ###### for smaller levels.",
        ins: { kind: "prefix", text: "### " },
      },
    ],
  },
  {
    title: "Emphasis",
    rows: [
      { code: "**bold**", ins: { kind: "wrap", before: "**", after: "**", placeholder: "bold" } },
      { code: "*italic*", ins: { kind: "wrap", before: "*", after: "*", placeholder: "italic" } },
      {
        code: "~~strikethrough~~",
        ins: { kind: "wrap", before: "~~", after: "~~", placeholder: "strikethrough" },
      },
      { code: "`inline code`", ins: { kind: "wrap", before: "`", after: "`", placeholder: "code" } },
    ],
  },
  {
    title: "Lists",
    rows: [
      { code: "- first\n- second", ins: { kind: "block", text: "- first\n- second" } },
      { code: "1. first\n2. second", ins: { kind: "block", text: "1. first\n2. second" } },
      {
        code: "- parent\n  - nested",
        note: "Indent 2 spaces to nest.",
        ins: { kind: "block", text: "- parent\n  - nested" },
      },
      { code: "- [ ] to do\n- [x] done", ins: { kind: "block", text: "- [ ] to do\n- [x] done" } },
    ],
  },
  {
    title: "Links & images",
    rows: [
      {
        code: "[link text](https://url.com)",
        ins: { kind: "wrap", before: "[", after: "](https://)", placeholder: "link text" },
      },
      { code: "https://bare-url.com", note: "Bare URLs auto-link." },
      {
        code: "![alt text](image.png)",
        render: false,
        note: "Embeds the image; alt text shows if it can't load.",
        ins: { kind: "block", text: "![alt text](image.png)" },
      },
    ],
  },
  {
    title: "Blocks",
    rows: [
      { code: "> a wise quote", ins: { kind: "prefix", text: "> " } },
      {
        code: "```ts\nconst x = 1;\n```",
        note: "Language tag enables highlighting.",
        ins: { kind: "block", text: "```ts\ncode\n```" },
      },
      {
        code: "| Col | Col |\n| --- | --- |\n| a | b |",
        ins: { kind: "block", text: "| Col | Col |\n| --- | --- |\n| a | b |" },
      },
      { code: "---", note: "Horizontal divider.", ins: { kind: "block", text: "---" } },
    ],
  },
  {
    title: "Tips",
    rows: [
      {
        code: "first line␣␣\nsecond line",
        render: false,
        note: "End a line with two spaces (shown as ␣␣) to force a line break; a blank line starts a new paragraph.",
      },
      { code: "\\*not italic\\*", note: "Backslash escapes literal characters." },
    ],
  },
];

function applyInsert(ins: InsertSpec) {
  const { from, to } = view.state.selection.main;
  if (ins.kind === "wrap") {
    if (from === to) {
      const insert = ins.before + ins.placeholder + ins.after;
      view.dispatch({
        changes: { from, insert },
        selection: { anchor: from + ins.before.length, head: from + ins.before.length + ins.placeholder.length },
      });
    } else {
      const sel = view.state.sliceDoc(from, to);
      view.dispatch({
        changes: { from, to, insert: ins.before + sel + ins.after },
        selection: { anchor: from + ins.before.length, head: from + ins.before.length + sel.length },
      });
    }
  } else if (ins.kind === "prefix") {
    const line = view.state.doc.lineAt(from);
    view.dispatch({
      changes: { from: line.from, insert: ins.text },
      selection: { anchor: from + ins.text.length },
    });
  } else {
    const line = view.state.doc.lineAt(from);
    const onEmptyLine = line.length === 0;
    const at = onEmptyLine ? line.from : line.to;
    const insert = (onEmptyLine ? "" : "\n\n") + ins.text + "\n";
    view.dispatch({
      changes: { from: at, insert },
      selection: { anchor: at + insert.length },
    });
  }
  view.focus();
}

const guidePanel = document.querySelector<HTMLElement>("#cheatsheet")!;
const guideBody = document.querySelector<HTMLElement>("#cheatsheet-body")!;
const guideBtn = document.querySelector<HTMLButtonElement>("#btn-guide")!;

for (const section of GUIDE) {
  const titleEl = document.createElement("div");
  titleEl.className = "cs-section-title";
  titleEl.textContent = section.title;
  guideBody.appendChild(titleEl);

  for (const row of section.rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "cs-row";

    const codeEl = document.createElement("pre");
    codeEl.className = "cs-code";
    codeEl.textContent = row.code;
    if (row.ins) {
      codeEl.dataset.insert = "true";
      codeEl.title = "Click to insert at cursor";
      codeEl.addEventListener("click", () => applyInsert(row.ins!));
    }
    rowEl.appendChild(codeEl);

    const demoEl = document.createElement("div");
    demoEl.className = "cs-demo markdown-body";
    if (row.render !== false) demoEl.innerHTML = md.render(row.code);
    if (row.note) {
      const noteEl = document.createElement("div");
      noteEl.className = "cs-note";
      noteEl.textContent = row.note;
      demoEl.appendChild(noteEl);
    }
    rowEl.appendChild(demoEl);

    guideBody.appendChild(rowEl);
  }
}

const isGuideOpen = () => guidePanel.classList.contains("open");

function setGuideOpen(open: boolean) {
  guidePanel.classList.toggle("open", open);
  guideBtn.classList.toggle("active", open);
  view.focus(); // reference panel, not a form — keep the caret in the editor
}

guideBtn.addEventListener("click", () => setGuideOpen(!isGuideOpen()));
document.querySelector("#btn-guide-close")!.addEventListener("click", () => setGuideOpen(false));

// ── App icon picker ──────────────────────────
const ICONS = [
  { id: "seal", label: "Seal", isDefault: true },
  { id: "band", label: "Band" },
  { id: "fringe", label: "Fringe" },
  { id: "word", label: "Word" },
];

const iconModal = document.querySelector<HTMLElement>("#icon-modal")!;
const iconGrid = document.querySelector<HTMLElement>("#icon-grid")!;

function currentIcon(): string {
  return localStorage.getItem("sahala:app-icon") ?? "seal";
}

async function selectIcon(id: string) {
  localStorage.setItem("sahala:app-icon", id);
  buildIconGrid();
  if (IN_TAURI) {
    try {
      await invoke("set_app_icon", { name: id });
    } catch (e) {
      console.error("Failed to set app icon:", e);
    }
  }
}

function buildIconGrid() {
  iconGrid.innerHTML = "";
  const selected = currentIcon();
  for (const icon of ICONS) {
    const tile = document.createElement("button");
    tile.className = `icon-tile${icon.id === selected ? " selected" : ""}`;
    const img = document.createElement("img");
    img.src = `/app-icons/${icon.id}.png`;
    img.alt = icon.label;
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = icon.label;
    tile.append(img, label);
    if (icon.isDefault) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "DEFAULT";
      tile.appendChild(tag);
    }
    tile.addEventListener("click", () => selectIcon(icon.id));
    iconGrid.appendChild(tile);
  }
}

function openIconModal() {
  buildIconGrid();
  iconModal.hidden = false;
}

function closeIconModal() {
  iconModal.hidden = true;
  view.focus();
}

document.querySelector("#icon-modal-close")!.addEventListener("click", closeIconModal);
iconModal.addEventListener("mousedown", (e) => {
  if (e.target === iconModal) closeIconModal();
});

// Re-apply a persisted non-default icon on startup.
if (IN_TAURI && currentIcon() !== "seal") {
  invoke("set_app_icon", { name: currentIcon() }).catch(() => {});
}

// ── URL params (tooling/deep-links) ──────────
// ?theme=<name>&guide=1 — set UI state on load without persisting it.
{
  const urlParams = new URLSearchParams(location.search);
  const paramTheme = urlParams.get("theme");
  if (paramTheme && THEMES.some((t) => t.value === paramTheme)) {
    applyTheme(paramTheme, false);
  }
  if (urlParams.get("guide") === "1") setGuideOpen(true);
  if (urlParams.get("menu") === "1") openThemeMenu();
  if (urlParams.get("icons") === "1") openIconModal();
  const seed = urlParams.get("seed-recents");
  if (seed) localStorage.setItem(RECENTS_KEY, JSON.stringify(seed.split(",")));
  if (urlParams.get("palette") === "1") openPalette();
}

// ── File intake: open-with, drag & drop, session restore ──
async function initFileIntake() {
  if (!IN_TAURI) return;
  try {
    // Files opened via Finder while the app is already running.
    const { listen } = await import("@tauri-apps/api/event");
    await listen<string[]>("open-file", (e) => {
      const p = e.payload?.[0];
      if (p) openPath(p);
    });

    // Native drag & drop onto the window (gives real filesystem paths).
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      const p =
        e.payload.paths.find((x) => /\.(md|markdown|txt)$/i.test(x)) ?? e.payload.paths[0];
      if (p) openPath(p);
    });

    // Cold start via file association: the Opened event fires before the
    // frontend exists, so Rust buffers the paths for us to collect.
    const pending = await invoke<string[]>("take_pending_open");
    if (pending.length > 0 && (await openPath(pending[0]))) return;

    // Nothing handed to us — restore the last edited file.
    const [last] = getRecents();
    if (last) await openPath(last);
  } catch (e) {
    console.error("File intake init failed:", e);
  }
}
initFileIntake();

// ── Resizable split ──────────────────────────
const splitEl = document.querySelector<HTMLElement>("#split")!;
const dividerEl = document.querySelector<HTMLElement>("#divider")!;

const savedSplit = localStorage.getItem("sahala:split");
if (savedSplit) splitEl.style.setProperty("--split", savedSplit);

dividerEl.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  dividerEl.setPointerCapture(e.pointerId);
  document.body.classList.add("dragging");

  const onMove = (ev: PointerEvent) => {
    const rect = splitEl.getBoundingClientRect();
    const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100));
    splitEl.style.setProperty("--split", `${pct.toFixed(1)}%`);
  };
  const onUp = (ev: PointerEvent) => {
    dividerEl.releasePointerCapture(ev.pointerId);
    dividerEl.removeEventListener("pointermove", onMove);
    dividerEl.removeEventListener("pointerup", onUp);
    document.body.classList.remove("dragging");
    localStorage.setItem("sahala:split", splitEl.style.getPropertyValue("--split"));
  };
  dividerEl.addEventListener("pointermove", onMove);
  dividerEl.addEventListener("pointerup", onUp);
});

dividerEl.addEventListener("dblclick", () => {
  splitEl.style.setProperty("--split", "50%");
  localStorage.setItem("sahala:split", "50%");
});

// ── Keyboard shortcuts ───────────────────────
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (isPaletteOpen()) return closePalette();
    if (!iconModal.hidden) return closeIconModal();
    if (!themeMenuEl.hidden) return closeThemeMenu();
    if (isGuideOpen()) return setGuideOpen(false);
    return;
  }
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === "o") {
    e.preventDefault();
    openFile();
  } else if (e.key === "s") {
    e.preventDefault();
    saveFile();
  } else if (e.key === "p") {
    e.preventDefault();
    if (isPaletteOpen()) closePalette();
    else openPalette();
  } else if (e.key === "\\") {
    e.preventDefault();
    setGuideOpen(!isGuideOpen());
  }
});

view.focus();
