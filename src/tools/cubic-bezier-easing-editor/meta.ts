import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "cubic-bezier-easing-editor",
  icon: "PenTool",
  name: "Cubic Bezier Easing Editor",
  description:
    "Drag the control points of a CSS easing curve, watch it animate, and copy the cubic-bezier or linear() value.",
  category: "Dev",
  keywords: [
    "cubic bezier editor",
    "css easing curve generator",
    "transition timing function",
    "animation easing preview",
    "css linear() easing",
    "spring easing css",
    "ease in out curve",
  ],
  searchTerms: [
    "bezier curve css",
    "easing function picker",
    "cubic-bezier(0.4, 0, 0.2, 1)",
    "material motion curve",
    "overshoot animation css",
    "bounce easing",
    "animation-timing-function",
    "easing cheat sheet",
    "penner easing equations",
    "linear() easing function stops",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Paste an easing function",
    hint: "Paste cubic-bezier(0.25, 0.1, 0.25, 1), one of the ease keywords, or four bare numbers. Leave it empty to start from a preset.",
  },
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Preset",
      default: "ease",
      groups: [
        {
          label: "CSS keywords",
          synonyms: ["built in", "native", "standard", "browser"],
          options: [
            {
              value: "linear",
              label: "linear",
              synonyms: ["none", "constant", "no easing", "straight"],
            },
            { value: "ease", label: "ease", synonyms: ["default", "css default", "browser"] },
            {
              value: "ease-in",
              label: "ease-in",
              synonyms: ["accelerate", "slow start", "exit", "leaving"],
            },
            {
              value: "ease-out",
              label: "ease-out",
              synonyms: ["decelerate", "soft landing", "enter", "entering"],
            },
            {
              value: "ease-in-out",
              label: "ease-in-out",
              synonyms: ["symmetric", "smooth", "both ends"],
            },
          ],
        },
        {
          label: "Design systems",
          synonyms: ["material", "google", "android", "motion"],
          options: [
            {
              value: "material-standard",
              label: "Material standard",
              synonyms: ["emphasized", "on screen", "0.4 0 0.2 1", "md3"],
            },
            {
              value: "material-decelerate",
              label: "Material decelerate",
              synonyms: ["entering", "incoming", "0 0 0.2 1"],
            },
            {
              value: "material-accelerate",
              label: "Material accelerate",
              synonyms: ["leaving", "outgoing", "0.4 0 1 1"],
            },
          ],
        },
        {
          label: "Overshoot and extreme",
          synonyms: ["springy", "bouncy", "dramatic", "playful"],
          options: [
            {
              value: "spring",
              label: "Spring",
              synonyms: ["back out", "overshoot", "bouncy", "elastic", "pop"],
            },
            {
              value: "anticipate",
              label: "Anticipate",
              synonyms: ["back in out", "wind up", "pull back", "cartoon"],
            },
            {
              value: "quart-out",
              label: "Quartic out",
              synonyms: ["fast start", "long settle", "snappy"],
            },
            {
              value: "expo-in-out",
              label: "Exponential in out",
              synonyms: ["dramatic", "still at the ends", "whoosh"],
            },
          ],
        },
      ],
    },
    { kind: "number", id: "duration", label: "Duration (ms)", default: 400, min: 1, max: 60000 },
    {
      kind: "boolean",
      id: "linearApproximation",
      label: "Also emit a linear() approximation",
      default: true,
    },
    {
      kind: "number",
      id: "stops",
      label: "linear() samples",
      default: 16,
      min: 2,
      max: 100,
      step: 1,
    },
  ],
  examples: [
    { label: "The CSS default", input: "", opts: { preset: "ease" } },
    { label: "Spring with overshoot", input: "cubic-bezier(0.34, 1.56, 0.64, 1)" },
    { label: "Material standard", input: "", opts: { preset: "material-standard" } },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Edits a CSS easing curve by dragging its two control points, with a live preview box that runs the animation at your chosen duration so you can judge the curve by how it moves rather than by how it looks. It ships the five CSS keywords with their real control points, the Material Design motion curves, and overshoot shapes like spring and anticipate, and it names whichever of those your curve is closest to. Alongside the cubic-bezier() value it can emit a linear() approximation, which is the modern way to hand a curve to something that only understands a list of points.",
    how: "Pick a preset or paste a value you already have, then drag either handle on the curve. With a handle focused the arrow keys nudge it, and Shift with an arrow moves it faster, so the whole editor works from the keyboard. Set the duration to whatever your transition uses, press Replay to watch it again, then copy the cubic-bezier() value, the ready made transition declaration, or the linear() approximation.",
    why: "The classic cubic-bezier editor is excellent and this one keeps what makes it good: draggable handles, a preview that actually moves, and a comparison against the curve you probably meant. It adds keyboard control of the handles, a linear() export, an honest note when the curve overshoots a property that cannot overshoot, and a shareable link that carries the exact curve. It runs entirely in the page, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Why can the y values go past 1 but the x values cannot?",
        a: "The x axis is time and the y axis is progress through the change. A control point with x outside 0 to 1 would ask the animation to sample outside its own duration, which is meaningless, so CSS rejects the whole declaration and the property falls back to ease. A y value outside that range just means the property passes its target and comes back, which is exactly how a spring or an anticipation curve is built.",
      },
      {
        q: "When should I use linear() instead of cubic-bezier()?",
        a: "A cubic bezier can only bend once in each direction, so it cannot describe a real bounce or a damped spring that crosses the target several times. linear() takes a list of points and therefore can. It is also useful for handing a curve to a runtime that has no bezier solver. The tradeoff is that linear() is an approximation with visible corners if you use too few points, and it needs Chrome 113, Safari 17.2, or Firefox 112 and later.",
      },
      {
        q: "Which easing should I use for a UI transition?",
        a: "For something entering the screen, an ease-out shape: fast at the start so it feels responsive, slow at the end so it lands softly. For something leaving, an ease-in shape, since nobody needs to watch it go. Symmetric ease-in-out reads as deliberate and suits longer moves between two on screen states. Keep durations short, roughly 150 to 300 milliseconds for small elements, and remember that a preview box tells you more than the shape of the curve does.",
      },
    ],
  },
};
