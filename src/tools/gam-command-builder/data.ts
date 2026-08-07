/**
 * Curated GAM recipe catalog for the gam-command-builder tool.
 *
 * Scope rule: accuracy beats coverage. Every template here was checked against
 * the GAM7 wiki and the BNF grammar GAM ships beside its binary
 * (GamCommands.txt, GAM7 7.47.02), not written from memory. Nothing is
 * invented to round out a category.
 *
 * Fork note, which most search results get wrong: GAMADV-XTD3 was replaced by
 * GAM7. Its README says so, its last release was 7.05.08 in March 2025, and
 * GAM7 is the continuation of that same lineage. So the two accept nearly the
 * same syntax and GAM7 is mostly a superset. The real syntax mismatch people
 * hit is legacy GAM 4, 5 and 6, the older gam.py lineage, which is a different
 * thing again. `variant` here marks only the handful of genuine differences.
 *
 * Prose rule: no em dashes or en dashes anywhere in this file, because every
 * string here can end up in the rendered output.
 */

export type RecipeCategory =
  | 'users'
  | 'groups'
  | 'drive'
  | 'gmail'
  | 'calendar'
  | 'org-units'
  | 'licenses'
  | 'reports';

export interface RecipeParam {
  /** Matches a `<name>` placeholder in the template, exactly. */
  name: string;
  /** One sentence: what to put here. */
  description: string;
  /** A realistic value, used to assemble the example command. */
  example: string;
  required: boolean;
}

export interface Recipe {
  /** Stable, searchable id, e.g. "user-suspend". */
  id: string;
  /** Plain English label, also the output row key, so it must be unique. */
  task: string;
  category: RecipeCategory;
  /** The command, with `<angle bracket>` placeholders. */
  template: string;
  params: RecipeParam[];
  /** Gotchas. May be empty, but a gotcha that exists must be here. */
  notes: string[];
  /** Which fork accepts this spelling. Missing means both. */
  variant?: 'gam7' | 'gamadv' | 'both';
  /** True when running it changes or removes data. */
  destructive?: boolean;
}

