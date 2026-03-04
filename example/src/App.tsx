import { useState } from "react";
import CheckoutPage from "./components/CheckoutPage";
import Header from "./components/Header";

export type CartItem = {
	id: string;
	name: string;
	price: number;
};

const INITIAL_CART: CartItem[] = [
	{ id: "1", name: "Widget A", price: 29.99 },
	{ id: "2", name: "Widget B", price: 49.99 },
	{ id: "3", name: "Gadget X", price: 19.99 },
];

export default function App() {
	const [cart, setCart] = useState<CartItem[]>(INITIAL_CART);
	const [promoApplied, setPromoApplied] = useState(false);

	const removeItem = (id: string) => {
		setCart((prev) => prev.filter((item) => item.id !== id));
	};

	const applyPromo = () => {
		setPromoApplied(true);
	};

	return (
		<>
			<Header />
			<CheckoutPage
				cart={cart}
				onRemoveItem={removeItem}
				onApplyPromo={applyPromo}
				promoApplied={promoApplied}
			/>
		</>
	);
}
