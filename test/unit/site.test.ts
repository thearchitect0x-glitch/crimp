// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Deimos AI LLC
/** The format's home: generated from the sources of truth, and the committed copy cannot drift from them. */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { markdown, inline, build } from '../../scripts/site.js';

describe('the markdown subset', () => {
  test('headings, paragraphs, inline marks and links', () => {
    const r = markdown('# Title here\n\nA **bold** and *italic* line with `code` and a [link](/x).\n\n## Section');
    assert.equal(r.title, 'Title here');
    assert.match(r.html, /<h1 id="title-here">Title here<\/h1>/);
    assert.match(r.html, /<p>A <strong>bold<\/strong> and <em>italic<\/em> line with <code>code<\/code> and a <a href="\/x">link<\/a>.<\/p>/);
    assert.deepEqual(r.toc, [{ level: 2, id: 'section', text: 'Section' }]);
  });
  test('code inside backticks is never touched, and HTML is escaped', () => {
    assert.equal(inline('`a < b && **not bold**`'), '<code>a &lt; b &amp;&amp; **not bold**</code>');
    assert.equal(inline('<script>'), '&lt;script&gt;');
  });
  test('fenced code, tables with escaped pipes, lists, blockquotes and rules', () => {
    const r = markdown([
      '```jsonc', '{ "a": 1 } // <x>', '```', '',
      '| Field | Values |', '|---|---|', '| `s` | `a \\| b` |', '',
      '- one', '- two', '  continued', '  - nested', '',
      '1. first', '2. second', '',
      '> quoted **text**', '', '---',
    ].join('\n'));
    assert.match(r.html, /<pre><code class="language-jsonc">\{ &quot;a&quot;: 1 \} \/\/ &lt;x&gt;<\/code><\/pre>/);
    assert.match(r.html, /<th>Field<\/th><th>Values<\/th>/);
    assert.match(r.html, /<td><code>s<\/code><\/td><td><code>a \| b<\/code><\/td>/);
    assert.match(r.html, /<ul><li>one<\/li><li>two continued<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
    assert.match(r.html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(r.html, /<blockquote><p>quoted <strong>text<\/strong><\/p><\/blockquote>/);
    assert.match(r.html, /<hr>/);
  });
  test('an HTML comment is dropped, not rendered', () => {
    assert.equal(markdown('<!-- SPDX -->\n# T\n').html, '<h1 id="t">T</h1>');
  });
});

describe('the committed site', () => {
  test('is exactly what the generator produces from the current sources', () => {
    const files = build();
    for (const [rel, content] of Object.entries(files)) {
      assert.equal(readFileSync(`web/${rel}`, 'utf8'), content, `web/${rel} is stale — run: npm run site`);
    }
  });
  test('says how many vectors there are, and gets the number from the vectors', () => {
    const v = JSON.parse(readFileSync('spec/vectors/vectors.json', 'utf8')) as Record<string, unknown>;
    const n = Object.values(v).filter(Array.isArray).reduce((a, g) => a + (g as unknown[]).length, 0);
    assert.match(readFileSync('web/index.html', 'utf8'), new RegExp(`${n} conformance\\s+vectors`));
  });
  test('holds the verifier unchanged, and the spec as markdown beside the render', () => {
    assert.equal(readFileSync('web/verify.html', 'utf8'), readFileSync('spec/verifier.html', 'utf8'));
    assert.equal(readFileSync('web/spec/verifier.mjs', 'utf8'), readFileSync('spec/verifier.mjs', 'utf8'));
    assert.equal(readFileSync('web/spec/SPEC.md', 'utf8'), readFileSync('docs/SPEC.md', 'utf8'));
  });
});
