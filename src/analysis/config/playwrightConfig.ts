import * as path from "node:path";
import {
	Node,
	type ObjectLiteralExpression,
	type PropertyAssignment,
	type SourceFile,
	SyntaxKind,
} from "ts-morph";
import { info, warn } from "../diagnostics";
import type { Diagnostic, PlaywrightConfigInfo } from "../types";
import { toPosix } from "../util/paths";
import type { Workspace } from "../workspace";

const CONFIG_BASENAMES = [
	"playwright.config.ts",
	"playwright.config.mts",
	"playwright.config.cts",
	"playwright.config.js",
	"playwright.config.mjs",
	"playwright.config.cjs",
];

const NESTED_DIRS = ["test", "tests", "e2e"];

function findConfigFile(
	workspace: Workspace,
	explicitPath?: string,
): SourceFile | undefined {
	const add = (absolute: string): SourceFile | undefined => {
		const existing = workspace.project.getSourceFile(toPosix(absolute));
		if (existing) {
			return existing;
		}
		try {
			// The config normally lives outside the tsconfig `include`, so it has
			// to be added explicitly rather than looked up in the program.
			return workspace.project.addSourceFileAtPathIfExists(toPosix(absolute));
		} catch {
			return undefined;
		}
	};

	if (explicitPath) {
		const absolute = path.isAbsolute(explicitPath)
			? explicitPath
			: path.resolve(workspace.root, explicitPath);
		return add(absolute);
	}

	for (const basename of CONFIG_BASENAMES) {
		const found = add(path.join(workspace.root, basename));
		if (found) {
			return found;
		}
	}
	for (const dir of NESTED_DIRS) {
		for (const basename of CONFIG_BASENAMES) {
			const found = add(path.join(workspace.root, dir, basename));
			if (found) {
				return found;
			}
		}
	}
	return undefined;
}

function getProperty(
	object: ObjectLiteralExpression,
	name: string,
): PropertyAssignment | undefined {
	const property = object.getProperty(name);
	return property && Node.isPropertyAssignment(property) ? property : undefined;
}

function hasSpread(object: ObjectLiteralExpression): boolean {
	return object
		.getProperties()
		.some((property) => Node.isSpreadAssignment(property));
}

function stringLiteralValue(node: Node | undefined): string | undefined {
	if (!node) {
		return undefined;
	}
	if (
		Node.isStringLiteral(node) ||
		Node.isNoSubstitutionTemplateLiteral(node)
	) {
		return node.getLiteralValue();
	}
	return undefined;
}

function isDefineConfigCall(node: Node): boolean {
	if (!Node.isCallExpression(node)) {
		return false;
	}
	const expression = node.getExpression();
	if (Node.isIdentifier(expression)) {
		return expression.getText() === "defineConfig";
	}
	if (Node.isPropertyAccessExpression(expression)) {
		return expression.getName() === "defineConfig";
	}
	return false;
}

/**
 * `module.exports = …` in a CommonJS config.
 *
 * `.js` / `.cjs` are advertised config extensions, and a CommonJS config has no
 * `ExportAssignment` at all — without this the file is found, reported as
 * "shape unrecognized" and its `testIdAttribute` silently lost.
 */
function commonJsExports(sourceFile: SourceFile): Node[] {
	const out: Node[] = [];
	for (const statement of sourceFile.getStatements()) {
		if (!Node.isExpressionStatement(statement)) {
			continue;
		}
		const expression = statement.getExpression();
		if (
			!Node.isBinaryExpression(expression) ||
			expression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken
		) {
			continue;
		}
		const left = expression.getLeft();
		if (!Node.isPropertyAccessExpression(left)) {
			continue;
		}
		const target = left.getExpression();
		const isModuleExports =
			Node.isIdentifier(target) &&
			target.getText() === "module" &&
			left.getName() === "exports";
		const isExportsDefault =
			Node.isIdentifier(target) &&
			target.getText() === "exports" &&
			left.getName() === "default";
		if (isModuleExports || isExportsDefault) {
			out.push(expression.getRight());
		}
	}
	return out;
}

/** Unwraps `export default …` / `module.exports = …` to the config object. */
function resolveConfigObject(sourceFile: SourceFile): {
	object: ObjectLiteralExpression | null;
	reasonNode: Node | null;
} {
	const candidates: Node[] = [
		...sourceFile
			.getExportAssignments()
			.map((assignment) => assignment.getExpression()),
		...commonJsExports(sourceFile),
	];

	for (const candidate of candidates) {
		let expression: Node = candidate;
		for (let hop = 0; hop < 3; hop += 1) {
			if (
				Node.isAsExpression(expression) ||
				Node.isSatisfiesExpression(expression) ||
				Node.isParenthesizedExpression(expression)
			) {
				expression = expression.getExpression();
				continue;
			}
			if (isDefineConfigCall(expression) && Node.isCallExpression(expression)) {
				const first = expression.getArguments()[0];
				if (first) {
					expression = first;
					continue;
				}
				return { object: null, reasonNode: expression };
			}
			if (Node.isIdentifier(expression)) {
				const declaration = sourceFile.getVariableDeclaration(
					expression.getText(),
				);
				const initializer = declaration?.getInitializer();
				if (initializer) {
					expression = initializer;
					continue;
				}
				return { object: null, reasonNode: expression };
			}
			break;
		}
		if (Node.isObjectLiteralExpression(expression)) {
			return { object: expression, reasonNode: null };
		}
		return { object: null, reasonNode: expression };
	}
	return { object: null, reasonNode: null };
}

