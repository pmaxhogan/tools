import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "gcode-viewer",
  matrixSlug: "gcode",
  icon: "Layers",
  name: "G-code Viewer",
  description:
    "Visualize a G-code toolpath layer by layer, with filament, time and temperature stats.",
  category: "3D Printing",
  keywords: [
    "gcode viewer online",
    "view gcode in browser",
    "gcode layer viewer",
    "3d printer gcode preview",
    "gcode analyzer",
    "gcode toolpath visualizer",
  ],
  searchTerms: [
    "open gcode file",
    "gcode preview",
    "toolpath preview",
    "read gcode",
    "gco file viewer",
    "cura gcode preview",
    "prusaslicer gcode preview",
    "how much filament does this print use",
    "print time estimate from gcode",
    "gcode layer slider",
    "travel moves gcode",
    "cnc nc file viewer",
  ],
  input: "File",
  output: "application/json",
  options: [
    {
      kind: "boolean",
      id: "svg",
      label: "Draw the toolpath",
      default: false,
    },
    {
      kind: "number",
      id: "layer",
      label: "Layer to draw (0 for the whole stack)",
      default: 0,
      min: 0,
      max: 10000,
      step: 1,
    },
    {
      kind: "boolean",
      id: "showTravel",
      label: "Show travel moves",
      default: false,
    },
    {
      kind: "select",
      id: "colorBy",
      label: "Color the strokes by",
      default: "type",
      options: [
        {
          value: "type",
          label: "Move type",
          synonyms: ["extrusion", "travel", "role", "line type", "flat", "single colour"],
        },
        {
          value: "speed",
          label: "Speed",
          synonyms: ["feed", "feedrate", "feed rate", "velocity", "mm/s", "fast slow"],
        },
      ],
    },
  ],
  copy: {
    what: "Drop a .gcode file and see what it actually does. This page walks the program the way firmware would, following G0 and G1 moves, G2 and G3 arcs, absolute and relative positioning, M82 and M83 extrusion modes, G92 resets and G28 homing, then splits the result into layers using the slicer markers when they are there and Z changes when they are not. You get the layer count and layer height, the printed bounding box, filament in millimeters and grams, extruding and travel distance, a rough time estimate, hotend and bed temperatures, fan speed and tool changes. It also reads the header comments, so it can tell you which slicer wrote the file and what that slicer estimated for time and filament.",
    how: "Drop the file, or paste the text of a short program. Turn on the toolpath drawing to get a top down SVG: leave the layer at 0 for the whole stack with the lower layers faded, or set a layer number to draw just that one. Turn on travel moves to see where the head jumps between islands, and switch the coloring to speed when you want to spot where the slicer slowed down. Every number is recomputed from the moves themselves, so it also works on hand written and post processed files.",
    why: "Most G-code previewers either want an upload to somebody else's server or want you to install a desktop slicer just to open one file. This one parses the program in the page, so your files and inputs never leave your device, there is no size gate at a few megabytes, and it keeps working offline after the first load. It also does not just trust the slicer header: the filament, distance and bounds come from the moves, so a post processing script that broke your file shows up here as numbers that no longer match the comments.",
    faq: [
      {
        q: "Why is the time estimate different from the one my slicer printed?",
        a: "The estimate here is deliberately rough. It divides each move by the feed rate in force and adds the results up, with no model of acceleration, jerk, junction deviation or the firmware speed limits, so it comes out optimistic on files full of short segments and close to right on long straight ones. Your slicer models the motion planner and knows the machine profile, which is why it does better. When the file carries the slicer estimate in its comments, this page shows that figure too on its own row, so you can compare the two.",
      },
      {
        q: "How does it decide where one layer ends and the next begins?",
        a: "First it looks for the markers slicers write: ;LAYER:n from Cura, ;LAYER_CHANGE followed by ;Z: from PrusaSlicer, SuperSlicer, OrcaSlicer and Bambu Studio, and the ; layer 1, Z = 0.2 form from Simplify3D. If the file has none of those, which is normal for hand written, vase mode or CNC programs, it falls back to starting a new layer whenever the Z height changes on an extruding move. The summary says which of the two it used, so you always know whether you are looking at real slicer layers or inferred ones.",
      },
      {
        q: "Does it handle arcs and CNC files?",
        a: "Yes. G2 and G3 arcs are flattened into short line segments in the XY plane, from either the I and J center offsets or the R radius form, with the commanded endpoint kept exact so the path never drifts. Inch mode from G20 is converted to millimeters. Files with no extrusion at all, which is most CNC work, still get bounds, distance, a rough time and the toolpath drawing; the filament and temperature rows just say they were not set in the file, because nothing in the program sets them.",
      },
    ],
  },
};
