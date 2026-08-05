import type {
	ConstructorDeclaration,
	GetAccessorDeclaration,
	MethodDeclaration,
	ParameterDeclaration,
	SetAccessorDeclaration,
} from "ts-morph";

export type SignatureMode = "syntactic" | "checked";

const MAX_TYPE = 200;

/** Strips `import("…/PageObject").` prefixes the checker likes to emit. */
export function renderType(text: string, max = MAX_TYPE): string {
	const cleaned = text
		.replace(/import\("(?:[^"]*)"\)\./g, "")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function renderParameter(parameter: ParameterDeclaration): string {
	const rest = parameter.isRestParameter() ? "..." : "";
	const optional = parameter.hasQuestionToken() ? "?" : "";
	const typeNode = parameter.getTypeNode();
	const annotation = typeNode ? `: ${renderType(typeNode.getText())}` : "";
	return `${rest}${parameter.getName()}${optional}${annotation}`;
}

export function renderParameters(parameters: ParameterDeclaration[]): string {
	return parameters.map(renderParameter).join(", ");
}

type Signable =
	| MethodDeclaration
	| GetAccessorDeclaration
	| SetAccessorDeclaration;

/**
 * Renders a method signature.
 *
 * `"syntactic"` (the default) copies whatever annotations the author wrote and
 * never touches the type checker. `"checked"` asks for the inferred return
 * type — the only checker-dependent path in the tree builder.
 */
export function renderMethod(node: Signable, mode: SignatureMode): string {
	const name = node.getName();
	const parameters = renderParameters(node.getParameters());
	const head = `${name}(${parameters})`;
	const returnType = renderReturnType(node, mode);
	return returnType ? `${head}: ${returnType}` : head;
}

export function renderReturnType(
	node: Signable,
	mode: SignatureMode,
): string | null {
	const annotated = node.getReturnTypeNode();
	if (annotated) {
		return renderType(annotated.getText());
	}
	if (mode === "checked") {
		try {
			return renderType(node.getReturnType().getText(node));
		} catch {
			return null;
		}
	}
	return null;
}

export function renderConstructor(node: ConstructorDeclaration): string {
	return `constructor(${renderParameters(node.getParameters())})`;
}
