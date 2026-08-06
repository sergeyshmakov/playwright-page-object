import type { Project, SourceFile } from "ts-morph";

/**
 * Cap gate for files that join a `Project` outside the workspace's own scan —
 * on-demand module resolution, chiefly: a `.js` module, an alias target,
 * anything outside a narrowed scope.
 *
 * The resolver takes a `Project`, not a `Workspace`, and it is the engine's
 * leaf utility: threading the owner through every call site would pull the
 * whole workspace module in behind it. A registry keyed by the project keeps
 * the enforcement single without that import edge.
 */
export type FileAdmission = (added: SourceFile) => void;

const admissions = new WeakMap<Project, FileAdmission>();

/** Registers the owning workspace's gate. One workspace, one project, one gate. */
export function registerFileAdmission(
	project: Project,
	admit: FileAdmission,
): void {
	admissions.set(project, admit);
}

/**
 * Runs the owning workspace's gate over a file that was just added.
 *
 * Throws `AnalysisLimitError` when the addition puts the project past
 * `maxFiles`; the gate undoes the addition first, so the project is left
 * exactly as it was. A project nobody registered — a bare `Project` built by a
 * unit test — has no cap to enforce.
 */
export function admitAddedFile(project: Project, added: SourceFile): void {
	admissions.get(project)?.(added);
}
