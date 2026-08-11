export interface Limiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  activeCount(): number;
  pendingCount(): number;
}

export function createLimiter(concurrency: number): Limiter {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("createLimiter: concurrency must be a positive integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  function dequeue() {
    if (active >= concurrency) return;
    const task = queue.shift();
    if (task) task();
  }

  const limit = (<T>(fn: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const task = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            dequeue();
          });
      };
      if (active < concurrency) task();
      else queue.push(task);
    });
  }) as Limiter;

  limit.activeCount = () => active;
  limit.pendingCount = () => queue.length;

  return limit;
}
