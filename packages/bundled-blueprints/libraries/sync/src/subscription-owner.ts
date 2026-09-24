/** Owns the subscription returned to a view, including setup that completes after teardown. */
export class SubscriptionOwner implements Disposable {
  #subscription: Disposable | undefined;
  #closed = false;

  /** Replace the live subscription, or immediately release a result arriving after teardown. */
  set(subscription: Disposable): void {
    if (this.#closed) {
      subscription[Symbol.dispose]();
      return;
    }
    const previous = this.#subscription;
    this.#subscription = subscription;
    previous?.[Symbol.dispose]();
  }

  /** End the view's ownership once; a pending setup may still call set(). */
  [Symbol.dispose](): void {
    this.#closed = true;
    const subscription = this.#subscription;
    this.#subscription = undefined;
    subscription?.[Symbol.dispose]();
  }
}
