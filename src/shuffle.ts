// A shuffle bag: hands out every item once, in a random order, before any of them comes up
// again, and a new round never opens with the item that closed the last one. So nothing
// repeats until everything else has had its turn (plain random picks repeat by chance).

export interface ShuffleBag<T> {
  next(): T;
}

export function createShuffleBag<T>(items: readonly T[], random: () => number = Math.random): ShuffleBag<T> {
  let bag: T[] = [];
  let last: T | undefined;
  return {
    next() {
      if (bag.length === 0) {
        bag = [...items];
        // Fisher-Yates; the bag is drawn from the end.
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [bag[i], bag[j]] = [bag[j], bag[i]];
        }
        if (bag.length > 1 && bag[bag.length - 1] === last) [bag[0], bag[bag.length - 1]] = [bag[bag.length - 1], bag[0]];
      }
      last = bag.pop();
      return last as T;
    },
  };
}
