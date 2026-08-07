import { Faker, en } from '@faker-js/faker';
import { ToolError, type ToolLogic } from '../types';

export interface FakeDataOpts {
  /** One of DATA_TYPES. */
  type: string;
  /** How many records to generate (1–100). */
  count: number;
  /** Empty = fresh randomness; non-empty = deterministic output for that string. */
  seed: string;
  [key: string]: unknown;
}

export const DATA_TYPES = [
  'people',
  'addresses',
  'companies',
  'users-json',
  'credit-cards',
  'lorem',
] as const;

export type DataType = (typeof DATA_TYPES)[number];

/**
 * FNV-1a over the UTF-16 code units, folded to a uint32. Any non-empty seed
 * string maps to a stable number so `faker.seed(n)` reproduces byte-identical
 * output across runs, machines, and processes.
 */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 keeps it a non-negative 32-bit integer.
  return h >>> 0;
}

/** A cryptographically random uint32, used when the user left the seed blank. */
function randomSeed(): number {
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return a[0]!;
}

/**
 * A fresh Faker instance per run. Faker's seed is instance state, so creating
 * one here (instead of reaching for the shared singleton) keeps `run` pure —
 * two calls never influence each other.
 */
function makeFaker(seed: string): Faker {
  const f = new Faker({ locale: en });
  f.seed(seed ? hashSeed(seed) : randomSeed());
  return f;
}

/** "Ada Lovelace <ada.lovelace@example.com> · 555-0134" */
function person(f: Faker): string {
  const first = f.person.firstName();
  const last = f.person.lastName();
  const email = f.internet.email({ firstName: first, lastName: last });
  return `${first} ${last} <${email}> · ${f.phone.number()}`;
}

/** "742 Evergreen Terrace, Apt. 4, Springfield, IL 62704, United States" */
function address(f: Faker): string {
  const parts = [
    f.location.streetAddress(),
    f.location.secondaryAddress(),
    f.location.city(),
    `${f.location.state({ abbreviated: true })} ${f.location.zipCode()}`,
    f.location.country(),
  ];
  return parts.join(', ');
}

/** "Acme Corp · Engineering · synergize scalable metrics" */
function company(f: Faker): string {
  return `${f.company.name()} · ${f.commerce.department()} · ${f.company.buzzPhrase()}`;
}

/** "visa · 4352-4363-4749-1740 · CVV 465": issuer and number always agree. */
function creditCard(f: Faker): string {
  const issuer = f.finance.creditCardIssuer();
  const number = f.finance.creditCardNumber({ issuer });
  return `${issuer} · ${number} · CVV ${f.finance.creditCardCVV()}`;
}

export interface FakeUser {
  id: string;
  name: string;
  email: string;
  address: {
    street: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
}

export function userRecord(f: Faker): FakeUser {
  const first = f.person.firstName();
  const last = f.person.lastName();
  return {
    id: f.string.uuid(),
    name: `${first} ${last}`,
    email: f.internet.email({ firstName: first, lastName: last }),
    address: {
      street: f.location.streetAddress(),
      city: f.location.city(),
      state: f.location.state({ abbreviated: true }),
      zip: f.location.zipCode(),
      country: f.location.country(),
    },
  };
}

const LINE_GENERATORS: Record<string, (f: Faker) => string> = {
  people: person,
  addresses: address,
  companies: company,
  'credit-cards': creditCard,
};

export function run(_input: undefined, opts: FakeDataOpts): string {
  const type = opts.type || 'people';
  if (!(DATA_TYPES as readonly string[]).includes(type))
    throw new ToolError(
      'bad-type',
      `Unknown data type "${type}".`,
      `Pick one of: ${DATA_TYPES.join(', ')}.`,
    );

  const count = Math.floor(Number(opts.count));
  if (!Number.isFinite(count) || count < 1 || count > 100)
    throw new ToolError(
      'bad-count',
      'Count must be between 1 and 100.',
      'Lower the count: 100 records per run is the cap.',
    );

  const f = makeFaker(typeof opts.seed === 'string' ? opts.seed.trim() : '');

  if (type === 'users-json') {
    const users = Array.from({ length: count }, () => userRecord(f));
    return JSON.stringify(users, null, 2);
  }

  if (type === 'lorem') {
    // count = paragraphs. Blank line between them, like real prose.
    return Array.from({ length: count }, () => f.lorem.paragraph()).join('\n\n');
  }

  const gen = LINE_GENERATORS[type]!;
  return Array.from({ length: count }, () => gen(f)).join('\n');
}

export default { run } satisfies ToolLogic<undefined, string, FakeDataOpts>;
