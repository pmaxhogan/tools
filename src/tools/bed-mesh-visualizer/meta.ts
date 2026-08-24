import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bed-mesh-visualizer",
  matrixSlug: "bed-mesh",
  icon: "Grid3x3",
  name: "Bed Mesh Visualizer",
  description: "Turn 3D printer bed levelling output into a surface plot and a tramming verdict.",
  category: "Hardware",
  keywords: [
    "bed mesh visualizer",
    "klipper bed mesh",
    "marlin g29 mesh viewer",
    "bed leveling visualizer",
    "ubl mesh viewer",
    "3d printer bed mesh",
  ],
  searchTerms: [
    "bed_mesh_output",
    "bed mesh calibrate",
    "m420 v",
    "g29 t",
    "mesh z values",
    "bilinear leveling grid",
    "bed leveling heat map",
    "is my printer bed warped",
    "bed tramming helper",
    "printer bed flatness",
    "bed mesh 3d plot",
    "klipper mesh graph",
    "prusa bed leveling",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "boolean",
      id: "svg",
      label: "Include SVG renders",
      default: false,
    },
    {
      kind: "select",
      id: "centerOn",
      label: "Color center",
      default: "zero",
      options: [
        {
          value: "zero",
          label: "Zero, the nozzle height",
          synonyms: ["0", "absolute", "z zero", "nozzle", "datum"],
        },
        {
          value: "mean",
          label: "Mesh average",
          synonyms: ["mean", "average", "relative", "midpoint", "centre of range"],
        },
      ],
    },
    {
      kind: "number",
      id: "zScale",
      label: "Height exaggeration",
      default: 10,
      min: 1,
      max: 50,
      step: 1,
    },
  ],
  copy: {
    what: "Paste the bed mesh your printer prints and get the numbers that actually matter: total deviation, mean, standard deviation, the value at each corner and at the middle, and the worst point on the plate. It reads Klipper BED_MESH_OUTPUT console text, a saved [bed_mesh default] block from printer.cfg, Marlin G29 T and M420 V grids in both the bilinear and the UBL layouts, plain grids of numbers, and JSON arrays of arrays. It also fits a least squares tilt plane through the mesh, so it can tell you how much of the deviation is a bed sitting crooked and how much is a plate that is genuinely bowed. The renders are a color heat map and an isometric 3D surface, both drawn as plain SVG.",
    how: "In Klipper, run BED_MESH_CALIBRATE, then BED_MESH_OUTPUT, and copy the console lines. In Marlin, run G29 and then M420 V, and copy the grid including the row and column labels. Paste it in and read the verdict. Turn on the SVG renders when you want the heat map and the 3D surface, switch the color center to the mesh average when your whole bed is offset from zero, and raise the height exaggeration to make a shallow mesh easier to see.",
    why: "The usual options are a Fusion or Excel surface chart you have to build by hand, an account gated web app, or a plugin you have to install into your printer stack. This page takes the raw text, needs no login, and adds the part those tools skip: it separates tilt from warp, so you know whether the fix is turning bed screws or accepting the plate you have. It runs entirely in your browser, so your files and inputs never leave your device, and it keeps working offline after the first load.",
    faq: [
      {
        q: "How do I get the mesh text out of Klipper or Marlin?",
        a: "On Klipper, probe the bed with BED_MESH_CALIBRATE and then send BED_MESH_OUTPUT in the console. The rows of Z values print straight into the terminal, and the // prefixes Mainsail or Fluidd add are stripped automatically. You can also paste the saved [bed_mesh default] section out of printer.cfg, which carries min_x, max_x, min_y and max_y so the report can name real bed coordinates. On Marlin, run G29 to probe, then M420 V to print the grid, or use G29 T for the topography report. Both the bilinear grid and the UBL Mesh Z values layout are understood, row and column labels included.",
      },
      {
        q: "What is a good total deviation for a printer bed?",
        a: "Under 0.1 mm is excellent and mesh compensation barely has to work. 0.1 to 0.2 mm is normal for a well trammed printer and prints without any thought. 0.2 to 0.35 mm still works with mesh compensation on, but first layers get more consistent if you close some of it mechanically. Above 0.35 mm you are asking the mesh to hide more than it comfortably can, and it tends to show up as squish that changes across the plate.",
      },
      {
        q: "What is the difference between tilt and warp?",
        a: "Tilt means the whole plate is flat but sitting at an angle, so one side is higher than the other. That is a levelling problem and bed screws fix it. Warp means the plate itself has a shape, usually a bowl or a dome, and no amount of screw turning will flatten it. This page fits a plane through the mesh and reports how much of the total deviation that plane accounts for. If tilt explains most of the range, tram the bed. If the residual is what dominates, the plate is bowed, and the honest fix is either living with mesh compensation or a different plate.",
      },
    ],
  },
};
