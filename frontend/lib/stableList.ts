/**
 * Reconciles a freshly fetched list against the previous one so React state
 * keeps its identity when nothing changed.
 *
 * - Items whose key matches a previous item and whose contents are equal are
 *   replaced by the previous object, so memoized rows bail out of re-rendering.
 * - If every position ends up holding the same object as before, the previous
 *   array itself is returned, so `setState(prev => reconcileList(prev, next))`
 *   is a no-op and memoized consumers skip the render entirely.
 *
 * Content equality is a JSON comparison: list items here are plain API
 * payloads, and a page is small enough that this is cheaper than a render.
 */
export function reconcileList<T>(
  prev: readonly T[],
  next: readonly T[],
  getKey: (item: T) => string,
): T[] {
  const prevByKey = new Map<string, T>();
  for (const item of prev) prevByKey.set(getKey(item), item);

  let changed = prev.length !== next.length;
  const merged = next.map((item, index) => {
    const previous = prevByKey.get(getKey(item));
    const out =
      previous !== undefined && (previous === item || JSON.stringify(previous) === JSON.stringify(item))
        ? previous
        : item;
    if (out !== prev[index]) changed = true;
    return out;
  });

  return changed ? merged : (prev as T[]);
}
