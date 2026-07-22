/**
 * 合并搜索结果，按 url 去重
 * 与 app/utils/mergeMergedByType.ts 同语义
 * @param {Object} target - { type: MergedLink[] }
 * @param {Object} [incoming]
 * @returns {Object}
 */
function mergeMergedByType(target, incoming) {
  if (!incoming) return target
  const out = Object.assign({}, target)
  var types = Object.keys(incoming)
  for (var i = 0; i < types.length; i++) {
    var type = types[i]
    var existed = out[type] || []
    var next = incoming[type] || []
    var seen = new Set(existed.map(function (x) { return x.url }))
    var mergedArr = existed.slice()
    for (var j = 0; j < next.length; j++) {
      var item = next[j]
      if (!seen.has(item.url)) {
        seen.add(item.url)
        mergedArr.push(item)
      }
    }
    out[type] = mergedArr
  }
  return out
}

module.exports = { mergeMergedByType: mergeMergedByType }
