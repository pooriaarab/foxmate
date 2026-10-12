// Tests for docs/failure-modes.md D6: run_python is not a way to fetch web pages.
import { describe, expect, it } from "vitest";
import { spaceTool } from "../src/space.js";

const den = () => {
  const ran: string[] = [];
  return { ran, den: async () => ({ run: async (code: string) => { ran.push(code); return { stdout: "", stderr: "", result: "2", error: null }; }, list: async () => [] }) };
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
    const { ran, den: open } = den();
    const tool = spaceTool(open);
    const out = await tool.run({ code: "sum([1050.0, 200.29])\n# parse the request rows from /drop/bill.txt" }, ctx);
    expect(out.ok).toBe(true);
    expect(ran).toHaveLength(1);
    expect(tool.description).toMatch(/not .*web pages|cannot read web pages/i);
  });
});
