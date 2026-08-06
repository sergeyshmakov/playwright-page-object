import { foldPath, normalizeRelPath } from "../util/paths";

/**
 * Levenshtein distance, iterative two-row form.
 *
 * Local rather than a dependency: the engine only ever runs it over a handful
 * of short identifiers, and the core package's zero-runtime-dependency rule
 * makes adding `fastest-levenshtein` a poor trade.
 */
export function editDistance(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	if (a.length === 0) {
		return b.length;
	}
	if (b.length === 0) {
		return a.length;
	}

	let previous = new Array<number>(b.length + 1);
	let current = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j += 1) {
		previous[j] = j;
	}

	for (let i = 1; i <= a.length; i += 1) {
		current[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1] + 1,
				previous[j] + 1,
				previous[j - 1] + cost,
			);
		}
		const swap = previous;
		previous = current;
		current = swap;
	}
	return previous[b.length];
}

/**
 * Closest candidates to `target`, best first.
 *
 * The distance ceiling scales with length so `PromoCode` does not "suggest"
 * `SignIn`; a suggestion that is not plausibly a typo is worse than none.
 */
export function nearestIds(
	target: string,
	candidates: Iterable<string>,
	limit = 3,
): string[] {
	const lowered = target.toLowerCase();
	const ceiling = Math.max(2, Math.ceil(target.length / 3));
	const scored: Array<{ id: string; distance: number }> = [];
	for (const candidate of candidates) {
		if (candidate === target) {
			continue;
		}
		const distance = editDistance(lowered, candidate.toLowerCase());
		if (distance <= ceiling) {
			scored.push({ id: candidate, distance });
		}
	}
	scored.sort((a, b) =>
		a.distance === b.distance
			? a.id < b.id
				? -1
				: 1
			: a.distance - b.distance,
	);
	return scored.slice(0, limit).map((entry) => entry.id);
}

function basenameOf(folded: string): string {
	return folded.slice(folded.lastIndexOf("/") + 1);
}

function byDistanceThenName(
	a: { file: string; distance: number },
	b: { file: string; distance: number },
): number {
	return a.distance === b.distance
		? a.file.localeCompare(b.file)
		: a.distance - b.distance;
}

/**
 * Files worth naming after a path that matched nothing, best first.
 *
 * Three tiers, because a caller who writes an unmatched path has made one of
 * three mistakes and they are not equally likely: they wrote a trailing segment
 * of the real path (`Home.ts` for `e2e/Home.ts`), they got the directory wrong
 * but the basename right, or they mistyped. Dumping the whole file list instead
 * — which is what this replaces, at 305 entries in one field test — buries the
 * answer in the noise and costs more tokens than the payload it accompanies.
 *
 * Case is folded exactly where the filesystem folds it, so a Windows caller's
 * `E2E/home.ts` still finds `e2e/Home.ts` and a Linux one's does not.
 */
export function nearestFiles(
	wanted: string,
	files: Iterable<string>,
	limit = 8,
): string[] {
	const list = [...new Set(files)];
	const target = foldPath(normalizeRelPath(wanted));
	const base = basenameOf(target);

	const suffixed: string[] = [];
	const sameBasename: string[] = [];
	const rest: string[] = [];
	for (const file of list) {
		const candidate = foldPath(normalizeRelPath(file));
		if (candidate === target || candidate.endsWith(`/${target}`)) {
			suffixed.push(file);
		} else if (basenameOf(candidate) === base) {
			sameBasename.push(file);
		} else {
			rest.push(file);
		}
	}

	const baseCeiling = Math.max(2, Math.ceil(base.length / 3));
	const pathCeiling = Math.max(2, Math.ceil(target.length / 3));
	const nearBasename: Array<{ file: string; distance: number }> = [];
	const nearPath: Array<{ file: string; distance: number }> = [];
	for (const file of rest) {
		const candidate = foldPath(normalizeRelPath(file));
		const distance = editDistance(base, basenameOf(candidate));
		if (distance <= baseCeiling) {
			nearBasename.push({ file, distance });
			continue;
		}
		const full = editDistance(target, candidate);
		if (full <= pathCeiling) {
			nearPath.push({ file, distance: full });
		}
	}
	nearBasename.sort(byDistanceThenName);
	nearPath.sort(byDistanceThenName);

	return [
		...new Set([
			...suffixed.sort(),
			...sameBasename.sort(),
			...nearBasename.map((entry) => entry.file),
			...nearPath.map((entry) => entry.file),
		]),
	].slice(0, limit);
}
