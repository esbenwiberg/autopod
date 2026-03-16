import Table from 'cli-table3';

export interface ColumnDef<T> {
  header: string;
  key?: keyof T;
  width?: number;
  align?: 'left' | 'center' | 'right';
  formatter?: (row: T) => string;
}

export function renderTable<T>(data: T[], columns: ColumnDef<T>[]): string {
  const termWidth = process.stdout.columns || 120;

  // Calculate available width minus table chrome (borders + padding)
  const chrome = columns.length + 1 + columns.length * 2; // borders + padding
  const fixedWidth = columns.reduce((sum, col) => sum + (col.width ?? 0), 0);
  const flexCols = columns.filter((c) => !c.width).length;
  const flexWidth = flexCols > 0 ? Math.floor((termWidth - chrome - fixedWidth) / flexCols) : 0;

  const table = new Table({
    head: columns.map((c) => c.header),
    colWidths: columns.map((c) => c.width ?? Math.max(flexWidth, 8)),
    colAligns: columns.map((c) => c.align ?? 'left'),
    style: {
      head: ['cyan'],
      border: ['dim'],
    },
    wordWrap: true,
  });

  for (const row of data) {
    const cells = columns.map((col) => {
      if (col.formatter) {
        return col.formatter(row);
      }
      if (col.key) {
        const val = row[col.key];
        return val === null || val === undefined ? '-' : String(val);
      }
      return '-';
    });
    table.push(cells);
  }

  return table.toString();
}
