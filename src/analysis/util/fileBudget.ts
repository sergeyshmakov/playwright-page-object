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

const admissions = new WeakMap<Project, FileAdmission[]>();

/**
 * Registers an owning workspace's gate.
 *
 * Gates accumulate; they never replace one another. Two workspaces over one
 * `Project` is unusual — `Workspace.fromProject` is the only door — but a second
 * registration used to overwrite the first, so a later wrapper with a laxer
 * `maxFiles` became the only cap enforced and the earlier workspace kept a
 * guarantee that had quietly stopped holding. With every owner's gate on the
 * chain, the strictest cap is the one that decides.
 *
 * Called only once its owner is fully built. A gate registered by a workspace
 * whose construction then threw belongs to nothing: it stays on the chain for
 * the life of the `Project`, and the next owner of that same project — one with
 * a larger `maxFiles`, typically, since that is why the first one failed — has
 * every on-demand addition refused by a cap nobody is enforcing any more.
 */
export function registerFileAdmission(
	project: Project,
	admit: FileAdmission,
): void {
	const existing = admissions.get(project);
	if (existing) {
		existing.push(admit);
		return;
	}
	admissions.set(project, [admit]);
}

/**
 * Runs every owning workspace's gate over a file that was just added.
 *
 * Throws `AnalysisLimitError` when the addition puts the project past
 * `maxFiles`; the gate undoes the addition first, so the project is left
 * exactly as it was, and the remaining gates are moot. A project nobody
 * registered — a bare `Project` built by a unit test — has no cap to enforce.
 */
export function admitAddedFile(project: Project, added: SourceFile): void {
	const gates = admissions.get(project);
	if (!gates) {
		return;
	}
	for (const admit of gates) {
		admit(added);
	}
}
