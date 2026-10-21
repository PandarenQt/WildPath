import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {markdownToHtml} from "../scripts/content/build-guide.mjs";

test("the guide's Markdown becomes its pages' HTML: headings, lists, tables, code and inline marks", () => {
  assert.equal(markdownToHtml("## A\n\nSome **b** and `c`\nwrapped.\n\n- one\n  more\n- two\n\n| X | Y |\n| --- | --- |\n| 1 | 2 |\n\n```\nnode a <b>\n```"),
    ["<h2>A</h2>", "<p>Some <strong>b</strong> and <code>c</code> wrapped.</p>", "<ul>", "<li>one more</li>", "<li>two</li>", "</ul>",
      "<table><thead><tr><th>X</th><th>Y</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>",
      "<pre><code>node a &lt;b&gt;</code></pre>"].join("\n"));
});

test("the guide compendium is built from docs/guide, a page per file", () => {
  const guide = JSON.parse(readFileSync("packs/_source/guide/wildpath-guide.json", "utf8"));
  assert.equal(guide.pages.length, 8);
  assert.ok(guide.pages.every(page => page.text.content && !page.text.content.includes("```")));
});
