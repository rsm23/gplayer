const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

export function quoteIdentifier(identifier: string): string {
  const parts = identifier.split('.')
  if (parts.length === 0 || parts.some((part) => !identifierPattern.test(part))) {
    throw new Error(`Invalid SQL identifier: ${identifier}`)
  }
  return parts.map((part) => `\`${part}\``).join('.')
}

export type CompiledQuery = Readonly<{ sql: string; values: readonly unknown[] }>

type Direction = 'ASC' | 'DESC'

export class SelectQuery {
  private readonly columns: string[] = []
  private readonly criteria: Array<{ sql: string; values: unknown[] }> = []
  private readonly groups: string[] = []
  private readonly orders: Array<{ column: string; direction: Direction }> = []
  private rowLimit?: number
  private rowOffset?: number

  public constructor(private readonly table: string) {}

  public select(...columns: string[]): this {
    this.columns.push(...columns)
    return this
  }

  public where(column: string, value: unknown): this {
    this.criteria.push({ sql: `${quoteIdentifier(column)} = ?`, values: [value] })
    return this
  }

  public whereIn(column: string, values: readonly unknown[]): this {
    if (values.length === 0) this.criteria.push({ sql: '1 = 0', values: [] })
    else this.criteria.push({ sql: `${quoteIdentifier(column)} IN (${values.map(() => '?').join(', ')})`, values: [...values] })
    return this
  }

  public groupBy(...columns: string[]): this {
    this.groups.push(...columns)
    return this
  }

  public orderBy(column: string, direction: Direction = 'ASC'): this {
    this.orders.push({ column, direction })
    return this
  }

  public limit(limit: number, offset = 0): this {
    if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Limit and offset must be non-negative safe integers')
    this.rowLimit = limit
    this.rowOffset = offset
    return this
  }

  public compile(): CompiledQuery {
    const selected = this.columns.length === 0 ? '*' : this.columns.map(quoteIdentifier).join(', ')
    let sql = `SELECT ${selected} FROM ${quoteIdentifier(this.table)}`
    const values: unknown[] = []
    if (this.criteria.length > 0) {
      sql += ` WHERE ${this.criteria.map((criterion) => criterion.sql).join(' AND ')}`
      values.push(...this.criteria.flatMap((criterion) => criterion.values))
    }
    if (this.groups.length > 0) sql += ` GROUP BY ${this.groups.map(quoteIdentifier).join(', ')}`
    if (this.orders.length > 0) sql += ` ORDER BY ${this.orders.map((order) => `${quoteIdentifier(order.column)} ${order.direction}`).join(', ')}`
    if (this.rowLimit !== undefined) {
      sql += ' LIMIT ? OFFSET ?'
      values.push(this.rowLimit, this.rowOffset ?? 0)
    }
    return Object.freeze({ sql, values: Object.freeze(values) })
  }
}
