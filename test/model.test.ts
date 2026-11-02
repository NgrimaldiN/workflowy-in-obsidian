import { test } from "node:test";
import assert from "node:assert/strict";
import {
	parseOutline, serializeOutline, mergeInto, nodeKey, parseQuery, matches, fold, toPlain, fromPlain,
} from "../src/model.ts";

const SAMPLE = `---
tags: [outline]
---
- Projects
	- [ ] Ship the plugin
	  A note line
	  - not a child, escaped
	- [x] Done thing
- Ideas #inbox
	- Nested
		- Deeper
- Last
`;

test("round-trips a canonical outline", () => {
	const src = SAMPLE.replace("  - not a child, escaped", "  \\- not a child, escaped");
	const doc = parseOutline(src);
	assert.equal(doc.lossy, false);
	assert.equal(serializeOutline(doc), src);
});

test("parses tasks, notes, nesting", () => {
	const doc = parseOutline(SAMPLE);
	const [projects, ideas, last] = doc.root.children;
	assert.equal(projects.text, "Projects");
	assert.equal(projects.children.length, 2);
	const ship = projects.children[0];
	assert.equal(ship.checkbox, true);
	assert.equal(ship.completed, false);
	// "  - not a child" is indented under a 1-tab item by 2 spaces => more indented than the item marker => child list
	assert.equal(projects.children[1].completed, true);
	assert.equal(ideas.children[0].children[0].text, "Deeper");
	assert.equal(last.text, "Last");
});

test("space-indented and lossy input", () => {
	const doc = parseOutline("# Title\n\nSome prose\n- a\n  - b\n    note of b\n* c\n1. d\n");
	assert.equal(doc.lossy, true);
	assert.deepEqual(doc.root.children.map((c) => c.text), ["# Title", "Some prose", "a", "c", "d"]);
	assert.equal(doc.root.children[2].children[0].note, "note of b");
});

test("multi-line notes keep blank lines", () => {
	const src = "- item\n  line 1\n\n  line 2\n- next\n";
	const doc = parseOutline(src);
	assert.equal(doc.root.children[0].note, "line 1\n\nline 2");
	assert.equal(serializeOutline(doc), src);
});

test("empty items survive", () => {
	const src = "- \n- a\n\t- \n";
	assert.equal(serializeOutline(parseOutline(src)), src);
});

test("mergeInto parent splices children in place", () => {
	const doc = parseOutline("- A\n\t- B\n\t\t- B1\n\t- C\n");
	const a = doc.root.children[0];
	mergeInto(a, a.children[0]);
	assert.equal(serializeOutline(doc), "- AB\n\t- B1\n\t- C\n");
});

test("mergeInto sibling appends children", () => {
	const doc = parseOutline("- A\n\t- A1\n- B\n\t- B1\n");
	const [a, b] = doc.root.children;
	mergeInto(a, b);
	assert.equal(serializeOutline(doc), "- AB\n\t- A1\n\t- B1\n");
});

test("nodeKey disambiguates duplicates", () => {
	const doc = parseOutline("- x\n- x\n\t- y\n");
	const [x1, x2] = doc.root.children;
	assert.notEqual(nodeKey(x1), nodeKey(x2));
	assert.equal(nodeKey(x2.children[0]), "x\u00011\u0000y");
});

test("search: accents, negation, phrases, is:complete", () => {
	const doc = parseOutline("- Réunion équipe #work\n- [x] Café\n- other work\n");
	const [a, b, c] = doc.root.children;
	assert.ok(matches(a, parseQuery("reunion")));
	assert.ok(matches(b, parseQuery("is:complete")));
	assert.ok(!matches(a, parseQuery("is:complete")));
	assert.ok(matches(c, parseQuery("work -#work")));
	assert.ok(!matches(a, parseQuery("work -#work")));
	assert.ok(matches(a, parseQuery('"réunion équipe"')));
	assert.equal(fold("Éte").length, 3);
});

test("plain snapshot round trip", () => {
	const doc = parseOutline(SAMPLE);
	const copy = fromPlain(toPlain(doc.root));
	assert.equal(serializeOutline({ ...doc, root: copy }), serializeOutline(doc));
});

import { allKeys } from "../src/model.ts";
test("allKeys agrees with nodeKey", () => {
	const doc = parseOutline("- a\n\t- b\n\t- b\n\t\t- c\n- a\n");
	const keys = allKeys(doc.root);
	const check = (n: import("../src/model.ts").FNode) => {
		for (const c of n.children) {
			assert.equal(keys.get(c), nodeKey(c));
			check(c);
		}
	};
	check(doc.root);
	assert.equal(keys.size, 5);
});
