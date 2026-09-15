// The document is the single source of truth. The editor, the agent (via MCP)
// and the exporter all read and write this JSON; pixels are always derived.

export type BlendMode =
  | "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten"
  | "color-dodge" | "color-burn" | "hard-light" | "soft-light" | "difference"
  | "exclusion" | "hue" | "saturation" | "color" | "luminosity";

export const BLEND_MODES: BlendMode[] = [
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity",
];

export interface DropShadow { enabled: boolean; color: string; blur: number; x: number; y: number; opacity: number }
export interface Stroke { enabled: boolean; color: string; size: number; position: "outside" | "inside" | "center" }
export interface OuterGlow { enabled: boolean; color: string; size: number; opacity: number }
export interface ColorOverlay { enabled: boolean; color: string; opacity: number; blend: BlendMode }
export interface GradientOverlay { enabled: boolean; from: string; to: string; angle: number; opacity: number; blend: BlendMode }
export interface Bevel { enabled: boolean; size: number; depth: number; angle: number; highlight: string; shadow: string; opacity: number }
export interface PatternOverlay { enabled: boolean; assetId: string; scale: number; opacity: number; blend: BlendMode }

/** Photoshop "fx" layer styles. All optional; a missing style is disabled. */
export interface LayerStyles {
  dropShadow?: DropShadow;
  innerShadow?: DropShadow;
  stroke?: Stroke;
  outerGlow?: OuterGlow;
  innerGlow?: OuterGlow;
  colorOverlay?: ColorOverlay;
  gradientOverlay?: GradientOverlay;
  bevel?: Bevel;
  patternOverlay?: PatternOverlay;
}

/** Non-destructive pixel adjustments applied to the layer's own pixels. */
export interface LayerFilters {
  blur?: number;        // px
  brightness?: number;  // 1 = unchanged
  contrast?: number;    // 1 = unchanged
  saturate?: number;    // 1 = unchanged
  hueRotate?: number;   // degrees
  grayscale?: number;   // 0..1
  sepia?: number;       // 0..1
  invert?: number;      // 0..1
  /** Film grain / noise amount 0..1. */
  noise?: number;
  /** Photoshop Levels: input black/white (0-255), gamma (0.1-10), output black/white (0-255). */
  levels?: { inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number };
  /** Photoshop Curves: control points [input, output] in 0-255 per channel. */
  curves?: { rgb?: [number, number][]; r?: [number, number][]; g?: [number, number][]; b?: [number, number][] };
  // ---- Photoshop-style adjustments (per-pixel) ----
  vibrance?: number;                                        // -1..1
  exposure?: { exposure: number; offset: number; gamma: number };  // stops, -0.5..0.5, 0.1..10
  colorBalance?: { shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number]; preserveLuminosity?: boolean }; // -100..100
  blackWhite?: { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint?: string }; // -200..300, 50 = neutral
  photoFilter?: { color: string; density: number; preserveLuminosity?: boolean }; // density 0..1
  gradientMap?: { stops: { pos: number; color: string }[]; reverse?: boolean };
  channelMixer?: { r: [number, number, number, number]; g: [number, number, number, number]; b: [number, number, number, number]; monochrome?: boolean }; // rgb + constant, 1 = 100%
  threshold?: number;                                       // 1..255
  posterize?: number;                                       // 2..255
  shadowsHighlights?: { shadows: number; highlights: number }; // 0..1
  colorize?: { hue: number; saturation: number; lightness: number }; // hue 0..360, sat 0..1, light -1..1
  // ---- Filters (pixel) ----
  unsharp?: { amount: number; radius: number };            // amount 0..5, radius px
  motionBlur?: { angle: number; distance: number };
  pixelate?: number;                                        // cell size px
  emboss?: number;                                          // 0..1
  findEdges?: number;                                       // 0..1
}

/** Multi-stop gradient with transparency, in Photoshop's five styles. */
export interface GradientStop { pos: number; color: string; opacity?: number }
export interface GradientFill { kind: "gradient"; type: "linear" | "radial" | "angle" | "reflected" | "diamond"; angle: number; stops: GradientStop[]; scale?: number; reverse?: boolean }

/** A layer mask. Either a vector shape or a raster asset (white = show, black = hide). */
export type LayerMask =
  | { kind: "shape"; shape: "rect" | "ellipse"; x: number; y: number; width: number; height: number; radius?: number; feather?: number; inverted?: boolean }
  | { kind: "raster"; assetId: string; inverted?: boolean }
  /** A painted mask: starts fully visible ("show") or hidden ("hide"); strokes reveal, erase strokes hide. */
  | { kind: "paint"; base: "show" | "hide"; strokes: BrushStroke[]; inverted?: boolean };

