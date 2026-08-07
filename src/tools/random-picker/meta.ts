import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'random-picker',
  matrixSlug: 'random',
  name: 'Dice & Random Picker',
  description: 'Dice, coin flips, list pickers and team splitters.',
  category: 'Generators',
  keywords: [
    'dice roller',
    'random picker',
    'coin flip',
    'team randomizer',
    'random name picker',
    'dice notation',
    'random team generator',
    'random number generator',
  ],
  searchTerms: [
    'd20 roller',
    'dnd dice roller',
    'tabletop dice',
    'heads or tails',
    'flip a coin',
    'random group generator',
    'shuffle teams',
    'raffle picker',
    'random name wheel',
    'randomizer',
    'pick a winner',
    'random draw',
  ],
  input: 'text/plain',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'mode',
      label: 'Mode',
      default: 'dice',
      choices: [
        { value: 'dice', label: 'Dice: roll notation like 3d6+2' },
        { value: 'coin', label: 'Coin flip' },
        { value: 'pick', label: 'Pick from list' },
        { value: 'teams', label: 'Split into teams' },
      ],
    },
    {
      kind: 'number',
      id: 'count',
      label: 'Count (flips / picks / teams)',
      default: 1,
      min: 1,
      max: 100,
    },
    {
      kind: 'text',
      id: 'seed',
      label: 'Seed (optional, for repeatable results)',
      default: '',
      placeholder: 'leave empty for true randomness',
    },
  ],
  copy: {
    what: 'Rolls dice from standard notation (3d6+2, d20), flips one or more coins, picks distinct random items from a list, or splits a list of names into randomized, evenly-sized teams. One tool for the "I need something random for tabletop/game night/team standup" moment.',
    how: 'Pick a mode. For dice, type notation like "2d6+3" into the input. For pick or teams, paste one item or name per line and set the count (items to pick, or number of teams). For coin, the input is ignored: just set how many times to flip. Leave the seed blank for true randomness, or set it to get the exact same result every time you run it.',
    why: 'Dice-roller and team-randomizer sites are typically cluttered with ads and force a page reload per roll. This one runs instantly in your browser, supports a reproducible seed for when you need to prove a roll or replay a draft, and never sends your list of names anywhere.',
    faq: [
      {
        q: 'What dice notation is supported?',
        a: 'Standard NdM(+/-K) notation: an optional dice count, "d", the number of sides, and an optional modifier, e.g. "d20", "3d6", or "2d6+3".',
      },
      {
        q: 'How does the seed work?',
        a: 'Leave it empty for cryptographically random results. Set it to any text and the tool switches to a deterministic PRNG seeded from that text, so the same seed plus the same input always reproduces the exact same rolls, flips, picks, or teams.',
      },
      {
        q: 'How are teams split?',
        a: 'Names are shuffled, then dealt round-robin into the requested number of teams, so sizes differ by at most one: 7 names into 3 teams gives 3/2/2.',
      },
    ],
  },
};
