import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'gam-command-builder',
  matrixSlug: 'gam',
  name: 'GAM Command Builder',
  description:
    'Build correct GAM commands for Google Workspace admin tasks from plain English intent.',
  category: 'Homelab',
  keywords: [
    'gam command builder',
    'gam suspend user command',
    'gam google workspace examples',
    'gamadv-xtd3 syntax',
    'gam bulk users',
    'gam transfer drive ownership',
    'gam offboard user checklist',
  ],
  input: 'text/plain',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'category',
      label: 'Category',
      default: 'all',
      choices: [
        { value: 'all', label: 'All categories' },
        { value: 'users', label: 'Users' },
        { value: 'groups', label: 'Groups' },
        { value: 'drive', label: 'Drive and shared drives' },
        { value: 'gmail', label: 'Gmail' },
        { value: 'calendar', label: 'Calendar' },
        { value: 'org-units', label: 'Org units' },
        { value: 'licenses', label: 'Licenses' },
        { value: 'reports', label: 'Reports, devices and diagnostics' },
      ],
    },
    {
      kind: 'boolean',
      id: 'gamadv',
      label: 'I still run GAMADV-XTD3',
      default: false,
    },
  ],
  http: { method: 'GET', contentType: 'application/json' },
  copy: {
    what: 'Describe a Google Workspace admin task in plain English and this returns the GAM command that does it, with every angle bracket placeholder explained and a filled in example you can adapt. The catalog is hand written against the GAM7 wiki and the BNF grammar GAM ships beside its binary, and it covers users, groups, org units, licenses, Drive and shared drives, Gmail, Calendar, reports and device management. Each recipe carries the gotchas that bite in practice, such as Git Bash rewriting a leading slash org unit path into a Windows directory, print filelist quietly adding an owner clause to your query so it returns nothing and exits happy, max_to_trash defaulting to one rather than unlimited, and Gmail deletions staying a dry run until you append doit. Commands that change or remove data are flagged, and the handful of recipes that only one fork accepts say so.',
    how: 'Type what you want to do, like "suspend a user", "transfer drive ownership" or "wipe a mobile device". One clear winner expands into the full breakdown: the command template, each parameter with a description and an example, the notes, and an assembled example command you can copy. A broader search lists the matching recipes with their commands so you can pick one, and searching a recipe id such as user-suspend or user-offboard jumps straight to it. Set the category to narrow the catalog, and turn on the GAMADV-XTD3 switch if you are still on that fork so its spellings rank first and the GAM7 only ones get marked.',
    why: "GAM's power is real, but its documentation is a wiki maze, the forks blur together in every search result, and one wrong flag lands on your whole domain rather than the one account you meant. Worse, several of GAM's sharpest traps fail silently: a query that returns zero rows and exit code zero, or a domain wide cleanup that quietly skips every mailbox with more than one match. This gives you the command, its placeholders and the gotcha in one screen, with destructive operations called out and a dry run suggested before you commit. It never touches your Workspace, holds no credentials and asks for no admin consent, because it only writes text: your files and inputs never leave your device.",
    faq: [
      {
        q: 'Does this run the commands against my Workspace?',
        a: 'No. It only builds the text of a command for you to read, adapt and paste into your own terminal, where your own GAM install and your own admin credentials decide what actually happens. There is no Google sign in here, no OAuth consent, and no connection to your domain at all. Nothing is executed until you run it yourself.',
      },
      {
        q: 'GAM7 or GAMADV-XTD3, which syntax do I get?',
        a: 'GAM7, and for almost every command that is the same answer either way. GAMADV-XTD3 was not a rival fork that drifted apart, it is the lineage GAM7 continues: its own README says it has been replaced by GAM7, and its last release was 7.05.08 in March 2025. So GAM7 is mostly a superset, and only a handful of recipes here are genuinely fork specific, each labelled and explained. The real syntax mismatch people hit is legacy GAM 4, 5 and 6, the older gam.py lineage, which is a different thing again. Run gam version before you trust any example you found online.',
      },
      {
        q: 'Is what I type here uploaded anywhere?',
        a: 'No. The catalog ships with the page and the search runs in your browser, so your files and inputs never leave your device. That matters here, because the words you search are a fair description of what you are about to do to your organization, and the example values you adapt tend to contain real user addresses and real file ids.',
      },
    ],
  },
};
