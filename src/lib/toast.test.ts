import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TOAST_MS,
  MAX_TOASTS,
  clearToasts,
  dismissToast,
  getToasts,
  subscribeToasts,
  toast,
} from "./toast";

afterEach(() => {
  clearToasts();
});

describe("toast", () => {
  it("queues a toast and returns its id", () => {
    const id = toast({ title: "Copied" });
    expect(id).toBeTruthy();
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]).toMatchObject({ id, title: "Copied", variant: "default" });
  });

  it("gives every toast a unique id", () => {
    const ids = [toast({ title: "a" }), toast({ title: "b" }), toast({ title: "c" })];
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps the variant, description and duration it was given", () => {
    toast({
      title: "Copy failed",
      description: "Copy it by hand instead.",
      variant: "error",
      durationMs: 6000,
    });
    expect(getToasts()[0]).toMatchObject({
      title: "Copy failed",
      description: "Copy it by hand instead.",
      variant: "error",
      durationMs: 6000,
    });
  });

  it("falls back to the default duration for a missing or non positive value", () => {
    toast({ title: "a" });
    toast({ title: "b", durationMs: 0 });
    toast({ title: "c", durationMs: -1 });
    for (const t of getToasts()) expect(t.durationMs).toBe(DEFAULT_TOAST_MS);
  });

  it("stamps createdAt so a late renderer can compute the time left", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    toast({ title: "a" });
    expect(getToasts()[0]?.createdAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
    vi.useRealTimers();
  });

  it("caps the stack and drops the oldest", () => {
    for (const title of ["one", "two", "three", "four", "five"]) toast({ title });
    const titles = getToasts().map((t) => t.title);
    expect(titles).toHaveLength(MAX_TOASTS);
    expect(titles).toEqual(["three", "four", "five"]);
  });

  it("orders the stack oldest first", () => {
    toast({ title: "first" });
    toast({ title: "second" });
    expect(getToasts().map((t) => t.title)).toEqual(["first", "second"]);
  });
});

describe("dismissToast", () => {
  it("removes only the named toast", () => {
    const a = toast({ title: "a" });
    toast({ title: "b" });
    dismissToast(a);
    expect(getToasts().map((t) => t.title)).toEqual(["b"]);
  });

  it("ignores an unknown id without notifying", () => {
    toast({ title: "a" });
    const seen: number[] = [];
    subscribeToasts((list) => seen.push(list.length));
    dismissToast("nope");
    expect(seen).toEqual([1]);
    expect(getToasts()).toHaveLength(1);
  });
});

describe("subscribeToasts", () => {
  it("calls back immediately with the current stack", () => {
    toast({ title: "already here" });
    const seen: string[][] = [];
    subscribeToasts((list) => seen.push(list.map((t) => t.title)));
    expect(seen).toEqual([["already here"]]);
  });

  it("notifies on push and on dismiss", () => {
    const seen: number[] = [];
    subscribeToasts((list) => seen.push(list.length));
    const id = toast({ title: "a" });
    dismissToast(id);
    expect(seen).toEqual([0, 1, 0]);
  });

  it("stops notifying after unsubscribe", () => {
    const seen: number[] = [];
    const off = subscribeToasts((list) => seen.push(list.length));
    off();
    toast({ title: "a" });
    expect(seen).toEqual([0]);
  });

  it("shares one stack across every subscriber, the way two islands do", () => {
    const island1: number[] = [];
    const island2: number[] = [];
    subscribeToasts((list) => island1.push(list.length));
    subscribeToasts((list) => island2.push(list.length));
    toast({ title: "from a panel" });
    expect(island1.at(-1)).toBe(1);
    expect(island2.at(-1)).toBe(1);
  });

  it("hands subscribers a stack they cannot mutate in place", () => {
    toast({ title: "a" });
    const before = getToasts();
    toast({ title: "b" });
    // Each change publishes a new array, so a Vue ref holding the old one is
    // never mutated behind the renderer's back.
    expect(before).toHaveLength(1);
    expect(getToasts()).toHaveLength(2);
  });
});

describe("clearToasts", () => {
  it("empties the stack and notifies once", () => {
    toast({ title: "a" });
    toast({ title: "b" });
    const seen: number[] = [];
    subscribeToasts((list) => seen.push(list.length));
    clearToasts();
    clearToasts();
    expect(seen).toEqual([2, 0]);
  });
});