export interface LayerBase {
  id: string;
  name: string;
  type: "image" | "text" | "shape" | "group" | "fill" | "adjustment" | "brush";
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blend: BlendMode;
  // Transform. x/y is the top-left of the untransformed box; rotation is around the box centre.
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number; // degrees
  scaleX: number;
  scaleY: number;
  /** Opacity of the layer's own pixels only; effects keep full strength (Photoshop "Fill"). */
  fillOpacity?: number;
  mask?: LayerMask;
  styles?: LayerStyles;
  filters?: LayerFilters;
  /** Free-form tags so the agent can find "headline", "cta", "logo" etc. */
  tags?: string[];
  /** Layers sharing a linkId keep their content in sync (text, colours, effects...) while geometry stays independent. */
  linkId?: string;
  /** Clipping mask: this layer only shows where the nearest non-clipped layer below it has pixels. */
  clipToBelow?: boolean;
  /** Distort / perspective / skew: offsets of the four box corners (TL, TR, BR, BL) in layer-local pixels. */
  quad?: [number, number, number, number, number, number, number, number];
}

export interface ImageLayer extends LayerBase {
  type: "image";
  assetId: string;
  fit: "fill" | "contain" | "cover";
  /** Optional source crop in asset pixel coordinates. */
  crop?: { x: number; y: number; width: number; height: number };
}

/** Character-range styling inside a text layer (start inclusive, end exclusive, in characters). Later runs win. */
export interface TextRun { start: number; end: number; color?: string; fontWeight?: number | "normal" | "bold"; fontStyle?: "normal" | "italic"; underline?: boolean; fontFamily?: string }

export interface TextLayer extends LayerBase {
  type: "text";
  text: string;
  runs?: TextRun[];
  fontFamily: string;
  fontSize: number;
  fontWeight: number | "normal" | "bold";
  fontStyle: "normal" | "italic";
  color: string;
  align: "left" | "center" | "right" | "justify";
  verticalAlign: "top" | "middle" | "bottom";
  lineHeight: number;      // multiplier, 1.2 = 120%
  letterSpacing: number;   // px
  textTransform?: "none" | "uppercase" | "lowercase";
  underline?: boolean;
  strikethrough?: boolean;
  /** Stack characters top to bottom (vertical type). */
  vertical?: boolean;
  /** Character panel extras: kerning on/off, baseline shift (px), horizontal/vertical scale (1 = 100%). */
  kerning?: boolean;
  baselineShift?: number;
  textScaleX?: number;
  textScaleY?: number;
  /** Text on a path: the path is normalised to the layer box (0..1). Presets: arc-up, arc-down, circle. */
  onPath?: { path: string; align?: "start" | "center" | "end"; offset?: number; flip?: boolean };
  /** When false the box grows with the text (point text); when true text wraps inside width (paragraph text). */
  wrap: boolean;
}

export type ShapeKind = "rect" | "ellipse" | "line" | "polygon" | "star" | "path";

export interface ShapeLayer extends LayerBase {
  type: "shape";
  shape: ShapeKind;
  fill: string | null;
  strokeColor: string | null;
  strokeWidth: number;
  radius?: number;      // rect corner radius
  /** Per-corner radii [top-left, top-right, bottom-right, bottom-left]; overrides radius when set. */
  radii?: [number, number, number, number];
  sides?: number;       // polygon / star
  innerRadius?: number; // star, 0..1 of outer radius
  /** SVG path data in a 0..1 normalised box, scaled to width/height. */
  path?: string;
  /** Dash pattern for the stroke, e.g. [8, 4]. */
  dash?: number[];
  /** Arrowheads for line shapes. */
  arrows?: "none" | "start" | "end" | "both";
}

export interface FillLayer extends LayerBase {
  type: "fill";
  fill: { kind: "solid"; color: string } | { kind: "linear"; from: string; to: string; angle: number; stops?: [number, number] } | { kind: "radial"; from: string; to: string } | { kind: "pattern"; assetId: string; scale: number } | GradientFill;
}

/** Adjustment layers affect everything beneath them (within their group). */
export interface AdjustmentLayer extends LayerBase {
  type: "adjustment";
  adjustment: LayerFilters;
}

/** One brush or eraser stroke. Points are a flat [x0,y0,x1,y1,...] list in layer-local pixels. */
export interface BrushStroke {
  points: number[];
  size: number;
  color: string;
  opacity: number;
  /** 1 = hard edge, 0 = very soft. */
  hardness: number;
  erase?: boolean;
  /** Closed polygon filled instead of a stroked line (fill / delete a selection). */
  fill?: boolean;
  /** Multi-ring version of `points` for fill strokes (even-odd): several areas and holes. */
  rings?: number[][];
  /** Multi-ring clip (even-odd), takes precedence over `clip`. */
  clipRings?: number[][];
  /** Per-point pen pressure 0..1 (same length as points/2); width = size * pressure. */
  pressures?: number[];
  /** Polygon (layer-local) the stroke is clipped to - the pixel selection active when it was painted. */
  clip?: number[];
  /** Clone stamp: paint what lies below the layer, sampled from this offset (layer-local px). */
  clone?: { dx: number; dy: number };
  /** With clone: healing brush - keep the destination's colour, take the source's texture (luminosity). */
  heal?: boolean;
}

