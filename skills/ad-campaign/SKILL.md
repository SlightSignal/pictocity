---
name: ad-campaign
description: Produce a complete ad campaign's creative assets with pictocity (visual, MCP "pictocity") and soundstudio (audio, MCP "soundstudio"): brief → brand kit → format set → copy variants → spec checks → exports, plus the audio spot with VO, music, ducking and loudness. Use whenever asked to make, adapt, or resize ads, banners, social creatives, stories, display sets, or an audio/radio spot.
---

# Ad campaign production

You have two production tools with the same design: a JSON document, every edit an operation with an exact inverse, a live editor the human watches and touches, and an MCP surface for you. **Every change you make appears live in the human's editor; every change they make is visible in your next `get_document` / `get_project`.** Work in small, named steps; the history is the shared record.

## 0. Before designing

1. `get_brand` (pictocity). If empty, ask for or infer the brand and store it with `set_brand`: colours with roles (`primary`, `accent`, `background`, `text`), fonts with roles (`headline`, `body`), voice, hard rules (claims you can't make, mandatory legal line, logo clearance), audio identity (target loudness, sonic logo asset if any). Brand colours show up in the human's Swatches panel.
2. `list_fonts`. If the brand font isn't served, `install_font` it (path or URL) — otherwise the human's preview and your export will differ.
3. Confirm the deliverables: platforms, sizes, copy variants, languages, duration for audio/video. Use `list_presets` for sizes; the groups are Social, Display, Screens, Print.

## 1. Build the master format first

- `create_document` at the primary format (usually 1080×1350 for feed or 1080×1920 for stories). Name layers by role (`Headline`, `Subhead`, `CTA button`, `CTA label`, `Logo`, `Product`, `Legal`) and tag them (`tags: ["cta"]`, `["logo"]`) — the spec checker and later edits rely on names.
- Layout order that reads on a phone: background → product/photo → headline → CTA → logo → legal. Keep headlines ≤ 6 words, body ≤ 90 characters.
- Images: `import_asset`, then `add_layer {type: "image", fit: "cover"}`. Knock out backgrounds with `process_image {tool: "knockout_background"}` when a cut-out is wanted. Photos placed small are resampled properly; you don't need to downscale first.
- Use styles sparingly: a soft shadow on the product, a stroke or fill-0 % outline for headline treatments, `patternOverlay`/`gradientOverlay` for texture. Style presets are available (`Soft shadow`, `Outline (white)`, `Sticker`…) from the Properties panel; you can set `styles` directly.
- Render and **look at it**: `render_preview` returns an image. Judge hierarchy, legibility, crowding. Iterate.

## 2. Make the format set

- `add_artboard` per size (`adoptExisting: true` on the first so the master becomes an artboard). Then `copy_to_artboard {fit: true, link: true}` from the master to each. `link: true` keeps text, colours, fonts and effects in sync across formats — later copy changes propagate; positions and font sizes stay per format so you can retune each.
- Retune each artboard by hand where needed: stories need bigger type and content pulled into the middle 65 %; display banners need one line and one CTA.
- Reference layers unambiguously: `"Story/Headline"`, `"Square/CTA button"`, or ids. A bare `"Headline"` fails with the candidates when several exist — that's intended.

## 3. Copy and language variants

- `save_comp` the current state as a named comp (`"A"`), change the copy (`replace_text` or `update_layer`), `save_comp "B"`. Comps store visibility, position and text; `apply_comp` switches. `export_document {allComps: true}` renders every variant.
- For languages, comps per language on the same artboards; run `check_spec` per language — longer languages overflow.

## 4. Check before you export — always

- `check_spec {platform, artboard}` for every artboard and its platform (`meta-feed`, `meta-story`, `google-display`, `youtube-thumbnail`, `linkedin`, `x`, `pinterest`, `print`). Fix `ERROR`s (size/aspect, weight, illegible type, unreadable contrast). Treat `WARNING`s as judgement: safe zones matter on stories; text coverage matters on Meta feed.
- Re-render and look once more after fixes.

## 5. Export

- `export_document {format, allArtboards: true}` → PNG for social, JPG q≥85 where weight matters, PNG-8 or GIF for display banners under 150 KB (`check_spec {weigh: true}` measures), PDF for print (`allArtboards` → one page per artboard), SVG when vectors are wanted, PSD when a designer will open it in Photoshop, HTML5 for animated banners.
- Animated: `set_keyframes` (position/opacity/rotation/scale with easing) then `export_document {format: "gif"}` or `"html"`. Keep GIFs ≤ 12 fps and short.
- Report paths/URLs and the spec scores in your summary.

## 6. The audio spot (soundstudio)

1. `create_project {name, targetLufs}` — `-14` for social/streaming, `-16` podcast, `-23` broadcast EBU, `-24` US TV. Default tracks: Voice, Music, SFX.
2. Voice: `synthesize_speech` if a TTS tool is configured (`list_audio_tools`), else `import_audio` a recorded take. Trim silence with `update_clip` (`offset`, `duration`). Put a `highpass` at 80–100 Hz and a gentle `compressor` on the Voice track.
3. Music: `import_audio` a licensed bed (preferred) or `generate_music` (placeholder-grade). `analyze_asset` for bpm and beats. `stretch_clip {duration, wholeBars: true}` to fit the spot length with pitch preserved. Fade out 1–2 s before the end.
4. `set_ducking {trackId: "Music", sourceTrackId: "Voice", amount: 8–12}` so the bed dips under the voice.
5. SFX on the beat: use `analyze_asset` beat times; `generate_sfx {preset}` (whoosh in, chime/impact on the logo, click on the CTA) or import samples. Put a sonic logo from the brand kit at the end.
6. `set_master_preset {preset}` for the destination, `measure_loudness`, then `render {format}` (mp3/m4a for web, wav for the video editor) and `export_stems` so the video editor can mix.
7. Timing hand-off: `add_marker` for VO in, logo, end card; the video editor lines picture to them.

## 7. Hand-off summary

Always end with: documents/projects and ids, formats produced with sizes, spec scores per artboard, loudness/true peak per audio render, file paths or URLs, and anything you couldn't verify (fonts missing, tools not configured, weight over limit).

## Rules of engagement

- Never invent claims, prices, or legal text; take them from the brief or the brand kit's rules. Keep mandatory legal lines legible (≥ the platform minimum) even though the checker allows small "legal" layers.
- Don't fight the human: if the history shows they moved something, keep their change unless they ask.
- Prefer non-destructive edits (masks, adjustment layers, linked layers); `merge_layers` only when an image tool needs pixels.
- When something fails, read the error — the tools tell you the accepted values and candidates.
