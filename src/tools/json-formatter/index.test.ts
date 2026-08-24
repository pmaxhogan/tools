import { describe, expect, it } from "vitest";
import { base64Decode, base64Encode, decodeJwt, run, validateJson } from "./index";
import { ToolError } from "../types";

const opts = (mode: string, indent = "2") => ({ mode, indent });

const UGLY = '{"b":1,\n  "a":[1,2,  3]}';

/** base64url-encode an object the way a JWT issuer would. */
function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("json-formatter: format", () => {
  it("pretty-prints with 2 spaces by default", () => {
    expect(run(UGLY, opts("format"))).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2,\n    3\n  ]\n}');
  });

  it("honors the 4-space and tab indents", () => {
    expect(run('{"a":1}', opts("format", "4"))).toBe('{\n    "a": 1\n}');
    expect(run('{"a":1}', opts("format", "tab"))).toBe('{\n\t"a": 1\n}');
  });

  it("rejects an unknown indent", () => {
    expect(() => run('{"a":1}', opts("format", "8"))).toThrowError(/Unknown indent/);
  });

  it("throws a positioned ToolError on malformed JSON", () => {
    expect(() => run('{"a": 1,}', opts("format"))).toThrowError(ToolError);
    try {
      run('{\n  "a": 1,\n}', opts("format"));
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ToolError;
      expect(err.code).toBe("invalid-json");
      expect(err.message).toMatch(/position \d+/);
      expect(err.message).toMatch(/line \d+, column \d+/);
      expect(err.fix).toMatch(/trailing comma/);
    }
  });
});

