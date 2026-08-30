import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "sudoku-generator-solver",
  icon: "Grid3x3",
  name: "Sudoku Generator and Solver",
  description:
    "Generate puzzles with a unique solution at any difficulty, or paste one in to solve it and get step by step hints.",
  category: "Generators",
  keywords: [
    "sudoku generator",
    "sudoku solver",
    "free sudoku",
    "printable sudoku",
    "sudoku puzzle maker",
    "sudoku hint",
    "sudoku difficulty",
  ],
  searchTerms: [
    "sudoku creator",
    "solve my sudoku",
    "sudoku checker",
    "unique solution sudoku",
    "easy medium hard expert sudoku",
    "sudoku with seed",
    "sudoku cheat",
    "naked single hidden single",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "difficulty",
      label: "Difficulty",
      default: "medium",
      ui: "segmented",
      options: [
        { value: "easy", label: "Easy", synonyms: ["beginner", "simple"] },
        { value: "medium", label: "Medium", synonyms: ["intermediate", "standard"] },
        { value: "hard", label: "Hard", synonyms: ["difficult", "advanced"] },
        { value: "expert", label: "Expert", synonyms: ["hardest", "master", "extreme"] },
      ],
    },
    {
      kind: "text",
      id: "seed",
      label: "Seed",
      default: "",
      placeholder: "leave empty for random, or type a phrase",
    },
  ],
  copy: {
    what: "Generates sudoku puzzles at four difficulty levels, each one built so it has exactly one solution, never a puzzle that only looks solvable. Difficulty is defined by the technique needed, not just clue count: easy puzzles fall to naked singles alone, medium adds hidden singles, and hard and expert dig further while staying inside a clue floor that keeps them fair. Paste an existing puzzle instead, and it solves it, tells you whether the answer is unique, and offers the next logical step with a plain explanation, not just a filled grid.",
    how: "Leave the box empty, pick a difficulty and an optional seed, and a new puzzle appears below. The same seed and difficulty always reproduce the same puzzle, so a page link is a reliable way to share or reprint one. To solve your own puzzle instead, paste it as 81 characters or 9 lines of 9 cells, using 0 or a period for blanks. Use Check to highlight any digit that already breaks the rules, and Hint for the next single step, with an explanation of the row, column, or box it comes from.",
    why: "Most sudoku sites throttle how many puzzles you can generate, hide the difficulty behind a paywall, or paste in a puzzle that turns out to have more than one solution. This one generates as many puzzles as you want with a real uniqueness guarantee, explains hints instead of just filling in the answer, and runs entirely in your browser, so your files and inputs never leave your device. The seed makes every puzzle reproducible, which most generators cannot offer at all.",
    faq: [
      {
        q: "What makes a sudoku puzzle unique?",
        a: "A unique puzzle has exactly one arrangement of digits that satisfies every row, column, and box. This generator checks that property at every step of removing clues, rather than just hoping it holds at the end, so every puzzle it produces has one and only one answer.",
      },
      {
        q: "How is the difficulty decided?",
        a: "By the hardest technique a solver needs, not just by how many clues are left. Easy puzzles finish with naked singles alone, medium adds hidden singles, and hard and expert puzzles need techniques beyond both, with a clue floor that stops the digging from producing a puzzle only solvable by trial and error.",
      },
      {
        q: "Can I get the same puzzle again later?",
        a: "Yes. Type a seed, or a memorable phrase, before generating, and the page link captures it along with the difficulty. Opening that link, or typing the same seed and difficulty again, reproduces the exact same puzzle every time.",
      },
    ],
  },
};
