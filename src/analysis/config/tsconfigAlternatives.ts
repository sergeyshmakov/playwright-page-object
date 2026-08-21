import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "ts-morph";
import { ts } from "ts-morph";
import { LIBRARY_PACKAGE } from "../page-objects/libraryImports";
import {
	foldPath,
	ignoredExcludeGlobs,
	isDeclarationFile,
	isIgnoredPath,
	isOutsideRoot,
	toPosix,
	toPosixRelative,
} from "../util/paths";
import { SCAN_EXTENSIONS, tsConfigFileNames } from "./tsconfig";

/** A sibling tsconfig whose program contains direct imports of this package. */
export interface PageObjectTsConfigCandidate {
	/** Project-relative config path. */
	file: string;
	/** Analysable source files selected by the config. */
	filesCovered: number;
	/** Selected files whose module graph names `playwright-page-object`. */
	filesImportingLibrary: number;
}

export interface PageObjectTsConfigCandidates {
	candidates: PageObjectTsConfigCandidate[];
	/** More configs existed than the bounded diagnostic inspected. */
	truncated?: true;
}

const TSCONFIG_GLOB = "**/tsconfig*.json";
const MAX_CONFIGS_PROBED = 40;
const MAX_CANDIDATES_RETURNED = 5;
const SCAN_EXTENSION_SET = new Set<string>(SCAN_EXTENSIONS);

/**
 * Finds alternate TypeScript programs that contain evidence of page objects.
 *
 * This is deliberately demand-driven: expanding several tsconfigs and reading
 * their selected files is useful when `list_page_objects` found nothing, and
 * needless work on every healthy request. It also stays outside the workspace
 * memo because these sibling configs and their sources are not dependencies of
 * the selected program, so its epoch cannot invalidate them reliably.
 */
export function findPageObjectTsConfigCandidates(
	project: Project,
	projectRoot: string,
	selectedTsconfig: string | null,
): PageObjectTsConfigCandidates {
	const root = toPosix(projectRoot).replace(/\/+$/, "");
	let found: string[];
	try {
		found = [
			...project
				.getFileSystem()
				.globSync([`${root}/${TSCONFIG_GLOB}`, ...ignoredExcludeGlobs(root)]),
		];
	} catch {
		return { candidates: [] };
	}

	const selectedKey = selectedTsconfig
		? foldPath(toPosix(path.resolve(selectedTsconfig)))
		: null;
	const configs = [...new Set(found.map(toPosix))]
		.filter((file) => {
			const relative = toPosixRelative(root, file);
			return (
				!isOutsideRoot(relative) &&
				!isIgnoredPath(relative) &&
				foldPath(toPosix(path.resolve(file))) !== selectedKey
			);
		})
		.sort((left, right) => {
			const leftRelative = toPosixRelative(root, left);
			const rightRelative = toPosixRelative(root, right);
			return (
				leftRelative.split("/").length - rightRelative.split("/").length ||
				leftRelative.localeCompare(rightRelative)
			);
		});

	const truncated = configs.length > MAX_CONFIGS_PROBED;
	const candidates: PageObjectTsConfigCandidate[] = [];
	for (const config of configs.slice(0, MAX_CONFIGS_PROBED)) {
		const selected = tsConfigFileNames(config);
		if (!selected) {
			continue;
		}
		const files = selected.filter((file) => isAnalysableSource(root, file));
		let filesImportingLibrary = 0;
		for (const file of files) {
			if (importsLibrary(file)) {
				filesImportingLibrary += 1;
			}
		}
		if (filesImportingLibrary === 0) {
			continue;
		}
		candidates.push({
			file: toPosixRelative(root, config),
			filesCovered: files.length,
			filesImportingLibrary,
		});
	}

	candidates.sort(
		(left, right) =>
			right.filesImportingLibrary - left.filesImportingLibrary ||
			left.file.localeCompare(right.file),
	);
	return {
		candidates: candidates.slice(0, MAX_CANDIDATES_RETURNED),
		...(truncated || candidates.length > MAX_CANDIDATES_RETURNED
			? { truncated: true as const }
			: {}),
	};
}

function isAnalysableSource(root: string, file: string): boolean {
	const relative = toPosixRelative(root, file);
	const extension = path.extname(file).slice(1).toLowerCase();
	return (
		!isDeclarationFile(file) &&
		!isOutsideRoot(relative) &&
		!isIgnoredPath(relative) &&
		SCAN_EXTENSION_SET.has(extension)
	);
}

/** `preProcessFile` reads imports/re-exports/require without building an AST. */
function importsLibrary(file: string): boolean {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return false;
	}
	return ts
		.preProcessFile(text, true, true)
		.importedFiles.some((specifier) => specifier.fileName === LIBRARY_PACKAGE);
}
