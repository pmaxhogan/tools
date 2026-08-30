import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "css-keyframes-builder",
  icon: "Film",
  name: "CSS Keyframes Builder",
  description:
    "Build @keyframes animations on a visual timeline, preview them live, and copy the CSS with a reduced motion guard.",
  category: "Dev",
  keywords: [
    "css keyframes generator",
    "css animation builder",
    "keyframe timeline editor",
    "css animation preview",
    "prefers-reduced-motion css",
    "css animation shorthand",
    "bounce shake pulse css",
  ],
  searchTerms: [
    "@keyframes",
    "animation-timing-function",
    "css loading spinner animation",
    "shake invalid input animation",
    "fade in css animation",
    "animation fill mode forwards",
    "animation-iteration-count infinite",
    "transform translate rotate scale keyframes",
    "css animation generator no signup",
    "reduced motion accessibility animation",
  ],
  input: "text/plain",
  output: "text/plain",
  inputOptional: {
    label: "Animation name",
    hint: "The @keyframes name and the class name in the generated rule. Leave it empty to use the preset's own name. CSS-wide keywords like none are rejected, because a rule that says animation-name: none turns the animation off.",
  },
  options: [
    {
      kind: "select",
      id: "preset",
      label: "Preset",
      default: "fade-in",
      groups: [
        {
          label: "Entrances",
          synonyms: ["enter", "appear", "in", "mount", "reveal"],
          options: [
            {
              value: "fade-in",
              label: "Fade in",
              synonyms: ["opacity", "appear", "reveal", "soft"],
            },
            {
              value: "slide-up",
              label: "Slide up",
              synonyms: ["translate", "rise", "enter from below", "scroll reveal"],
            },
            {
              value: "pop-in",
              label: "Pop in",
              synonyms: ["scale", "zoom in", "grow", "spring", "modal"],
            },
          ],
        },
        {
          label: "Attention",
          synonyms: ["loop", "emphasis", "feedback", "notice"],
          options: [
            {
              value: "bounce",
              label: "Bounce",
              synonyms: ["hop", "jump", "playful", "spring"],
            },
            {
              value: "pulse",
              label: "Pulse",
              synonyms: ["breathe", "heartbeat", "throb", "highlight"],
            },
            {
              value: "shake",
              label: "Shake",
              synonyms: ["wobble", "error", "invalid", "nope", "wiggle"],
            },
          ],
        },
        {
          label: "Continuous",
          synonyms: ["infinite", "looping", "background"],
          options: [
            {
              value: "spin",
              label: "Spin",
              synonyms: ["rotate", "loader", "spinner", "turn", "loading"],
            },
            {
              value: "color-shift",
              label: "Color shift",
              synonyms: ["background fade", "hue", "gradient loop", "ambient"],
            },
          ],
        },
      ],
    },
    { kind: "number", id: "duration", label: "Duration (ms)", default: 600, min: 1, max: 600000 },
    { kind: "number", id: "delay", label: "Delay (ms)", default: 0, min: 0, max: 600000 },
    {
      kind: "select",
      id: "timing",
      label: "Timing function",
      default: "ease",
      options: [
        { value: "ease", label: "ease", synonyms: ["default", "css default"] },
        { value: "linear", label: "linear", synonyms: ["constant", "spinner", "loop safe"] },
        { value: "ease-in", label: "ease-in", synonyms: ["accelerate", "exit", "leaving"] },
        { value: "ease-out", label: "ease-out", synonyms: ["decelerate", "enter", "entering"] },
        { value: "ease-in-out", label: "ease-in-out", synonyms: ["symmetric", "smooth"] },
        {
          value: "cubic-bezier(0.4, 0, 0.2, 1)",
          label: "Material standard",
          synonyms: ["emphasized", "google", "md3", "custom curve"],
        },
        {
          value: "cubic-bezier(0.34, 1.56, 0.64, 1)",
          label: "Spring overshoot",
          synonyms: ["bouncy", "back out", "pop", "elastic"],
        },
        {
          value: "steps(6, end)",
          label: "steps(6, end)",
          synonyms: ["sprite", "stop motion", "jump", "typewriter", "frame by frame"],
        },
      ],
    },
    {
      kind: "text",
      id: "iteration",
      label: "Iteration count",
      default: "1",
      placeholder: "1 or infinite",
    },
    {
      kind: "select",
      id: "direction",
      label: "Direction",
      default: "normal",
      options: [
        { value: "normal", label: "normal", synonyms: ["forwards", "default", "start to end"] },
        { value: "reverse", label: "reverse", synonyms: ["backwards", "end to start"] },
        {
          value: "alternate",
          label: "alternate",
          synonyms: ["ping pong", "back and forth", "yoyo", "loop back"],
        },
        {
          value: "alternate-reverse",
          label: "alternate-reverse",
          synonyms: ["ping pong reversed", "yoyo backwards"],
        },
      ],
    },
    {
      kind: "select",
      id: "fill",
      label: "Fill mode",
      default: "both",
      options: [
        { value: "none", label: "none", synonyms: ["snap back", "no hold", "default css"] },
        {
          value: "forwards",
          label: "forwards",
          synonyms: ["hold the end", "stay", "keep final state"],
        },
        {
          value: "backwards",
          label: "backwards",
          synonyms: ["hold the start", "apply during delay"],
        },
        { value: "both", label: "both", synonyms: ["hold both ends", "recommended", "safest"] },
      ],
    },
    {
      kind: "boolean",
      id: "reducedMotion",
      label: "Wrap in a prefers-reduced-motion guard",
      default: true,
    },
  ],
  examples: [
    { label: "Fade in", input: "", opts: { preset: "fade-in" } },
    { label: "Loading spinner", input: "spin", opts: { preset: "spin", timing: "linear" } },
    {
      label: "Shake an invalid field",
      input: "field-error",
      opts: { preset: "shake", reducedMotion: "true" },
    },
  ],
  http: { method: "GET", contentType: "text/plain" },
  copy: {
    what: "Builds a CSS @keyframes animation on a timeline. Each stop sits at a percentage and carries a translate, a rotation, a scale, an opacity, and an optional background color, all edited with sliders while a preview element runs the result. It writes the @keyframes block, the animation shorthand with every longhand spelled out, and, if you want it, the prefers-reduced-motion guard that keeps the animation from running for visitors who asked for less of it.",
    how: "Pick a preset, then add stops on the timeline and adjust each one. Set the duration, the timing function, the iteration count, the direction, and the fill mode in the settings, and give the animation a name if you do not want the preset's. Press Replay to watch it again, then copy the CSS. The whole timeline lives in the URL, so a link reproduces exactly the animation you built.",
    why: "Most keyframe generators give you a fixed list of canned animations and no way to move a stop. This one is a real timeline: add a stop anywhere, drag it, and see the transform recomposed as the same function list at every stop, which is what a browser needs in order to interpolate at all. It also refuses an animation name that is a CSS-wide keyword, which is a silent failure that costs people an afternoon, and it offers the reduced motion guard by default. It runs entirely in the page, so your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does my transform animation jump instead of interpolating?",
        a: "A browser can only interpolate two transforms whose function lists match in kind and in order. If one stop says translateY(20px) and the next says scale(1.1), there is nothing to interpolate between, so the value snaps at the stop boundary. This tool writes translate, rotate, and scale on every stop as soon as any stop needs a transform, which is exactly what keeps the animation smooth.",
      },
      {
        q: "What does animation-fill-mode actually change?",
        a: "It decides what the element looks like outside the animation's own running time. With the default of none, the element snaps back to its normal styles the moment the animation ends, which is why a fade in often flashes back to invisible. forwards holds the last keyframe, backwards applies the first keyframe during the delay, and both does the two together. For an entrance animation, both is almost always what you meant.",
      },
      {
        q: "How should I handle prefers-reduced-motion?",
        a: "Put the animation inside a prefers-reduced-motion: no-preference query rather than turning it off inside a reduce query. Written that way, a browser that does not understand the query never starts the animation at all, so the safe path is the default rather than the exception. Motion that conveys meaning, such as a progress spinner, can stay, but large movement, parallax, and anything that loops should not run for someone who asked for less of it.",
      },
    ],
  },
};
