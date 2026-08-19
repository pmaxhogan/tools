import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

describe("subnet-calculator", () => {
  it("computes a classic /24", () => {
    const out = run("192.168.1.0/24", { split: 0 });
    expect(out["CIDR"]).toBe("192.168.1.0/24");
    expect(out["Netmask"]).toBe("255.255.255.0");
    expect(out["Wildcard mask"]).toBe("0.0.0.255");
    expect(out["Network address"]).toBe("192.168.1.0");
    expect(out["Broadcast address"]).toBe("192.168.1.255");
    expect(out["First usable host"]).toBe("192.168.1.1");
    expect(out["Last usable host"]).toBe("192.168.1.254");
    expect(out["Usable host count"]).toBe("254");
    expect(out["Total addresses"]).toBe("256");
    expect(out["Binary netmask"]).toBe("11111111.11111111.11111111.00000000");
    expect(out["Address type"]).toBe("Private (RFC 1918)");
  });

  it("handles a /31 point-to-point link per RFC 3021", () => {
    const out = run("192.168.1.0/31", { split: 0 });
    expect(out["Broadcast address"]).toMatch(/RFC 3021/);
    expect(out["First usable host"]).toBe("192.168.1.0");
    expect(out["Last usable host"]).toBe("192.168.1.1");
    expect(out["Usable host count"]).toMatch(/^2 /);
  });

  it("handles a /32 single host", () => {
    const out = run("192.168.1.5/32", { split: 0 });
    expect(out["Network address"]).toBe("192.168.1.5");
    expect(out["Broadcast address"]).toBe("N/A (single host)");
    expect(out["First usable host"]).toBe("192.168.1.5");
    expect(out["Last usable host"]).toBe("192.168.1.5");
    expect(out["Usable host count"]).toBe("1 (this address only)");
  });

  it("assumes /32 for a bare IPv4 address and says so", () => {
    const out = run("192.168.1.5", { split: 0 });
    expect(out["CIDR"]).toBe("192.168.1.5/32");
    expect(out["Note"]).toMatch(/\/32/);
  });

  it("parses an address plus dotted netmask", () => {
    const out = run("192.168.1.37 255.255.255.0", { split: 0 });
    expect(out["CIDR"]).toBe("192.168.1.0/24");
    expect(out["Containing network"]).toMatch(/192\.168\.1\.37/);
    expect(out["Containing network"]).toMatch(/192\.168\.1\.0\/24/);
  });

  it("computes an IPv6 /48", () => {
    const out = run("2001:db8::/48", { split: 0 });
    expect(out["Compressed address"]).toBe("2001:db8::");
    expect(out["Expanded address"]).toBe("2001:0db8:0000:0000:0000:0000:0000:0000");
    expect(out["Prefix length"]).toBe("/48");
    expect(out["Last address"]).toBe("2001:db8:0:ffff:ffff:ffff:ffff:ffff");
    expect(out["Total addresses"]).toBe("2^80");
    expect(out["Scope"]).toMatch(/Documentation/);
  });

  it("assumes /128 for a bare IPv6 address and says so", () => {
    const out = run("2001:db8::1", { split: 0 });
    expect(out["Prefix length"]).toBe("/128");
    expect(out["Note"]).toMatch(/\/128/);
  });

  it("splits a network into 4 equal subnets", () => {
    const out = run("10.0.0.0/24", { split: 4 });
    expect(out["Subnet 1"]).toBe("10.0.0.0/26");
    expect(out["Subnet 2"]).toBe("10.0.0.64/26");
    expect(out["Subnet 3"]).toBe("10.0.0.128/26");
    expect(out["Subnet 4"]).toBe("10.0.0.192/26");
    expect(out["Subnet 5"]).toBeUndefined();
  });

  it("truncates a split beyond 32 rows", () => {
    const out = run("10.0.0.0/8", { split: 64 });
    expect(out["Subnet 32"]).toBeDefined();
    expect(out["Subnet 33"]).toBeUndefined();
    expect(out["Split truncated"]).toMatch(/64/);
  });

  it("detects containment between two CIDRs", () => {
    const out = run("10.0.0.0/16 10.0.1.0/24", { split: 0 });
    expect(out["Relationship"]).toMatch(/10\.0\.0\.0\/16 contains 10\.0\.1\.0\/24/);
    expect(out["Overlap"]).toBe("Yes");
  });

  it("finds the smallest common supernet", () => {
    const out = run("10.0.0.0/24, 10.0.1.0/24", { split: 0 });
    expect(out["Smallest common supernet"]).toBe("10.0.0.0/23");
    expect(out["Overlap"]).toBe("No");
  });

  it("throws empty-input on blank input", () => {
    expect(() => run("", { split: 0 })).toThrowError(ToolError);
    try {
      run("  ", { split: 0 });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("throws bad-ip on an unparseable address", () => {
    try {
      run("not.an.ip", { split: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-ip");
      expect((e as ToolError).message).toMatch(/not\.an\.ip/);
    }
  });

  it("throws bad-prefix on an out-of-range prefix", () => {
    try {
      run("10.0.0.0/99", { split: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-prefix");
    }
  });

  it("throws bad-prefix on a non-contiguous netmask", () => {
    try {
      run("192.168.1.37 255.255.0.255", { split: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-prefix");
    }
  });

  it("throws bad-split when the split would exceed /32", () => {
    try {
      run("10.0.0.0/30", { split: 8 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-split");
    }
  });

  it("throws bad-ip when comparing an IPv4 and an IPv6 CIDR", () => {
    try {
      run("10.0.0.0/24, 2001:db8::/48", { split: 0 });
      expect.unreachable();
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-ip");
    }
  });
});