/**
 * Reads `playwright.config.*` **statically** — the config is never executed, so
 * `testIdAttribute: process.env.X` resolves to `undefined` plus a diagnostic
 * rather than to whatever the analysing process happens to have in its env.
 */
export function readPlaywrightConfig(
	workspace: Workspace,
	explicitPath?: string,
): PlaywrightConfigInfo {
	const notes: Diagnostic[] = [];
	const sourceFile = findConfigFile(workspace, explicitPath);

	if (!sourceFile) {
		notes.push(
			info(
				"playwright-config-not-found",
				`No playwright.config.{ts,mts,cts,js,mjs,cjs} found under ${toPosix(workspace.root)}; assuming Playwright defaults.`,
			),
		);
		return {
			configFile: null,
			testIdAttribute: undefined,
			testDir: undefined,
			projectOverrides: [],
			notes,
		};
	}

	const configFile = workspace.rel(sourceFile.getFilePath());
	const { object, reasonNode } = resolveConfigObject(sourceFile);

	if (!object) {
		notes.push(
			warn(
				"config-shape-unrecognized",
				"Could not statically resolve the default export of the Playwright config to an object literal.",
				reasonNode ? workspace.loc(reasonNode) : { file: configFile, line: 1 },
			),
		);
		return {
			configFile,
			testIdAttribute: undefined,
			testDir: undefined,
			projectOverrides: [],
			notes,
		};
	}

	// Playwright resolves a relative `testDir` against the directory holding the
	// config, not against the repo root — a nested `e2e/playwright.config.ts`
	// with `testDir: "./specs"` means `e2e/specs`.
	const rawTestDir = stringLiteralValue(
		getProperty(object, "testDir")?.getInitializer(),
	);
	const testDir =
		rawTestDir === undefined
			? undefined
			: workspace.rel(
					path.resolve(path.dirname(sourceFile.getFilePath()), rawTestDir),
				);

	let testIdAttribute: string | undefined;
	const useProperty = getProperty(object, "use");
	const useInitializer = useProperty?.getInitializer();
	if (useInitializer && Node.isObjectLiteralExpression(useInitializer)) {
		const attributeProperty = getProperty(useInitializer, "testIdAttribute");
		if (attributeProperty) {
			const initializer = attributeProperty.getInitializer();
			testIdAttribute = stringLiteralValue(initializer);
			if (testIdAttribute === undefined) {
				notes.push(
					warn(
						"testid-attribute-unresolved",
						"`use.testIdAttribute` is not a string literal and cannot be resolved without executing the config.",
						initializer
							? workspace.loc(initializer)
							: workspace.loc(attributeProperty),
					),
				);
			}
		} else if (hasSpread(useInitializer)) {
			notes.push(
				info(
					"testid-attribute-maybe-spread",
					"`use` contains a spread and no explicit `testIdAttribute`; the default `data-testid` may be wrong.",
					workspace.loc(useInitializer),
				),
			);
		}
	}

	const projectOverrides: PlaywrightConfigInfo["projectOverrides"] = [];
	const projectsInitializer = getProperty(object, "projects")?.getInitializer();
	if (
		projectsInitializer &&
		Node.isArrayLiteralExpression(projectsInitializer)
	) {
		for (const element of projectsInitializer.getElements()) {
			if (!Node.isObjectLiteralExpression(element)) {
				continue;
			}
			const projectUse = getProperty(element, "use")?.getInitializer();
			if (!projectUse || !Node.isObjectLiteralExpression(projectUse)) {
				continue;
			}
			const attributeProperty = getProperty(projectUse, "testIdAttribute");
			const value = stringLiteralValue(attributeProperty?.getInitializer());
			if (value === undefined || !attributeProperty) {
				continue;
			}
			projectOverrides.push({
				project:
					stringLiteralValue(getProperty(element, "name")?.getInitializer()) ??
					null,
				testIdAttribute: value,
				loc: workspace.loc(attributeProperty),
			});
		}
	}

	const disagreeing = projectOverrides.filter(
		(override) => override.testIdAttribute !== testIdAttribute,
	);
	if (disagreeing.length > 0) {
		notes.push(
			info(
				"testid-attribute-project-override",
				`${disagreeing.length} Playwright project(s) override testIdAttribute; analysis uses the top-level value.`,
				disagreeing[0].loc,
			),
		);
	}

	return { configFile, testIdAttribute, testDir, projectOverrides, notes };
}
