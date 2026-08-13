import { warn } from "../diagnostics";
import type { Diagnostic, TestIdAttributeSource } from "../types";
import type { WorkspaceFiles } from "../workspaceFiles";

/**
 * Evidence that the resolved test-id attribute is the one the sources actually
 * use.
 *
 * Every tool in this engine reads test ids by attribute *name*. Resolve that
 * name wrongly — an undiscovered Playwright config, a `--attribute` typo, a
 * repository that migrated from `data-testid` to `data-tid` — and nothing
 * fails: the scan simply finds no attributes, the tree comes back empty, every
 * page-object selector looks dead and coverage reports `1` because zero of zero
 * ids are covered. Confidently wrong output with no warning is the worst answer
 * a static analyser can give, so the answer is checked against the source text
 * before it ships.
 */
export interface AttributeCensus {
	/** The attribute the analysis used. */
	attribute: string;
	/** JSX/TSX files in scope. Zero means the scope, not the attribute, is wrong. */
	files: number;
	/** Occurrences of `<attribute>=` found. Zero is the alarming case. */
	resolvedCount: number;
	/** Hyphenated attribute names present instead, most frequent first (max 5). */
	candidates: Array<{ name: string; count: number }>;
	evidence: "ast" | "text";
	/** `true` when counting stopped early because the attribute was clearly present. */
	sampled?: true;
	/**
	 * `true` when the name tally hit {@link MAX_TRACKED_NAMES} and stopped
	 * admitting new ones.
	 *
	 * Distinct from {@link sampled}, which is set on the opposite outcome - the
	 * attribute was found, so counting stopped early. This one says the search
	 * for an *alternative* was incomplete, which is the case where a caller is
	 * about to be told no alternative stood out.
	 */
	namesCapped?: true;
}

/**
 * Distinct attribute names tracked before the tally stops growing.
 *
 * A memory bound on a loop that terminates by itself, so its only effect is to
 * decide which names are countable - and at 64 that was reachable before the
 * scan ever met the real attribute. Inline SVG alone brings `stroke-width`,
 * `stroke-linecap`, `clip-rule`, `stop-color`, `text-anchor`,
 * `dominant-baseline` and a dozen more, and `ws.jsxFiles()` order then decides
 * which 64 win.
 *
 * That matters more here than anywhere else in the engine: this census is what
 * turns "no test ids found" into "you are reading the wrong attribute, and the
 * sources use `qa-id` 4,000 times". Losing the real name to a cap turns the one
 * diagnostic written against confidently-wrong output into
 * `attribute-no-evidence`.
 */
const MAX_TRACKED_NAMES = 4096;
const MAX_REPORTED_CANDIDATES = 5;
/**
 * One occurrence of a hyphenated attribute is as likely to be `aria`-adjacent
 * markup, a stray `data-icon`, or a string in a comment as it is to be the
 * repository's real test-id convention. Naming it would send a caller off to
 * restart the server with an attribute that matches one element.
 */
const MIN_CANDIDATE_COUNT = 2;

/**
 * Hyphenated attribute names in JSX-ish text.
 *
 * A hyphen is the whole filter: JavaScript identifiers cannot contain one, so
 * `foo-bar=` in a `.tsx` file is an attribute and essentially nothing else,
 * while `className=` / `onClick=` / `value=` never qualify. That keeps the
 * candidate list to the family test ids actually belong to (`data-*`, `qa-*`,
 * `test-*`) without parsing anything.
 */
