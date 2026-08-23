import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { AccountMonthSummary } from '@/types/domain';

interface EmailsByMonthChartProps {
  byAccountMonth: AccountMonthSummary[];
}

interface MonthDatum {
  monthFolder: string;
  emailsCount: number;
}

/** Agrupa por monthFolder sumando emailsCount de todas las cuentas y ordena cronológicamente. */
function buildMonthlyData(byAccountMonth: AccountMonthSummary[]): MonthDatum[] {
  const totals = new Map<string, number>();
  for (const row of byAccountMonth) {
    totals.set(row.monthFolder, (totals.get(row.monthFolder) ?? 0) + row.emailsCount);
  }
  return Array.from(totals.entries())
    .map(([monthFolder, emailsCount]) => ({ monthFolder, emailsCount }))
    .sort((a, b) => a.monthFolder.localeCompare(b.monthFolder));
}

export function EmailsByMonthChart({ byAccountMonth }: EmailsByMonthChartProps) {
  const data = buildMonthlyData(byAccountMonth);

  if (data.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
        Todavía no hay correos procesados para graficar.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={256}>
      <BarChart data={data} barCategoryGap={2} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis
          dataKey="monthFolder"
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          axisLine={{ stroke: 'var(--border)' }}
          tickLine={false}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fill: 'var(--muted-foreground)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          width={36}
        />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          contentStyle={{
            backgroundColor: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            color: 'var(--popover-foreground)',
          }}
          labelStyle={{ color: 'var(--popover-foreground)' }}
        />
        <Bar
          dataKey="emailsCount"
          name="Correos"
          fill="var(--chart-1)"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
