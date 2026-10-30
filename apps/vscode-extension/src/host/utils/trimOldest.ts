/** Forgets the oldest entries of a Map, which iterates in insertion order, until at most `max` remain. */
export function trimOldest<K, V>(map: Map<K, V>, max: number): void {
  for (const oldest of [...map.keys()].slice(0, Math.max(0, map.size - max))) {
    map.delete(oldest);
  }
}
