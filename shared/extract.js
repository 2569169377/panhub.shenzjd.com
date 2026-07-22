/**
 * 从后端响应里提取 MergedLinks。
 * 与 app/utils/extractMergedFromResponse.ts 同语义。
 */
function extractMergedFromResponse(data) {
  if (!data) return {}
  if (data.merged_by_type && typeof data.merged_by_type === 'object') {
    var m = data.merged_by_type
    if (Object.keys(m).length > 0) return m
  }
  var results = data.results
  if (Array.isArray(results) && results.length > 0) {
    var out = {}
    for (var i = 0; i < results.length; i++) {
      var r = results[i]
      var links = r.links
      if (Array.isArray(links) && links.length > 0) {
        var note = r.title || r.content || ''
        var dt = r.datetime || ''
        for (var k = 0; k < links.length; k++) {
          var link = links[k]
          var t = link.type || 'others'
          if (!out[t]) out[t] = []
          out[t].push({
            url: link.url,
            password: link.password || '',
            note: note,
            datetime: dt,
            source: r.channel ? 'tg:' + r.channel : undefined
          })
        }
      } else if (r.url) {
        var tt = r.type || 'others'
        if (!out[tt]) out[tt] = []
        out[tt].push({
          url: r.url,
          password: r.password || '',
          note: r.note || '',
          datetime: r.datetime || '',
          source: r.source
        })
      }
    }
    return out
  }
  var arr = Array.isArray(data) ? data : (data.items || data.list || data.data)
  if (Array.isArray(arr) && arr.length > 0) {
    var o = {}
    for (var j = 0; j < arr.length; j++) {
      var it = arr[j]
      if (it && it.url) {
        var t = it.type || 'others'
        if (!o[t]) o[t] = []
        o[t].push({
          url: it.url,
          password: it.password || '',
          note: it.note || '',
          datetime: it.datetime || '',
          source: it.source
        })
      }
    }
    return o
  }
  return {}
}

module.exports = { extractMergedFromResponse: extractMergedFromResponse }
