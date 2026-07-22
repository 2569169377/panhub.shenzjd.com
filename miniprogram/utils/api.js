const app = getApp()
const auth = require('./auth.js')

function request(options) {
  const base = (app && app.globalData && app.globalData.apiBase) || ''
  const secret = (app && app.globalData && app.globalData.mpClientSecret) || ''
  const token = auth.getToken()
  const headers = Object.assign({
    'content-type': 'application/json',
    'x-panhub-client': 'miniprogram',
    'x-panhub-client-secret': secret
  }, options.header || {})
  if (token) headers['Authorization'] = 'Bearer ' + token
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + options.url,
      method: options.method || 'GET',
      data: options.data,
      header: headers,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
        } else if (res.statusCode === 401) {
          const err = new Error('search locked')
          err.statusCode = 401
          reject(err)
        } else {
          const err = new Error('http ' + res.statusCode)
          err.statusCode = res.statusCode
          reject(err)
        }
      },
      fail(err) {
        reject(err)
      }
    })
  })
}

function buildQuery(params) {
  const parts = []
  for (const k in params) {
    const v = params[k]
    if (v === undefined || v === null || v === '') continue
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v))
  }
  return parts.join('&')
}

function getHotSearches(limit) {
  return request({ url: '/api/hot-searches', data: { limit: limit || 10 } })
}

function recordHotSearch(term) {
  return request({ url: '/api/hot-searches', method: 'POST', data: { term } }).catch(() => {})
}

function search(keyword, params) {
  const q = {
    kw: keyword,
    res: 'merged_by_type'
  }
  if (params && params.src) q.src = params.src
  if (params && params.plugins) q.plugins = params.plugins
  if (params && params.channels) q.channels = params.channels
  if (params && params.conc) q.conc = String(params.conc)
  if (params && params.timeoutMs) {
    q.ext = JSON.stringify({ __plugin_timeout_ms: params.timeoutMs })
  }
  return request({ url: '/api/search?' + buildQuery(q) })
}

module.exports = { request, getHotSearches, recordHotSearch, search }
