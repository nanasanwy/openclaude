// node:fs and node:path calls in the database opener; in the browser the database lives in memory.
export const mkdirSync = (): void => {}
export const dirname = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf('/'))) || '.'
