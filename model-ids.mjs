// Adapted from magpie-community/plugins packages/agy-cli 0.1.89 (model-ids.mjs).
// MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce. See NOTICE-upstream-license.txt.
//
// Runtime catalog rows mapped by display name so usage.mjs stays import-free of index.mjs.

let rows = null
let index = new Map()

export function storeCatalogRows(list) {
  rows = Array.isArray(list) ? list.filter(model => model && typeof model.id === "string" && model.id) : null
  index = null
}

export function catalogRows() {
  return rows ? [...rows] : null
}

const normalizeName = (value) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,;]$/, "")

// `agy models` names variants with an effort suffix while usage groups use the base display name.
const stripEffortSuffix = (name) => name.replace(/\s+\((?:high|medium|low|minimal|xhigh|max)\)$/i, "")

// In "Models within this group: A, B and C", the separator before "and" may omit the Oxford comma.
function listedNames(description) {
  const listed = /Models within this group:\s*(.+)/i.exec(String(description ?? ""))
  if (!listed) return null
  return listed[1]
    .split(/,|\s+and\s+/i)
    .map(normalizeName)
    .filter(Boolean)
}

export function nameIndex() {
  if (index) return index
  index = new Map()
  if (rows) {
    const families = new Map()
    const claims = new Map()
    for (const model of rows) {
      const effort = /-(high|medium|low|minimal|xhigh|max)$/i.exec(model.id)?.[1]?.toLowerCase() || ""
      const family = effort ? model.id.slice(0, -(effort.length + 1)) : model.id
      if (!families.has(family)) families.set(family, new Set())
      families.get(family).add(model.id)
      const name = normalizeName(model.name)
      if (!name) continue
      for (const alias of [name, stripEffortSuffix(name)]) {
        if (!claims.has(alias)) claims.set(alias, new Set())
        claims.get(alias).add(family)
      }
    }
    for (const [family, ids] of families) {
      // Include the bare family id served as the catalog default even when only variants are listed.
      ids.add(family)
    }
    for (const [name, owners] of claims) {
      // Leave ambiguous display names shared by multiple families unmatched.
      if (owners.size !== 1) continue
      const [family] = owners
      index.set(name, { family, ids: families.get(family) })
    }
  }
  return index
}

export function modelsInGroup(group) {
  const byName = nameIndex()
  if (!byName.size) return []
  const ids = new Set()
  const names = listedNames(group?.description) || []
  for (const name of names) {
    const entry = byName.get(name)
    if (entry) for (const id of entry.ids) ids.add(id)
  }
  if (!ids.size) {
    const own = normalizeName((group?.displayName || group?.display_name || group?.name || "").replace(/\s+models$/i, ""))
    const entry = byName.get(own)
    if (entry) for (const id of entry.ids) ids.add(id)
  }
  return [...ids].sort()
}
