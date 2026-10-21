import {mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";

/**
 * The player and GM guide (docs/guide/*.md) as the system's Journal compendium, one entry with a page per file, in
 * file order: packs/_source/guide. Its Markdown is kept simple (headings, paragraphs, lists, tables, code blocks, bold,
 * italics, code, links), which this turns into the page's HTML; the Markdown stays its source.
 *
 *   node scripts/content/build-guide.mjs
 */

const escape = text => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = text => escape(text)
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\*([^*]+)\*/g, "<em>$1</em>")
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<a href=\"$2\">$1</a>");
const cells = line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => inline(cell.trim()));

/** A guide page's Markdown as HTML. */
export function markdownToHtml(markdown) {
  const html = [];
  let list = null;
  let table = null;
  let paragraph = [];
  const flush = () => {
    if ( paragraph.length ) html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const close = () => {
    if ( list ) html.push(`</${list}>`);
    list = null;
  };
  const closeTable = () => {
    if ( table ) html.push(`<table><thead><tr>${table.head.map(cell => `<th>${cell}</th>`).join("")}</tr></thead><tbody>${table.rows
      .map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
    table = null;
  };
  let code = null;
  for ( const line of String(markdown).split(/\r?\n/) ) {
    // A fenced code block, as it is.
    if ( /^\s*```/.test(line) ) {
      if ( code ) { html.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`); code = null; }
      else { flush(); close(); closeTable(); code = []; }
      continue;
    }
    if ( code ) { code.push(line); continue; }
    // A table: its first row is its head; the row of dashes under it is left out.
    if ( /^\s*\|/.test(line) ) {
      flush(); close();
      if ( !table ) table = {head: cells(line), rows: []};
      else if ( !/^\s*\|[\s|:-]+\|\s*$/.test(line) ) table.rows.push(cells(line));
      continue;
    }
    closeTable();
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if ( heading ) {
      flush(); close();
      html.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    } else if ( item ) {
      flush();
      const kind = /\d/.test(item[1]) ? "ol" : "ul";
      if ( list !== kind ) { close(); html.push(`<${kind}>`); list = kind; }
      html.push(`<li>${inline(item[2])}</li>`);
    } else if ( !line.trim() ) {
      flush(); close();
    } else if ( list && /^\s+/.test(line) ) {
      html[html.length - 1] = html.at(-1).replace(/<\/li>$/, ` ${inline(line.trim())}</li>`);
    } else {
      close();
      paragraph.push(line.trim());
    }
  }
  flush(); close(); closeTable();
  return html.join("\n");
}

const isMain = process.argv[1]?.endsWith("build-guide.mjs");
if ( isMain ) {
  const files = readdirSync("docs/guide").filter(file => file.endsWith(".md")).sort();
  const id = "wildpathGuide000";
  const pages = files.map((file, index) => {
    const markdown = readFileSync(join("docs/guide", file), "utf8");
    const name = /^#\s+(.*)$/m.exec(markdown)?.[1] ?? file.replace(/\.md$/, "");
    const pageId = `wpGuidePage${String(index + 1).padStart(5, "0")}`;
    return {_id: pageId, _key: `!journal.pages!${id}.${pageId}`, name, type: "text", sort: (index + 1) * 100000,
      title: {show: false, level: 1}, text: {format: 1, content: markdownToHtml(markdown.replace(/^#\s+.*$/m, "").trim()), markdown}};
  });
  rmSync("packs/_source/guide", {recursive: true, force: true});
  mkdirSync("packs/_source/guide", {recursive: true});
  writeFileSync("packs/_source/guide/wildpath-guide.json", `${JSON.stringify({_id: id, _key: `!journal!${id}`, name: "WildPath Guide",
    pages, ownership: {default: 2}, flags: {wildpath: {guide: true}}}, null, 2)}\n`);
  console.log(`Guide: ${pages.length} pages`);
}
