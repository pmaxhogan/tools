import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'oauth-scope-decoder',
  matrixSlug: 'oauth-scopes',
  name: 'OAuth Scope Decoder',
  description: 'Turn an OAuth scope list into plain English access and an honest risk read.',
  category: 'Crypto',
  keywords: [
    'oauth scopes explained',
    'what can this app access',
    'google oauth scope list meaning',
    'github oauth repo scope',
    'is this permission dangerous',
    'microsoft graph permissions explained',
    'decode jwt scope claim',
  ],
  searchTerms: [
    'scope checker',
    'consent screen decoder',
    'app permissions checker',
    'oauth consent url parser',
    'jwt scp claim',
    'access token scope reader',
    'slack oauth scopes',
    'discord oauth scopes',
    'stripe api scope',
    'zoom oauth scopes',
    'salesforce oauth scopes',
    'spotify oauth scopes',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'sort',
      label: 'Sort',
      default: 'risk',
      choices: [
        { value: 'risk', label: 'Widest access first' },
        { value: 'input', label: 'Order I pasted' },
      ],
    },
    { kind: 'boolean', id: 'hideLow', label: 'Hide low risk scopes', default: false },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Reads a list of OAuth scopes and says, in one sentence each, what the app can actually do with them. It covers Google, Microsoft Graph, GitHub, Slack, Discord, Shopify, Stripe, Zoom, Dropbox, Atlassian, Salesforce, Spotify, X and plain OpenID Connect, plus the generic scopes every provider shares. Each row carries a risk level from low to critical and a short reason for it, and a summary line counts how many scopes sit at each level. Risk describes what a scope permits, never an accusation that a particular app misuses it.',
    how: 'Paste the scopes separated by spaces, commas or newlines. You can also paste a whole consent or authorize URL and the scope parameter is pulled out of the query string or the fragment for you, or paste an access token in JWT form and the scope or scp claim is read straight out of its payload without any signature check. Sort by widest access first to see the scopes worth arguing about, or switch to the order you pasted, and hide the low risk rows when the list is long.',
    why: 'Consent screens describe permissions in vague marketing language, and the real definitions are scattered across a dozen provider documentation sites that each use their own naming style. This reads the whole list in one place and grades it consistently, so a Microsoft Graph .All suffix and a GitHub repo scope can be compared side by side. It runs entirely in the page: your files and inputs never leave your device, which matters when the thing you are pasting is a live access token.',
    faq: [
      {
        q: 'Why does risk matter if I already trust the app?',
        a: 'Trust in a company is not the same as trust in every future version of its code, its contractors, or whoever ends up with a copy of its database. A scope decides what a breach of that app costs you, so the useful question is not whether the developer is honest but whether the access is bigger than the feature needs. A calendar app asking for full Drive access is worth a second look even when the developer is entirely reputable.',
      },
      {
        q: 'What does offline_access actually mean?',
        a: 'It gives the app a refresh token, so it can mint new access tokens and keep using everything it was granted when you are not signed in or not using it at all. That access continues until you revoke the app in your provider account settings, not until you close the tab. It is the difference between an app that reads your mail while you watch and one that reads it at three in the morning.',
      },
      {
        q: 'Is the token I paste uploaded anywhere?',
        a: 'No. The decoding, the catalog lookup and the risk grading all happen in your browser, and your files and inputs never leave your device. JWT payloads are decoded locally with no signature verification, because reading the scope claim does not require the signing key.',
      },
    ],
  },
};
