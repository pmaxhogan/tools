import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "sql-formatter",
  icon: "Database",
  matrixSlug: "sql-format",
  name: "SQL Formatter",
  description:
    "Prettify and normalise SQL across dialects with configurable keyword case and indentation.",
  category: "Data",
  keywords: [
    "sql formatter",
    "sql beautifier",
    "format sql online",
    "postgres sql formatter",
    "mysql sql formatter",
    "sql pretty print",
    "sql indent tool",
    "online sql formatter free",
  ],
  searchTerms: [
    "sql linter",
    "reformat sql",
    "sql code formatter",
    "query beautifier",
    "sql style formatter",
    "sql capitalize keywords",
    "multi statement sql formatter",
    "oracle sql formatter",
    "mariadb sql formatter",
    "sql formatting rules",
  ],
  input: "text/plain",
  output: "text/plain",
  options: [
    {
      kind: "select",
      id: "dialect",
      label: "Dialect",
      default: "sql",
      groups: [
        {
          label: "Standard",
          synonyms: ["ansi", "generic sql", "vanilla sql"],
          options: [
            {
              value: "sql",
              label: "Standard SQL",
              synonyms: ["ansi sql", "generic sql"],
            },
          ],
        },
        {
          label: "Open source databases",
          synonyms: ["postgres", "mysql", "mariadb", "sqlite", "free database"],
          options: [
            {
              value: "postgresql",
              label: "PostgreSQL",
              synonyms: ["postgres", "psql"],
            },
            {
              value: "mysql",
              label: "MySQL",
              synonyms: ["my sql"],
            },
            {
              value: "mariadb",
              label: "MariaDB",
              synonyms: ["maria db"],
            },
            {
              value: "sqlite",
              label: "SQLite",
              synonyms: ["sqlite3", "embedded database"],
            },
          ],
        },
        {
          label: "Commercial databases",
          synonyms: ["sql server", "oracle", "proprietary database", "enterprise database"],
          options: [
            {
              value: "tsql",
              label: "SQL Server (T-SQL)",
              synonyms: ["sql server", "microsoft sql server", "transact-sql", "mssql"],
            },
            {
              value: "plsql",
              label: "Oracle (PL/SQL)",
              synonyms: ["oracle", "oracle database", "procedural language sql"],
            },
          ],
        },
        {
          label: "Cloud data warehouses",
          synonyms: ["bigquery", "snowflake", "warehouse", "cloud database"],
          options: [
            {
              value: "bigquery",
              label: "BigQuery",
              synonyms: ["google bigquery", "gcp sql"],
            },
            {
              value: "snowflake",
              label: "Snowflake",
              synonyms: ["snowflake data cloud", "snowsql"],
            },
          ],
        },
      ],
    },
    {
      kind: "select",
      id: "keywordCase",
      label: "Keyword case",
      default: "upper",
      options: [
        {
          value: "upper",
          label: "UPPERCASE",
          synonyms: ["all caps", "capitalize keywords"],
        },
        {
          value: "lower",
          label: "lowercase",
          synonyms: ["small caps", "lowercase keywords"],
        },
        {
          value: "preserve",
          label: "Preserve as typed",
          synonyms: ["as typed", "keep case", "unchanged", "leave as is"],
        },
      ],
    },
    {
      kind: "number",
      id: "tabWidth",
      label: "Indent width",
      default: 2,
      min: 1,
      max: 8,
    },
    {
      kind: "number",
      id: "linesBetweenQueries",
      label: "Blank lines between queries",
      default: 1,
      min: 0,
      max: 5,
    },
  ],
  http: { method: "POST", contentType: "text/plain" },
  copy: {
    what: "Formats and normalises SQL for nine dialects, including Standard SQL, PostgreSQL, MySQL, SQLite, SQL Server, BigQuery, Snowflake, MariaDB, and Oracle PL/SQL. Reindents clauses, breaks long statements onto readable lines, and lets you set keyword case and indent width. Handles multiple semicolon-separated statements in one paste.",
    how: "Paste a query or a batch of statements into the input, pick the dialect that matches your database, and adjust keyword case, indent width, or spacing between queries. The formatted SQL appears instantly with a copy button, and the URL updates so you can share exactly what you see.",
    why: "Most online SQL formatters cap how much you can paste, run ads next to the output, or push a signup wall after a few uses, and all of them send your query to a server first. This one runs the formatter locally in your browser: your files and inputs never leave your device, there is no length cap, and no ads.",
    faq: [
      {
        q: "Which SQL dialects are supported?",
        a: "Standard SQL, PostgreSQL, MySQL, SQLite, SQL Server (T-SQL), BigQuery, Snowflake, MariaDB, and Oracle PL/SQL. Pick the one that matches your database for dialect-specific syntax like PostgreSQL casts or T-SQL square-bracket identifiers.",
      },
      {
        q: "Does it validate or run my SQL?",
        a: "No. It only reformats whitespace and casing, it does not check the query against a schema or execute it, so a formatted query can still fail at the database if the SQL itself is wrong.",
      },
      {
        q: "Is my query uploaded anywhere?",
        a: "No, your files and inputs never leave your device. Formatting happens entirely in your browser.",
      },
    ],
  },
};
