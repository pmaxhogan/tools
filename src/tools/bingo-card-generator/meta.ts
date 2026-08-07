import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "bingo-card-generator",
  icon: "Grid3x3",
  name: "Bingo Board Maker",
  description:
    "Turns a pasted list of items into randomized, printable bingo boards, with a seed for repeatable sets.",
  category: "Generators",
  keywords: [
    "bingo card generator",
    "bingo board maker",
    "bingo sheet",
    "custom bingo",
    "printable bingo",
    "bingo generator",
    "free bingo cards",
    "classroom bingo",
  ],
  searchTerms: [
    "bingo maker",
    "bingo card creator",
    "bingo board generator",
    "party bingo",
    "office bingo",
    "custom bingo card",
    "bingo grid generator",
    "5x5 bingo",
    "random bingo cards",
    "printable bingo sheet",
  ],
  input: "text/plain",
  output: "application/json",
  options: [
    {
      kind: "select",
      id: "size",
      label: "Board size",
      default: "5",
      options: [
        { value: "3", label: "3 x 3", synonyms: ["small", "nine squares", "quick bingo"] },
        { value: "4", label: "4 x 4", synonyms: ["medium", "sixteen squares"] },
        {
          value: "5",
          label: "5 x 5",
          synonyms: ["standard", "classic bingo", "twenty five squares"],
        },
      ],
    },
    { kind: "boolean", id: "freeSpace", label: "Free space in the center", default: true },
    {
      kind: "text",
      id: "freeText",
      label: "Free space text",
      default: "FREE",
      placeholder: "FREE",
    },
    { kind: "number", id: "count", label: "Number of cards", default: 4, min: 1, max: 50 },
    {
      kind: "text",
      id: "title",
      label: "Board title",
      default: "",
      placeholder: "e.g. Office Party Bingo",
    },
  ],
  copy: {
    what: "Builds a bingo board by randomly placing your own items into a grid. Paste any list, one item per line, choose a 3x3, 4x4, or 5x5 size, and generate one card or a batch of many distinct cards at once, each with items shuffled into different cells so no two players can copy each other. A free center space is optional on odd sized boards, and its label is yours to set.",
    how: "Paste your list of items, one per line, into the box. Pick a board size, decide whether the center cell is a free space, set how many cards you need, and give the set a title if you want one printed above each card. Hit Shuffle to reroll with a fresh layout, then use Print for a page per card or Export PNG to save an image of one board at a time.",
    why: "Most bingo generators online require an account, cap you at a handful of cards, or slap a watermark on the printout. This one runs entirely in your browser: paste a list, generate as many cards as you need, and print or export straight away. Because the boards are built locally, your files and inputs never leave your device, and the page link captures the exact layout, so reopening it reproduces the same set of cards if you need a reprint.",
    faq: [
      {
        q: "How many items do I need for a 5x5 board?",
        a: "Twenty four unique items with the free space on, or twenty five with it off. A 4x4 needs sixteen, and a 3x3 needs eight with the free space on or nine without it. If you paste too few, the tool tells you exactly how many more to add.",
      },
      {
        q: "Will every card in a batch be different?",
        a: "Yes. Each card in a generated set uses its own derived seed, so item placement differs from card to card, while the whole batch stays reproducible: generating from the same list, size, and seed always produces the same set of cards again.",
      },
      {
        q: "Can I control which items appear together?",
        a: "Not directly. Placement is randomized across the whole grid so the boards stay fair, but you can influence variety by only listing items you are happy to see anywhere, and by regenerating with Shuffle until you like the layout.",
      },
    ],
  },
};
