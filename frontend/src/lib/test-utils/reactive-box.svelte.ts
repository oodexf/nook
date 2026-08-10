/**
 * Test helper: a `$state`-backed box so component tests can update props
 * after `mount`. Plain getter props over a mutable object do not notify
 * Svelte; reading this box inside a prop getter creates a real reactive
 * dependency, and assigning `value` re-renders the mounted component.
 */
export function reactiveBox<T>(initial: T): {
  readonly value: T;
  set(next: T): void;
} {
  let current = $state(initial);
  return {
    get value() {
      return current;
    },
    set(next: T) {
      current = next;
    }
  };
}
