/**
 * 小程序鉴权封装。
 * 后端 /api/auth/unlock 返回 { ok, token }，token 即 Bearer 凭证，
 * 后续请求通过 Authorization: Bearer <token> 通过校验。
 */
const TOKEN_KEY = 'panhub_token'

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

function saveToken(token) {
  if (token) {
    try { wx.setStorageSync(TOKEN_KEY, token) } catch (e) {}
  }
}

function clearToken() {
  try { wx.removeStorageSync(TOKEN_KEY) } catch (e) {}
}

function request(options) {
  const base = (getApp() && getApp().globalData && getApp().globalData.apiBase) || ''
  return new Promise((resolve, reject) => {
    wx.request({
      url: base + options.url,
      method: options.method || 'GET',
      data: options.data,
      header: Object.assign(
        { 'content-type': 'application/json', 'x-panhub-client': 'miniprogram' },
        options.header || {}
      ),
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.data)
        else reject(new Error('http ' + res.statusCode))
      },
      fail(err) { reject(err) }
    })
  })
}

// 返回 true 表示后端开启了密码门（小程序无 cookie，必然 locked）
function fetchStatus() {
  return request({ url: '/api/auth/status' })
    .then(d => !!(d && d.locked === true))
    .catch(() => false)
}

// 解锁成功后写入 token；返回是否成功
function unlock(password) {
  return request({ url: '/api/auth/unlock', method: 'POST', data: { password } })
    .then(d => {
      if (d && d.ok && d.token) {
        saveToken(d.token)
        return true
      }
      return false
    })
}

module.exports = { TOKEN_KEY, getToken, saveToken, clearToken, fetchStatus, unlock }