describe("json-formatter: minify", () => {
  it("strips all insignificant whitespace", () => {
    expect(run(UGLY, opts("minify"))).toBe('{"b":1,"a":[1,2,3]}');
  });

  it("handles scalars and nested structures", () => {
    expect(run('  [ { "x" : null } , true ]  ', opts("minify"))).toBe('[{"x":null},true]');
  });

  it("throws a positioned ToolError on malformed JSON", () => {
    try {
      run("{'a': 1}", opts("minify"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-json");
      expect((e as ToolError).message).toMatch(/position \d+/);
    }
  });
});

describe("json-formatter: validate", () => {
  it("reports valid documents with shape info", () => {
    const out = run('{"a":1,"b":2}', opts("validate")) as Record<string, string>;
    expect(out.Valid).toBe("yes");
    expect(out["Root type"]).toBe("object");
    expect(out["Top-level keys"]).toBe("2");
  });

  it("counts array items and reports scalar roots", () => {
    expect((run("[1,2,3]", opts("validate")) as Record<string, string>).Items).toBe("3");
    expect((run("null", opts("validate")) as Record<string, string>)["Root type"]).toBe("null");
  });

  it("returns invalid as a RESULT, never as a thrown error", () => {
    const out = run('{"a": 1,}', opts("validate")) as Record<string, string>;
    expect(out.Valid).toBe("no");
    expect(out.Error).toBeTruthy();
    expect(Number(out.Position)).toBeGreaterThan(0);
    expect(out.Line).toBe("1");
    // Every value the record surface renders must be a string.
    expect(Object.values(out).every((v) => typeof v === "string")).toBe(true);
  });

  it("reports line and column for a multi-line document", () => {
    const out = validateJson('{\n  "a": 1\n  "b": 2\n}');
    expect(out.Valid).toBe("no");
    expect(out.Line).toBe("3");
  });
});

describe("json-formatter: jwt-decode", () => {
  // The canonical HS256 example token, assembled from its known base64url parts.
  const HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
  const PAYLOAD = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
  const SIGNATURE = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  const TOKEN = `${HEADER}.${PAYLOAD}.${SIGNATURE}`;

  it("decodes header, payload and signature of a real token", () => {
    const out = run(TOKEN, opts("jwt-decode")) as Record<string, string>;
    expect(out.Algorithm).toBe("HS256");
    expect(out.Type).toBe("JWT");
    expect(JSON.parse(out.Header)).toEqual({ alg: "HS256", typ: "JWT" });
    expect(JSON.parse(out.Payload)).toEqual({
      sub: "1234567890",
      name: "John Doe",
      iat: 1516239022,
    });
    expect(out.Header).toContain('\n  "alg"');
    expect(out.Signature).toBe(SIGNATURE);
    expect(out["Signature verified"]).toMatch(/^no/);
  });

  it("humanizes exp, iat and nbf as ISO strings", () => {
    const token = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
      iat: 1516239022,
      nbf: 1516239022,
      exp: 1516242622,
    })}.sig`;
    const out = decodeJwt(token);
    expect(out.Algorithm).toBe("RS256");
    expect(out["Issued at (iat)"]).toBe("2018-01-18T01:30:22.000Z");
    expect(out["Not before (nbf)"]).toBe("2018-01-18T01:30:22.000Z");
    expect(out["Expires (exp)"]).toBe("2018-01-18T02:30:22.000Z");
  });

  it("omits time claims that are absent and labels a missing signature", () => {
    const out = decodeJwt(`${b64url({ alg: "none" })}.${b64url({ sub: "x" })}.`);
    expect(out["Expires (exp)"]).toBeUndefined();
    expect(out.Type).toBe("(not specified)");
    expect(out.Signature).toBe("(none: unsecured token)");
  });

  it("names the part that failed: wrong number of segments", () => {
    try {
      run(`${HEADER}.${PAYLOAD}`, opts("jwt-decode"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-jwt");
      expect((e as ToolError).message).toMatch(/3 dot-separated parts/);
    }
  });

  it("names the part that failed: an empty header or payload segment", () => {
    expect(() => decodeJwt(".abc.sig")).toThrowError(/JWT header is empty/);
    expect(() => decodeJwt(`${HEADER}..sig`)).toThrowError(/JWT payload is empty/);
  });

  it("names the part that failed: header is not base64url", () => {
    expect(() => decodeJwt(`not!base64.${PAYLOAD}.sig`)).toThrowError(
      /JWT header is not valid base64url/,
    );
  });

  it("names the part that failed: payload is not JSON", () => {
    const bad = Buffer.from("hello, not json", "utf8").toString("base64url");
    expect(() => decodeJwt(`${HEADER}.${bad}.sig`)).toThrowError(
      /JWT payload decoded, but it is not valid JSON/,
    );
  });

  it("rejects a payload that is JSON but not an object", () => {
    expect(() => decodeJwt(`${HEADER}.${b64url([1, 2])}.sig`)).toThrowError(
      /payload is valid JSON but not a JSON object/,
    );
  });
});

describe("json-formatter: base64", () => {
  it("encodes and decodes ASCII", () => {
    expect(run("hello", opts("base64-encode"))).toBe("aGVsbG8=");
    expect(run("aGVsbG8=", opts("base64-decode"))).toBe("hello");
  });

  it("round-trips unicode, including astral-plane emoji", () => {
    for (const text of ["😀", "héllo wörld", "こんにちは 😀🎉", "😀".repeat(500)]) {
      const encoded = base64Encode(text);
      expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      expect(base64Decode(encoded)).toBe(text);
    }
    expect(base64Encode("😀")).toBe("8J+YgA==");
    expect(run("8J+YgA==", opts("base64-decode"))).toBe("😀");
  });

  it("rejects strings that are not valid base64", () => {
    expect(() => run("not base64!!", opts("base64-decode"))).toThrowError(ToolError);
    try {
      run("abc", opts("base64-decode"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-base64");
      expect((e as ToolError).fix).toMatch(/multiple of 4/);
    }
  });

  it("rejects base64 whose bytes are not UTF-8 text", () => {
    // 0xff 0xfe 0xfd — a valid base64 string, but not decodable as text.
    try {
      run("//79", opts("base64-decode"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-utf8");
    }
  });
});

describe("json-formatter: url", () => {
  it("encodes reserved characters", () => {
    expect(run("a b&c=d/e?f", opts("url-encode"))).toBe("a%20b%26c%3Dd%2Fe%3Ff");
  });

  it("round-trips unicode", () => {
    const s = "café 😀";
    const encoded = run(s, opts("url-encode")) as string;
    expect(run(encoded, opts("url-decode"))).toBe(s);
  });

  it("rejects malformed percent-escapes", () => {
    try {
      run("%E0%A4%A", opts("url-decode"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("invalid-url-encoding");
      expect((e as ToolError).fix).toMatch(/%25/);
    }
  });
});

describe("json-formatter: input guards", () => {
  it("rejects empty and whitespace-only input in every mode", () => {
    for (const mode of [
      "format",
      "minify",
      "validate",
      "jwt-decode",
      "base64-encode",
      "base64-decode",
      "url-encode",
      "url-decode",
    ]) {
      expect(() => run("   \n ", opts(mode))).toThrowError(ToolError);
    }
    try {
      run("", opts("format"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("rejects an unknown mode instead of guessing", () => {
    try {
      run('{"a":1}', opts("yaml-please"));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ToolError).code).toBe("unknown-mode");
      expect((e as ToolError).fix).toMatch(/jwt-decode/);
    }
  });
});
