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

export function rankEmployeeWorkload(months: MonthRecord[], monthId: string, sort: EmployeeWorkloadSort = 'month'): EmployeeWorkload[] {
  const source = months.find(month => month.id === monthId)
  if (!source) return []
  const numbers = [...new Set(candidatesForMonth(source).map(candidate => candidate.number))]
  const hoursKey = sort === 'total' ? 'totalHours' : 'monthHours'
  const rows = numbers.map(deltaNumber => {
    const monthIds = months.filter(month => candidateForMonth(month, deltaNumber)).map(month => month.id)
    const hours = calendarWorkHours(months, deltaNumber, monthIds)
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
