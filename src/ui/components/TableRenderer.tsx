/**
 * 表格渲染器 - 基于 ink-table 源码实现
 *
 * 原始来源: https://github.com/maticzav/ink-table
 * 许可证: MIT
 * 作者: Matic Zavadlal
 *
 * 修改说明:
 * - 移除了 object-hash 依赖，使用简单的索引作为 key
 * - 简化了组件结构，适配我们的使用场景
 * - 保留了核心的表格渲染逻辑和样式
 */

import { Box, Text } from 'ink';
import React from 'react';

/* Types */

type Scalar = string | number | boolean | null | undefined;

type ScalarDict = {
  [key: string]: Scalar;
};

type CellProps = React.PropsWithChildren<{ column: number }>;

type TableProps<T extends ScalarDict> = {
  data: T[];
  columns?: (keyof T)[];
  padding?: number;
  header?: (props: React.PropsWithChildren<{}>) => React.ReactElement;
  cell?: (props: CellProps) => React.ReactElement;
  skeleton?: (props: React.PropsWithChildren<{}>) => React.ReactElement;
};

type Column<T> = {
  key: string;
  column: keyof T;
  width: number;
};

type RowConfig = {
  cell: (props: CellProps) => React.ReactElement;
  padding: number;
  skeleton: {
    component: (props: React.PropsWithChildren<{}>) => React.ReactElement;
    left: string;
    right: string;
    cross: string;
    line: string;
  };
};

type RowProps<T extends ScalarDict> = {
  key: string;
  data: Partial<T>;
  columns: Column<T>[];
};

/* Helper Components */

function Header(props: React.PropsWithChildren<{}>) {
  return (
    <Text bold color="cyan">
      {props.children}
    </Text>
  );
}

function Cell(props: CellProps) {
  return <Text>{props.children}</Text>;
}

function Skeleton(props: React.PropsWithChildren<{}>) {
  return <Text bold>{props.children}</Text>;
}

/* Utility Functions */

function intersperse<T, I>(
  intersperser: (index: number) => I,
  elements: T[]
): (T | I)[] {
  const interspersed: (T | I)[] = elements.reduce(
    (acc, element, index) => {
      if (acc.length === 0) return [element];
      return [...acc, intersperser(index), element];
    },
    [] as (T | I)[]
  );

  return interspersed;
}

function row<T extends ScalarDict>(
  config: RowConfig
): (props: RowProps<T>) => React.ReactElement {
  const skeleton = config.skeleton;

  return (props) => (
    <Box flexDirection="row">
      {/* Left */}
      <skeleton.component>{skeleton.left}</skeleton.component>
      {/* Data */}
      {...intersperse(
        (i) => {
          const key = `${props.key}-hseparator-${i}`;
          return <skeleton.component key={key}>{skeleton.cross}</skeleton.component>;
        },
        props.columns.map((column, colI) => {
          const value = props.data[column.column];

          if (value == undefined || value == null) {
            const key = `${props.key}-empty-${column.key}`;
            return (
              <config.cell key={key} column={colI}>
                {skeleton.line.repeat(column.width)}
              </config.cell>
            );
          } else {
            const key = `${props.key}-cell-${column.key}`;
            const ml = config.padding;
            const mr = column.width - String(value).length - config.padding;

            return (
              <config.cell key={key} column={colI}>
                {`${skeleton.line.repeat(ml)}${String(value)}${skeleton.line.repeat(mr)}`}
              </config.cell>
            );
          }
        })
      )}
      {/* Right */}
      <skeleton.component>{skeleton.right}</skeleton.component>
    </Box>
  );
}

/* Table Component */

class InkTable<T extends ScalarDict> extends React.Component<TableProps<T>> {
  getConfig(): Required<TableProps<T>> {
    return {
      data: this.props.data,
      columns: this.props.columns || this.getDataKeys(),
      padding: this.props.padding || 1,
      header: this.props.header || Header,
      cell: this.props.cell || Cell,
      skeleton: this.props.skeleton || Skeleton,
    };
  }

  getDataKeys(): (keyof T)[] {
    const keys = new Set<keyof T>();
    for (const data of this.props.data) {
      for (const key in data) {
        keys.add(key);
      }
    }
    return Array.from(keys);
  }

  getColumns(): Column<T>[] {
    const { columns, padding } = this.getConfig();

    return columns.map((key) => {
      const header = String(key).length;
      const data = this.props.data.map((data) => {
        const value = data[key];
        if (value == undefined || value == null) return 0;
        return String(value).length;
      });

      const width = Math.max(...data, header) + padding * 2;

      return {
        column: key,
        width: width,
        key: String(key),
      };
    });
  }

  getHeadings(): Partial<T> {
    const { columns } = this.getConfig();
    return columns.reduce((acc, column) => ({ ...acc, [column]: column }), {});
  }

  header = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      line: '─',
      left: '┌',
      right: '┐',
      cross: '┬',
    },
  });

  heading = row<T>({
    cell: this.getConfig().header,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      line: ' ',
      left: '│',
      right: '│',
      cross: '│',
    },
  });

  separator = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      line: '─',
      left: '├',
      right: '┤',
      cross: '┼',
    },
  });

  data = row<T>({
    cell: this.getConfig().cell,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      line: ' ',
      left: '│',
      right: '│',
      cross: '│',
    },
  });

  footer = row<T>({
    cell: this.getConfig().skeleton,
    padding: this.getConfig().padding,
    skeleton: {
      component: this.getConfig().skeleton,
      line: '─',
      left: '└',
      right: '┘',
      cross: '┴',
    },
  });

  render() {
    const columns = this.getColumns();
    const headings = this.getHeadings();

    return (
      <Box flexDirection="column">
        {/* Header */}
        {this.header({ key: 'header', columns, data: {} })}
        {this.heading({ key: 'heading', columns, data: headings })}
        {/* Data */}
        {this.props.data.map((row, index) => {
          const key = `row-${index}`;
          return (
            <Box flexDirection="column" key={key}>
              {this.separator({ key: `separator-${key}`, columns, data: {} })}
              {this.data({ key: `data-${key}`, columns, data: row })}
            </Box>
          );
        })}
        {/* Footer */}
        {this.footer({ key: 'footer', columns, data: {} })}
      </Box>
    );
  }
}

/* Adapter for our existing TableRenderer interface */

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  terminalWidth: number;
}

export const TableRenderer: React.FC<TableRendererProps> = ({ headers, rows }) => {
  if (headers.length === 0 || rows.length === 0) {
    return null;
  }

  // 将数据转换为 ink-table 需要的格式
  const data = rows.map((row) => {
    const rowData: Record<string, string> = {};
    headers.forEach((header, index) => {
      rowData[header] = row[index] || '';
    });
    return rowData;
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <InkTable data={data} />
    </Box>
  );
};

// 导出 InkTable 供其他地方使用
export { InkTable };
export type { ScalarDict, TableProps };
