import { describe, expect, it } from "bun:test";
import { NativeGeometryFollower, validNativeGrid, type NativeGrid } from "./native-geometry.ts";
const grid = (cols = 80, rows = 24): NativeGrid => ({ cols, rows });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe("native geometry ownership", () => {
  it("shares one read across panes and applies only native layout changes", async () => {
    let reads = 0; const changed: NativeGrid[] = [];
    const layouts = new Map([["a", grid()], ["b", grid(120, 30)]]);
    const follower = new NativeGeometryFollower(async () => { reads++; return layouts; });
    follower.watch("a", grid(), value => changed.push(value));
    follower.watch("b", grid(120, 30), value => changed.push(value));
    await follower.refresh(); expect(reads).toBe(1); expect(changed).toEqual([]);
    layouts.set("a", grid(70, 18)); await follower.refresh();
    expect(changed).toEqual([grid(70, 18)]);
    await follower.refresh(); expect(changed).toHaveLength(1);
    follower.stop();
  });
  it("does not overlap slow reads or apply them to a replaced controller", async () => {
    let resolve!: (map: Map<string, NativeGrid>) => void; let reads = 0;
    const changed: NativeGrid[] = [];
    const follower = new NativeGeometryFollower(() => { reads++; return new Promise(r => { resolve = r; }); });
    const old = follower.watch("a", grid(), value => changed.push(value));
    const pending = follower.refresh(); await flush();
    expect(follower.refresh()).toBe(pending); expect(reads).toBe(1);
    follower.watch("a", grid(), value => changed.push(value)); old();
    resolve(new Map([["a", grid(60, 12)]])); await pending;
    expect(changed).toEqual([]);
    const next = follower.refresh(); await flush(); resolve(new Map([["a", grid(65, 16)]])); await next;
    expect(changed).toEqual([grid(65, 16)]); follower.stop();
  });
  it("ignores missing, invalid and unreadable layouts rather than guessing", async () => {
    const changed: NativeGrid[] = []; let fail = true;
    const layouts = new Map<string, NativeGrid>();
    const follower = new NativeGeometryFollower(async () => { if (fail) throw Error("offline"); return layouts; });
    follower.watch("a", grid(), value => changed.push(value));
    await follower.refresh(); fail = false; await follower.refresh();
    for (const value of [grid(0), grid(80, -1), grid(80, 1.5), grid(1001), grid(NaN)]) {
      layouts.set("a", value); await follower.refresh();
    }
    expect(changed).toEqual([]);
    layouts.set("a", grid(90, 40)); await follower.refresh(); expect(changed).toEqual([grid(90, 40)]);
    follower.stop();
  });
  it("does not read without subscribers and discards completion after stop", async () => {
    let resolve!: (map: Map<string, NativeGrid>) => void; let reads = 0; let changes = 0;
    const follower = new NativeGeometryFollower(() => { reads++; return new Promise(r => { resolve = r; }); });
    await follower.refresh(); expect(reads).toBe(0);
    follower.watch("a", grid(), () => changes++);
    const pending = follower.refresh(); await flush(); follower.stop();
    resolve(new Map([["a", grid(60, 12)]])); await pending; await follower.refresh();
    expect(reads).toBe(1); expect(changes).toBe(0);
  });
  it("validates row and column bounds", () => {
    expect(validNativeGrid(undefined)).toBe(false);
    expect(validNativeGrid(grid(1000, 1000))).toBe(true);
  });
});
