import { Node } from "ts-morph";

const MAX_DOC = 160;

/**
 * First sentence of a JSDoc comment, flattened to one line.
 *
 * Agents read these as hints next to a member name, so a full multi-paragraph
 * comment is noise; the first sentence is almost always the summary.
 */
export function docSummary(node: Node, max = MAX_DOC): string | undefined {
	if (!Node.isJSDocable(node)) {
		return undefined;
	}
	const docs = node.getJsDocs();
	if (docs.length === 0) {
		return undefined;
	}
	const raw = docs
		.map((doc) => doc.getDescription())
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (raw === "") {
		return undefined;
	}
	const sentenceEnd = raw.search(/[.!?](\s|$)/);
	const sentence = sentenceEnd >= 0 ? raw.slice(0, sentenceEnd + 1) : raw;
	const trimmed = sentence.trim();
	if (trimmed.length > max) {
		return `${trimmed.slice(0, max - 1)}…`;
	}
	return trimmed;
}
