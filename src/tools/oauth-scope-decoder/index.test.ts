import { describe, expect, it } from "vitest";
import { decode, extractScopes, guessUnknown, lookup, run } from "./index";
import { SCOPES } from "./data";
import { ToolError } from "../types";

const OPTS = { sort: "risk", hideLow: false };

/** Build a JWT-shaped token with the given payload. Signature is not checked. */
function jwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
): string {
  const b64 = (o: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(o), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64(header)}.${b64(payload)}.c2ln`;
}

describe("oauth-scope-decoder catalog", () => {
  it("has no duplicate patterns", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const s of SCOPES) {
      if (seen.has(s.pattern)) dupes.push(s.pattern);
      seen.add(s.pattern);
    }
    expect(dupes).toEqual([]);
  });

  it("is large enough to be useful", () => {
    expect(SCOPES.length).toBeGreaterThanOrEqual(150);
  });

  it("never uses em or en dashes in prose", () => {
    // U+2013 en dash and U+2014 em dash are banned in prose by DESIGN.md.
    const offenders = SCOPES.filter((s) => /[–—]/.test(`${s.plainEnglish}${s.riskWhy}${s.label}`));
    expect(offenders).toEqual([]);
  });
});

describe("oauth-scope-decoder lookup", () => {
  it("resolves a bare Google scope through the auth prefix", () => {
    expect(lookup("gmail.readonly")?.provider).toBe("Google");
    expect(lookup("https://www.googleapis.com/auth/gmail.readonly")?.risk).toBe("high");
  });

  it("resolves mail.google.com, which sits outside the auth prefix", () => {
    expect(lookup("https://mail.google.com/")?.risk).toBe("critical");
  });

  it("strips the Microsoft Graph resource prefix", () => {
    expect(lookup("https://graph.microsoft.com/Mail.Read")?.provider).toBe("Microsoft Graph");
  });

  it("falls back to a longest matching prefix pattern", () => {
    const hit = lookup("admin.directory.customer.readonly");
    expect(hit?.pattern).toBe("https://www.googleapis.com/auth/admin.directory.*");
    expect(hit?.risk).toBe("critical");
  });

  it("returns null for something genuinely unknown", () => {
    expect(lookup("acme.widgets.frobnicate")).toBeNull();
  });
});

describe("oauth-scope-decoder input extraction", () => {
  it("splits on spaces, commas and newlines and deduplicates", () => {
    expect(extractScopes("openid, profile\nemail openid")).toEqual(["openid", "profile", "email"]);
  });

  it("extracts a url encoded scope param from a consent URL", () => {
    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com" +
      "&response_type=code&redirect_uri=https%3A%2F%2Fexample.com%2Fcb" +
      "&scope=openid%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive";
    expect(extractScopes(url)).toEqual([
      "openid",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/drive",
    ]);
  });

  it("reads a scope param out of an implicit flow fragment", () => {
    const url = "https://example.com/cb#access_token=xyz&scope=user%3Aemail+repo&token_type=bearer";
    expect(extractScopes(url)).toEqual(["user:email", "repo"]);
  });

  it("treats a lone Google scope URL as a scope, not a consent URL", () => {
    expect(extractScopes("https://www.googleapis.com/auth/drive.file")).toEqual([
      "https://www.googleapis.com/auth/drive.file",
    ]);
  });

  it("extracts an scp array claim from a JWT payload", () => {
    const token = jwt({ aud: "api://x", scp: ["Mail.Read", "User.Read"] });
    expect(extractScopes(token)).toEqual(["Mail.Read", "User.Read"]);
  });

  it("extracts a space delimited scope claim, Bearer prefix and all", () => {
    const token = jwt({ scope: "openid profile email" });
    expect(extractScopes(`Bearer ${token}`)).toEqual(["openid", "profile", "email"]);
  });

  it("does not mistake a dotted scope name for a JWT", () => {
    expect(extractScopes("files.content.read")).toEqual(["files.content.read"]);
  });

  it("throws when a JWT carries no scope claim", () => {
    expect(() => extractScopes(jwt({ sub: "abc", aud: "api" }))).toThrowError(
      /scope, scp or scopes/,
    );
  });

  it("throws on an unreadable JWT payload", () => {
    expect(() => extractScopes("eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.sig")).toThrowError(ToolError);
  });
});

describe("oauth-scope-decoder run", () => {
  it("decodes a Google Gmail plus Drive grant", () => {
    const out = run("gmail.readonly drive", OPTS);
    expect(out["Access summary"]).toContain("2 scopes");
    expect(out["Access summary"]).toContain("Google");
    expect(out["Access summary"]).toContain("overall risk: critical");
    expect(out["Access summary"]).toContain("1 critical, 1 high");
    expect(out["gmail.readonly"]).toContain("Read every message");
    expect(out["gmail.readonly"]).toContain("(risk: high)");
    expect(out["drive"]).toContain("(risk: critical)");
    expect(out["Things to check"]).toContain("not a claim that this app misuses it");
  });

  it("counts a mixed risk grant correctly", () => {
    const out = run("openid, userinfo.email, gmail.send, drive.readonly", OPTS);
    expect(out["Access summary"]).toContain("4 scopes");
    expect(out["Access summary"]).toContain("overall risk: high");
    expect(out["Access summary"]).toContain("1 high, 1 moderate, 2 low");
  });

  it("flags GitHub repo plus delete_repo as critical overall", () => {
    const out = run("repo delete_repo workflow", OPTS);
    expect(out["Access summary"]).toContain("GitHub");
    expect(out["Access summary"]).toContain("overall risk: critical");
    expect(out["repo"]).toContain("private");
    expect(out["delete_repo"]).toContain("(risk: critical)");
    expect(out["Things to check"]).toContain("delete");
  });

  it("reports both providers when the list is mixed", () => {
    const out = run("gmail.readonly Mail.Read chat:write", OPTS);
    expect(out["Access summary"]).toContain("Google");
    expect(out["Access summary"]).toContain("Microsoft Graph");
    expect(out["Access summary"]).toContain("Slack");
  });

  it("marks an unknown scope as a guess with a heuristic read", () => {
    const out = run("foo.write.all", OPTS);
    const row = out["foo.write.all"];
    expect(row).toContain("Not in the catalog. The name suggests");
    expect(row).toContain("a guess");
    expect(row).toContain(".All suffix");
    expect(out["Access summary"]).toContain("no provider recognized");
    expect(out["Things to check"]).toContain("1 scope is not in the catalog");
    expect(out["Things to check"]).toContain("informed guess");
  });

  it("reads read-only unknown names as lower risk than delete ones", () => {
    expect(guessUnknown("widgets.list.readonly").risk).toBe("low");
    expect(guessUnknown("widgets.delete").risk).toBe("high");
    expect(guessUnknown("admin:everything.All").risk).toBe("critical");
  });

  it("calls out offline_access in the advice row", () => {
    const out = run("openid offline_access", OPTS);
    expect(out["Things to check"]).toContain("offline_access");
    expect(out["Things to check"]).toContain("refresh token");
  });

  it("sorts by risk descending by default and by input order on request", () => {
    const input = "openid drive gmail.send";
    const byRisk = Object.keys(run(input, { sort: "risk", hideLow: false }));
    expect(byRisk).toEqual(["Access summary", "drive", "gmail.send", "openid", "Things to check"]);

    const byInput = Object.keys(run(input, { sort: "input", hideLow: false }));
    expect(byInput).toEqual(["Access summary", "openid", "drive", "gmail.send", "Things to check"]);
  });

  it("hides low risk rows but still counts them in the summary", () => {
    const out = run("openid drive", { sort: "risk", hideLow: true });
    expect(out.openid).toBeUndefined();
    expect(out.drive).toBeDefined();
    expect(out["Access summary"]).toContain("2 scopes");
    expect(out["Access summary"]).toContain("1 low risk row hidden");
  });

  it("throws an actionable error on empty input", () => {
    expect(() => run("   ", OPTS)).toThrowError(ToolError);
    try {
      run("", OPTS);
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/scope list, an OAuth consent URL, or an access token/);
    }
  });

  it("decodes a single scope without pluralising the summary", () => {
    const out = run("openid", OPTS);
    expect(out["Access summary"]).toContain("1 scope ·");
  });

  it("keeps decode output shaped for the generic record panel", () => {
    const d = decode("Files.ReadWrite.All");
    expect(d.provider).toBe("Microsoft Graph");
    expect(d.risk).toBe("critical");
    expect(d.guess).toBe(false);
  });
});
