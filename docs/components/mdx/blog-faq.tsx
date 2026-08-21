import { Accordion, Accordions } from "fumadocs-ui/components/accordion";
import type { ComponentProps } from "react";

type BlogFaqProps = Omit<ComponentProps<typeof Accordions>, "className"> & {
	className?: string;
};

export function BlogFaq({ className, ...props }: BlogFaqProps) {
	return (
		<Accordions
			className={["my-6", className].filter(Boolean).join(" ")}
			{...props}
		/>
	);
}

export function BlogFaqItem(props: ComponentProps<typeof Accordion>) {
	return <Accordion {...props} />;
}