const HYPHENATED_ATTRIBUTE = /\b([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+)\s*=/g;

/**
 * Counts the resolved attribute in the scanned JSX sources, and — only when it
 * is nowhere to be found — what the sources use instead.
 *
 * Phase one is a substring scan that stops at the first file containing the
 * attribute, so the healthy path costs one `includes()` per file up to the
 * first hit and nothing more. Phase two only ever runs on a repository where
 * the attribute is genuinely absent, which is precisely when spending a regex
 * sweep to produce an actionable message is worth it.
 *
 * The needle is `attribute=`, not the bare name: a repository whose README or
 * a comment mentions `data-testid` must not be able to silence the check.
 */
export function censusFromText(
	ws: WorkspaceFiles,
	attribute: string,
): AttributeCensus {
	return ws.memo(`attr-census::${attribute}`, [], () => {
		const files = ws.jsxFiles();
		const needle = `${attribute}=`;

		for (const sourceFile of files) {
			const text = sourceFile.getFullText();
			if (!text.includes(needle)) {
				continue;
			}
			return {
				attribute,
				files: files.length,
				resolvedCount: countOccurrences(text, needle),
				candidates: [],
				evidence: "text",
				sampled: true,
			};
		}

		const tally = new Map<string, number>();
		let capped = false;
		for (const sourceFile of files) {
			capped =
				tallyAttributeNames(sourceFile.getFullText(), attribute, tally) ||
				capped;
		}
		const candidates = [...tally.entries()]
			.filter(([name]) => name !== attribute)
			.sort(
				(left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1),
			)
			.slice(0, MAX_REPORTED_CANDIDATES)
			.map(([name, count]) => ({ name, count }));

		return {
			attribute,
			files: files.length,
			resolvedCount: 0,
			candidates,
			evidence: "text",
			...(capped ? { namesCapped: true as const } : {}),
		};
	});
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index >= 0) {
		count += 1;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Tallies hyphenated names into `into`. Returns whether the cap turned any away. */
function tallyAttributeNames(
	text: string,
	attribute: string,
	into: Map<string, number>,
): boolean {
	let capped = false;
	HYPHENATED_ATTRIBUTE.lastIndex = 0;
	let match = HYPHENATED_ATTRIBUTE.exec(text);
	while (match !== null) {
		const name = match[1];
		// `aria-*` is an accessibility contract, never a test hook: offering
		// `aria-label` as the repository's test-id attribute would be noise.
		const skip = name !== attribute && name.startsWith("aria-");
		if (!skip) {
			if (into.has(name) || into.size < MAX_TRACKED_NAMES) {
				into.set(name, (into.get(name) ?? 0) + 1);
			} else {
				capped = true;
			}
		}
		match = HYPHENATED_ATTRIBUTE.exec(text);
	}
	return capped;
}

/**
 * Turns the census into the one diagnostic worth shipping, or `null` when the
 * environment checks out.
 *
 * Messages name no CLI flag: this is the engine, and the same census backs a
 * future `doctor` command and any programmatic consumer. The MCP layer turns a
 * verdict into flag-shaped advice; see `environmentHint` in `src/mcp/tools.ts`.
 */
export function attributeVerdict(
	census: AttributeCensus,
	attributeSource: TestIdAttributeSource,
): Diagnostic | null {
	if (census.files === 0) {
		return warn(
			"scope-empty",
			"No JSX/TSX files are in the analysed scope, so no rendered test id can be found and every page-object selector will look unmatched.",
			undefined,
			{ kind: "jsx", attribute: census.attribute },
		);
	}
	if (census.resolvedCount > 0) {
		return null;
	}

	const origin = describeSource(attributeSource);
	const [candidate, runnerUp] = census.candidates;

	if (candidate && candidate.count >= MIN_CANDIDATE_COUNT) {
		const alternative = runnerUp
			? ` (next most common: "${runnerUp.name}", ${runnerUp.count})`
			: "";
		return warn(
			"attribute-mismatch",
			`No element in the ${census.files} scanned JSX/TSX file(s) uses the "${census.attribute}" attribute (${origin}), but "${candidate.name}" appears ${candidate.count} time(s)${alternative}. Every test id in this result was read with an attribute the sources do not use.`,
			undefined,
			{
				attribute: census.attribute,
				attributeSource,
				files: census.files,
				candidate: candidate.name,
				candidateCount: candidate.count,
				runnerUp: runnerUp?.name,
				runnerUpCount: runnerUp?.count,
			},
		);
	}

	// `namesCapped` turns this from a finding into a shrug, and saying so is the
	// difference between "the sources use no such convention" and "we stopped
	// looking". The second is not a conclusion a caller should act on.
	const incomplete = census.namesCapped
		? ` The search for an alternative was incomplete: more distinct attribute names were present than the tally admits, so a name they do use may not have been counted.`
		: "";
	return warn(
		"attribute-no-evidence",
		`No element in the ${census.files} scanned JSX/TSX file(s) uses the "${census.attribute}" attribute (${origin}), and no other attribute name stood out as the one they use instead. Either the analysed scope is not where the UI lives, or the attribute name is wrong.${incomplete}`,
		undefined,
		{
			attribute: census.attribute,
			attributeSource,
			files: census.files,
			namesCapped: census.namesCapped,
		},
	);
}

function describeSource(attributeSource: TestIdAttributeSource): string {
	switch (attributeSource) {
		case "playwright-config":
			return "read from the Playwright config";
		case "param":
			return "supplied by the caller";
		default:
			return "Playwright's built-in default";
	}
}
