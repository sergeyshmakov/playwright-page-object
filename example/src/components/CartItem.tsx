import type { CartItem as CartItemType } from "../App";

type Props = {
	item: CartItemType;
	onRemove: (id: string) => void;
};

export default function CartItem({ item, onRemove }: Props) {
	return (
		<div data-testid="CartItem" data-item-id={item.id}>
			<span data-testid="CartItemName">{item.name}</span>
			<span data-testid="CartItemPrice">${item.price.toFixed(2)}</span>
			<button
				type="button"
				onClick={() => onRemove(item.id)}
				data-testid="Remove"
				aria-label="Remove"
			>
				Remove
			</button>
		</div>
	);
}
