import { foldPath, normalizeRelPath } from "../../analysis";

/**
 * Comparing a path the engine emitted with one a caller wrote.
 *
 * Shared by the handlers and by the not-found hints, which both have to decide
 * whether two spellings name the same file — and would answer differently if
 * each folded case its own way.
 */

export /**
 * A path as the engine spells it, folded for comparison: posix separators, no
 * leading `./`, and case folded only where the filesystem folds it too.
 *
 * Both halves come from the engine. The case rule in particular has one owner -
 * `util/paths.ts` documents `isCaseInsensitiveFileSystem` as the single source
 * of truth, blind spots and all - and re-inlining the platform test here meant
 * the tool layer could answer a question about the filesystem differently from
 * the analysis that produced the paths it is comparing.
 */
function foldFile(value: string): string {
	return foldPath(normalizeRelPath(value));
}

export /**
 * Whether an engine-emitted path is the scanned file `resolveEntryFile` picked.
 *
 * Exact, deliberately. The suffix rule that makes `Nested.tsx` stand in for
 * `src/deep/Nested.tsx` belongs to {@link matchEntryPath}, which has already run
 * by the time anything here compares paths — and applying it a second time to
 * the *result* undoes it: `src/App.tsx`, resolved exactly against the scan,
 * matched `packages/ui/src/App.tsx` again, so a monorepo that declares the
 * requested component in the package copy was answered with the package copy
 * however fully the caller spelled the path.
 */
function isScannedFile(rel: string, resolved: string): boolean {
	return foldFile(rel) === foldFile(resolved);
}
