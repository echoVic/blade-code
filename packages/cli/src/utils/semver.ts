export function gte(v1: string, v2: string): boolean {
  const parse = (v: string) =>
    v.split('.').map(n => parseInt(n, 10) || 0) as [number, number, number]
  const [a1, a2, a3] = parse(v1)
  const [b1, b2, b3] = parse(v2)
  if (a1 !== b1) return a1! > b1!
  if (a2 !== b2) return a2! > b2!
  return a3! >= b3!
}
