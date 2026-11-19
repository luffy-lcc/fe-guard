// 故意的架构违规：services 层引用了 ui 层
import { formatName } from '../ui/format'

export function formatUser(name: string): string {
  return formatName(name)
}
