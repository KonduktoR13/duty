import type { WorkInterval } from "./intervals"
import { calendarWorkHours } from './month-analysis'
import { candidateForMonth, candidatesForMonth } from './roster'
import type { MonthRecord } from './types'

export type EmployeeWorkloadSort = 'month' | 'total'

export type EmployeeWorkload = {
  deltaNumber: string
  rank: number
  monthHours: number
  totalHours: number
  availableMonths: number
}

export function rankEmployeeWorkload(months: MonthRecord[], monthId: string, sort: EmployeeWorkloadSort = 'month', adjusted?: { owner: string; intervals: WorkInterval[] }): EmployeeWorkload[] {
  const source = months.find(month => month.id === monthId)
  if (!source) return []
  const numbers = [...new Set(candidatesForMonth(source).map(candidate => candidate.number))]
  const hoursKey = sort === 'total' ? 'totalHours' : 'monthHours'
  const rows = numbers.map(deltaNumber => {
    const monthIds = months.filter(month => candidateForMonth(month, deltaNumber)).map(month => month.id)
    const hours = calendarWorkHours(months, deltaNumber, monthIds)
    if (adjusted?.owner === deltaNumber) {
      for (const id of monthIds) {
        const start = id + '-01T00:00:00';
        const end = new Date(Date.UTC(Number(id.slice(0, 4)), Number(id.slice(5, 7)), 1)).toISOString().slice(0, 19);
        const total = adjusted.intervals.filter(i => i.kind === 'hours').reduce((n, i) => {
          const a = i.start.dateTime > start ? i.start.dateTime : start;
          const b = i.end.dateTime < end ? i.end.dateTime : end;
          return n + Math.max(0, (Date.parse(b + 'Z') - Date.parse(a + 'Z')) / 3600000);
        }, 0);
        hours.set(id, Math.round(total * 10) / 10);
      }
    }
    return {
      deltaNumber,
      rank: 0,
      monthHours: hours.get(monthId) || 0,
      totalHours: Math.round([...hours.values()].reduce((sum, value) => sum + value, 0) * 10) / 10,
      availableMonths: monthIds.length,
    }
  }).sort((a, b) => b[hoursKey] - a[hoursKey] || a.deltaNumber.localeCompare(b.deltaNumber, 'en', { numeric: true }))
  for (let index = 0; index < rows.length; index++) {
    rows[index].rank = index && rows[index][hoursKey] === rows[index - 1][hoursKey]
      ? rows[index - 1].rank
      : index + 1
  }
  return rows
}
