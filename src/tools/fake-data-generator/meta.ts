import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'fake-data-generator',
  matrixSlug: 'fake-data',
  name: 'Fake Data Generator',
  description:
    'Bulk names, emails, addresses, IDs and JSON fixtures, with a seed for repeatable output.',
  category: 'Data',
  keywords: [
    'fake data generator',
    'dummy data',
    'test data generator',
    'random name generator',
    'fake address generator',
    'sample json data',
    'mock user data',
    'faker online',
  ],
  input: 'none',
  output: 'text/plain',
  options: [
    {
      kind: 'select',
      id: 'type',
      label: 'Data type',
      default: 'people',
      choices: [
        { value: 'people', label: 'People — name, email, phone' },
        { value: 'addresses', label: 'Addresses' },
        { value: 'companies', label: 'Companies' },
        { value: 'users-json', label: 'Users (JSON fixture)' },
        { value: 'credit-cards', label: 'Credit cards — fake numbers' },
        { value: 'lorem', label: 'Lorem ipsum paragraphs' },
      ],
    },
    { kind: 'number', id: 'count', label: 'Count', default: 5, min: 1, max: 100 },
    {
      kind: 'text',
      id: 'seed',
      label: 'Seed',
      default: '',
      placeholder: 'Leave blank for random',
    },
  ],
  copy: {
    what: 'Generates realistic-looking placeholder data for testing, demos, and seeding databases: people with matching names, emails and phone numbers; street addresses; company names; fake credit card numbers whose digits match their issuer; lorem ipsum paragraphs; and a ready-to-paste JSON fixture array of users with id, name, email and a structured address. Up to 100 records per run. Every value is invented — no real person, address, or card is ever produced.',
    how: 'Pick a data type, set how many records you want, and hit Generate. Leave the seed blank for fresh data every time, or type any word into the seed field to lock the output — the same seed always produces exactly the same records, which is what you want for reproducible test fixtures and stable screenshots. Copy the block straight into your seed script, spreadsheet, or test file.',
    why: 'The usual mock-data sites gate the good stuff behind a signup, cap free rows, or push a paid API. This runs entirely in your browser with no account and no row limit beyond the 100-per-run cap, and because generation is local your generated fixtures never leave your device or get logged on someone else’s server. The seed field is the part most online generators skip — it makes output reproducible instead of throwaway.',
    faq: [
      {
        q: 'Do the fake credit card numbers work?',
        a: 'No — and that is the point. They pass the Luhn checksum and carry the right prefix for their issuer, so they exercise your validation code, but no bank will authorize them. Use them for form testing only.',
      },
      {
        q: 'How do I get the same data twice?',
        a: 'Type anything into the seed field. That string is hashed to a number and fed to the generator, so "staging-fixtures" always yields the identical set of records — on any machine, in any browser, today or next year.',
      },
      {
        q: 'Are these real names, emails, or addresses?',
        a: 'No. Names, street names, cities, and email domains are assembled from generic word lists, so a result can coincidentally resemble a real person or address, but nothing is drawn from any real dataset. Do not mail anything to a generated address.',
      },
    ],
  },
};
