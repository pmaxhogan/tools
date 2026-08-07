import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { ToolError } from "../types";
import {
  describeHeader,
  formatCell,
  introspect,
  renderRows,
  run,
  safeIdent,
  scalar,
  summarize,
  toCsv,
  type SqlEngine,
  type SqliteOpts,
} from "./index";

/**
 * The logic layer never imports sql.js, so the tests supply the engine. A real
 * SQLite build runs happily in Node, which means these are not stub tests: the
 * quoting, the pragmas and the row shapes are checked against the same engine
 * the panel uses in the browser.
 */
let db: SqlEngine;

const WEIRD = 'my "table"';

const OPTS: SqliteOpts = { maxRows: 100, maxCell: 40 };

beforeAll(async () => {
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
  });

  const database = new SQL.Database();
  database.run(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY NOT NULL,
      email TEXT NOT NULL,
      bio TEXT,
      avatar BLOB
    );
    CREATE TABLE ${safeIdent(WEIRD)} (
      id INTEGER,
      note TEXT
    );
    CREATE VIEW active_users AS SELECT id, email FROM users WHERE bio IS NOT NULL;
    CREATE INDEX idx_users_email ON users (email);

    INSERT INTO users VALUES (1, 'ada@example.com', 'first programmer', NULL);
    INSERT INTO users VALUES (2, 'grace@example.com', NULL, NULL);
    INSERT INTO users VALUES (3, 'linus@example.com', 'kernel', x'00ff10a5');
    INSERT INTO ${safeIdent(WEIRD)} VALUES (1, 'a name with "quotes" in it');
  `);

  db = database;
});

describe("safeIdent", () => {
  it("double quotes a plain name", () => {
    expect(safeIdent("users")).toBe('"users"');
  });

  it("doubles interior quotes", () => {
    expect(safeIdent('my "table"')).toBe('"my ""table"""');
  });

  it("survives spaces, keywords and semicolons", () => {
    expect(safeIdent("order by; drop table users")).toBe('"order by; drop table users"');
    expect(safeIdent("two words")).toBe('"two words"');
  });

  it("quotes an odd name well enough for SQLite to use it", () => {
    const rows = db.exec(`SELECT note FROM ${safeIdent(WEIRD)}`);
    expect(rows[0].values[0][0]).toBe('a name with "quotes" in it');
  });
});

describe("introspect", () => {
  it("lists tables with row counts", () => {
    const info = introspect(db);
    expect(info.tables.map((t) => t.name)).toEqual([WEIRD, "users"]);
    expect(info.tables.find((t) => t.name === "users")?.rowCount).toBe(3);
    expect(info.tables.find((t) => t.name === WEIRD)?.rowCount).toBe(1);
  });

  it("reports columns with types, primary keys and not null", () => {
    const users = introspect(db).tables.find((t) => t.name === "users");
    expect(users?.columns).toEqual([
      { name: "id", type: "INTEGER", pk: true, notnull: true },
      { name: "email", type: "TEXT", pk: false, notnull: true },
      { name: "bio", type: "TEXT", pk: false, notnull: false },
      { name: "avatar", type: "BLOB", pk: false, notnull: false },
    ]);
  });

  it("lists views, indexes and the SQLite version", () => {
    const info = introspect(db);
    expect(info.views).toEqual(["active_users"]);
    expect(info.indexes).toEqual(["idx_users_email"]);
    expect(info.sqliteVersion).toMatch(/^\d+\.\d+/);
  });

  it("leaves out SQLite internal objects", async () => {
    const SQL = await initSqlJs({
      locateFile: (file: string) =>
        path.join(process.cwd(), "node_modules", "sql.js", "dist", file),
    });
    const other = new SQL.Database();
    other.run(`
      CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, msg TEXT);
      CREATE TABLE codes (code TEXT UNIQUE);
      INSERT INTO logs (msg) VALUES ('hello');
    `);

    // AUTOINCREMENT creates sqlite_sequence, UNIQUE creates sqlite_autoindex_*.
    const raw = other.exec("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_%'");
    expect(raw[0].values.length).toBeGreaterThan(0);

    const info = introspect(other);
    expect(info.tables.map((t) => t.name)).toEqual(["codes", "logs"]);
    expect(info.indexes).toEqual([]);
    other.close();
  });

  it("throws a ToolError when the schema cannot be read", () => {
    const broken: SqlEngine = {
      exec() {
        throw new Error("file is not a database");
      },
    };
    expect(() => introspect(broken)).toThrow(ToolError);
    try {
      introspect(broken);
    } catch (e) {
      expect((e as ToolError).code).toBe("unreadable-database");
      expect((e as ToolError).message).toContain("file is not a database");
      expect((e as ToolError).fix).toContain("encrypted");
    }
  });

  it("reports an unknown row count instead of failing the whole schema", () => {
    let calls = 0;
    const flaky: SqlEngine = {
      exec(sql: string) {
        calls++;
        if (sql.startsWith("SELECT type, name FROM sqlite_master")) {
          return [{ columns: ["type", "name"], values: [["table", "ghost"]] }];
        }
        if (sql.startsWith("SELECT COUNT(*)")) throw new Error("no such table: ghost");
        return [];
      },
    };
    const info = introspect(flaky);
    expect(calls).toBeGreaterThan(1);
    expect(info.tables).toEqual([{ name: "ghost", rowCount: -1, columns: [] }]);
  });
});

describe("renderRows", () => {
  it("aligns columns and spells out NULL", () => {
    const result = db.exec("SELECT id, email, bio FROM users ORDER BY id")[0];
    expect(renderRows(result)).toBe(
      [
        "3 rows x 3 columns",
        "",
        "| id  | email             | bio              |",
        "| --- | ----------------- | ---------------- |",
        "| 1   | ada@example.com   | first programmer |",
        "| 2   | grace@example.com | NULL             |",
        "| 3   | linus@example.com | kernel           |",
      ].join("\n"),
    );
  });

  it("shows blobs by size rather than by content", () => {
    const result = db.exec("SELECT avatar FROM users WHERE id = 3")[0];
    expect(renderRows(result)).toContain("<blob 4 bytes>");
    expect(renderRows(result)).not.toContain("¥");
  });

  it("notes how many rows were left out", () => {
    const result = db.exec("SELECT id FROM users ORDER BY id")[0];
    const out = renderRows(result, { maxRows: 2 });
    expect(out).toContain("| 1   |");
    expect(out).not.toContain("| 3   |");
    expect(out).toContain("... 1 more row (3 total)");
  });

  it("shortens long cells and says so", () => {
    const result: import("./index").SqlExecResult = {
      columns: ["note"],
      values: [["abcdefghijklmnop"], ["short"]],
    };
    const out = renderRows(result, { maxCell: 8 });
    expect(out).toContain("| abcdefg… |");
    expect(out).toContain("Note: 1 cell was shortened to 8 characters.");
  });

  it("flattens newlines and escapes pipes so the grid stays readable", () => {
    const out = renderRows({ columns: ["v"], values: [["a\nb|c"]] });
    expect(out).toContain("| a b\\|c |");
  });

  it("handles a statement that returned no columns", () => {
    expect(renderRows({ columns: [], values: [] })).toBe("This statement returned no columns.");
  });

  it("keeps a header for an empty result set", () => {
    const result = db.exec("SELECT id FROM users WHERE id = 99")[0] ?? {
      columns: ["id"],
      values: [],
    };
    expect(renderRows(result)).toContain("0 rows x 1 column");
  });
});

describe("summarize", () => {
  it("lists every table with its row count and columns", () => {
    const out = summarize(db);
    expect(out).toMatch(/^SQLite \d+\.\d+/);
    expect(out).toContain("2 tables, 1 view, 1 index");
    expect(out).toContain("users (3 rows)");
    expect(out).toContain('my "table" (1 row)');
    expect(out).toContain("id      INTEGER  primary key, not null");
    expect(out).toContain("email   TEXT     not null");
    expect(out).toContain("Views: active_users");
    expect(out).toContain("Indexes: idx_users_email");
  });

  it("says so when a database has no tables", () => {
    const empty: SqlEngine = {
      exec(sql: string) {
        if (sql.startsWith("SELECT sqlite_version")) {
          return [{ columns: ["sqlite_version()"], values: [["3.0.0"]] }];
        }
        return [];
      },
    };
    expect(summarize(empty)).toContain("This database has no tables of its own.");
  });
});

describe("formatCell, scalar and toCsv", () => {
  it("formats the value kinds SQLite hands back", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(undefined)).toBe("NULL");
    expect(formatCell(42)).toBe("42");
    expect(formatCell("")).toBe("");
    expect(formatCell(new Uint8Array([1]))).toBe("<blob 1 byte>");
    expect(formatCell(new Uint8Array([1, 2, 3]))).toBe("<blob 3 bytes>");
    expect(formatCell("a very long value indeed", 10)).toBe("a very lo…");
  });

  it("reads a single pragma value, or null when there is none", () => {
    expect(scalar(db, "PRAGMA page_size")).toMatch(/^\d+$/);
    expect(scalar(db, "PRAGMA encoding")).toBe("UTF-8");
    expect(scalar(db, "SELECT bio FROM users WHERE id = 2")).toBeNull();
    expect(scalar(db, "SELECT * FROM nope")).toBeNull();
  });

  it("writes CSV with quoted fields, empty NULLs and blob placeholders", () => {
    const result = db.exec("SELECT id, bio, avatar FROM users ORDER BY id")[0];
    expect(toCsv(result)).toBe(
      ["id,bio,avatar", "1,first programmer,", "2,,", "3,kernel,<blob 4 bytes>"].join("\n"),
    );
    expect(toCsv({ columns: ["a"], values: [["x,y"], ['he said "hi"']] })).toBe(
      ["a", '"x,y"', '"he said ""hi"""'].join("\n"),
    );
  });
});

describe("describeHeader", () => {
  it("recognises a real SQLite file", () => {
    const bytes = new TextEncoder().encode("SQLite format 3\0rest of the file");
    expect(describeHeader(bytes)).toEqual({
      looksLikeSqlite: true,
      found: "SQLite format 3\\x00",
    });
  });

  it("names the bytes it actually found", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const described = describeHeader(zip);
    expect(described.looksLikeSqlite).toBe(false);
    expect(described.found).toBe(
      "PK\\x03\\x04\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00",
    );
  });

  it("handles an empty file", () => {
    expect(describeHeader(new Uint8Array(0))).toEqual({
      looksLikeSqlite: false,
      found: "(empty file)",
    });
  });
});

describe("run", () => {
  it("describes dropped bytes and points at the panel", () => {
    const bytes = new TextEncoder().encode("SQLite format 3\0more");
    const out = run(bytes, OPTS);
    expect(out.File).toBe("20 bytes read.");
    expect(out.Header).toContain("SQLite format 3");
    expect(out["Open it above"]).toContain("panel");
  });

  it("is honest when the bytes are not a database", () => {
    const out = run(new Uint8Array([0x25, 0x50, 0x44, 0x46]), OPTS);
    expect(out.Header).toContain("%PDF");
    expect(out.Header).toContain("encrypted");
  });

  it("explains that typed SQL needs a database first", () => {
    const out = run("select * from users;", OPTS);
    expect(out["Your SQL"]).toBe("select * from users;");
    expect(out["Nothing to run it against"]).toContain(".sqlite3");
    expect(out["Rows at a time"]).toContain("100 rows");
    expect(out["Where it runs"]).toContain("your files and inputs never leave your device");
  });

  it("respects the row option it was given", () => {
    const out = run("select 1", { maxRows: 25, maxCell: 40 });
    expect(out["Rows at a time"]).toContain("25 rows");
  });

  it("throws on empty input", () => {
    expect(() => run("   ", OPTS)).toThrow(ToolError);
    try {
      run("", OPTS);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toContain("Drop a .db");
    }
  });
});
