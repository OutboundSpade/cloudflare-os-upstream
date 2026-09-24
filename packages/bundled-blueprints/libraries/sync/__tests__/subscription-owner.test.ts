// @vitest-environment node
import { expect, it, vi } from "vitest";
import { SubscriptionOwner } from "../src/subscription-owner.ts";
import { createSubscription } from "../src/subscription.ts";

it("releases an old subscription on replacement and the current one once on teardown", () => {
  const owner = new SubscriptionOwner();
  const first = { [Symbol.dispose]: vi.fn() }, second = { [Symbol.dispose]: vi.fn() };
  owner.set(first); owner.set(second);
  expect(first[Symbol.dispose]).toHaveBeenCalledTimes(1);
  expect(second[Symbol.dispose]).not.toHaveBeenCalled();
  owner[Symbol.dispose](); owner[Symbol.dispose]();
  expect(second[Symbol.dispose]).toHaveBeenCalledTimes(1);
});

it("releases setup that finishes after the view has already closed", async () => {
  const owner = new SubscriptionOwner();
  const subscription = { [Symbol.dispose]: vi.fn() };
  const setup = Promise.resolve(subscription).then(value => owner.set(value));
  owner[Symbol.dispose]();
  await setup;
  expect(subscription[Symbol.dispose]).toHaveBeenCalledTimes(1);
});

it("runs server subscription cleanup once even when released repeatedly", () => {
  const cleanup = vi.fn();
  const subscription = createSubscription(Object, cleanup);
  subscription[Symbol.dispose](); subscription[Symbol.dispose]();
  expect(cleanup).toHaveBeenCalledTimes(1);
});
