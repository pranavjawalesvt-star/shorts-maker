const $ = (id) => document.getElementById(id);

// Add your font files to the /fonts folder. Names must match exactly.
const FONTS = {
  "Roboto Bold": "Roboto-Bold.ttf",
  "Oswald Bold": "Oswald-Bold.ttf",
};

const RATIOS = {
  "9:16": { w: 720, h: 1280, wrap: 18 },
  "1:1":  { w: 720, h: 720,  wrap: 24 },
  "16:9": { w: 1280, h: 720, wrap: 36 },
};

// Caption vertical position as an ffmpeg expression
const POS_Y = {
  top: "h*0.12",
  middle: "(h-text_h)/2",
  bottom: "h*0.78",
};

const state = {
  file: null,
  segments: [],     // full transcript: {start, end, text}
  chunks: [],       // candidate clips: {index, start, end, text, score, hook, reason}
  selected: [],     // chosen clips, in order
  inputLoaded: false,
};

let ffmpeg = null;
let previewEnd = null;
const loadedFonts = new Set();

const els = {
  file: $("fileInput"),
  video: $("preview"),
  overlay: $("captionPreview"),
  transcribe: $("btnTranscribe"),
  status: $("status"),
  stepClips: $("step-clips"),
  stepStyle: $("step-style"),
  clipList: $("clipList"),
  selectedList: $("selectedList"),
  rank: $("btnRank"),
  story: $("btnStory"),
  exportBtn: $("btnExport"),
  results: $("results"),
  font: $("font"),
};

// ---------- Helpers ----------
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const hexFF = (hex) => "0x" + hex.slice(1);

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function setStatus(msg) { els.status.textContent = msg; }

function btn(label, onClick, cls = "small") {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = cls;
  b.onclick = onClick;
  return b;
}

function wrapText(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

function getSettings() {
  return {
    font: els.font.value,
    size: Number($("fontSize").value),
    textColor: $("textColor").value,
    boxColor: $("boxColor").value,
    boxOpacity: Number($("boxOpacity").value),
    position: $("position").value,
    ratio: $("ratio").value,
  };
}

// ---------- FFmpeg (in-browser) ----------
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  const { FFmpeg } = window.FFmpegWASM;
  const { toBlobURL } = window.FFmpegUtil;
  ffmpeg = new FFmpeg();
  const base = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
  });
  return ffmpeg;
}

async function ensureInput() {
  const ff = await getFFmpeg();
  if (!state.inputLoaded) {
    await ff.writeFile("input.mp4", await FFmpegUtil.fetchFile(state.file));
    state.inputLoaded = true;
  }
  return ff;
}

async function extractAudio() {
  const ff = await ensureInput();
  const code = await ff.exec([
    "-i", "input.mp4",
    "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k",
    "audio.mp3",
  ]);
  if (code !== 0) throw new Error("Could not read audio from this video. Try an H.264 MP4.");
  const data = await ff.readFile("audio.mp3");
  await ff.deleteFile("audio.mp3");
  return new Blob([data], { type: "audio/mpeg" });
}

