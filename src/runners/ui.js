import { buildInventory, findDuplicates, writeInventory } from '../inventory.js'

export const id = 'ui'

const DEFAULT_INVENTORY = '.fe-guard/ui-inventory.json'

/**
 * 组件清单与重复实现检测。
 * 清单在每次检查时重建（只读源码、不跑编译器），既保证新鲜，也避免把整份清单塞进上下文。
 * 重复命中只对“本次范围内”的文件报错，和 baseline 的增量语义保持一致。
 */
export async function runCheck({ root, check, changedFiles, inventoryRoot }) {
  const inventory = buildInventory(root, check)
  try {
    // --staged 时源码来自影子目录，但清单应写回真实仓库，ui_lookup 才能看到最新结果。
    writeInventory(inventoryRoot ?? root, check.inventory ?? DEFAULT_INVENTORY, inventory)
  } catch {
    // 清单是缓存：CI 只读文件系统时不应该因此让检查失败。
  }

  const duplicates = findDuplicates(inventory.components, check)
  if (!changedFiles) return duplicates

  const scope = new Set(changedFiles)
  return duplicates.filter((violation) => scope.has(violation.file))
}
