import * as path from "node:path";
import { Project, ts } from "ts-morph";
import { describe, expect, it } from "vitest";
import {
	CANONICAL_EXPORTS,
	FIXED_ARITY_DECORATORS,
	LIBRARY_BASE_CLASSES,
	MEMBER_DECORATORS,
	ROOT_DECORATORS,
} from "../../../analysis/page-objects/libraryImports";
import { REPO_ROOT } from "../helpers/example";

/**
 * The analyser's mirror of the library's public API, held to the real thing.
 *
 * `libraryImports.ts` hand-copies the names of every decorator and base class
 * `src/index.ts` exports, and those sets decide *what counts as a page object at
 * all*: `canonicalLocalName` resolves a local binding through them, and a name
 * missing from them resolves to nothing.
 *
 * That failure is silent and total. Add a decorator to the library, forget this
 * file, and a class using it disappears from `list_page_objects` and
 * `get_page_object_tree` — and, worse, drops out of the coverage denominator, so
 * the ids it selects are reported as uncovered rather than as unanalysed. No
 * error, no warning, just a smaller answer that looks complete.
 *
 * Read off the source syntactically rather than by importing `src/index.ts`,
 * for the same reason `no-runtime-import.spec.ts` does: a `type` re-export is
 * erased at runtime, so an import can only see the value exports, and the point
 * here is to notice a *new* name the moment it is written.
 */

/** Value (non-type) names `src/index.ts` re-exports. */
function publicValueExports(): Set<string> {
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true,
		skipLoadingLibFiles: true,
		compilerOptions: { target: ts.ScriptTarget.ES2022, noEmit: true },
	});
	const entry = project.addSourceFileAtPath(
		path.join(REPO_ROOT, "src", "index.ts"),
	);
	const names = new Set<string>();
	for (const declaration of entry.getExportDeclarations()) {
		// `export type { … } from` contributes nothing at runtime, and the analyser
		// only ever matches value bindings written in user code.
		if (declaration.isTypeOnly()) {
			continue;
		}
		for (const specifier of declaration.getNamedExports()) {
			if (specifier.isTypeOnly()) {
				continue;
			}
			const alias = specifier.getAliasNode();
			names.add(alias ? alias.getText() : specifier.getName());
		}
	}
	return names;
}

const PUBLIC = publicValueExports();

describe("the analyser's mirror of the library API", () => {
	it("reads a public surface at all", () => {
		// Guards the guard: a refactor that moves `src/index.ts` or switches it to
		// `export *` would otherwise make every assertion below vacuously true.
		expect(PUBLIC.size).toBeGreaterThan(15);
		expect(PUBLIC).toContain("PageObject");
		expect(PUBLIC).toContain("Selector");
	});

	it("classifies exactly the names the library exports", () => {
		// Both directions in one assertion, which is the point: a name the library
		// gained and this file has not, and a name this file still lists after the
		// library dropped it.
		expect([...CANONICAL_EXPORTS].sort()).toEqual([...PUBLIC].sort());
	});

	it("sorts every export into exactly one bucket", () => {
		// `CANONICAL_EXPORTS` is a union, so the test above passes even if a name
		// landed in two buckets or in none of the three and only in the union.
		const buckets = [ROOT_DECORATORS, MEMBER_DECORATORS, LIBRARY_BASE_CLASSES];
		for (const name of PUBLIC) {
			// `createFixtures` is a function, not a decorator or a base class; it is
			// canonical without belonging to any of the three.
			if (name === "createFixtures") {
				continue;
			}
			const homes = buckets.filter((bucket) => bucket.has(name));
			expect(homes.length, `${name} should be in exactly one bucket`).toBe(1);
		}
	});

	it("keeps the arity split inside the member decorators", () => {
		// `FIXED_ARITY_DECORATORS` names the ones whose factory argument sits at a
		// known index; anything in it that is not a member decorator is a typo that
		// would otherwise change nothing and be invisible.
		for (const name of FIXED_ARITY_DECORATORS) {
			expect(MEMBER_DECORATORS.has(name), `${name} is a member decorator`).toBe(
				true,
			);
		}
	});
});
