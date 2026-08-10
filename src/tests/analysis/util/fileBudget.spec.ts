import * as path from "node:path";
import { Project } from "ts-morph";
import { beforeEach, describe, expect, it } from "vitest";
import { AnalysisLimitError } from "../../../analysis/diagnostics";
import { admitAddedFile } from "../../../analysis/util/fileBudget";
import { Workspace } from "../../../analysis/workspace";

/**
 * The cap gate is a chain keyed by the `Project`, not by the workspace that
 * installed it, so a gate outlives its owner unless the owner is careful.
 */

const ROOT = path.resolve("/ppo-budget");

function projectWith(count: number): Project {
	const project = new Project({ useInMemoryFileSystem: true });
	for (let index = 0; index < count; index += 1) {
		project.createSourceFile(
			`${ROOT.replace(/\\/g, "/")}/src/f${index}.ts`,
			`export const f${index} = ${index};\n`,
		);
	}
	return project;
}

beforeEach(() => {
	Workspace.reset();
});

describe("file admission gates", () => {
	// A `Workspace` whose construction threw never became an owner of anything.
	// Its gate used to stay on the chain for the life of the `Project`, so the
	// next caller to reuse that project — with the larger `maxFiles` the failure
	// asked for — had every on-demand addition refused by a cap nobody owned.
	it("leaves no cap behind when construction fails", () => {
		const project = projectWith(3);
		expect(() =>
			Workspace.fromProject(project, { projectRoot: ROOT, maxFiles: 1 }),
		).toThrow(AnalysisLimitError);

		Workspace.fromProject(project, { projectRoot: ROOT, maxFiles: 50 });
		const added = project.createSourceFile(
			`${ROOT.replace(/\\/g, "/")}/src/late.ts`,
			"export const late = 1;\n",
		);
		expect(() => admitAddedFile(project, added)).not.toThrow();
	});

	// The other half of the same rule: a gate whose owner *did* finish is still
	// enforced, however lax a later owner of the same project is.
	it("keeps the gate of an owner that finished", () => {
		const project = projectWith(2);
		Workspace.fromProject(project, { projectRoot: ROOT, maxFiles: 2 });
		Workspace.fromProject(project, { projectRoot: ROOT, maxFiles: 50 });
		const added = project.createSourceFile(
			`${ROOT.replace(/\\/g, "/")}/src/late.ts`,
			"export const late = 1;\n",
		);
		expect(() => admitAddedFile(project, added)).toThrow(AnalysisLimitError);
	});
});