// ---------- Backend calls ----------
async function callFunction(name, body) {
  const res = await fetch(`/.netlify/functions/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `${name} failed`);
  return data;
}

async function transcribe(audioBlob) {
  const res = await fetch("/.netlify/functions/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/mpeg" },
    body: audioBlob,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Transcription failed");
  return data.segments;
}

// ---------- Clip building ----------
function buildChunks(segments) {
  const chunks = [];
  let cur = null;
  for (const s of segments) {
    if (!cur) cur = { start: s.start, end: s.end, text: s.text };
    else { cur.end = s.end; cur.text += " " + s.text; }
    if (cur.end - cur.start >= 30) { chunks.push(cur); cur = null; }
  }
  if (cur && cur.end - cur.start >= 10) chunks.push(cur);
  return chunks;
}

async function scoreChunks(chunks) {
  const pool = chunks.slice(0, 30); // keep token use low on free tier
  const payload = pool.map((c, i) => ({
    index: i, start: c.start, end: c.end, text: c.text.slice(0, 600),
  }));
  const { clips } = await callFunction("score", { action: "score", chunks: payload });
  const byIndex = new Map(clips.map((c) => [Number(c.index), c]));
  return pool.map((c, i) => {
    const r = byIndex.get(i) || {};
    return {
      ...c,
      index: i,
      score: Number(r.score) || 0,
      hook: r.hook || "",
      reason: r.reason || "",
    };
  });
}

// ---------- Rendering: clips ----------
function renderClipList() {
  els.clipList.innerHTML = "";
  [...state.chunks].sort((a, b) => b.score - a.score).forEach((c) => {
    const card = document.createElement("div");
    card.className = "clip";

    const head = document.createElement("div");
    head.className = "clip-head";
    const score = document.createElement("span");
    score.className = "score";
    score.textContent = `${c.score}/10`;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = `${fmt(c.start)} – ${fmt(c.end)}`;
    head.append(score, time);

    const hook = document.createElement("p");
    hook.className = "hook";
    hook.textContent = c.hook || c.text.slice(0, 80);

    const reason = document.createElement("p");
    reason.className = "reason";
    reason.textContent = c.reason;

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      btn("Preview", () => previewClip(c)),
      btn("Add", () => addClip(c))
    );

    card.append(head, hook, reason, row);
    els.clipList.append(card);
  });
}

function previewClip(c) {
  previewEnd = c.end;
  els.video.currentTime = c.start;
  els.video.play();
}

function addClip(c) {
  if (state.selected.some((x) => x.index === c.index)) return;
  state.selected.push({ ...c });
  renderSelected();
}

function renderSelected() {
  els.selectedList.innerHTML = "";
  if (!state.selected.length) {
    els.selectedList.innerHTML = '<p class="hint">No clips selected yet.</p>';
    return;
  }
  state.selected.forEach((c, i) => {
    const card = document.createElement("div");
    card.className = "clip";

    const label = document.createElement("p");
    label.className = "hook";
    const role = c.role ? ` [${c.role}]` : "";
    label.textContent = `${i + 1}. ${c.hook || c.text.slice(0, 60)}${role}`;

    const why = document.createElement("p");
    why.className = "reason";
    why.textContent = c.orderReason || `${fmt(c.start)} – ${fmt(c.end)} · score ${c.score}`;

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      btn("↑", () => move(i, -1)),
      btn("↓", () => move(i, 1)),
      btn("Remove", () => removeClip(i))
    );

    card.append(label, why, row);
    els.selectedList.append(card);
  });
}

function move(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.selected.length) return;
  [state.selected[i], state.selected[j]] = [state.selected[j], state.selected[i]];
  renderSelected();
}

function removeClip(i) {
  state.selected.splice(i, 1);
  renderSelected();
}

// ---------- Rendering: caption preview & style ----------
async function applyPreviewFont() {
  const file = FONTS[els.font.value];
  const family = "F_" + file.replace(/\W/g, "_");
  if (!loadedFonts.has(file)) {
    const face = new FontFace(family, `url(fonts/${file})`);
    await face.load();
    document.fonts.add(face);
    loadedFonts.add(file);
  }
  els.overlay.style.fontFamily = `${family}, sans-serif`;
}

async function refreshOverlay() {
  const s = getSettings();
  $("fontSizeVal").textContent = s.size;
  $("boxOpacityVal").textContent = s.boxOpacity;
  els.overlay.style.fontSize = `${s.size * 0.5}px`;
  els.overlay.style.color = s.textColor;
  els.overlay.style.background = hexToRgba(s.boxColor, s.boxOpacity);
  els.overlay.dataset.pos = s.position;
  try { await applyPreviewFont(); } catch (e) { console.warn("Font preview failed", e); }
}

// Show the caption that matches the current playback time
els.video.addEventListener("timeupdate", () => {
  const t = els.video.currentTime;
  if (previewEnd !== null && t >= previewEnd) {
    els.video.pause();
    previewEnd = null;
  }
  const seg = state.segments.find((s) => t >= s.start && t < s.end);
  els.overlay.textContent = seg ? seg.text : "";
});

// ---------- Export ----------
async function exportClips() {
  if (!state.selected.length) return setStatus("Select at least one clip first.");
  const s = getSettings();
  const ratio = RATIOS[s.ratio];

  els.exportBtn.disabled = true;
  els.results.innerHTML = "";

  try {
    const ff = await ensureInput();

    const fontFile = FONTS[s.font];
    const fontData = new Uint8Array(await (await fetch(`fonts/${fontFile}`)).arrayBuffer());
    await ff.writeFile("font.ttf", fontData);

    for (let n = 0; n < state.selected.length; n++) {
      const c = state.selected[n];
      const dur = c.end - c.start;
      setStatus(`Exporting clip ${n + 1} of ${state.selected.length}. This can take a while on phones...`);

      // Captions for this clip, timed relative to the clip start
      const segs = state.segments.filter((x) => x.end > c.start && x.start < c.end);
      const drawtexts = [];
      for (let k = 0; k < segs.length; k++) {
        const seg = segs[k];
        const name = `cap${k}.txt`;
        await ff.writeFile(name, wrapText(seg.text, ratio.wrap));
        const st = Math.max(0, seg.start - c.start).toFixed(2);
        const en = Math.min(dur, seg.end - c.start).toFixed(2);
        drawtexts.push(
          `drawtext=fontfile=font.ttf:textfile=${name}` +
          `:fontsize=${s.size}:fontcolor=${hexFF(s.textColor)}` +
          `:box=1:boxcolor=${hexFF(s.boxColor)}@${s.boxOpacity}:boxborderw=18` +
          `:x=(w-text_w)/2:y=${POS_Y[s.position]}` +
          `:enable='between(t,${st},${en})'`
        );
      }

      // Crop to the chosen ratio from the center, then scale
      const scale =
        `crop='min(iw,ih*${ratio.w}/${ratio.h})':'min(ih,iw*${ratio.h}/${ratio.w})',` +
        `scale=${ratio.w}:${ratio.h},setsar=1`;
      const vf = [scale, ...drawtexts].join(",");

      const out = `clip${n}.mp4`;
      const code = await ff.exec([
        "-ss", String(c.start), "-t", String(dur),
        "-i", "input.mp4",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        out,
      ]);
      if (code !== 0) throw new Error(`Export failed for clip ${n + 1}.`);

      const data = await ff.readFile(out);
      const url = URL.createObjectURL(new Blob([data], { type: "video/mp4" }));

      const v = document.createElement("video");
      v.src = url;
      v.controls = true;
      v.playsInline = true;

      const a = document.createElement("a");
      a.href = url;
      a.download = `short-${n + 1}.mp4`;
      a.textContent = `Download clip ${n + 1}`;
      a.className = "button-link";

      els.results.append(v, a);

      // Free memory before the next clip
      await ff.deleteFile(out);
      for (let k = 0; k < segs.length; k++) await ff.deleteFile(`cap${k}.txt`);
    }

    setStatus("Export complete. Tap a download link.");
  } catch (e) {
    setStatus("Error: " + e.message);
  } finally {
    els.exportBtn.disabled = false;
  }
}

// ---------- Event wiring ----------
els.file.addEventListener("change", () => {
  const f = els.file.files[0];
  if (!f) return;
  state.file = f;
  state.inputLoaded = false;
  state.segments = [];
  state.chunks = [];
  state.selected = [];
  els.video.src = URL.createObjectURL(f);
  els.transcribe.disabled = false;
  els.stepClips.classList.add("hidden");
  els.stepStyle.classList.add("hidden");
  renderSelected();
  setStatus("Video loaded. Tap Transcribe.");
});

els.transcribe.addEventListener("click", async () => {
  els.transcribe.disabled = true;
  try {
    setStatus("Extracting audio...");
    const audio = await extractAudio();

    setStatus("Transcribing with Whisper...");
    state.segments = await transcribe(audio);
    if (!state.segments.length) throw new Error("No speech found in this video.");

    state.chunks = buildChunks(state.segments);

    setStatus("Scoring clips for virality...");
    state.chunks = await scoreChunks(state.chunks);

    renderClipList();
    renderSelected();
    els.stepClips.classList.remove("hidden");
    els.stepStyle.classList.remove("hidden");
    setStatus(`Done: ${state.chunks.length} clip suggestions.`);
  } catch (e) {
    setStatus("Error: " + e.message);
  } finally {
    els.transcribe.disabled = false;
  }
});

els.rank.addEventListener("click", () => {
  state.selected.sort((a, b) => b.score - a.score);
  state.selected.forEach((c) => { c.role = ""; c.orderReason = ""; });
  renderSelected();
  setStatus("Sorted by score.");
});

els.story.addEventListener("click", async () => {
  if (state.selected.length < 2) return setStatus("Add at least 2 clips first.");
  try {
    setStatus("Ordering clips as a story...");
    const payload = state.selected.map((c) => ({
      index: c.index, start: c.start, end: c.end, text: c.text.slice(0, 600),
    }));
    const { order } = await callFunction("score", { action: "order", chunks: payload });

    const byIndex = new Map(state.selected.map((c) => [c.index, c]));
    const reordered = [];
    order.forEach((o) => {
      const c = byIndex.get(Number(o.index));
      if (c && !reordered.includes(c)) {
        c.role = o.role;
        c.orderReason = o.reason;
        reordered.push(c);
      }
    });
    state.selected.forEach((c) => { if (!reordered.includes(c)) reordered.push(c); });

    state.selected = reordered;
    renderSelected();
    setStatus("Story order applied.");
  } catch (e) {
    setStatus("Error: " + e.message);
  }
});

els.exportBtn.addEventListener("click", exportClips);

// Populate font list and live-update the preview
Object.keys(FONTS).forEach((name) => {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name;
  els.font.append(opt);
});

document.querySelectorAll("#step-style input, #step-style select").forEach((el) =>
  el.addEventListener("input", refreshOverlay)
);
refreshOverlay();
renderSelected();