/** A paint layer: strokes are kept as vectors so they stay editable, undoable and syncable. */
export interface BrushLayer extends LayerBase {
  type: "brush";
  strokes: BrushStroke[];
}

export interface GroupLayer extends LayerBase {
  type: "group";
  children: Layer[];
  /** An artboard: a group whose children are clipped to its frame (x/y/width/height) and which exports on its own. */
  artboard?: boolean;
}

export type Layer = ImageLayer | TextLayer | ShapeLayer | FillLayer | AdjustmentLayer | BrushLayer | GroupLayer;

export interface Asset {
  id: string;
  name: string;
  /** URL relative to the document server, e.g. /assets/abc.png */
  src: string;
  width: number;
  height: number;
  mime: string;
}

export interface Guide { axis: "x" | "y"; position: number }

export interface Keyframe { t: number; x?: number; y?: number; opacity?: number; rotation?: number; scaleX?: number; scaleY?: number; visible?: boolean; ease?: "linear" | "ease-in" | "ease-out" | "ease-in-out" }
export interface Animation { fps: number; duration: number; loop?: boolean; tracks: Record<string, Keyframe[]> }

/** A saved state of layer visibility / position / text - Photoshop layer comps, e.g. A/B headlines or language variants. */
export interface LayerComp {
  id: string;
  name: string;
  states: Record<string, { visible?: boolean; x?: number; y?: number; opacity?: number; text?: string }>;
}

export interface AdDocument {
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  /** Document background. null = transparent. */
  background: string | null;
  /** Bottom-to-top order, like Photoshop's layers panel read upwards. */
  layers: Layer[];
  assets: Record<string, Asset>;
  guides: Guide[];
  /** Blend gradients and blurs in linear light instead of gamma-encoded sRGB (physically correct; Photoshop's default is off). */
  linearBlending?: boolean;
  comps?: LayerComp[];
  /** Saved pixel selections (document-space rings), like Photoshop's alpha channels. */
  selections?: { id: string; name: string; rings: number[][] }[];
  /** Timeline for animated banners: keyframes per layer. */
  animation?: Animation;
  /** Monotonic revision, incremented by the server on every applied op. */
  rev: number;
  createdAt: string;
  updatedAt: string;
}

// ---- Operations (the collaboration protocol) -------------------------------
// Every change to a document is an op. The server applies ops in order, bumps
// rev and broadcasts. Both the editor and the agent speak only in ops, which is
// what makes the history panel, live collaboration and agent edits one thing.

export type Op =
  | { type: "doc.set"; props: Partial<Pick<AdDocument, "name" | "width" | "height" | "background" | "guides" | "comps" | "selections" | "animation" | "linearBlending">> }
  | { type: "layer.add"; layer: Layer; parentId: string | null; index: number }
  | { type: "layer.remove"; id: string }
  | { type: "layer.set"; id: string; props: Record<string, unknown> }
  | { type: "layer.move"; id: string; parentId: string | null; index: number }
  /** Append items to an array property (e.g. brush strokes) without resending the whole array. */
  | { type: "layer.push"; id: string; key: string; items: unknown[] }
  | { type: "layer.splice"; id: string; key: string; index: number; count: number; items?: unknown[] }
  | { type: "asset.add"; asset: Asset }
  | { type: "asset.remove"; id: string };

export interface OpEnvelope {
  docId: string;
  ops: Op[];
  /** Who made the change: "editor:<clientId>" or "agent:<name>". Used for history labels and lock checks. */
  actor: string;
  /** Human-readable label for the history panel, e.g. "Move headline". */
  label?: string;
}

export interface AppliedOps extends OpEnvelope {
  rev: number;
  /** Inverse ops the server computed while applying, so any client can undo. */
  inverse: Op[];
  at: string;
}

// ---- Wire messages (WebSocket) ------------------------------------------------

export type ClientMessage =
  | { kind: "subscribe"; docId: string }
  | { kind: "ops"; envelope: OpEnvelope; clientRev: number }
  | { kind: "presence"; docId: string; selection: string[]; cursor?: { x: number; y: number } };

export type ServerMessage =
  | { kind: "snapshot"; doc: AdDocument }
  | { kind: "applied"; applied: AppliedOps }
  | { kind: "rejected"; reason: string; rev: number }
  | { kind: "presence"; actor: string; selection: string[]; cursor?: { x: number; y: number } }
  | { kind: "error"; message: string };
