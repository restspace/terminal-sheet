export interface Identifiable {
  id: string;
}

export interface UpdateByIdResult<T> {
  items: T[];
  found: boolean;
  changed: boolean;
}

export function updateById<T extends Identifiable>(
  items: readonly T[],
  id: string,
  updater: (item: T) => T,
): UpdateByIdResult<T> {
  let found = false;
  let changed = false;

  const nextItems = items.map((item) => {
    if (item.id !== id) {
      return item;
    }

    found = true;
    const nextItem = updater(item);
    changed ||= nextItem !== item;
    return nextItem;
  });

  return {
    items: changed ? nextItems : [...items],
    found,
    changed,
  };
}
