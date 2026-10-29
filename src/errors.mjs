export class ForkError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ForkError';
    this.code = code;
    Object.assign(this, details);
  }
}

export async function bounded(operation, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ForkError('timeout', `${label} timed out.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
