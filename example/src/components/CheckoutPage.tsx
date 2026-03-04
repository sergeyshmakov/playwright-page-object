import type { CartItem } from "../App";
import CartItemComponent from "./CartItem";

type Props = {
  cart: CartItem[];
  onRemoveItem: (id: string) => void;
  onApplyPromo: () => void;
  promoApplied: boolean;
};

export default function CheckoutPage({
  cart,
  onRemoveItem,
  onApplyPromo,
  promoApplied,
}: Props) {
  return (
    <main data-testid="CheckoutPage">
      <section data-testid="PromoSection">
        <label htmlFor="promo">Promo code</label>
        <input
          id="promo"
          type="text"
          data-testid="PromoCodeInput"
          placeholder="Enter promo code"
          aria-label="Promo code"
        />
        <button
          type="button"
          onClick={onApplyPromo}
          data-testid="ApplyPromoButton"
          aria-label="Apply promo"
        >
          Apply
        </button>
        {promoApplied && (
          <span data-testid="PromoApplied">Promo applied!</span>
        )}
      </section>

      <section data-testid="CartSection">
        <h2>Cart</h2>
        {cart.length === 0 ? (
          <p data-testid="EmptyCart">Your cart is empty.</p>
        ) : (
          <div data-testid="CartItemsList">
            {cart.map((item) => (
              <CartItemComponent
                key={item.id}
                item={item}
                onRemove={onRemoveItem}
              />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
