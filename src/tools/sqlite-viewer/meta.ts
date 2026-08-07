import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'sqlite-viewer',
  matrixSlug: 'sqlite',
  name: 'SQLite Browser',
  description: 'Drop a .db file and browse tables or run SQL, all in your browser.',
  category: 'Data',
  keywords: [
    'sqlite viewer online',
    'open db file',
    'browse sqlite in browser',
    'sql.js viewer',
    'query sqlite file',
    'sqlite browser online',
    'read .sqlite3 file',
  ],
  input: 'File',
  output: 'text/plain',
  options: [
    {
      kind: 'number',
      id: 'maxRows',
      label: 'Rows per page',
      default: 100,
      min: 10,
      max: 1000,
      step: 10,
    },
    {
      kind: 'number',
      id: 'maxCell',
      label: 'Characters per cell',
      default: 40,
      min: 8,
      max: 400,
      step: 4,
    },
  ],
  copy: {
    what: 'Opens a SQLite database file, .db, .sqlite or .sqlite3, and gives you a real browser for it. It lists every table with its row count, shows each column with its declared type and a marker on the primary key, and pages through rows a hundred at a time. There is also a SQL box that runs whatever you type against a full SQLite build, including several statements at once, and SQLite errors come back word for word rather than as a generic failure. Views and indexes are listed alongside the tables, and the header reports the file size, the SQLite version and the page size read from a pragma.',
    how: 'Drop a database file onto the panel or pick one with the file button. Click a table in the list to browse it, then use prev and next to walk through the pages. To query, type SQL into the box and press Run, or press Ctrl and Enter. Writes are allowed because you are working on a copy held in memory, so an UPDATE or a CREATE TABLE works normally; press "Download database" to save the modified copy as a file, or "Export CSV" to save the result set you are looking at.',
    why: 'Most online database viewers ask you to upload the file, and a SQLite database is usually the actual user data behind an app: accounts, messages, locations, purchase history. Handing that to a stranger for a read only preview is a bad trade. This one compiles SQLite to WebAssembly and runs it in the tab you already have open, so your files and inputs never leave your device, and you still get real SQL rather than a crippled preview with a row limit and a paywall.',
    faq: [
      {
        q: 'Can I edit the database, not just read it?',
        a: 'Yes. The file is loaded into memory and the SQL box accepts INSERT, UPDATE, DELETE, CREATE and anything else SQLite understands. Nothing is written back to the file you dropped, because a web page cannot reach into your disk like that. When you are happy with the changes, press "Download database" and you get the modified copy as a new file to keep or to swap in yourself.',
      },
      {
        q: 'How large a database can it open?',
        a: 'The whole file is loaded into memory, so it is limited by the tab rather than by the tool. Databases up to roughly a hundred megabytes open comfortably on an ordinary laptop. Past a few hundred megabytes the tab will get slow or run out of memory, and at that point a desktop client is the right tool. Very wide result sets are paged rather than rendered all at once, so a big table is fine as long as the file itself fits.',
      },
      {
        q: 'Is my database uploaded anywhere?',
        a: 'No. SQLite itself is compiled to WebAssembly and served from this site, and the database is opened and queried inside the page: your files and inputs never leave your device. This tool deliberately has no API endpoint, because posting a database file to a server is exactly the risk it exists to remove.',
      },
    ],
  },
};