export const CATEGORIES: { id: RecipeCategory; label: string }[] = [
  { id: 'users', label: 'Users' },
  { id: 'groups', label: 'Groups' },
  { id: 'drive', label: 'Drive and shared drives' },
  { id: 'gmail', label: 'Gmail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'org-units', label: 'Org units' },
  { id: 'licenses', label: 'Licenses' },
  { id: 'reports', label: 'Reports, devices and diagnostics' },
];

/** Reused note text, so one wording change does not have to be made 20 times. */
const GIT_BASH_SLASH =
  'On Windows in Git Bash, put MSYS_NO_PATHCONV=1 in front of the command, or the shell rewrites the leading slash org unit path into a Windows directory and GAM reports that an org unit you never typed does not exist.';

const OU_SYNONYMS = 'GAM accepts ou, org and orgunitpath as the same argument, so pick whichever reads best.';

const DOIT_DRY_RUN =
  'Destructive Gmail operations are a dry run until you append doit, so run it once without doit to see the blast radius first.';

const P = {
  user: {
    name: 'user',
    description: 'The primary email address of the account you are acting on.',
    example: 'jdoe@example.com',
    required: true,
  },
  ou: {
    name: 'ou',
    description: 'An org unit path, always starting with a slash.',
    example: '/Staff/Finance',
    required: true,
  },
  group: {
    name: 'group',
    description: 'The email address of the group.',
    example: 'sales@example.com',
    required: true,
  },
  fileid: {
    name: 'fileid',
    description: 'The Drive file or folder id, the long string in the document URL.',
    example: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
    required: true,
  },
  driveid: {
    name: 'driveid',
    description: 'The shared drive id, visible in the drive URL after /drive/folders/.',
    example: '0ABcDeFgHiJkUk9PVA',
    required: true,
  },
  sku: {
    name: 'sku',
    description:
      'A licence SKU id or one of GAM\'s aliases, such as 1010020028, wsbizstan, 1010020020, wsentplus or Google-Apps-Unlimited.',
    example: '1010020028',
    required: true,
  },
} satisfies Record<string, RecipeParam>;

export const RECIPES: Recipe[] = [
  // ------------------------------------------------------------------ users
  {
    id: 'user-create',
    task: 'Create a user account',
    category: 'users',
    template:
      'gam create user <email> firstname "<firstname>" lastname "<lastname>" password "<password>" changepassword on ou <ou>',
    params: [
      {
        name: 'email',
        description: 'The primary email address for the new account.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'firstname',
        description: 'Given name. GAM also accepts givenname as a synonym.',
        example: 'Jane',
        required: true,
      },
      {
        name: 'lastname',
        description: 'Family name. GAM also accepts familyname as a synonym.',
        example: 'Doe',
        required: true,
      },
      {
        name: 'password',
        description:
          'The starting password. Write the word random instead of a quoted string to have GAM generate one and print it.',
        example: 'ChangeMe-4718',
        required: true,
      },
      {
        name: 'ou',
        description: 'The org unit the account should land in. Leave the clause off for the root.',
        example: '/Staff/Finance',
        required: false,
      },
    ],
    notes: [
      'changepassword takes a boolean, and GAM reads on, true, yes, enabled and 1 as true, so changepassword on and changepassword true are the same thing.',
      GIT_BASH_SLASH,
      'You can do the whole onboarding in one command by adding license <SKUIDList> and notify <EmailAddressList>, which mails the new credentials somewhere you can reach.',
    ],
  },
  {
    id: 'user-suspend',
    task: 'Suspend a user',
    category: 'users',
    template: 'gam update user <user> suspended on',
    params: [P.user],
    notes: [
      'gam suspend user <user> is an equivalent standalone verb if you prefer it.',
      'Suspending does not revoke OAuth tokens or app specific passwords, so a suspended account can still be reachable through a connected third party app. Run the deprovision recipe as well, and run it before you suspend, because backup codes cannot be cleared on a suspended account.',
      'Reversible with suspended off, and the mailbox and Drive contents stay intact while suspended.',
    ],
    destructive: true,
  },
  {
    id: 'user-unsuspend',
    task: 'Unsuspend a user',
    category: 'users',
    template: 'gam update user <user> suspended off',
    params: [P.user],
    notes: [
      'gam unsuspend user <user> is an equivalent standalone verb.',
      'The account returns to the org unit it was in, so check that the org unit still has the policies you expect before you hand the account back.',
    ],
  },
  {
    id: 'user-password-reset',
    task: 'Reset a password and force a change at next sign in',
    category: 'users',
    template: 'gam update user <user> password "<password>" changepassword on',
    params: [
      P.user,
      {
        name: 'password',
        description:
          'The new password. Write random instead of a quoted string to have GAM generate and print one.',
        example: 'Temp-Pass-9042',
        required: true,
      },
    ],
    notes: [
      'password also accepts random, uniquerandom, blocklogin and prompt, so gam update user <user> password random changepassword on avoids inventing one yourself.',
      'Add notify <EmailAddressList> to have GAM mail the new password to an address the person can actually reach.',
      'A password reset does not end existing sessions. Pair it with the sign out recipe when you are responding to a compromise.',
    ],
  },
  {
    id: 'user-info',
    task: 'Show everything about one user',
    category: 'users',
    template: 'gam info user <user>',
    params: [P.user],
    notes: [
      'This can be slow. The Licensing API has no call that lists a user\'s licences, so GAM probes every SKU it knows one at a time, which burns quota. Run gam show configlicenseskus once and save the result into license_skus in gam.cfg to limit the probing to SKUs you actually own.',
      'If you only need a few attributes across a lot of accounts, gam print users with a fields clause is far cheaper than looping info user.',
    ],
  },
  {
    id: 'user-delete',
    task: 'Delete a user account',
    category: 'users',
    template: 'gam delete user <user>',
    params: [P.user],
    notes: [
      'Google keeps a deleted account restorable for 20 days, after which it is gone. Transfer Drive and any shared drive membership before you delete, not after.',
      'Add noactionifalias so the command quietly does nothing if the address you typed turns out to be an alias rather than a real account.',
    ],
    destructive: true,
  },
  {
    id: 'user-undelete',
    task: 'Undelete a recently deleted user',
    category: 'users',
    template: 'gam undelete user <user> ou <ou>',
    params: [
      P.user,
      {
        name: 'ou',
        description:
          'Where to put the restored account. Leave the clause off to return it to its original org unit.',
        example: '/Staff/Finance',
        required: false,
      },
    ],
    notes: [
      'Only works inside Google\'s 20 day window, and only if the address has not been reused.',
      OU_SYNONYMS,
      GIT_BASH_SLASH,
    ],
  },
  {
    id: 'user-move-ou',
    task: 'Move a user into a different org unit',
    category: 'users',
    template: 'gam update user <user> ou <ou>',
    params: [P.user, P.ou],
    notes: [
      OU_SYNONYMS,
      GIT_BASH_SLASH,
      'For more than a handful of people, run it from the org unit side instead: gam update ou <path> add users <list> batches the moves and is much faster.',
    ],
  },
  {
    id: 'user-rename',
    task: 'Change a user\'s primary email address',
    category: 'users',
    template: 'gam update user <user> primaryemail <newemail>',
    params: [
      P.user,
      {
        name: 'newemail',
        description: 'The address the account should answer to from now on.',
        example: 'jane.doe@example.com',
        required: true,
      },
    ],
    notes: [
      'email, primaryemail and username are all accepted for this attribute.',
      'Check afterwards whether the old address survived as an alias, and add one yourself if people still need to mail the old name.',
      'The directory lags writes, so if you plan to reuse the freed address for a group, re-check the state before you create it rather than retrying blind.',
    ],
  },
  {
    id: 'user-print-all',
    task: 'List users with a query and the fields you care about',
    category: 'users',
    template: 'gam print users query "<query>" fields <fields>',
    params: [
      {
        name: 'query',
        description:
          'A raw Google Directory search string, the same syntax the admin console search box uses.',
        example: "orgUnitPath='/Staff'",
        required: true,
      },
      {
        name: 'fields',
        description:
          'Comma separated field names. primaryemail, name, ou, suspended, lastlogintime and creationtime are the usual ones.',
        example: 'primaryemail,name,ou,suspended,lastlogintime',
        required: true,
      },
    ],
    notes: [
      'Without a fields, basic, full or allfields clause you get almost nothing back, so always name the fields.',
      'GAM splits list arguments on spaces as well as commas, so a query containing a space needs the double quote around single quote form, like queries "\'orgUnitPath=/Middle School\'".',
      'Prefer the first class flags over a hand written query where one exists: issuspended, isarchived and limittoou <path> are all real arguments.',
      'orgunitpath, org and ou are the same field name here, so pick one and stay consistent across your scripts.',
    ],
  },
  {
    id: 'user-print-ou',
    task: 'List everyone in an org unit and everything under it',
    category: 'users',
    template: 'gam ou_and_children <ou> print users fields primaryemail,name,ou,suspended',
    params: [P.ou],
    notes: [
      'ou, ou_and_children, ous, ous_and_children, group, group_users, all users, query and file are all valid ways to name the set of users a command runs over, and they work the same on almost every user command.',
      GIT_BASH_SLASH,
      'ou selects that org unit only. ou_and_children walks the subtree, which is almost always what you meant.',
    ],
  },
  {
    id: 'user-deprovision',
    task: 'Cut off a leaver\'s tokens, app passwords and backup codes',
    category: 'users',
    template: 'gam user <user> deprovision popimap signout turnoff2sv',
    params: [P.user],
    notes: [
      'deprovision deletes the account\'s application specific passwords, backup verification codes and OAuth access tokens. The three optional words add turning off POP and IMAP, signing out of every session, and turning off 2 step verification.',
      'Run this before you suspend the account. On a suspended user GAM reports that backup verification codes were not deprovisioned because the user is suspended, and you have to unsuspend to finish the job.',
      'deprov is an accepted short form.',
    ],
    destructive: true,
  },
  {
    id: 'user-signout',
    task: 'Sign a user out of every session',
    category: 'users',
    template: 'gam user <user> signout',
    params: [P.user],
    notes: [
      'Takes no arguments. Use it after a password reset, because resetting a password on its own does not end sessions that are already open.',
      'To revoke one connected application instead of everything, use gam user <user> delete tokens clientid <ClientID>. There is no delete all tokens form on that command, which is what deprovision is for.',
    ],
  },
  {
    id: 'user-offboard',
    task: 'Offboard a leaver, in the order that actually works',
    category: 'users',
    template: `gam user <user> deprovision popimap signout turnoff2sv
gam user <user> add forwardingaddress <manager>
gam user <user> forward on archive <manager>
gam user <user> add delegate <manager>
gam create datatransfer <user> gdrive <manager> privacy_level shared,private
gam update user <user> suspended on ou <ou>
gam user <user> delete license <sku>`,
    params: [
      P.user,
      {
        name: 'manager',
        description: 'Whoever inherits the mail and the files, usually the leaver\'s manager.',
        example: 'manager@example.com',
        required: true,
      },
      {
        name: 'ou',
        description: 'An org unit you use to park departed staff, with sign in and sharing locked down.',
        example: '/Leavers',
        required: true,
      },
      P.sku,
    ],
    notes: [
      'The order matters. Deprovision first, because backup codes cannot be cleared once the account is suspended. Suspend near the end, because a suspended account can still be a data transfer source but is much less pleasant to work with.',
      'The Data Transfer API defaults to shared files only, so without privacy_level shared,private the leaver\'s private files stay behind and vanish with the account.',
      'Do not remove the licence until gam show datatransfers reports the transfer finished. A half transferred Drive is not something you can restart cleanly.',
      'Forwarding only starts once the destination address shows an accepted verification status, so check gam user <user> show forwardingaddresses before you trust it.',
      GIT_BASH_SLASH,
    ],
    destructive: true,
  },
  {
    id: 'user-alias-create',
    task: 'Add an email alias to a user',
    category: 'users',
    template: 'gam create alias <alias> user <user>',
    params: [
      {
        name: 'alias',
        description: 'The extra address that should deliver to this account.',
        example: 'jane@example.com',
        required: true,
      },
      P.user,
    ],
    notes: [
      'Watch the argument order. On create and delete the alias comes first. On gam remove alias the target comes first and the aliases second, which is the opposite way round.',
      'An address can be a user alias or a group, never both.',
    ],
  },
  {
    id: 'user-alias-delete',
    task: 'Remove an email alias',
    category: 'users',
    template: 'gam delete alias <alias>',
    params: [
      {
        name: 'alias',
        description: 'The alias address to remove. The account itself is untouched.',
        example: 'jane@example.com',
        required: true,
      },
    ],
    notes: [
      'The directory lags writes. Deleting an alias and immediately creating a group at the same address fails as a duplicate, so re-check the state and retry rather than hammering the same command.',
      'gam update alias is implemented as a delete followed by a recreate, which is why it has a waitafterdelete argument.',
    ],
    destructive: true,
  },
  {
    id: 'user-bulk-csv',
    task: 'Run one command for every row of a CSV',
    category: 'users',
    template: 'gam csv <csvfile> gam update user ~primaryEmail ou <ou>',
    params: [
      {
        name: 'csvfile',
        description: 'A CSV whose header row names the columns you substitute in.',
        example: 'movers.csv',
        required: true,
      },
      P.ou,
    ],
    notes: [
      'Substitution has three forms: ~column when the argument is nothing but the field, ~~column~~ when it is embedded in other text, and ~~column~!~pattern~!~replacement~~ for a regex substitution.',
      'gam csv runs the rows in parallel. gam loop takes the same arguments and runs them one at a time, which is what you want when the order matters or you are watching for the first failure.',
      'To collect the output of a parallel run into one file, prefix the whole thing with gam redirect csv <file> multiprocess. Without multiprocess each subprocess writes its own separate file.',
      'Never pipe a long live run through tail. tail buffers until the process exits, so progress and mid run errors are invisible. Redirect to a file, or let it stream.',
    ],
  },

  // ----------------------------------------------------------------- groups
  {
    id: 'group-create',
    task: 'Create a group',
    category: 'groups',
    template: 'gam create group <group> name "<name>" description "<description>"',
    params: [
      P.group,
      {
        name: 'name',
        description: 'The display name people see in the directory.',
        example: 'Sales Team',
        required: true,
      },
      {
        name: 'description',
        description: 'What the group is for. Future you will be grateful.',
        example: 'Everyone in the sales organisation',
        required: false,
      },
    ],
    notes: [
      'Add copyfrom <GroupItem> to clone the settings of a group you already trust rather than setting a dozen options by hand.',
      'If you just freed the address by deleting an alias or another group, the create can fail as a duplicate because the directory lags writes. Wait and re-check rather than retrying in a loop.',
    ],
  },
  {
    id: 'group-add-member',
    task: 'Add someone to a group',
    category: 'groups',
    template: 'gam update group <group> add member <user>',
    params: [P.group, P.user],
    notes: [
      'The role is owner, manager or member, and the singular and plural spellings both work.',
      'The member argument is a full user entity, so gam update group <group> add member ou /Staff adds a whole org unit in one go.',
      'Add preview to see what would happen without doing it, and actioncsv to get a machine readable record of what did happen.',
    ],
  },
  {
    id: 'group-add-manager',
    task: 'Make someone a manager or owner of a group',
    category: 'groups',
    template: 'gam update group <group> add <role> <user>',
    params: [
      P.group,
      {
        name: 'role',
        description: 'owner, manager or member.',
        example: 'manager',
        required: true,
      },
      P.user,
    ],
    notes: [
      'add creates the membership, so pointing it at somebody who is already in the group may fail as a duplicate. Use the update sub verb to change an existing member\'s role.',
    ],
  },
  {
    id: 'group-change-role',
    task: 'Change an existing member\'s role in a group',
    category: 'groups',
    template: 'gam update group <group> update <role> <user>',
    params: [
      P.group,
      {
        name: 'role',
        description: 'The role they should hold from now on: owner, manager or member.',
        example: 'manager',
        required: true,
      },
      P.user,
    ],
    notes: [
      'This is the reason the update sub verb exists. On the remove sub verb the role is ignored entirely, so removing a manager as a member still removes them.',
      'Add createifnotfound to create the membership when the person is not in the group yet.',
    ],
  },
  {
    id: 'group-remove-member',
    task: 'Take someone out of a group',
    category: 'groups',
    template: 'gam update group <group> remove <user>',
    params: [P.group, P.user],
    notes: [
      'You can pass a role, but GAM ignores it on remove. Whatever role they hold, they are removed.',
      'Add preview first if the target is an entity like an org unit rather than one address.',
    ],
  },
  {
    id: 'group-sync-members',
    task: 'Make a group\'s membership match a list exactly',
    category: 'groups',
    template: 'gam update group <group> sync member ou <ou> preview',
    params: [P.group, P.ou],
    notes: [
      'sync adds who is missing and removes who should not be there, so the removals are the dangerous half. Keep preview on the first run and drop it only once the output looks right.',
      'With neither a role nor ignorerole, member is assumed, so managers and owners are left alone. ignorerole makes sync remove people whatever their role and add everyone back as a plain member, which is rarely what you want.',
      'Add addonly or removeonly to do only half the job.',
      GIT_BASH_SLASH,
    ],
    destructive: true,
  },
  {
    id: 'group-list-members',
    task: 'List the members of a group',
    category: 'groups',
    template: 'gam print group-members group <group> fields email,role',
    params: [P.group],
    notes: [
      'The subcommand really is hyphenated: print group-members.',
      'The wiki shows examples with a bare group name after the subcommand. That form does not parse. Use group <GroupItem> for one group or select <GroupEntity> for several.',
      'Add recursive to expand nested groups, and membernames to get display names alongside the addresses.',
    ],
  },
  {
    id: 'group-find-membership',
    task: 'Find every group one person belongs to',
    category: 'groups',
    template: 'gam print groups member <user>',
    params: [P.user],
    notes: [
      'This is the reverse lookup people usually reach for print group-members to do the hard way.',
      'It reports direct membership. Add the roles clause if you also want to know whether they are a manager or owner of each one.',
    ],
  },
  {
    id: 'group-info',
    task: 'Show one group with its settings',
    category: 'groups',
    template: 'gam print groups group <group> settings',
    params: [P.group],
    notes: [
      'settings pulls the whole Groups Settings block, which is where posting permissions, external membership and moderation live.',
      'gam info group <group> gives the human readable view instead, with members listed underneath.',
    ],
  },
  {
    id: 'group-delete',
    task: 'Delete a group',
    category: 'groups',
    template: 'gam delete group <group>',
    params: [P.group],
    notes: [
      'The group\'s archived conversations go with it. Export anything you need from Groups first.',
      'If you are deleting a group to free the address for a user or an alias, expect the directory to lag, so re-check before creating the replacement.',
    ],
    destructive: true,
  },

  // ------------------------------------------------------------------ drive
  {
    id: 'drive-find-owner',
    task: 'Find who owns a Drive file when all you have is the id',
    category: 'drive',
    template: 'gam show ownership <fileid>',
    params: [P.fileid],
    notes: [
      'This is an admin level command, not a gam user command, and it resolves the owner through the Reports API audit trail, so it needs the Reports scope and it does not need access to the file.',
      'It may come up empty if nobody has touched the file in 180 days, because that is how far the audit activity goes back.',
      'Do not loop show fileinfo across every account to find an owner. It reports that the file does not exist for every user who lacks access, which tells you nothing.',
      'You can pass drivefilename "<name>" instead of an id if you only know what it is called.',
    ],
  },
  {
    id: 'drive-search-files',
    task: 'Search a user\'s Drive with a query',
    category: 'drive',
    template: 'gam user <user> print filelist query "<query>" fields id,name,mimetype,modifiedtime',
    params: [
      P.user,
      {
        name: 'query',
        description: 'A Drive API search query, the same syntax the Drive search box builds.',
        example: "name contains 'budget'",
        required: true,
      },
    ],
    notes: [
      'The big one: GAM seeds the query with \'me\' in owners and appends yours with and. So a query about somebody else\'s files runs as \'me\' in owners and (your query), returns Got 0 Drive Files and exits with status 0. Nothing errors.',
      'To escape that, use fullquery "<query>" which replaces the whole query instead of appending, and add showownedby any. anyowner does the same job by removing both the owners clauses.',
      'Watch the query line GAM echoes back. It prints the query it actually ran, so if there is a clause in it you did not type, that is your bug.',
      'Without a fields or allfields clause you only get id and webViewLink back.',
    ],
  },
  {
    id: 'drive-list-shared-drive-contents',
    task: 'List what is inside a shared drive',
    category: 'drive',
    template:
      'gam user <user> print filelist select shareddriveid <driveid> fields id,name,mimetype,owners',
    params: [
      {
        name: 'user',
        description: 'Any account with access to the shared drive. GAM acts as this user.',
        example: 'admin@example.com',
        required: true,
      },
      P.driveid,
    ],
    notes: [
      'select shareddriveid is the incantation that works, because it leaves the query empty so the \'me\' in owners clause is never added. Trying to reach a shared drive by its parent folder id instead returns zero rows and exit status 0.',
      'teamdriveid is still accepted as an alias for shareddriveid, so older scripts and older wiki pages both keep working.',
      'Inside select <folderid> for an ordinary folder you cannot use query at all. It is a hard error there, and selectsubquery is the argument you want instead. That asymmetry is not written down anywhere.',
      'depth 0 lists only the immediate children. The default walks the whole subtree.',
    ],
  },
  {
    id: 'drive-file-info',
    task: 'Show everything about one Drive file',
    category: 'drive',
    template: 'gam user <user> show fileinfo <fileid> allfields',
    params: [P.user, P.fileid],
    notes: [
      'The acting user needs access to the file, otherwise you get a flat does not exist. That is not a bug, and it is why the find owner recipe uses the audit trail instead.',
      'gam user <user> info drivefile <fileid> is documented as equivalent.',
      'Add filepath to get the folder path rather than just the parent id.',
    ],
  },
  {
    id: 'drive-transfer-file-ownership',
    task: 'Hand one file or folder to a new owner',
    category: 'drive',
    template: 'gam user <user> transfer ownership <fileid> <newowner>',
    params: [
      {
        name: 'user',
        description: 'The current owner. GAM runs the command as this account.',
        example: 'jdoe@example.com',
        required: true,
      },
      P.fileid,
      {
        name: 'newowner',
        description: 'Who should own it afterwards.',
        example: 'manager@example.com',
        required: true,
      },
    ],
    notes: [
      'By default this recurses into a folder\'s contents. Add norecursion to move only the folder itself.',
      'Ownership transfer only works between accounts in the same Workspace domain. Across domains you can only share.',
      'Shared drives have no owner at all, so this does not apply there. Change the organizer role instead.',
      'Run with preview first to see the list of files it would touch.',
    ],
  },
  {
    id: 'drive-transfer-ownership-acl',
    task: 'Make someone the owner through an ACL change, with control over where it lands',
    category: 'drive',
    template:
      'gam user <user> add drivefileacl <fileid> user <newowner> role owner movetonewownersroot',
    params: [
      {
        name: 'user',
        description: 'The current owner, whose credentials the change is made under.',
        example: 'jdoe@example.com',
        required: true,
      },
      P.fileid,
      {
        name: 'newowner',
        description: 'The account that should become the owner.',
        example: 'manager@example.com',
        required: true,
      },
    ],
    notes: [
      'With role owner, Google forces a notification email to the new owner. You cannot suppress it, you can only add text with emailmessage.',
      'movetonewownersroot false is the default, and it leaves the file with no parent in the new owner\'s Drive, which looks a lot like it vanished. Set the flag unless you have a reason not to.',
      'Inherited permissions cannot be updated or deleted on the child. Change them on the folder that grants them.',
    ],
  },
  {
    id: 'drive-transfer-all',
    task: 'Transfer everything a leaver owns in Drive',
    category: 'drive',
    template: 'gam create datatransfer <user> gdrive <newowner> privacy_level shared,private',
    params: [
      {
        name: 'user',
        description: 'The old owner, whose Drive is being handed over.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'newowner',
        description: 'Who receives everything.',
        example: 'manager@example.com',
        required: true,
      },
    ],
    notes: [
      'Argument order is old owner, then service, then new owner. Getting it backwards is a silent way to transfer the wrong Drive.',
      'The default is shared files only, so without privacy_level shared,private every private file is left behind and dies with the account. The bare word all means the same thing.',
      'gdrive, drive, googledrive and "drive and docs" all name the same service. calendar and lookerstudio are the other two you can transfer.',
      'Watch it finish with gam show datatransfers, and do not remove the source account\'s licence until it has.',
    ],
  },
  {
    id: 'drive-transfer-all-gam',
    task: 'Transfer a whole Drive using GAM\'s own transfer instead of the Google API',
    category: 'drive',
    template: 'gam user <user> transfer drive <newowner> preview',
    params: [
      {
        name: 'user',
        description: 'The source account.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'newowner',
        description: 'The target account.',
        example: 'manager@example.com',
        required: true,
      },
    ],
    notes: [
      'This exists in both GAM7 and GAMADV-XTD3, despite the common belief that it is one fork\'s exclusive feature.',
      'Everything except trash lands in a subfolder named "#user# old files" under the target\'s root, and the source user keeps no access at all unless you add keepuser or retainrole.',
      'Drop preview only after you have read the preview output. Unlike the Data Transfer API version, this one walks and rewrites the tree itself.',
    ],
  },
  {
    id: 'drive-share-file',
    task: 'Share a file with someone',
    category: 'drive',
    template:
      'gam user <user> add drivefileacl <fileid> user <recipient> role <role> sendemail emailmessage "<message>"',
    params: [
      P.user,
      P.fileid,
      {
        name: 'recipient',
        description: 'Who to share with. Swap the user keyword for group, domain or anyone.',
        example: 'contractor@example.net',
        required: true,
      },
      {
        name: 'role',
        description: 'reader, commenter, writer, fileorganizer, organizer or owner.',
        example: 'writer',
        required: true,
      },
      {
        name: 'message',
        description: 'Text added to the notification email.',
        example: 'Sharing the Q3 numbers, shout if the tab is missing',
        required: false,
      },
    ],
    notes: [
      'sendemail is a bare flag. Writing sendemail true is a syntax error, and passing emailmessage turns the notification on by itself anyway.',
      'When Google refuses with a complaint about checking the Notify people box, which happens for addresses with no Google account, sendemail is the fix.',
      'Add expires <Time> to make the access lapse. It cannot be more than a year out, and Google only allows it on the commenter and reader style roles.',
      'withlink and allowfilediscovery only mean anything on anyone and domain permissions.',
    ],
  },
  {
    id: 'drive-unshare-file',
    task: 'Remove someone\'s access to a file',
    category: 'drive',
    template: 'gam user <user> delete drivefileacl <fileid> <recipient>',
    params: [
      P.user,
      P.fileid,
      {
        name: 'recipient',
        description: 'The permission id, or just the email address of whoever you are removing.',
        example: 'contractor@example.net',
        required: true,
      },
    ],
    notes: [
      'A permission inherited from a parent folder cannot be removed here. Remove it from the folder that grants it.',
      'Removing access does not claw back anything already downloaded or copied.',
    ],
    destructive: true,
  },
  {
    id: 'shareddrive-create',
    task: 'Create a shared drive',
    category: 'drive',
    template: 'gam user <user> create shareddrive "<name>" returnidonly',
    params: [
      {
        name: 'user',
        description: 'The account that creates it and becomes its first manager.',
        example: 'admin@example.com',
        required: true,
      },
      {
        name: 'name',
        description: 'What the shared drive is called.',
        example: 'Finance 2026',
        required: true,
      },
    ],
    notes: [
      'Only the theme can be set in the same API call as the create. Every other setting forces GAM into a create then update dance with retries, which is why bulk creation should be two passes rather than one long command.',
      'returnidonly prints just the new drive id, which is exactly what you want to feed into the next command.',
      'teamdrive is still a live alias for shareddrive in GAM 7.x, even though the current wiki only documents shareddrive.',
    ],
  },
  {
    id: 'shareddrive-list',
    task: 'List every shared drive in the organisation',
    category: 'drive',
    template: 'gam print shareddrives',
    params: [],
    notes: [
      'Run as an admin this lists the whole organisation. gam user <user> print shareddrives lists only the drives that user is in, unless you add adminaccess.',
      'Add orgunit <path> to scope it to the org unit a shared drive is filed under.',
    ],
  },
  {
    id: 'shareddrive-acls',
    task: 'See who has access to which shared drives',
    category: 'drive',
    template: 'gam print shareddriveacls matchname "<name>" oneitemperrow',
    params: [
      {
        name: 'name',
        description: 'A regular expression matched against the shared drive name.',
        example: 'Finance.*',
        required: true,
      },
    ],
    notes: [
      'oneitemperrow gives you one row per person per drive, which is the shape you want for a spreadsheet or a diff.',
      'Add user <address> or group <address> to answer the narrower question of what one person can reach.',
      'shownopermissionsdrives only will find the drives nobody is left in, which is where the abandoned data lives.',
    ],
  },
  {
    id: 'shareddrive-add-member',
    task: 'Give someone access to a shared drive',
    category: 'drive',
    template: 'gam add drivefileacl shareddriveid <driveid> user <user> role <role>',
    params: [
      P.driveid,
      P.user,
      {
        name: 'role',
        description:
          'organizer, fileorganizer, writer, commenter or reader. Case does not matter.',
        example: 'fileorganizer',
        required: true,
      },
    ],
    notes: [
      'The role names do not match the labels in the Drive interface. organizer is Manager, fileorganizer is Content manager, writer is Contributor, and reader is Viewer.',
      'manager and contentmanager are accepted as aliases if the interface names are stuck in your head.',
      'Shared drives have no owner role, so do not go looking for one.',
    ],
  },
  {
    id: 'shareddrive-delete',
    task: 'Delete a shared drive',
    category: 'drive',
    template: 'gam delete shareddrive shareddriveid <driveid> allowitemdeletion',
    params: [P.driveid],
    notes: [
      'Without allowitemdeletion the command refuses to delete a drive that still has files in it. With it, the files go too, and this is not reversible.',
      'allowitemdeletion needs a super admin, not just a drive manager.',
      'Export or move the contents first, and take a shareddriveacls listing so you know who to apologise to.',
    ],
    destructive: true,
  },

  // ------------------------------------------------------------------ gmail
  {
    id: 'gmail-delegate-add',
    task: 'Give someone delegated access to a mailbox',
    category: 'gmail',
    template: 'gam user <user> add delegate <delegate>',
    params: [
      {
        name: 'user',
        description: 'The mailbox being delegated.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'delegate',
        description: 'The account that gets to read and send as this mailbox.',
        example: 'assistant@example.com',
        required: true,
      },
    ],
    notes: [
      'gam user <user> delegate to <delegate> is the same command in older wording.',
      'Passing an alias as the delegate is an error. Add convertalias to have GAM resolve it, at the cost of one extra API call per user.',
      'Delegation lets the delegate send as the mailbox, which is worth remembering before you hand it to a contractor.',
    ],
  },
  {
    id: 'gmail-delegate-list',
    task: 'See who has delegated access to a mailbox',
    category: 'gmail',
    template: 'gam user <user> show delegates shownames',
    params: [P.user],
    notes: [
      'Swap user <address> for all users to audit the whole domain in one run, which is the version worth putting on a schedule.',
      'shownames costs an extra lookup per delegate but turns addresses into people.',
    ],
  },
  {
    id: 'gmail-delegate-remove',
    task: 'Remove a delegate from a mailbox',
    category: 'gmail',
    template: 'gam user <user> delete delegate <delegate>',
    params: [
      P.user,
      {
        name: 'delegate',
        description: 'The delegate to remove.',
        example: 'assistant@example.com',
        required: true,
      },
    ],
    notes: [
      'Removing delegation does not remove anything the delegate already forwarded, filed or sent.',
    ],
    destructive: true,
  },
  {
    id: 'gmail-forward-on',
    task: 'Forward a mailbox to another address',
    category: 'gmail',
    template: `gam user <user> add forwardingaddress <forwardto>
gam user <user> forward on <disposition> <forwardto>`,
    params: [
      P.user,
      {
        name: 'forwardto',
        description: 'Where the mail should go.',
        example: 'manager@example.com',
        required: true,
      },
      {
        name: 'disposition',
        description:
          'What happens to the original: keep or leaveininbox, archive, markread, or delete and trash which both mean trash.',
        example: 'archive',
        required: true,
      },
    ],
    notes: [
      'The address has to exist as a forwarding address before forward on will accept it, which is why this is two commands.',
      'Check gam user <user> show forwardingaddresses and look at the verification status before you assume mail is flowing. Google decides whether an address needs a confirmation click, and GAM has no way to skip it.',
      'delete and trash are the same disposition. There is no star or spam option.',
      'gam user <user> forward off turns it back off and leaves the forwarding address in place.',
    ],
  },
  {
    id: 'gmail-filter-add',
    task: 'Create a Gmail filter for a user',
    category: 'gmail',
    template: 'gam user <user> add filter from "<from>" label "<label>" archive markread',
    params: [
      P.user,
      {
        name: 'from',
        description: 'The sender to match. to, subject, haswords and nowords work the same way.',
        example: 'noreply@vendor.example.com',
        required: true,
      },
      {
        name: 'label',
        description: 'The label to apply. It is created if it does not exist yet.',
        example: 'Vendor',
        required: true,
      },
    ],
    notes: [
      'One user label and one category per filter, no more.',
      'size is a criterion, not an action, and it is written size larger 5m. musthaveattachment is likewise a criterion only.',
      'The forward action only works to an address that is already a verified forwarding address on that mailbox.',
      'To roll a filter out to everyone, put all users in place of user <address>. There is no domain wide filter object in Gmail, only per mailbox ones.',
    ],
  },
  {
    id: 'gmail-filter-list',
    task: 'List a user\'s Gmail filters',
    category: 'gmail',
    template: 'gam user <user> show filters',
    params: [P.user],
    notes: [
      'You need the filter id from here before you can delete one.',
      'Run it over all users and redirect to CSV when you are hunting for the rule that is quietly deleting somebody\'s mail.',
    ],
  },
  {
    id: 'gmail-filter-delete',
    task: 'Delete a Gmail filter',
    category: 'gmail',
    template: 'gam user <user> delete filters <filterid>',
    params: [
      P.user,
      {
        name: 'filterid',
        description: 'The filter id, which show filters prints.',
        example: 'ANe1BmhVTQ5nQzBpZmVy',
        required: true,
      },
    ],
    notes: [
      'Filters are per mailbox, so deleting one for the person who complained does not fix it for anyone else.',
    ],
    destructive: true,
  },
  {
    id: 'gmail-label-create',
    task: 'Create a label in a mailbox',
    category: 'gmail',
    template: 'gam user <user> add label "<label>"',
    params: [
      P.user,
      {
        name: 'label',
        description: 'The label name.',
        example: 'Legal Hold',
        required: true,
      },
    ],
    notes: [
      'The verb is optional, so gam user <user> label "<name>" does the same thing.',
      'Add labellistvisibility and messagelistvisibility to control whether it clutters the sidebar.',
    ],
  },
  {
    id: 'gmail-label-nested',
    task: 'Create a nested label hierarchy',
    category: 'gmail',
    template: 'gam user <user> add label "<label>" buildpath',
    params: [
      P.user,
      {
        name: 'label',
        description: 'The full path of the label, with slashes between the levels.',
        example: 'Clients/Acme/Invoices',
        required: true,
      },
    ],
    notes: [
      'Without buildpath you get one flat label whose name literally contains slashes, which looks almost right in the interface and is not.',
      'buildpath creates each missing parent level as it goes.',
    ],
  },
  {
    id: 'gmail-label-delete',
    task: 'Delete a label from a mailbox',
    category: 'gmail',
    template: 'gam user <user> delete label "<label>"',
    params: [
      P.user,
      {
        name: 'label',
        description: 'The label to remove. Messages keep existing, they just lose the label.',
        example: 'Legal Hold',
        required: true,
      },
    ],
    notes: [
      'This command also accepts a regex: prefix and the literal --ALL_LABELS--, both of which are exactly as dangerous as they sound.',
      'The related delete labellist argument splits on spaces, so a name containing a space needs the quote inside quote form, like "\'Legal Hold\'".',
    ],
    destructive: true,
  },
  {
    id: 'gmail-vacation-on',
    task: 'Turn on a vacation responder with start and end dates',
    category: 'gmail',
    template:
      'gam user <user> vacation on subject "<subject>" message "<message>" start <startdate> end <enddate> contactsonly',
    params: [
      P.user,
      {
        name: 'subject',
        description: 'Subject line of the auto reply.',
        example: 'Out of office until 24 August',
        required: true,
      },
      {
        name: 'message',
        description:
          'Body of the auto reply. Use file <path> or htmlfile <path> instead for anything longer than a line.',
        example: 'I am away and will reply when I am back. For anything urgent, mail sales@example.com.',
        required: true,
      },
      {
        name: 'startdate',
        description: 'When it starts, as YYYY-MM-DD or a relative value like +1d.',
        example: '2026-08-10',
        required: false,
      },
      {
        name: 'enddate',
        description: 'When it stops, as YYYY-MM-DD or a relative value like +14d.',
        example: '2026-08-24',
        required: false,
      },
    ],
    notes: [
      'Always set both dates. A leftover expired end date from a previous responder silently suppresses the new one, and that is the single most common reason a vacation reply does not fire.',
      'contactsonly limits replies to people in the user\'s contacts, domainonly limits them to your own domain. Leave both off and you are auto replying to the whole internet, spam included.',
      'The leading on is optional, which lets you edit the subject or message of a live responder without toggling it.',
    ],
  },
  {
    id: 'gmail-signature',
    task: 'Set a signature from an HTML file, with per user substitutions',
    category: 'gmail',
    template:
      'gam user <user> signature htmlfile <sigfile> replace FirstName field:name.givenname',
    params: [
      P.user,
      {
        name: 'sigfile',
        description: 'Path to a local HTML file containing the signature template.',
        example: './signature.html',
        required: true,
      },
    ],
    notes: [
      'replace <Tag> field:<UserField> substitutes directory data per user, so one file plus all users gives everyone their own name and title.',
      'There is no set verb: the subcommand is just signature, or sig.',
      'This sets the signature on the primary address. For a send as alias, use update sendas instead.',
    ],
  },
  {
    id: 'gmail-messages-find',
    task: 'Find messages matching a query in a mailbox',
    category: 'gmail',
    template: 'gam user <user> print messages query "<query>" headers all showlabels',
    params: [
      P.user,
      {
        name: 'query',
        description: 'A Gmail search query, exactly what you would type into the Gmail search box.',
        example: 'from:phish@bad.example.com newer_than:7d',
        required: true,
      },
    ],
    notes: [
      'Always run this before the trash or delete version. It is the read only half of the same query, so it is your blast radius check.',
      'Swap user <address> for all users to sweep the whole domain, and expect it to take a while.',
      'rfc822msgid:<id> is the query to use when you want exactly one specific message across every mailbox.',
    ],
  },
  {
    id: 'gmail-messages-trash-org-wide',
    task: 'Trash a phishing message across every mailbox',
    category: 'gmail',
    template:
      'gam config auto_batch_min 1 all users trash messages query "<query>" max_to_trash 0 doit',
    params: [
      {
        name: 'query',
        description: 'A Gmail search query identifying the message.',
        example: 'from:phish@bad.example.com subject:"Urgent invoice"',
        required: true,
      },
    ],
    notes: [
      DOIT_DRY_RUN,
      'max_to_trash defaults to 1, not unlimited, and the wiki does not mention it. Without max_to_trash 0 the command silently does nothing for any mailbox holding two or more matches, which is the failure mode that makes people think GAM did not work.',
      'Trashed messages sit in each user\'s trash rather than disappearing, which gives you a window to undo a mistake.',
      'Underscores are ignored in this argument, so max_to_trash, maxtotrash and maxtoprocess are all the same thing.',
    ],
    destructive: true,
  },
  {
    id: 'gmail-messages-delete',
    task: 'Permanently delete messages from one mailbox',
    category: 'gmail',
    template: 'gam user <user> delete messages query "<query>" max_to_delete 0 doit',
    params: [
      P.user,
      {
        name: 'query',
        description: 'A Gmail search query identifying the messages.',
        example: 'from:phish@bad.example.com newer_than:7d',
        required: true,
      },
    ],
    notes: [
      DOIT_DRY_RUN,
      'delete skips the trash entirely. There is no undo, and Vault retention is the only thing that will save you. Prefer trash unless you specifically need the messages gone.',
      'max_to_delete defaults to 1, so set it explicitly or most mailboxes will quietly go untouched.',
    ],
    destructive: true,
  },

  // --------------------------------------------------------------- calendar
  {
    id: 'calendar-list-events',
    task: 'List events on a calendar in a date range',
    category: 'calendar',
    template:
      'gam calendar <calendar> print events after <startdate> before <enddate> singleevents orderby starttime',
    params: [
      {
        name: 'calendar',
        description: 'A calendar address: a person\'s primary calendar or a resource calendar.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'startdate',
        description: 'Start of the window. Relative values like -30d work too.',
        example: '2026-01-01',
        required: true,
      },
      {
        name: 'enddate',
        description: 'End of the window.',
        example: '2026-02-01',
        required: true,
      },
    ],
    notes: [
      'after and timemin are the same argument, as are before and timemax.',
      'orderby starttime is only valid together with singleevents, which expands recurring events into individual ones.',
      'Every event selection argument has to come before the display arguments, or GAM rejects the command.',
      'Add query "<text>" to search within the window.',
    ],
  },
  {
    id: 'calendar-wipe',
    task: 'Delete every event on a calendar',
    category: 'calendar',
    template: 'gam calendar <calendar> wipe events',
    params: [
      {
        name: 'calendar',
        description: 'The calendar to empty.',
        example: 'jdoe@example.com',
        required: true,
      },
    ],
    notes: [
      'The wiki scopes wipe to a user\'s primary calendar. For a secondary or resource calendar use delete events, which does need doit.',
      'Unlike delete events, wipe does not require doit, and whether it stops to ask you is not documented anywhere. Try it on a throwaway calendar before you point it at a real one.',
      'Meetings this person organised disappear from everyone else\'s calendar too.',
    ],
    destructive: true,
  },
  {
    id: 'calendar-delete-event',
    task: 'Delete one calendar event by its id',
    category: 'calendar',
    template: 'gam calendar <calendar> delete events id <eventid> doit',
    params: [
      {
        name: 'calendar',
        description: 'The calendar holding the event.',
        example: 'jdoe@example.com',
        required: true,
      },
      {
        name: 'eventid',
        description: 'The event id, which the list events recipe prints.',
        example: '_6tj3ce9m6cp3ib9k6oq3ab9k',
        required: true,
      },
    ],
    notes: [
      'doit is required. Without it nothing is deleted and GAM tells you so.',
      'Deleted events sit in the calendar trash for 30 days, so this is recoverable. purge events is the version that is not.',
    ],
    destructive: true,
  },
  {
    id: 'calendar-share',
    task: 'Give someone access to a calendar',
    category: 'calendar',
    template: 'gam calendars <calendar> add acls <role> user <user> sendnotifications false',
    params: [
      {
        name: 'calendar',
        description: 'The calendar being shared.',
        example: 'team@example.com',
        required: true,
      },
      {
        name: 'role',
        description:
          'freebusy, reader, writer, editor or owner. freebusyreader shows only busy blocks.',
        example: 'reader',
        required: true,
      },
      P.user,
    ],
    notes: [
      'Note the plural: gam calendars, not gam calendar. The singular form is the older spelling and takes a different argument shape.',
      'Swap the user keyword for group, domain or default to share more widely. default means anyone with the link.',
      'sendnotifications false keeps a bulk run from mailing everybody.',
    ],
  },
  {
    id: 'calendar-unshare',
    task: 'Remove someone\'s access to a calendar',
    category: 'calendar',
    template: 'gam calendars <calendar> delete acls user <user>',
    params: [
      {
        name: 'calendar',
        description: 'The calendar to remove access from.',
        example: 'team@example.com',
        required: true,
      },
      P.user,
    ],
    notes: [
      'The role is optional here, because an account only holds one ACL entry per calendar.',
      'Removing the last owner of a calendar leaves it awkward to manage, so check the ACL listing first.',
    ],
    destructive: true,
  },
  {
    id: 'calendar-show-acls',
    task: 'See who can read or edit a calendar',
    category: 'calendar',
    template: 'gam calendars <calendar> print acls noselfowner',
    params: [
      {
        name: 'calendar',
        description: 'The calendar to audit.',
        example: 'team@example.com',
        required: true,
      },
    ],
    notes: [
      'noselfowner hides the calendar owner\'s own entry, which is noise in a bulk audit.',
      'Run it over a list of calendars to find the ones shared with default, meaning anybody.',
    ],
  },
  {
    id: 'calendar-user-list',
    task: 'List the calendars in someone\'s calendar list',
    category: 'calendar',
    template: 'gam user <user> show calendars',
    params: [P.user],
    notes: [
      'The subcommand is plural. Only calendars is documented, so do not rely on the singular spelling.',
      'This is the user\'s subscription list, not the calendars they own.',
    ],
  },
  {
    id: 'calendar-add-to-user',
    task: 'Add a shared calendar to someone\'s calendar list',
    category: 'calendar',
    template: 'gam user <user> add calendars <calendar> selected true',
    params: [
      P.user,
      {
        name: 'calendar',
        description: 'The calendar to subscribe them to.',
        example: 'team@example.com',
        required: true,
      },
    ],
    notes: [
      'selected true ticks the box so it actually shows up, rather than sitting in their list switched off.',
      'This subscribes them. It does not grant access, so give them an ACL first or they will see nothing.',
    ],
  },
  {
    id: 'calendar-transfer-ownership',
    task: 'Transfer ownership of a calendar to someone else',
    category: 'calendar',
    template: 'gam calendars <calendar> transfer ownership <newowner>',
    params: [
      {
        name: 'calendar',
        description: 'The calendar changing hands.',
        example: 'team@example.com',
        required: true,
      },
      {
        name: 'newowner',
        description: 'The account that should own it.',
        example: 'manager@example.com',
        required: true,
      },
    ],
    notes: [
      'Added in GAM7. GAMADV-XTD3 does not document this subcommand, so on that fork you have to add an owner ACL and remove the old one by hand.',
      'Useful for a calendar that was created under a departing person\'s account rather than as a resource.',
    ],
    variant: 'gam7',
  },
  {
    id: 'calendar-writer-no-private',
    task: 'Give write access without exposing private event details',
    category: 'calendar',
    template: 'gam calendars <calendar> add acls writerwithoutprivateaccess user <user>',
    params: [
      {
        name: 'calendar',
        description: 'The calendar being shared.',
        example: 'jdoe@example.com',
        required: true,
      },
      P.user,
    ],
    notes: [
      'The writerwithoutprivateaccess role arrived in GAM 7.44.03 and became effective on 29 June 2026. Older GAM builds and GAMADV-XTD3 reject the word.',
      'It is the role you want for an assistant who has to manage a diary without reading the events marked private.',
    ],
    variant: 'gam7',
  },

  // -------------------------------------------------------------- org units
  {
    id: 'ou-create',
    task: 'Create an org unit',
    category: 'org-units',
    template: 'gam create ou <ou> description "<description>"',
    params: [
      P.ou,
      {
        name: 'description',
        description: 'What the org unit is for.',
        example: 'Finance department',
        required: false,
      },
    ],
    notes: [
      GIT_BASH_SLASH,
      'Add buildpath to create any missing parent levels rather than failing.',
      'org and ou are interchangeable everywhere GAM accepts either.',
    ],
  },
  {
    id: 'ou-create-nested',
    task: 'Create an org unit under a named parent',
    category: 'org-units',
    template: 'gam create ou <name> parent <parentou> description "<description>"',
    params: [
      {
        name: 'name',
        description: 'The leaf name, with no slashes.',
        example: 'Finance',
        required: true,
      },
      {
        name: 'parentou',
        description: 'The full path of the parent org unit.',
        example: '/Staff',
        required: true,
      },
      {
        name: 'description',
        description: 'What the org unit is for.',
        example: 'Finance department',
        required: false,
      },
    ],
    notes: [
      GIT_BASH_SLASH,
      'This is the same thing as passing the full path to gam create ou. Use whichever makes your script readable.',
    ],
  },
  {
    id: 'ou-move-users',
    task: 'Move a batch of users into an org unit',
    category: 'org-units',
    template: 'gam update ou <ou> add users <users>',
    params: [
      P.ou,
      {
        name: 'users',
        description:
          'A comma separated list of addresses. You can also write file <path> to read them from a text file.',
        example: 'jdoe@example.com,rroe@example.com',
        required: true,
      },
    ],
    notes: [
      'add and move mean the same thing here.',
      'This is the batched path, so it is much faster than looping gam update user <address> ou <path> for a long list.',
      GIT_BASH_SLASH,
    ],
  },
  {
    id: 'ou-sync-users',
    task: 'Make an org unit hold exactly the users you specify',
    category: 'org-units',
    template: 'gam update ou <ou> sync ou <sourceou> removetoou <removeou>',
    params: [
      P.ou,
      {
        name: 'sourceou',
        description: 'The set of users the target org unit should end up holding.',
        example: '/Staff',
        required: true,
      },
      {
        name: 'removeou',
        description: 'Where to send anyone who is in the target but should not be.',
        example: '/Staff/Other',
        required: true,
      },
    ],
    notes: [
      'Without removetoou, the users being removed have nowhere to go, so decide that destination deliberately rather than discovering it.',
      'Moving an org unit moves the policies that come with it, which can turn services on or off for people without warning. Test with two accounts first.',
      GIT_BASH_SLASH,
    ],
    destructive: true,
  },
  {
    id: 'ou-print',
    task: 'List every org unit',
    category: 'org-units',
    template: 'gam print orgs',
    params: [],
    notes: [
      'Add minusercount 1 to see only the org units that actually contain people, which is a quick way to find the empty ones left over from a reorganisation.',
      'gam show orgtree draws the hierarchy instead of listing paths.',
    ],
  },
  {
    id: 'ou-info',
    task: 'Show one org unit and who is in it',
    category: 'org-units',
    template: 'gam info ou <ou>',
    params: [P.ou],
    notes: [
      GIT_BASH_SLASH,
      'Org unit names containing a hash or a plus sign break update, delete and info because of a Google bug GAM cannot work around. Avoid those characters when you name one.',
      'Add nousers when you only want the org unit metadata, and children to include the ones underneath.',
    ],
  },
  {
    id: 'ou-rename',
    task: 'Rename or re-parent an org unit',
    category: 'org-units',
    template: 'gam update ou <ou> name "<name>" parent <parentou>',
    params: [
      P.ou,
      {
        name: 'name',
        description: 'The new leaf name.',
        example: 'Finance and Legal',
        required: false,
      },
      {
        name: 'parentou',
        description: 'A new parent path, if you are moving it in the tree.',
        example: '/Staff',
        required: false,
      },
    ],
    notes: [
      'Re-parenting an org unit changes which policies its users inherit. That takes effect for everyone inside it, so read the settings on the new parent first.',
      GIT_BASH_SLASH,
    ],
  },
  {
    id: 'ou-delete',
    task: 'Delete an org unit',
    category: 'org-units',
    template: 'gam delete ou <ou>',
    params: [P.ou],
    notes: [
      'Move the users and devices out first, and check for child org units, so you know exactly what the delete is taking with it.',
      GIT_BASH_SLASH,
    ],
    destructive: true,
  },
  {
    id: 'ou-block-inheritance',
    task: 'Change the old block inheritance flag on an org unit',
    category: 'org-units',
    template: 'gam update ou <ou> blockinheritance False',
    params: [P.ou],
    notes: [
      'This is a genuine fork difference. Google deprecated the block inheritance flag, GAM7 removed the argument entirely, and only GAMADV-XTD3 still parses it. On GAM7 the command is a syntax error and there is nothing to set.',
      'If you are migrating scripts to GAM7, this is one of the few lines you have to actually delete rather than translate.',
      GIT_BASH_SLASH,
    ],
    variant: 'gamadv',
  },

  // -------------------------------------------------------------- licenses
  {
    id: 'license-assign',
    task: 'Assign a licence to a user',
    category: 'licenses',
    template: 'gam user <user> add license <sku>',
    params: [P.user, P.sku],
    notes: [
      'GAM validates the SKU against an internal table, so a typo is rejected rather than silently doing nothing. For a SKU GAM does not know, the escape hatch is nv:<Product>:<SKU>.',
      'A user cannot hold two conflicting SKUs. Adding Cloud Identity to somebody who already has Business Standard fails as not enough licenses, and then as a backend error if you retry. Remove the old SKU first, or use the swap recipe.',
      'create is accepted as a synonym for add here.',
    ],
  },
  {
    id: 'license-remove',
    task: 'Remove a licence from a user',
    category: 'licenses',
    template: 'gam user <user> delete license <sku>',
    params: [P.user, P.sku],
    notes: [
      'Removing a licence takes away the services it paid for, which can mean a mailbox becomes unreachable. Do this after any data transfer, never before.',
      'To free the seat but keep the data, look at archiving the user instead.',
    ],
    destructive: true,
  },
  {
    id: 'license-swap',
    task: 'Move a user from one licence to another',
    category: 'licenses',
    template: 'gam user <user> update license <newsku> from <oldsku>',
    params: [
      P.user,
      {
        name: 'newsku',
        description: 'The SKU the user should end up with.',
        example: '1010020028',
        required: true,
      },
      {
        name: 'oldsku',
        description: 'The SKU they currently hold, which is removed.',
        example: '1010020020',
        required: true,
      },
    ],
    notes: [
      'Do it in this one command rather than add then delete. Conflicting SKUs cannot coexist, so the add half of a two step version fails first and leaves you mid change.',
      'The word from is optional but the old SKU is not.',
      'Add archive to archive the user as part of the swap, which is the route for archiving somebody who holds a licence that cannot be archived directly.',
    ],
  },
  {
    id: 'license-assign-ou',
    task: 'Assign a licence to everyone in an org unit',
    category: 'licenses',
    template: 'gam ou <ou> add license <sku> actioncsv',
    params: [P.ou, P.sku],
    notes: [
      'actioncsv gives you a machine readable record of which accounts succeeded, which matters when you are past a handful of people.',
      'Use ou_and_children instead of ou to include the org units underneath.',
      'Check your available seats first. GAM will happily march down the list failing on every account once you run out.',
      GIT_BASH_SLASH,
    ],
  },
  {
    id: 'license-sync-ou',
    task: 'Make everyone in an org unit hold exactly one licence SKU',
    category: 'licenses',
    template: 'gam ou <ou> sync license <sku> onesku preview',
    params: [P.ou, P.sku],
    notes: [
      'sync both adds and removes, and the removals are what makes it worth a preview run. Drop preview only after reading the output.',
      'onesku confines it to the SKU you named. allskus lets it remove any other licence it finds, which is a much bigger swing.',
      'addonly and removeonly let you do half the job when you only trust half of it.',
      GIT_BASH_SLASH,
    ],
    destructive: true,
  },
  {
    id: 'license-print',
    task: 'List every licence assignment in the domain',
    category: 'licenses',
    template: 'gam print licenses',
    params: [],
    notes: [
      'Add countsonly for just the totals, which is the version you want for a seat count before a renewal conversation.',
      'Add skus <SKUIDList> to narrow it to the products you actually pay for.',
    ],
  },
  {
    id: 'license-print-sku',
    task: 'Count how many seats of one licence SKU are in use',
    category: 'licenses',
    template: 'gam print licenses skus <sku> countsonly',
    params: [P.sku],
    notes: [
      'Useful SKU aliases: wsbizstarter, wsbizstan, wsbizplus, wsentstan, wsentplus, gsuitebusiness, cloudidentity and vault. The numeric ids work too.',
      'This counts assignments, not what you are billed for. Reconcile against the billing console before you cancel anything.',
    ],
  },
  {
    id: 'license-config-skus',
    task: 'Find which licence SKUs your domain owns, so gam info user stops crawling',
    category: 'licenses',
    template: 'gam show configlicenseskus',
    params: [],
    notes: [
      'Added in GAM7 and not present in GAMADV-XTD3.',
      'The Licensing API cannot list a user\'s licences, so gam info user probes every SKU GAM knows, one call each. Put this command\'s output into license_skus in gam.cfg and info user gets dramatically faster and stops eating quota.',
    ],
    variant: 'gam7',
  },

  // --------------------------------------------------- reports and devices
  {
    id: 'report-login',
    task: 'See who signed in and who failed',
    category: 'reports',
    template: 'gam report login user all start <startdate> end <enddate>',
    params: [
      {
        name: 'startdate',
        description: 'Start of the window. Relative values like -30d work.',
        example: '-30d',
        required: false,
      },
      {
        name: 'enddate',
        description: 'End of the window.',
        example: 'today',
        required: false,
      },
    ],
    notes: [
      'The arguments are start and end, not start_date and end_date, and range <start> <end> is a shorthand for both.',
      'Add event login_failure to see only the failures, which is the version worth watching.',
      'Add ip <address> to trace one source, and filter for the finer grained conditions.',
    ],
  },
  {
    id: 'report-admin',
    task: 'See what your admins have been changing',
    category: 'reports',
    template: 'gam report admin start <startdate>',
    params: [
      {
        name: 'startdate',
        description: 'How far back to look. Relative values like -7d work.',
        example: '-7d',
        required: false,
      },
    ],
    notes: [
      'For the admin and chrome activity reports the plain orgunit argument does not work. Use select ou <path> instead.',
      'This is the audit trail that answers who turned that setting off, and it is the first place to look after an unexplained change.',
    ],
  },
  {
    id: 'report-drive-file',
    task: 'See who has touched a specific Drive file',
    category: 'reports',
    template: 'gam report drive filter "doc_id==<fileid>"',
    params: [P.fileid],
    notes: [
      'This is what gam show ownership runs underneath, so the same 180 day audit horizon applies.',
      'It shows views, edits, downloads and sharing changes, which is more than the file\'s own revision history will tell you.',
    ],
  },
  {
    id: 'report-user-usage',
    task: 'Get per user numbers like storage used and last login',
    category: 'reports',
    template: 'gam report users parameters <parameters> date <date>',
    params: [
      {
        name: 'parameters',
        description: 'Comma separated report parameters, in the form service:metric.',
        example: 'accounts:used_quota_in_mb,accounts:last_login_time',
        required: true,
      },
      {
        name: 'date',
        description: 'The single day to report on, as YYYY-MM-DD or a relative value.',
        example: '-5d',
        required: true,
      },
    ],
    notes: [
      'User reports lag by roughly four days, so asking for today returns nothing at all and looks like a broken command.',
      'fields and parameters are the same argument.',
      'This is the reliable way to find dormant accounts, because the directory\'s own last login field is not always what you want to bill decisions on.',
    ],
  },
  {
    id: 'report-customer-usage',
    task: 'Get domain wide usage numbers over a date range',
    category: 'reports',
    template: 'gam report usage customer parameters <parameters> range <startdate> <enddate>',
    params: [
      {
        name: 'parameters',
        description: 'Comma separated report parameters.',
        example: 'meet:total_call_minutes,gmail:num_emails_received',
        required: true,
      },
      {
        name: 'startdate',
        description: 'First day of the range.',
        example: '-30d',
        required: true,
      },
      {
        name: 'enddate',
        description: 'Last day of the range.',
        example: '-3d',
        required: true,
      },
    ],
    notes: [
      'The difference between report usage customer and report customer is the date handling: usage takes a range, the plain form takes one date.',
      'Customer reports lag by roughly two days.',
      'Run gam report usageparameters customer to find out what you are allowed to ask for rather than guessing metric names.',
    ],
  },
  {
    id: 'report-print-tokens',
    task: 'List every third party app your users have connected',
    category: 'reports',
    template: 'gam all users print tokens',
    params: [],
    notes: [
      'This is the OAuth surface of your domain, and it is usually longer and older than anyone expects.',
      'Revoke one app for one person with gam user <address> delete tokens clientid <ClientID>.',
      'Expect it to be slow. It walks every account one at a time.',
    ],
  },
  {
    id: 'mobile-list',
    task: 'List mobile devices',
    category: 'reports',
    template: 'gam print mobile query "<query>" fields resourceid,email,model,os,status,lastsync',
    params: [
      {
        name: 'query',
        description: 'A device search query.',
        example: 'status:approved',
        required: true,
      },
    ],
    notes: [
      'listlimit defaults to 1 for the multi value fields such as email and name, so add listlimit 0 if a device has more than one account on it and you want to see them all.',
      'Terms inside one query are ANDed. To OR them, use queries with a comma separated list.',
      'You need the resourceid from here before you can wipe anything.',
    ],
  },
  {
    id: 'mobile-wipe',
    task: 'Remotely wipe a mobile device',
    category: 'reports',
    template: 'gam update mobile <resourceid> action admin_remote_wipe',
    params: [
      {
        name: 'resourceid',
        description: 'The device resource id, which print mobile gives you.',
        example: 'AFiQxQ8xY2ZfV1RkZXZpY2U',
        required: true,
      },
    ],
    notes: [
      'admin_remote_wipe factory resets the entire device, personal photos included. admin_account_wipe removes only the work account and is what you almost always actually want.',
      'You can pass a query instead of a resource id, and then doit is required. Add matchusers <UserTypeEntity> as a safety net so devices belonging to anyone outside your list are skipped.',
      'wipe is an accepted alias for admin_remote_wipe, which makes it very easy to type the destructive one by accident.',
    ],
    destructive: true,
  },
  {
    id: 'mobile-account-wipe',
    task: 'Remove only the work account from a phone',
    category: 'reports',
    template: 'gam update mobile <resourceid> action admin_account_wipe',
    params: [
      {
        name: 'resourceid',
        description: 'The device resource id.',
        example: 'AFiQxQ8xY2ZfV1RkZXZpY2U',
        required: true,
      },
    ],
    notes: [
      'accountwipe and wipeaccount are accepted aliases.',
      'This is the offboarding action for a personal phone. It leaves the owner\'s own data alone.',
      'The device has to check in before anything happens, so a phone that is off stays untouched until it is not.',
    ],
    destructive: true,
  },
  {
    id: 'cros-list',
    task: 'List ChromeOS devices in an org unit',
    category: 'reports',
    template:
      'gam print cros cros_ou_and_children <ou> fields deviceid,serialnumber,annotatedassetid,status,lastsync',
    params: [P.ou],
    notes: [
      GIT_BASH_SLASH,
      'For list valued fields the entries come back oldest first, so listlimit 5 gives you the five oldest, not the newest. Add reverselists to flip it.',
      'listlimit 0 means no limit here, which is the opposite of what it means on print mobile.',
    ],
  },
  {
    id: 'cros-deprovision',
    task: 'Deprovision a ChromeOS device you are retiring',
    category: 'reports',
    template:
      'gam update cros <deviceid> action deprovision_retiring_device acknowledge_device_touch_requirement',
    params: [
      {
        name: 'deviceid',
        description: 'The ChromeOS device id, which print cros gives you.',
        example: 'a1b2c3d4-5e6f-7890-abcd-ef1234567890',
        required: true,
      },
    ],
    notes: [
      'acknowledge_device_touch_requirement is required for every deprovision action, not optional. Google wants you to confirm that somebody will physically handle the device.',
      'Pick the reason honestly: deprovision_retiring_device, deprovision_same_model_replace, deprovision_different_model_replace or deprovision_upgrade_transfer. The choice affects whether the licence can be reused.',
      'From GAM 7.43.05 onwards the default maxtodeprov is 1, so the command refuses when more than one device matches. Set maxtodeprov 0 to act on a whole org unit deliberately.',
      'The shipped grammar spells that argument maxtodeprov. Some wiki prose writes max_to_deprov, and the grammar is the one that is right.',
      'Deprovisioning is not a soft state. Bringing the device back means wiping and re-enrolling it.',
    ],
    destructive: true,
  },
  {
    id: 'cros-move-ou',
    task: 'Move ChromeOS devices into a different org unit',
    category: 'reports',
    template: 'gam update cros <deviceid> ou <ou>',
    params: [
      {
        name: 'deviceid',
        description: 'The ChromeOS device id.',
        example: 'a1b2c3d4-5e6f-7890-abcd-ef1234567890',
        required: true,
      },
      P.ou,
    ],
    notes: [
      GIT_BASH_SLASH,
      'For a whole org unit at once, gam cros_ou <from> update ou <to> quickcrosmove is much faster than looping.',
      'The org unit decides the device policy, so this is how a shared laptop becomes a kiosk and back again.',
    ],
  },
  {
    id: 'oauth-info',
    task: 'Work out why GAM says Not Authorized',
    category: 'reports',
    template: 'gam oauth info',
    params: [],
    notes: [
      'Not Authorized to access this resource or api almost always means a missing OAuth scope, not a missing admin role. gam print groups can succeed in the same session where gam info group fails, and that is the tell.',
      'The same error appears for an account on a different subdomain, which is a genuinely separate directory rather than a permissions problem.',
      'Add showsecret only when you know who is looking at your screen.',
    ],
  },
  {
    id: 'version-check',
    task: 'Check which GAM you are actually running',
    category: 'reports',
    template: 'gam version extended',
    params: [],
    notes: [
      'Worth doing before you trust any example you found online. Legacy GAM 4, 5 and 6, the older gam.py lineage, genuinely differ from everything here, and plenty of them are still installed.',
      'GAMADV-XTD3 is not a rival fork any more. Its README says it has been replaced by GAM7, its last release was 7.05.08 in March 2025, and GAM7 is the continuation of that same code, which is why almost all of the syntax matches.',
      'gam version simple prints just the number, and checkrc sets the exit code so a script can tell whether you are out of date.',
    ],
  },
];
