export function removeDuplicates<T>(
  items: T[],
  key: (item: T) => string
): T[] {

  const map = new Map<string, T>();

  for (const item of items) {

    map.set(
      key(item),
      item
    );

  }

  return [...map.values()];

}