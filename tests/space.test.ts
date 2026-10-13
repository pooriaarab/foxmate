// Tests for docs/failure-modes.md D6, D7 and D8: run_python is not a way to fetch web pages or find files.
import { describe, expect, it } from "vitest";
import { spaceTool } from "../src/space.js";

const den = (files: string[] = []) => {
  const ran: string[] = [];
  return { ran, den: async () => ({ run: async (code: string) => { ran.push(code); return { stdout: "", stderr: "", result: "2", error: null }; }, list: async () => files }) };
};
const ctx = {} as never;

describe("space", () => {
  it("D6: code that opens a network connection is refused before it runs, with a hint to the browser tools", async () => {
    for (const code of [
      'import urllib.request\nhtml = urllib.request.urlopen("http://127.0.0.1:51194/miniwob/click-dialog.html").read()',
      "from urllib.request import urlopen\nurlopen('https://bank.test/')",
      "import requests\nrequests.get('https://bank.test/')",
      "import http.client\nc = http.client.HTTPSConnection('bank.test')",
      "import socket\nsocket.create_connection(('bank.test', 443))",
      "from pyodide.http import pyfetch\nawait pyfetch('https://bank.test/')",
      "import js\njs.fetch('https://bank.test/')",
    ]) {
      const { ran, den: open } = den();
      const out = await spaceTool(open).run({ code }, ctx);
      expect(out.ok, code).toBe(false);
      expect(out.summary).toMatch(/no network/i);
      expect(out.summary).toMatch(/snapshot/);
      expect(ran).toEqual([]);
    }
  });

  it("D6: other code still runs, and the description says Python cannot read web pages", async () => {
    const { ran, den: open } = den(["/drop/bill.txt"]);
    const tool = spaceTool(open);
    const out = await tool.run({ code: "sum([1050.0, 200.29])\n# parse the request rows from /drop/bill.txt" }, ctx);
    expect(out.ok).toBe(true);
    expect(ran).toHaveLength(1);
    expect(tool.description).toMatch(/not .*web pages|cannot read web pages/i);
  });

  it("D7: with no files in the Space, code that reads files is refused with a hint to the page; with files it runs", async () => {
    for (const code of ["import os\nfor d in ['/drop','/home']:\n    print(os.listdir(d))", "print(open('landlord-notices.txt').read())", "import glob\nprint(glob.glob('/**/*.txt'))", "from pathlib import Path\nprint(list(Path('/').iterdir()))"]) {
      const { ran, den: open } = den();
      const out = await spaceTool(open).run({ code }, ctx);
      expect(out.ok, code).toBe(false);
      expect(out.summary).toMatch(/no files/i);
      expect(out.summary).toMatch(/site.s links/);
      expect(ran).toEqual([]);
    }
    const full = den(["/drop/notices.txt"]);
    expect((await spaceTool(full.den).run({ code: "print(open('/drop/notices.txt').read())" }, ctx)).ok).toBe(true);
    expect(full.ran).toHaveLength(1);
    const sums = den();
    expect((await spaceTool(sums.den).run({ code: "round(1000 * 0.195 + 5.29, 2)" }, ctx)).ok).toBe(true);
  });

  it("D8: an empty Space gets a run description for arithmetic that points to the site's links; the D7 hint does too", async () => {
    const empty = spaceTool(den().den);
    const told = await empty.describeRun?.();
    expect(told).toMatch(/no files/i);
    expect(told).toMatch(/arithmetic/i);
    expect(told).toMatch(/links/i);
    expect(told).not.toMatch(/on the files in the Space/);
    const out = await empty.run({ code: "import os\nprint(os.listdir('/drop'))" }, ctx);
    expect(out.summary).toMatch(/links/i);
    expect(out.summary).toMatch(/Documents or Files/);
    expect(await spaceTool(den(["/drop/bill.txt"]).den).describeRun?.()).toBeUndefined();
  });
});
