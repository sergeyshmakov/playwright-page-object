import type {
	ArrowFunction,
	ConstructorDeclaration,
	FunctionExpression,
	GetAccessorDeclaration,
	MethodDeclaration,
	ParameterDeclaration,
	PropertyDeclaration,
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

/**
 * Renders an accessor as the thing a caller writes, not as a method.
 *
 * `total(): number` for a getter is a lie an agent acts on: it writes
 * `page.total()` and gets a `TypeError`. A getter reads as a property and a
 * setter as an assignment, so the signature says `get total: number` and
 * `set total(value: number)` — the `get`/`set` word carries the call syntax and
 * the shape carries the type.
 */
export function renderAccessor(
	node: GetAccessorDeclaration | SetAccessorDeclaration,
	kind: "getter" | "setter",
	mode: SignatureMode,
): string {
	const name = node.getName();
	if (kind === "setter") {
		return `set ${name}(${renderParameters(node.getParameters())})`;
	}
	const returnType = renderReturnType(node, mode);
	return returnType ? `get ${name}: ${returnType}` : `get ${name}`;
}

/**
 * Renders a class property that holds a function as the call it supports.
 *
 * `run = async (n: number) => {}` is callable exactly like a method, and an
 * agent reading a bare property name has no way to tell. The rendered form is
 * deliberately method-shaped for that reason; `MethodInfo.declaredAsProperty`
 * carries the distinction for anything that needs it.
 */
export function renderFunctionProperty(
	property: PropertyDeclaration,
	fn: ArrowFunction | FunctionExpression,
	mode: SignatureMode,
): string {
	const head = `${property.getName()}(${renderParameters(fn.getParameters())})`;
	const returnType = renderFunctionReturnType(fn, mode);
	return returnType ? `${head}: ${returnType}` : head;
}

export function renderFunctionReturnType(
	fn: ArrowFunction | FunctionExpression,
	mode: SignatureMode,
): string | null {
	const annotated = fn.getReturnTypeNode();
	if (annotated) {
		return renderType(annotated.getText());
	}
	if (mode === "checked") {
		try {
			return renderType(fn.getReturnType().getText(fn));
		} catch {
			return null;
		}
	}
	return null;
}

export function renderConstructor(node: ConstructorDeclaration): string {
	return `constructor(${renderParameters(node.getParameters())})`;
}
