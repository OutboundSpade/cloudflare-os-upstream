/** Create a native RPC subscription using the caller's Workers RpcTarget base. */
export function createSubscription(Base: abstract new () => object, cleanup: () => void): Disposable {
  return new class extends Base implements Disposable {
    #cleanup: (() => void) | undefined = cleanup;

    /** Release the retained callback once, including on transport teardown. */
    [Symbol.dispose](): void {
      const release = this.#cleanup;
      this.#cleanup = undefined;
      release?.();
    }
  }();
}
